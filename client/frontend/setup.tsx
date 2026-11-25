/* First-run setup wizard — shared language, identity and control steps plus
 * setup contributions registered by the device modules. */

import {
	Actions,
	Break,
	Button,
	Checkbox,
	CheckField,
	ConnectionBadge,
	DynamicForm,
	Field,
	Form,
	Input,
	Page,
	Select,
} from "@ui/components/";
import { languageOptions, setLanguage, t } from "@ui/i18n";
import { roleIcon, setupStepsForRole } from "@ui/module_registry";
import { RpcClient, socketUrl } from "@ui/services/rpc";
import { HOSTNAME_PATTERN, mountPage, setHeaderColor } from "@ui/util";
import m from "mithril";
import roleDiagrams from "../../generated/role_diagrams";
import type { ModuleSetupStep } from "../../shared/contracts/frontend_module";
import type {
	Role,
	SetupInfo,
	ModuleInfoView,
} from "../../shared/contracts/wire";
import type { LogEntry, LogEvent } from "../../shared/log_messages";
import { attemptedSteps } from "../../shared/setup_progress";
import { errorMessage } from "../../shared/util";
import { schemaFor } from "./module_panel";
import {
	DEFAULT_COLOR,
	HOSTNAME_RE,
	PASSWORD_MIN,
	USERNAME_RE,
} from "../../shared/validate";

interface WizardStep {
	id: string;
	title: string;
	subtitle: string;
	/** null when the step is complete; otherwise what is still missing. */
	problem(): string | null;
	render(): m.Children;
}

interface CoreStep {
	id:
		| "language"
		| "access"
		| "role"
		| "install"
		| "identity"
		| "control"
		| "finish";
	title: string;
	subtitle: string;
}

const CORE_STEPS: CoreStep[] = [
	{
		id: "language",
		title: "ui.language_label",
		subtitle: "setup.step.language_sub",
	},
	{
		id: "access",
		title: "setup.step.access",
		subtitle: "setup.step.access_sub",
	},
	{ id: "role", title: "set.role", subtitle: "setup.step.role_sub" },
	{
		id: "install",
		title: "setup.step.install",
		subtitle: "setup.step.install_sub",
	},
	{
		id: "identity",
		title: "setup.step.identity",
		subtitle: "setup.step.identity_sub",
	},
	{
		id: "control",
		title: "setup.step.control",
		subtitle: "setup.step.control_sub",
	},
];
const FINISH_STEP: CoreStep = {
	id: "finish",
	title: "setup.step.review",
	subtitle: "setup.save",
};

/** The install step can take minutes (module package downloads). */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

const state = {
	connected: false,
	loaded: false,
	current: 0,
	message: "",
	saving: false,
	info: null as SetupInfo | null,
	/** The install step: the role's rules applied on this host. */
	install: {
		role: undefined as Role | undefined,
		status: "idle" as "idle" | "running" | "done" | "failed",
		// Date.now() when the install started — the log only collects
		// entries from this moment on (the wizard survives restarts and
		// the log keeps pushing).
		at: null as number | null,
	},
	installLog: [] as LogEntry[],
};

const f = {
	language: "en",
	role: undefined as Role | undefined,
	hostname: "",
	color: DEFAULT_COLOR,
	username: "",
	password: "",
	passwordRepeat: "",
	remoteUrl: "",
	remoteToken: "",
	autostart: false,
	/** Optional-module selection in the role step: per-module selection + config. */
	optSel: {} as Record<string, { enabled: boolean; config: Record<string, unknown> }>,
};

// The per-role architecture diagram each module ships (role_<role>.svg),
// keyed by role id via the generated manifest; the wizard shows it in the
// role card of the role it illustrates.
const ROLE_DIAGRAMS = roleDiagrams;

