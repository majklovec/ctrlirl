/*
 * Device-side module lifecycle: the registry's registrations driven by the
 * device process — settings slices (defaults, backfill, enable/disable),
 * start/stop/restart, RPC ownership and gating, status / settings / setup
 * contributions, and autostart. Nothing here names a module id, method
 * prefix or status key: every decision reads the registration contract
 * (shared/contracts/backend_module.ts).
 */
import type {
    BackendModule,
    ModuleSlice,
    Params,
} from "../../shared/contracts/backend_module";
import type { ModuleInfoView } from "../../shared/contracts/wire";
import { argFail } from "../../shared/args";
import { ApiError } from "../../shared/params";
import {
    ALL_MODULES,
    ROLES,
    isRegisteredRole,
    moduleById,
    roleDefinitions,
} from "../../shared/registry";
import { roleEnablesModule, roleServesModule } from "../../shared/roles";
import { deepMerge, isPlainObject } from "../../shared/util";
import type { Role } from "../../shared/validate";
import { runAutostart as runAutostartWith } from "./autostart";
import { provideCapability } from "../../shared/capabilities";
import { logEvent } from "./eventlog";
import { buildModuleCore, type ModuleCore } from "./module_core";
import { pushModuleEvent } from "./push";
import {
    completeSetup,
    saveState,
    type ModulesState,
    setupRequired,
    state,
} from "./state";

export { ALL_MODULES, moduleById };

type Module = BackendModule<ModuleCore>;

const DEVICE_MODULES = ALL_MODULES.filter(
    (m) => m.kind === "device",
) as Module[];

if (state.settings.role && !isRegisteredRole(state.settings.role))
    argFail(
        "config role",
        state.settings.role,
        roleDefinitions().map((role) => role.id).join(" | "),
    );

// ---------------------------------------------------------------------------
// Settings slices
// ---------------------------------------------------------------------------

const configKey = (mod: BackendModule): string => mod.configKey ?? mod.id;

/** The module's persisted settings slice (undefined before setup / for unknown ids). */
export const moduleSlice = (mod: BackendModule): ModuleSlice | undefined =>
    state.settings.modules?.[configKey(mod)];

export const moduleEnabled = (id: string): boolean => {
    const mod = moduleById(id);
    return mod ? moduleSlice(mod)?.enabled === true : false;
};

/** A role runs `mod` when it lists the module in its own `requires` (the role
 * owns the knowledge; the module never names a role). No role → nothing runs. */
const servesRole = (mod: BackendModule, role: Role | undefined): boolean =>
    roleServesModule(ROLES, role, mod.id);

/** The slice a fresh device gets for `mod` on `role` (no role → disabled). */
const defaultSlice = (mod: BackendModule, role: Role | undefined): ModuleSlice =>
    deepMerge(
        { enabled: roleEnablesModule(ROLES, role, mod.id) },
        mod.configDefaults,
    );

/** Default slices of every device module for `role` (the role presets). */
export const defaultModules = (role: Role): ModulesState =>
    Object.fromEntries(
        DEVICE_MODULES.map((m) => [configKey(m), defaultSlice(m, role)]),
    );

/**
 * Make sure every device module has a complete slice: missing modules get the
 * role's default, existing slices are backfilled with new default fields
 * (stored values win). Unknown stored keys are kept. With no role selected a
 * missing slice is seeded disabled.
 */
export function ensureModuleSlices(
    role: Role | undefined = effectiveRole(),
    mods: Module[] = DEVICE_MODULES,
): ModulesState {
    const stored = state.settings.modules ?? {};
    const modules: ModulesState = { ...stored };
    for (const mod of mods) {
        const key = configKey(mod);
        // A renamed module adopts the slice stored under its former key.
        if (!(key in stored))
            for (const legacy of mod.legacyConfigKeys ?? [])
                if (legacy in modules) {
                    stored[key] = modules[legacy];
                    delete modules[legacy];
                    break;
                }
        modules[key] = deepMerge(defaultSlice(mod, role), stored[key]);
    }
    state.settings.modules = modules;
    return modules;
}

/** The persisted module map for the status; secret strings come back as `{configured}`. */
export function safeModules(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, slice] of Object.entries(state.settings.modules ?? {})) {
        const secrets = new Set(moduleById(key)?.secretFields ?? []);
        out[key] = Object.fromEntries(
            Object.entries(slice).map(([k, v]) =>
                (secrets.has(k) || /password|token/i.test(k)) &&
                typeof v === "string"
                    ? [k, { configured: v !== "" }]
                    : [k, v],
            ),
        );
    }
    return out;
}

