/*
 * Persistent storage (two files):
 *   config.json      permanent parameters only — the core device settings
 *                     (identity, role, control link, language, per-module
 *                     settings slices). Stable key order, 2-space indent.
 *   state.json       the mutable per-module data sections, kept verbatim under
 *                     `state.data`. Separate file so high-churn module data
 *                     never rewrites the small, long-lived config file.
 *   in memory        live process state (running flags, pids, counters) is
 *                     module-owned and never written to disk.
 *
 * Modules mutate their `state.data.<section>` objects and their settings slice,
 * then call `saveState()`, which persists the permanent part to config.json and
 * the data sections to state.json. The core knows no section by name.
 *
 * Legacy: older config files stored the data sections as top-level keys. On load
 * a device with a config but no state file adopts those keys as its data, and the
 * next save moves them into state.json (they drop out of config.json).
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModuleSlice } from "../../shared/contracts/backend_module";
import {
	asLanguage,
	DEFAULT_LANGUAGE,
	type Language,
	setCurrentLanguage,
} from "../../shared/i18n";
import { stableStringify } from "../../shared/util";
import { DEFAULT_COLOR, type Role } from "../../shared/validate";
import {
	CONFIG_EXISTS,
	CONFIG_FILE,
	DRY_RUN,
	INITIAL_CONFIG,
	INITIAL_STATE,
	STATE_EXISTS,
	STATE_FILE,
} from "./config";
import { writeFileAtomic } from "./files";

/** Per-module persisted settings, keyed by the module's `configKey` (default: id). */
export type ModulesState = Record<string, ModuleSlice>;

/** Device settings that can be changed from the control UI and used on restart. */
export interface DeviceSettings {
	/** Stable identity; the device registers with the control server under this uuid */
	uuid?: string;
	hostname?: string;
	role?: Role;
	remoteUrl?: string;
	remoteToken?: string;
	color?: string;
	/** UI language (see LANGUAGE_INFO in i18n.ts); defaults to "en". */
	language?: Language;
	/** Web-login credentials registered in the setup wizard (scrypt hash). */
	username?: string;
	passwordHash?: string;
	modules?: ModulesState;
}

/** The core's own keys in the config file; everything else is a module section. */
const CORE_KEYS = [
	"autostart",
	"color",
	"hostname",
	"language",
	"modules",
	"passwordHash",
	"remoteToken",
	"remoteUrl",
	"role",
	"username",
	"uuid",
] as const;

/** Permanent device parameters persisted to the config file (core keys only). */
export interface DeviceConfig {
	autostart: boolean;
	color: string;
	hostname: string;
	language: Language;
	remoteUrl: string;
	/** Omitted while no role has been selected (the device runs no modules). */
	role?: Role;
	uuid: string;
	remoteToken?: string;
	username?: string;
	passwordHash?: string;
	modules?: ModulesState;
}

/** Merged in-memory view of the persisted config. */
export interface PersistentState {
	settings: DeviceSettings;
	/** Resume the last run when the service starts (modules implement `resume`). */
	autostart: boolean;
	/** Module-owned config sections (`data.<section>`), persisted verbatim. */
	data: Record<string, unknown>;
}

// A fresh device (no config file) shows the setup wizard first.
export let setupRequired = !CONFIG_EXISTS;

// ----------------------------------------------------------------------
// Projection between the merged in-memory state and the config file
// ----------------------------------------------------------------------

function projectConfig(s: PersistentState): DeviceConfig {
	const { settings } = s;
	const cfg: DeviceConfig = {
		autostart: !!s.autostart,
		color: settings.color ?? DEFAULT_COLOR,
		hostname: settings.hostname ?? "",
		language: asLanguage(settings.language),
		remoteUrl: settings.remoteUrl ?? "",
		uuid: settings.uuid ?? "",
	};
	if (settings.role) cfg.role = settings.role;
	if (settings.remoteToken) cfg.remoteToken = settings.remoteToken;
	if (settings.username) cfg.username = settings.username;
	if (settings.passwordHash) cfg.passwordHash = settings.passwordHash;
	if (settings.modules) cfg.modules = settings.modules;
	return cfg;
}

/**
 * Build the in-memory state from a config object (the core device settings)
 * and a data object (the module data sections — from the state file, or from
 * legacy top-level config keys). Core keys are never treated as data.
 */
export function fromConfig(
	cfg: Record<string, unknown> | null,
	dataIn?: Record<string, unknown> | null,
): PersistentState {
	const c = cfg ?? {};
	const data: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(dataIn ?? {}))
		if (!(CORE_KEYS as readonly string[]).includes(key)) data[key] = value;
	return {
		settings: {
			uuid: c.uuid as string | undefined,
			hostname: (c.hostname as string | undefined) ?? "",
			role: c.role as Role | undefined,
			remoteUrl: (c.remoteUrl as string | undefined) ?? "",
			remoteToken: c.remoteToken as string | undefined,
			color: c.color as string | undefined,
			language: c.language as Language | undefined,
			username: c.username as string | undefined,
			passwordHash: c.passwordHash as string | undefined,
			modules: c.modules as ModulesState | undefined,
		},
		autostart: c.autostart === true,
		data,
	};
}

