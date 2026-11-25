/*
 * WebSocket API methods and request dispatch. Transport-agnostic: the local server
 * (api.ts) and the remote control link (remote.ts) both pass raw frames to handleRequest().
 *
 * Client → server (request):
 *   { "id": 1, "method": "modems.toggle", "params": { "iface": "wwan0" } }
 *
 * Server → client (response to a request, `id` echoed back):
 *   { "type": "response", "id": 1, "method": "modems.toggle", "ok": true,  "result": { ... } }
 *   { "type": "response", "id": 1, "method": "modems.toggle", "ok": false, "error": "...", "code": 404 }
 *
 * Server → client (push, sent on connect and whenever state changes; see push.ts):
 *   { "type": "event", "event": "status", "data": { ...same as `status` result... } }
 *   { "type": "event", "event": "log", "data": { "reset"?: true, "entries": [LogEntry, ...] } }
 *   { "type": "event", "event": "<module event>", "data": {...}, "module": "<id>" }
 *
 * Core methods:
 *   status, log.list, log.clear
 *   setup.get, setup.install {role}, setup.complete {...wizard answers}
 *       (only while the device has no config file)
 *   settings.get, settings.update {hostname?, role?, color?, remoteUrl?, remoteToken?, language?}
 *   modules.list, modules.info, modules.enable {id}, modules.disable {id},
 *   modules.configure {id, config}
 *   autostart.set {enabled}   resume the last run when the service starts
 *
 * Every other method belongs to a module (modules/<id>/backend.ts `methods`)
 * and is routed to its `dispatch` — which validates the parameters itself.
 * A module's methods are rejected with 409 outside the roles it serves (and,
 * when it says so, while it is disabled). Methods that change something are
 * recorded in the event log (success or failure); their responses carry
 * `"logged": true` so clients do not log them a second time.
 */

import { randomUUID } from "node:crypto";
import type { Params } from "../../shared/contracts/backend_module";
import { LANGUAGES, setCurrentLanguage, t } from "../../shared/i18n";
import { isLoggedMethod, methodLog } from "../../shared/log_messages";
import {
	ApiError,
	checkColor,
	checkHostname,
	checkPassword,
	checkRemoteUrl,
	checkUsername,
	oneOf,
	optionalSettingString,
	requireBoolean,
	requireString,
} from "../../shared/params";
import { installModuleRoot } from "../../shared/paths";
import { registeredRoleIds, roleDefinitions } from "../../shared/registry";
import { errorMessage, isPlainObject, textOf } from "../../shared/util";
import { DEFAULT_COLOR, type Role } from "../../shared/validate";
import { autoInstallRole } from "../install/auto_install";
import { realProviderBundle } from "../install/providers";
import { authEnabled, hashPassword } from "./auth";
import { setAutostart } from "./autostart";
import { CONFIG_FILE } from "./config";
import { clearLog, logEntries, logEvent } from "./eventlog";
import {
	callModule,
	configureModule,
	effectiveRole,
	finishSetup,
	methodAllowed,
	methodOwner,
	moduleById,
	moduleInfos,
	moduleSettings,
	optionalModuleInfo,
	moduleSetupInfo,
	moduleStatuses,
	restartModule,
	safeModules,
	seedOptionalModules,
	setModuleEnabled,
	setupModules,
	validateModuleConfig,
} from "./modules";
import { applyRemoteSettings } from "./remote";
import {
	type DeviceSettings,
	saveState,
	setupRequired,
	state,
	uiLanguage,
} from "./state";

type Method = (params: Params) => Promise<object> | object;

/** The `status` payload: the core fields plus every applicable module's fragment. */
export async function buildStatus(): Promise<Record<string, unknown>> {
	const fragments = await moduleStatuses();
	return {
		role: effectiveRole(),
		setupRequired,
		auth: authEnabled,
		...fragments,
		state: { ...(fragments.state as object), autostart: !!state.autostart },
		modules: safeModules(),
	};
}