const stepFrame = (
	id: string,
	heading: string,
	subtitle: string,
	opts: { required?: boolean } = {},
	...children: m.Children[]
) => (
	<fieldset
		class={opts.required ? "wizard-step wiz-required" : "wizard-step"}
		data-step={id}
	>
		<h2 class="wiz-heading">
			{heading}
			{opts.required ? <b class="wiz-req"> *</b> : null}
		</h2>
		<p class="wiz-desc">{subtitle}</p>
		{children}
	</fieldset>
);

const roleCard = (
	value: Role,
	name: string,
	tagline?: string,
	invalid?: boolean,
): m.Vnode => (
	// No `key`: the cards are stable-order and siblings of stepFrame's
	// unkeyed <h2>/<p>, so a keyed child here would form a mixed-keys
	// fragment and crash Mithril's render (see `optionalModuleSelect`).
	<label class={`role-card${invalid ? " invalid" : ""}`}>
		<input
			type="radio"
			name="role"
			value={value}
			required={true}
			checked={f.role === value}
			onchange={() => {
				f.role = value;
				// Picking a role reveals its optional modules below the cards.
				m.redraw();
			}}
		/>
		{roleIcon(value) ?? null}
		<span class="role-name">{name}</span>
		{tagline ? <span class="role-tagline">{tagline}</span> : null}
		{ROLE_DIAGRAMS[value] ? (
			<img src={ROLE_DIAGRAMS[value]} alt={name} loading="lazy" />
		) : null}
	</label>
);

function moduleStep(step: ModuleSetupStep, role: Role): WizardStep {
	return {
		id: step.id,
		title: step.title,
		subtitle: step.subtitle,
		problem: () => (step.isValid(role) ? null : t("setup.step_invalid")),
		render: () => {
			const info = state.info;
			if (!info) throw new Error("Setup data is not available");
			return stepFrame(
				step.id,
				t(step.title),
				t(step.subtitle),
				{ required: true },
				step.render(role, info),
			);
		},
	};
}