// ----------------------------------------------------------------------
// Change notification and save
// ----------------------------------------------------------------------
type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/** Subscribe to state / uplink changes; returns an unsubscribe function. */
export function onStateChange(listener: ChangeListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function notifyStateChange(): void {
	for (const listener of listeners) listener();
}

let lastConfig = "";
let lastState = "";
/** Newest config/state awaiting persist, plus the single in-flight writer it drains. */
let pendingConfig: string | null = null;
let pendingState: string | null = null;
let draining: Promise<void> | null = null;

/**
 * Persist the permanent parameters to config.json and the module data sections
 * to state.json; no-op for a file that has not changed. Saves coalesce onto one
 * in-flight writer: rapid successive changes only ever have a single
 * `writeFileAtomic` outstanding per file, so a crash can orphan at most one
 * `.tmp` (which `removeStaleTmps` clears on the next boot) instead of a burst.
 *
 * Pass `force` to write both files even when unchanged — used for the one-time
 * legacy migration, where the on-disk config file still carries the data keys
 * while the in-memory canonical form already matches the detectors.
 */
export async function saveState(force = false): Promise<void> {
	notifyStateChange();
	if (DRY_RUN) return;
	const config = stableStringify(projectConfig(state));
	const data = stableStringify(state.data);
	if (!force && config === lastConfig && data === lastState) return;
	lastConfig = config;
	lastState = data;
	pendingConfig = config;
	pendingState = data;
	if (!draining) draining = drain();
	return draining;
}

async function drain(): Promise<void> {
	try {
		while (pendingConfig !== null || pendingState !== null) {
			// Preserve legacy config data if creating or writing the state file fails.
			if (pendingState !== null) {
				const toWrite = pendingState;
				pendingState = null;
				await mkdir(dirname(STATE_FILE), { recursive: true });
				await writeFileAtomic(STATE_FILE, toWrite);
			}
			if (pendingConfig !== null) {
				const toWrite = pendingConfig;
				pendingConfig = null;
				await writeFileAtomic(CONFIG_FILE, toWrite);
			}
		}
	} catch (error) {
		pendingConfig = null;
		pendingState = null;
		lastConfig = "";
		lastState = "";
		throw error;
	} finally {
		draining = null;
	}
}

/** Leave the setup wizard; the caller has seeded the module slices. */
export async function completeSetup(): Promise<void> {
	setupRequired = false;
	await saveState();
}

/**
 * Shared mutable state. The data sections load from the state file when present;
 * a device that predates the split (config file, no state file) adopts the
 * legacy top-level data keys from the config file — the next save moves them
 * into state.json and they drop out of config.json.
 */
export const state: PersistentState =
	CONFIG_EXISTS || STATE_EXISTS
		? fromConfig(
				INITIAL_CONFIG,
				STATE_EXISTS ? INITIAL_STATE : INITIAL_CONFIG,
			)
		: { settings: {}, autostart: false, data: {} };

// Seed the change detectors with the canonical form of the loaded files so the
// first saveState() of a process writes only when a value actually differs —
// an untouched file is never rewritten (no spurious reformat/mtime churn).
lastConfig = stableStringify(projectConfig(state));
lastState = stableStringify(state.data);

// Hostnames change; the uuid is the device's permanent identity on the control server.
// It is auto-assigned here (backfilled into older config files) and never changes.
// Older config files have no language either; normalize so it is always present.
// A fresh device keeps both in memory only, so the setup wizard still runs.
{
	const existsBefore = CONFIG_EXISTS || STATE_EXISTS;
	// One-time migration: a config file that predates the split stores its data
	// sections as top-level keys. Force an initial save so they move into
	// state.json and drop out of config.json (a no-op under --dry-run).
	const migrateLegacy = existsBefore && CONFIG_EXISTS && !STATE_EXISTS;
	const backfill =
		existsBefore &&
		(!state.settings.uuid || state.settings.language === undefined);
	state.settings.uuid ||= randomUUID();
	state.settings.language ??= DEFAULT_LANGUAGE;
	if (migrateLegacy || backfill) await saveState(migrateLegacy);
}

// Seed the process-wide current language so t()/label() self-resolve to the
// device's saved UI language from the first log entry onward.
setCurrentLanguage(state.settings.language);

/** UI language as persisted in settings (defaults to "en"). */
export const uiLanguage = (): Language => asLanguage(state.settings.language);