const settingsView = () => {
	const s = state.settings;
	return {
		uuid: s.uuid ?? "",
		hostname: s.hostname ?? "",
		role: s.role ?? "",
		remoteUrl: s.remoteUrl ?? "",
		hasRemoteToken: !!s.remoteToken,
		color: s.color ?? DEFAULT_COLOR,
		language: uiLanguage(),
		...moduleSettings(),
		roleDefinitions: roleDefinitions().filter(
			(role) => role.setupSelectable !== false,
		),
	};
};

/** [field, label] pairs for the settings re-registered & logged on change. */
const settingFields: ReadonlyArray<
	readonly [key: keyof DeviceSettings, label: string]
> = [
	["hostname", "name"],
	["role", "role"],
	["remoteUrl", "remote URL"],
	["remoteToken", "remote token"],
	["color", "color"],
];

/**
 * Apply the role's host rules (systemd units, firewall, dependencies, …) and
 * stream the install log to the UI as `log` events (section "Install"). The
 * wizard's install step awaits it — the response only lands when the install
 * finishes (it can take minutes). `missing` is the no-op signal: when the
 * role has no modules to install, nothing ran at all.
 */
async function runRoleInstall(role: Role): Promise<{
	installed: boolean;
	missing: string[];
	skipped?: "skip" | "not-root";
}> {
	logEvent("info", "Install", t("log.install_started", { role }));
	let cfg: Record<string, unknown> = {};
	try {
		const data: unknown = await Bun.file(CONFIG_FILE).json();
		if (typeof data === "object" && data !== null)
			cfg = data as Record<string, unknown>;
	} catch {
		cfg = {};
	}
	const res = await autoInstallRole(role, {
		providers: realProviderBundle(),
		cfg,
		moduleRoot: installModuleRoot(),
		// Stream each step's lines the moment it finishes — a live log,
		// not a dump at the end of the module.
		onStep: (_module, _step, lines) =>
			lines.forEach((line) => logEvent("info", "Install", line)),
	});
	if (res.error !== undefined) {
		logEvent(
			"error",
			"Install",
			t("log.install_failed", { role, error: errorMessage(res.error) }),
		);
		return { installed: false, missing: res.missing };
	}
	if (res.missing.length === 0) {
		logEvent("info", "Install", t("log.install_up_to_date", { role }));
		return { installed: false, missing: [] };
	}
	if (res.skipped === "not-root") {
		logEvent("warn", "Install", t("log.install_skipped_not_root", { role }));
		return { installed: false, missing: res.missing, skipped: "not-root" };
	}
	if (res.installed)
		logEvent("info", "Install", t("log.install_done", { role }));
	return { installed: res.installed, missing: res.missing, skipped: res.skipped };
}

/** Wizard install step: apply the picked role's rules now; the step follows
 * the streamed log and awaits the response. Only while the wizard is open. */
async function setupInstall(p: Params): Promise<object> {
	if (!setupRequired)
		throw new ApiError("Setup has already been completed", 409);
	const role = oneOf(requireString(p, "role"), "role", registeredRoleIds());
	return runRoleInstall(role);
}