function coreStep(step: CoreStep): WizardStep {
	return {
		...step,
		problem: () => {
			switch (step.id) {
				case "role":
					return f.role ? null : t("setup.err_role");
				case "install":
					// Blocked while the install runs; a failed install shows
					// its error in the log and may be retried.
					return state.install.status === "running"
						? t("setup.install_wait")
						: null;
				case "access":
					if (!USERNAME_RE.test(f.username)) return t("setup.err_username");
					if (f.password.length < PASSWORD_MIN) {
						return t("setup.err_password_short", {
							min: String(PASSWORD_MIN),
						});
					}
					if (f.password !== f.passwordRepeat)
						return t("setup.err_password_match");
					return null;
				case "identity":
					return HOSTNAME_RE.test(f.hostname)
						? null
						: t("setup.hostname_title");
				default:
					return null;
			}
		},
		render: () => {
			switch (step.id) {
				case "language":
					return stepFrame(
						step.id,
						t("ui.language_label"),
						t("setup.language_desc"),
						{},
						<Field
							label={t("ui.language_label")}
							control={
								<Select
									target={f}
									prop="language"
									onChange={(v) => setLanguage(v)}
								>
									{languageOptions()}
								</Select>
							}
						/>,
					);
				case "role": {
					const roleInvalid = attemptedSteps.has("role") && !f.role;
					return stepFrame(
						step.id,
						t("set.role"),
						t("setup.step.role_sub"),
						{ required: true },
						...(state.info?.roleDefinitions ?? []).map((definition) =>
							roleCard(
								definition.id,
								t(definition.titleKey),
								definition.taglineKey ? t(definition.taglineKey) : undefined,
								roleInvalid,
							),
						),
						optionalModuleSelect(),
					);
				}
				case "identity": {
					const identityInvalid =
						attemptedSteps.has("identity") && !HOSTNAME_RE.test(f.hostname);
					return stepFrame(
						step.id,
						t("setup.identity"),
						t("setup.identity_desc"),
						{ required: true },
						<Field
							label={t("setup.hostname")}
							required={true}
							invalid={identityInvalid}
							control={
								<Input
									target={f}
									prop="hostname"
									required={true}
									pattern={HOSTNAME_PATTERN}
									title={t("setup.hostname_title")}
								/>
							}
						/>,
						<Field
							label={t("set.color")}
							control={
								<Input
									target={f}
									prop="color"
									type="color"
									onChange={(v) => setHeaderColor(v)}
								/>
							}
						/>,
					);
				}
				case "access": {
					const attempted = attemptedSteps.has("access");
					const usernameInvalid = attempted && !USERNAME_RE.test(f.username);
					const passwordInvalid = attempted && f.password.length < PASSWORD_MIN;
					const repeatInvalid = attempted && f.password !== f.passwordRepeat;
					return stepFrame(
						step.id,
						t("setup.step.access"),
						t("setup.step.access_sub"),
						{ required: true },
						<Field
							label={t("setup.username_title")}
							required={true}
							invalid={usernameInvalid}
							control={
								<Input
									target={f}
									prop="username"
									required={true}
									autocomplete="username"
								/>
							}
						/>,
						<Field
							label={t("setup.password_title")}
							required={true}
							invalid={passwordInvalid}
							control={
								<Input
									target={f}
									prop="password"
									type="password"
									required={true}
									autocomplete="new-password"
								/>
							}
						/>,
						<Field
							label={t("setup.password_repeat")}
							required={true}
							invalid={repeatInvalid}
							control={
								<Input
									target={f}
									prop="passwordRepeat"
									type="password"
									required={true}
									autocomplete="new-password"
								/>
							}
						/>,
					);
				}
				case "control":
					return stepFrame(
						step.id,
						t("setup.step.control"),
						t("setup.control_desc"),
						{},
						<Field
							label={t("set.remote_url")}
							control={
								<Input
									target={f}
									prop="remoteUrl"
									placeholder="wss://control.example/device"
								/>
							}
						/>,
						<Field
							label={t("setup.control_token")}
							control={
								<Input
									target={f}
									prop="remoteToken"
									type="password"
									autocomplete="off"
								/>
							}
						/>,
					);
				case "install":
					return stepFrame(
						step.id,
						t("setup.step.install"),
						t("setup.step.install_sub"),
						{},
						<div class="install-log">
							<span class="install-log-title">
								{t("setup.install_log")}
							</span>
							<code class="install-log-entries">
								{state.installLog.length
									? state.installLog.map((entry) => (
										  <li
											key={entry.id}
											class={`install-log-${entry.level}`}
									  >
											{entry.message}
											{(entry.count ?? 1) > 1
												? ` ×${entry.count}`
												: null}
									  </li>
									  ))
									: t("setup.install_wait")}
							</code>
						</div>,
					);
				case "finish":
					return stepFrame(
						step.id,
						t("setup.step.review"),
						t("setup.review_desc"),
						{},
						<CheckField
							label={t("setup.autostart")}
							control={<Checkbox target={f} prop="autostart" />}
						/>,
					);
			}
		},
	};
}

/** The role's optional modules (from `setup.get`), empty when the role has none
 * — then the inline selection renders nothing. */
const optionalInfos = (): readonly ModuleInfoView[] =>
	f.role ? state.info?.optionalModuleInfo?.[f.role] ?? [] : [];

/** The role's optional-module selection, shown inline below the role cards:
 * a checkbox per optional module, with a schema-driven config form revealed
 * for each selection. Empty (nothing rendered) when the selected role declares
 * no optional modules. */