/**
 * Validate a `modules.configure` payload against the module's declared fields
 * (unknown fields and wrong types = 400, thrown before anything is written).
 * `enabled` is always accepted.
 */
export function validateModuleConfig(mod: Module, config: Params): void {
    const known = new Set([
        "enabled",
        ...(mod.configFields ?? []).map((f) => f.name),
    ]);
    for (const key of Object.keys(config))
        if (!known.has(key))
            throw new ApiError(`Unknown config field: ${key}`, 400);
    for (const field of mod.configFields ?? []) {
        const value = config[field.name];
        if (value === undefined) continue;
        const fail = (expected: string) =>
            new ApiError(
                `config ${field.name} must be ${expected} (module ${mod.id})`,
                400,
            );
        switch (field.type) {
            case "text":
            case "password":
                if (typeof value !== "string") throw fail("a string");
                break;
            case "select": {
                if (typeof value !== "string") throw fail("a string");
                if (field.options && !field.options.some(([v]) => v === value))
                    throw fail("one of " + field.options.map(([v]) => v).join(" | "));
                break;
            }
            case "number": {
                if (typeof value !== "number" || !Number.isFinite(value))
                    throw fail("a number");
                if (field.min !== undefined && value < field.min)
                    throw fail(`>= ${field.min}`);
                if (field.max !== undefined && value > field.max)
                    throw fail(`<= ${field.max}`);
                break;
            }
            case "boolean":
                if (typeof value !== "boolean") throw fail("a boolean");
                break;
        }
    }
}

/** Apply a `modules.configure` payload (the module's hook, or its declared
 * fields + `enabled` when the module declares none of its own). */
export function configureModule(mod: Module, config: Params): void {
    const slice = ensureModuleSlices()[configKey(mod)];
    if (mod.configure) {
        mod.configure(config, slice);
        return;
    }
    if (typeof config.enabled === "boolean") slice.enabled = config.enabled;
    for (const field of mod.configFields ?? []) {
        const value = config[field.name];
        if (value === undefined) continue;
        // An empty password keeps the stored secret (the UI omits it on save).
        if (
            field.type === "password" &&
            value === "" &&
            slice[field.name] !== undefined
        )
            continue;
        slice[field.name] = value;
    }
}

/**
 * Per-module info for the web UI's Modules panel: the role's required and
 * optional modules, with their editable fields (secret state masked as
 * `configured`) and the dependency preflight. A preflight that throws or
 * times out never fails the call — it reports `ok: false` (acceptance test).
 */
/** The module's editable fields as serialized for the web UI (secret state masked). */
const infoFields = (
    mod: Module,
    slice: ModuleSlice | undefined,
): ModuleInfoView["fields"] => {
    const secrets = new Set(mod.secretFields ?? []);
    return (mod.configFields ?? []).map((f) => ({
        name: f.name,
        labelKey: f.labelKey,
        type: f.type,
        placeholderKey: f.placeholderKey,
        helpKey: f.helpKey,
        options: f.options,
        min: f.min,
        max: f.max,
        step: f.step,
        secret: secrets.has(f.name),
        configured:
            f.type === "password" &&
            typeof slice?.[f.name] === "string" &&
            (slice[f.name] as string) !== "",
    }));
};

export async function moduleInfos(): Promise<ModuleInfoView[]> {
    const role = effectiveRole();
    const def = role === undefined ? undefined : ROLES.find((r) => r.id === role);
    if (def === undefined) return [];
    const build = async (mod: Module, required: boolean): Promise<ModuleInfoView> => {
        const slice = moduleSlice(mod);
        let deps: ModuleInfoView["deps"];
        if (mod.checkDependencies) {
            try {
                deps = await withTimeout(
                    Promise.resolve(mod.checkDependencies()),
                    3000,
                );
            } catch {
                deps = { ok: false, messageKey: "mods.deps_timeout" };
            }
        }
        return {
            id: mod.id,
            title: mod.title,
            titleKey: mod.titleKey,
            required,
            optional: !required,
            enabled: slice?.enabled === true,
            fields: infoFields(mod, slice),
            deps,
        };
    };
    const entries = [
        ...def.requires.modules.map((id) => moduleById(id)),
        ...(def.requires.optionalModules ?? []).map((id) => moduleById(id)),
    ].filter((m): m is Module => m !== undefined && m.kind === "device");
    return Promise.all(
        entries.map((m) => build(m, def.requires.modules.includes(m.id))),
    );
}