/** First-run wizard: validate all fields, write the initial state and bring the role up. */
async function setupComplete(p: Params): Promise<object> {
	if (!setupRequired)
		throw new ApiError("Setup has already been completed", 409);
	const language =
		p.language === undefined ? "en" : oneOf(p.language, "language", LANGUAGES);
	const role = oneOf(requireString(p, "role"), "role", registeredRoleIds());
	const hostname = checkHostname(requireString(p, "hostname").trim());
	const username = checkUsername(requireString(p, "username").trim());
	const password = checkPassword(requireString(p, "password"));
	if (password === undefined) throw new ApiError("password is required");
	const color = checkColor(requireString(p, "color"));
	const remoteUrl = checkRemoteUrl(
		optionalSettingString(p, "remoteUrl", undefined),
	);
	const remoteToken = optionalSettingString(p, "remoteToken", undefined);
	// Optional modules the wizard selected: id → config. Validated now (a
	// rejection here leaves the device untouched); applied after finishSetup.
	const optionalModules =
		p.optionalModules &&
		typeof p.optionalModules === "object" &&
		!Array.isArray(p.optionalModules)
			? (p.optionalModules as Record<string, unknown>)
			: {};
	for (const [id, raw] of Object.entries(optionalModules)) {
		const mod = moduleById(id);
		if (!mod || mod.kind !== "device")
			throw new ApiError(`Unknown module: ${id}`);
		const config = isPlainObject(raw) ? raw : {};
		validateModuleConfig(mod, config);
	}
	const applyModules = await setupModules(p, role);

	// Everything is valid: apply
	await applyModules();
	state.autostart = p.autostart === true;
	// The uuid is auto-assigned from the start and never changes afterwards.
	state.settings = {
		...state.settings,
		uuid: state.settings.uuid ?? randomUUID(),
		hostname,
		role,
		username,
		passwordHash: hashPassword(password),
		color,
		remoteUrl,
		remoteToken,
		language,
	};
	setCurrentLanguage(language);
	await finishSetup(role);
	await seedOptionalModules(role, optionalModules);
	if (remoteUrl) applyRemoteSettings(remoteUrl, remoteToken);
	// The wizard's install step already applied the role's host rules.
	return { completed: true, restartRequired: true };
}

/** Partial update of the persisted settings; the device uuid is immutable. */
async function updateSettings(p: Params): Promise<object> {
	const current = state.settings;
	if (p.uuid !== undefined && p.uuid !== current.uuid)
		throw new ApiError("The device uuid can't be changed");
	const hostname = checkHostname(
		optionalSettingString(p, "hostname", current.hostname),
	);
	const roleValue = optionalSettingString(p, "role", current.role);
	const role =
		roleValue === undefined
			? undefined
			: oneOf(roleValue, "role", registeredRoleIds());
	const remoteUrl = checkRemoteUrl(
		optionalSettingString(p, "remoteUrl", current.remoteUrl),
	);
	if (p.remoteToken !== undefined && typeof p.remoteToken !== "string")
		throw new ApiError("remoteToken must be a string");
	const remoteToken =
		p.remoteToken === undefined
			? current.remoteToken
			: p.remoteToken.trim() || undefined;
	const color = checkColor(optionalSettingString(p, "color", current.color));
	const language =
		p.language === undefined
			? uiLanguage()
			: oneOf(p.language, "language", LANGUAGES);
	const next: DeviceSettings = {
		...current,
		hostname,
		role,
		remoteUrl,
		remoteToken,
		color,
		language,
	};
	// Labels of the settings that moved from their saved value. A non-empty
	// list means the box must re-register with the control server (new
	// name / dot color / endpoint); an empty remote url stops the link.
	const changed = settingFields
		.filter(([key]) => current[key] !== next[key])
		.map(([, label]) => label);

	state.settings = next;
	setCurrentLanguage(language);
	await saveState();
	if (changed.length > 0) applyRemoteSettings(remoteUrl ?? "", remoteToken);
	logEvent(
		"info",
		"Settings",
		changed.length > 0
			? t("log.settings_saved_fields", { fields: changed.join(", ") })
			: t("mlog.done.settings_saved"),
	);
	return { settings: settingsView(), restartRequired: true };
}

const requireModule = (p: Params) => {
	const id = requireString(p, "id");
	const mod = moduleById(id);
	if (!mod || mod.kind !== "device")
		throw new ApiError(`Unknown module: ${id}`);
	return mod;
};