function optionalModuleSelect(): m.Vnode | null {
	const infos = optionalInfos();
	if (infos.length === 0) return null;
	// No `key` on the wrapper: it is a sibling of stepFrame's unkeyed
	// <h2>/<p> and the unkeyed role cards, so a keyed wrapper would form a
	// mixed-keys fragment and crash Mithril's render. The lead <p> must stay
	// unkeyed too — a nested array counts as an *unkeyed* child, so a keyed
	// <p> alongside the keyed `.map()` of module divs would be mixed.
	return (
		<div class="wiz-opt-block">
			<p class="wiz-opt-lead">{t("setup.step.optional_modules_sub")}</p>
			{infos.map((info) => {
				const sel = f.optSel[info.id];
				const enabled = sel?.enabled ?? false;
				return (
					<div class="wiz-opt" key={info.id}>
						<label class="wiz-opt-head">
							<input
								type="checkbox"
								checked={enabled}
								onchange={(e: Event) => {
									const on = (e.target as HTMLInputElement).checked;
									f.optSel[info.id] =
										f.optSel[info.id] ?? { enabled: false, config: {} };
									f.optSel[info.id].enabled = on;
									m.redraw();
								}}
							/>
							<span>{info.titleKey ? t(info.titleKey) : info.title}</span>
						</label>
						{enabled ? (
							<DynamicForm
								schema={schemaFor(info)}
								value={sel?.config ?? {}}
								onChange={(next) => {
									f.optSel[info.id] = { enabled: true, config: next };
									m.redraw();
								}}
							/>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function visibleSteps(): WizardStep[] {
	const role = f.role;
	const modules = role
		? setupStepsForRole(role).map((s) => moduleStep(s, role))
		: [];
	return [
		...CORE_STEPS.map(coreStep),
		...modules,
		coreStep(FINISH_STEP),
	];
}

const currentIndex = () => Math.min(state.current, visibleSteps().length - 1);

function goNext(): void {
	const steps = visibleSteps();
	const current = currentIndex();
	const problem = steps[current]?.problem() ?? null;
	if (problem) {
		// Stay on the step, highlight its failed fields red and say exactly
		// what is missing.
		attemptedSteps.add(steps[current].id);
		state.message = problem;
		return;
	}
	state.message = "";
	state.current = Math.min(current + 1, steps.length - 1);
	// Arriving at the install step kicks off the role's install.
	if (steps[state.current]?.id === "install") ensureInstallStarted();
}

function goPrev(): void {
	state.current = Math.max(currentIndex() - 1, 0);
}

const rpc = new RpcClient(() => socketUrl("ws"));
rpc.on("open", async () => {
	state.connected = true;
	m.redraw();
	try {
		const info = await rpc.call<SetupInfo>("setup.get");
		if (!info.required) {
			location.replace("./");
			return;
		}
		state.info = info;
		Object.assign(f, {
			hostname: info.hostname,
			color: info.color,
			language: info.language,
		});
		setLanguage(info.language);
		setHeaderColor(info.color);
		state.loaded = true;
	} catch (error: unknown) {
		state.message = errorMessage(error);
	}
	m.redraw();
});
rpc.on("close", () => {
	state.connected = false;
	m.redraw();
});
// The install step streams its progress as `log` events (section
// "Install"); collect them from the moment the install started.
rpc.on("log", (data?: unknown) => {
	const startedAt = state.install.at;
	if (startedAt === null) return;
	for (const entry of (data as LogEvent | undefined)?.entries ?? []) {
		if (entry.section !== "Install" || entry.at < startedAt) continue;
		const at = state.installLog.findIndex((e) => e.id === entry.id);
		if (at === -1) state.installLog.push(entry);
		else state.installLog[at] = entry;
	}
	m.redraw();
});

/**
 * Apply the role's host rules now — the RPC resolves when the install
 * finishes (it can take minutes). Progress arrives as `log` events and is
 * shown by the step while it runs.
 */
async function startInstall(role: Role): Promise<void> {
	state.install = { role, status: "running", at: Date.now() };
	state.installLog = [];
	state.message = "";
	m.redraw();
	try {
		const res = (await rpc.call(
			"setup.install",
			{ role },
			INSTALL_TIMEOUT_MS,
		)) as {
			installed: boolean;
			missing: string[];
			skipped?: "skip" | "not-root";
		};
		// No modules to install is a clean no-op, not a failure.
		state.install.status =
			res.missing.length === 0 || res.skipped !== undefined
				? "done"
				: res.installed
					? "done"
					: "failed";
	} catch (error: unknown) {
		console.error("setup.install failed", error);
		state.install.status = "failed";
		state.message = errorMessage(error);
	}
	m.redraw();
}

/** Entering the step: start the install for the picked role — a rerun for
 * the role if the previous attempt failed or targeted a different role. */
function ensureInstallStarted(): void {
	if (!f.role) return;
	if (state.install.role === f.role && state.install.status !== "idle")
		return;
	void startInstall(f.role);
}

async function complete(): Promise<void> {
	const role = f.role;
	if (!role) {
		state.message = t("setup.step.role_sub");
		return;
	}
	state.saving = true;
	state.message = "";
	const payload: Record<string, unknown> = {
		language: f.language,
		role,
		hostname: f.hostname,
		color: f.color,
		username: f.username,
		password: f.password,
		remoteUrl: f.remoteUrl,
		remoteToken: f.remoteToken,
		autostart: f.autostart,
	};
	for (const setupStep of setupStepsForRole(role))
		Object.assign(payload, setupStep.config(role));
	// Optional modules: only the selected role's modules that the operator
	// enabled, each with its config (an unselected module is omitted and stays
	// default-off). Scoped to the role so a stale selection from a previously
	// viewed role can't leak into the payload.
	const allowed = new Set(optionalInfos().map((info) => info.id));
	const optionalModules: Record<string, unknown> = {};
	for (const [id, sel] of Object.entries(f.optSel))
		if (allowed.has(id) && sel.enabled) optionalModules[id] = sel.config;
	Object.assign(payload, { optionalModules });
	try {
		await rpc.call("setup.complete", payload);
		state.message = `${t("setup.saved")} ${t("set.restart_required")}`;
		rpc.reconnect();
	} catch (error: unknown) {
		state.message = errorMessage(error);
	} finally {
		state.saving = false;
		m.redraw();
	}
}

function wizard(): m.Children {
	const steps = visibleSteps();
	const current = currentIndex();
	const last = current === steps.length - 1;
	const stage = (i: number) =>
		i < current ? "done" : i === current ? "current" : "upcoming";
	return [
		<ol class="wizard-stepper">
			{steps.map((s, i) => (
				<li key={s.id} class={`wiz-item ${stage(i)}`} data-step={s.id}>
					<span class="wiz-dot">{i < current ? "✓" : String(i + 1)}</span>
					<span class="wiz-title">{t(s.title)}</span>
					<span class="wiz-sub">{t(s.subtitle)}</span>
				</li>
			))}
		</ol>,
		<Form id="setup-form" onSubmit={() => void complete()}>
			{steps[current].render()}
			<Break />
			<Actions>
				<Button
					label={t("ui.back")}
					class="secondary"
					hidden={current === 0}
					onclick={goPrev}
				/>
				<Button
					label={t("ui.next")}
					hidden={last}
					disabled={
						steps[current].id === "install" &&
						state.install.status === "running"
					}
					onclick={goNext}
				/>
				<Button
					label={t("setup.save")}
					type="submit"
					hidden={!last}
					disabled={state.saving}
				/>
			</Actions>
		</Form>,
		<p class="muted" role="status">
			{state.message}
		</p>,
	];
}

const App: m.Component = {
	view: () => (
		<Page
			title={t("setup.title")}
			headerRight={<ConnectionBadge connected={state.connected} />}
		>
			<section class="card">
				{state.loaded ? wizard() : <p class="muted">{t("setup.loading")}</p>}
			</section>
		</Page>
	),
};

void mountPage(() => t("setup.title"), App);