/**
 * Setup wizard: per role, its optional modules and their editable fields —
 * the wizard renders a checkbox + config form per selection and sends them
 * back on `setup.complete` as `optionalModules: {id: config}`.
 */
export function optionalModuleInfo(): Record<
    string,
    readonly ModuleInfoView[]
> {
    const out: Record<string, readonly ModuleInfoView[]> = {};
    for (const def of roleDefinitions()) {
        const mods = (def.requires.optionalModules ?? [])
            .map((id) => moduleById(id))
            .filter((m): m is Module => m !== undefined && m.kind === "device");
        if (mods.length > 0)
            out[def.id] = mods.map((m) => ({
                id: m.id,
                title: m.title,
                titleKey: m.titleKey,
                required: false,
                optional: true,
                enabled: false,
                fields: infoFields(m, undefined),
            }));
    }
    return out;
}

/** Reject a promise after `ms` (used to keep a module preflight from stalling the panel). */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e);
            },
        );
    });

export function setModuleEnabled(mod: Module, enabled: boolean): void {
    ensureModuleSlices()[configKey(mod)].enabled = enabled;
}

// ---------------------------------------------------------------------------
// Discovery wiring: capabilities + the core bag
// ---------------------------------------------------------------------------

const core = buildModuleCore(moduleEnabled);
/** The role that decides which modules serve the box; `undefined` while no
 * role has been selected (fresh device) — then no module runs at all. */
export const effectiveRole = (): Role | undefined => core.role();

for (const mod of ALL_MODULES)
    for (const [name, impl] of Object.entries(mod.services?.capabilities ?? {}))
        provideCapability(name, impl);

/**
 * Bind the process bag into every device module. Runs at discovery, before
 * start: a module's lazy objects must work — reporting "stopped" — even when
 * its start never runs. Tests that bind a stub bag into a module call it
 * again to restore the real one (the test suite shares one process).
 */
export function bindModules(): void {
    for (const mod of DEVICE_MODULES) mod.bind?.(core);
}
bindModules();

// A configured device gets its slices completed at load (new modules / fields).
if (!setupRequired) ensureModuleSlices();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const startCtx = (mod: Module) => ({
    config: { ...(moduleSlice(mod) ?? {}) },
    core,
    emit: (
        event: string,
        data: unknown,
        opts?: Parameters<typeof pushModuleEvent>[3],
    ) => pushModuleEvent(event, data, mod.id, opts),
    log: (section: string, message: string) =>
        logEvent("info", section, message),
});

const shouldRun = (mod: Module): boolean =>
    servesRole(mod, effectiveRole()) && moduleSlice(mod)?.enabled === true;

/** Start every settings-enabled module that serves the current role, in dependency order.
 * `mods` is a test seam; the process starts with the full registry. A device
 * with no role selected (fresh install, wizard not finished) starts nothing —
 * the web UI stays up so a role can be picked first. */
export async function startModules(mods: Module[] = DEVICE_MODULES): Promise<void> {
    const role = effectiveRole();
    if (role === undefined) return;
    // A device without stored slices has no slices yet; seed the role's
    // defaults so its default-enabled modules (speedtest, ...) start and can
    // emit events. The in-memory slices are persisted on the first save.
    if (!state.settings.modules) ensureModuleSlices(role, mods);
    for (const mod of mods)
        if (shouldRun(mod)) {
            started.add(mod);
            await mod.start(startCtx(mod));
        }
}

/** Stop every module (unstarted ones are no-ops by contract). */
export async function stopModules(): Promise<void> {
    for (const mod of [...DEVICE_MODULES].reverse()) await mod.stop();
}

/** Restart one module (stop, then start when it should run). */
export async function restartModule(mod: Module): Promise<void> {
    started.delete(mod);
    await mod.stop();
    if (shouldRun(mod)) {
        started.add(mod);
        await mod.start(startCtx(mod));
    }
}

/** Modules whose contributions apply to the current role (enabled or not). */
const applicable = (): Module[] =>
    DEVICE_MODULES.filter((m) => servesRole(m, effectiveRole()));