const CORE_METHODS: Record<string, Method> = {
	status: buildStatus,
	"log.list": () => ({ entries: logEntries() }),
	"log.clear": () => {
		clearLog();
		return { cleared: true };
	},
	"setup.get": async () => ({
		required: setupRequired,
		hostname: state.settings.hostname ?? "",
		color: state.settings.color ?? DEFAULT_COLOR,
		language: uiLanguage(),
		...(await moduleSetupInfo()),
		// The wizard's optional-module step: role → its selectable modules + fields.
		optionalModuleInfo: optionalModuleInfo(),
		roleDefinitions: roleDefinitions().filter(
			(role) => role.setupSelectable !== false,
		),
	}),
	"setup.install": setupInstall,
	"setup.complete": setupComplete,
	"settings.get": () => ({ settings: settingsView(), restartRequired: true }),
	"settings.update": updateSettings,
	"modules.list": () => ({ modules: safeModules() }),
	/** The web UI's Modules panel: role rows + fields + dependency preflight. */
	"modules.info": async () => ({ modules: await moduleInfos() }),
	"modules.enable": async (p) => {
		const mod = requireModule(p);
		setModuleEnabled(mod, true);
		await saveState();
		void restartModule(mod);
		return { ok: true, modules: safeModules() };
	},
	"modules.disable": async (p) => {
		const mod = requireModule(p);
		setModuleEnabled(mod, false);
		await saveState();
		void restartModule(mod);
		return { ok: true, modules: safeModules() };
	},
	"modules.configure": async (p) => {
		const mod = requireModule(p);
		const config =
			p.config && typeof p.config === "object" && !Array.isArray(p.config)
				? (p.config as Params)
				: {};
		// Validate BEFORE mutating anything: a 400 must leave the slice on
		// disk untouched.
		validateModuleConfig(mod, config);
		configureModule(mod, config);
		await saveState();
		void restartModule(mod);
		return { ok: true, modules: safeModules() };
	},
	"autostart.set": async (p) => {
		await setAutostart(requireBoolean(p, "enabled"));
		return { autostart: !!state.autostart };
	},
};

// ----------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------
/** Dispatch one request message; returns the serialized response. */
export async function handleRequest(
	raw: string | Buffer | ArrayBuffer | Uint8Array,
): Promise<string> {
	let id: unknown = null;
	let method = "";
	let logged = false;
	try {
		let msg: unknown;
		try {
			msg = JSON.parse(textOf(raw));
		} catch {
			throw new ApiError("Invalid JSON");
		}
		if (!msg || typeof msg !== "object" || Array.isArray(msg))
			throw new ApiError("Message must be a JSON object");
		const req = msg as { id?: unknown; method?: unknown; params?: unknown };
		id = req.id ?? null;
		if (typeof req.method !== "string")
			throw new ApiError("method is required");
		method = req.method;

		const core = Object.hasOwn(CORE_METHODS, method)
			? CORE_METHODS[method]
			: undefined;
		const owner = core ? undefined : methodOwner(method);
		if (!core && !owner) throw new ApiError(`Unknown method: ${method}`, 404);
		if (!methodAllowed(method))
			throw new ApiError(
				`${method} is not available on ${effectiveRole()} devices`,
				409,
			);

		const params: Params =
			req.params && typeof req.params === "object" && !Array.isArray(req.params)
				? (req.params as Params)
				: {};
		logged = isLoggedMethod(method);
		const result = core ? await core(params) : await callModule(method, params);
		if (logged) {
			const { section, done } = methodLog(method);
			logEvent("info", section, done(params));
		}
		return JSON.stringify({
			type: "response",
			id,
			method,
			ok: true,
			result,
			...(logged ? { logged } : {}),
		});
	} catch (err: unknown) {
		const code = err instanceof ApiError ? err.code : 500;
		if (code >= 500) console.error(`API error (${method || "?"}):`, err);
		if (logged) {
			const { section, action } = methodLog(method);
			logEvent(
				"error",
				section,
				t("mlog.failed", { action, reason: errorMessage(err) }),
			);
		}
		return JSON.stringify({
			type: "response",
			id,
			method,
			ok: false,
			error: errorMessage(err),
			code,
			...(logged ? { logged } : {}),
		});
	}
}