/** Every applicable module's status fragment, deep-merged (keys never collide by design). */
export async function moduleStatuses(): Promise<Record<string, unknown>> {
    let out: Record<string, unknown> = {};
    for (const mod of applicable())
        if (mod.status) out = deepMerge(out, await mod.status());
    return out;
}

export const moduleSettings = (): Record<string, unknown> =>
    Object.assign({}, ...applicable().map((m) => m.settings?.() ?? {}));

/** Setup wizard data: merge the setup info of every module that provides it.
 * Not filtered by the process role — the wizard lets the user pick any role,
 * so any process must still return the encoder's pipelines & audio sources
 * when the user selects the encoder role. */
export async function moduleSetupInfo(): Promise<Record<string, unknown>> {
    let out: Record<string, unknown> = {};
    for (const mod of DEVICE_MODULES)
        if (mod.setupInfo) out = deepMerge(out, await mod.setupInfo());
    return out;
}

/**
 * Setup wizard: let every module serving `role` validate its answers, then
 * apply them all (nothing is applied while any module may still reject).
 */
export async function setupModules(
    params: Params,
    role: Role,
): Promise<() => Promise<void>> {
    const applies: (() => void | Promise<void>)[] = [];
    for (const mod of DEVICE_MODULES) {
        if (!roleEnablesModule(ROLES, role, mod.id) || !mod.setup) continue;
        const apply = await mod.setup(params, role);
        if (apply) applies.push(apply);
    }
    return async () => {
        for (const apply of applies) await apply();
    };
}

/** Seed the module slices for the role picked in the wizard and leave setup. */
export async function finishSetup(role: Role): Promise<void> {
    ensureModuleSlices(role);
    await completeSetup();
}

/**
 * Seed the role's optional modules (the wizard's selection): each listed
 * module gets its validated config and `enabled` (absent = selected = `true`).
 * Run after `finishSetup`, which persists the role's own slices.
 */
export async function seedOptionalModules(
    role: Role,
    optional: Record<string, unknown>,
): Promise<void> {
    const def = ROLES.find((r) => r.id === role);
    const allowed = new Set(def?.requires.optionalModules ?? []);
    for (const [id, raw] of Object.entries(optional)) {
        const mod = moduleById(id);
        if (!mod || mod.kind !== "device" || !allowed.has(id))
            throw new ApiError(`Optional module not on role: ${id}`, 400);
        const config = isPlainObject(raw) ? raw : {};
        validateModuleConfig(mod, config);
        configureModule(mod, {
            ...config,
            enabled: config.enabled === undefined ? true : config.enabled,
        });
    }
    await saveState();
}

// ---------------------------------------------------------------------------
// RPC ownership and gating
// ---------------------------------------------------------------------------

const METHOD_OWNER = new Map<string, Module>();
for (const mod of DEVICE_MODULES)
    for (const method of mod.methods) METHOD_OWNER.set(method, mod);

export const methodOwner = (method: string): Module | undefined =>
    METHOD_OWNER.get(method);

/** Whether a module method may run now (role + enabled gates from the registration). */
export function methodAllowed(method: string): boolean {
    const mod = METHOD_OWNER.get(method);
    if (!mod) return true;
    if (!servesRole(mod, effectiveRole())) return false;
    if (mod.requireEnabled && moduleSlice(mod)?.enabled !== true) return false;
    return true;
}

const started = new Set<Module>();

/** Whether the module's `start` has run (its `emit` is wired). */
export const moduleStarted = (mod: Module): boolean => started.has(mod);

/** Dispatch an RPC method to the module that owns it. */
export async function callModule(
    method: string,
    params: Params,
): Promise<unknown> {
    const mod = METHOD_OWNER.get(method);
    if (!mod) throw new Error(`unknown method ${method}`);
    if (!started.has(mod) && shouldRun(mod)) {
        // Late start: the slice may only exist now (setup just completed, no
        // config file at boot). Without this the module would work — but its
        // events would be dropped because start never captured its emit.
        started.add(mod);
        await mod.start(startCtx(mod));
    }
    return mod.dispatch(method, params);
}

/** Autostart: resume every running module's last run (see autostart.ts). */
export const runAutostart = (): void =>
    runAutostartWith(async () => {
        let resumed = false;
        for (const mod of DEVICE_MODULES)
            if (moduleStarted(mod) && mod.resume && (await mod.resume()))
                resumed = true;
        return resumed;
    });
