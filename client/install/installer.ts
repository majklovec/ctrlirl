/*
 * The install orchestrator: drives the providers in the fixed per-module order
 * (handoff §11), persists state after every module, and rolls back a module
 * (reverse of the steps already applied) when one fails. No host mutation
 * happens here — everything real is delegated to the injected `providers`.
 */
import type {
    InstallPlan,
    InstallState,
    ModuleInstallState,
} from "../../shared/install/types";
import type { RoleDefinition } from "../../shared/contracts/roles";
import type { BoardId } from "../../shared/install/board";
import { buildPlan } from "./plan";
import { emptyModuleState, loadState, saveState, stateFile, stateRoot } from "./state";
import { reverseOrder } from "./ordering";
import type {
    InstallProvider,
    ModuleCtx,
    ProviderOpts,
    StepKey,
} from "./provider";

const INSTALL_STEPS: readonly StepKey[] = [
    "packagesCheck",
    "overlayInstall",
    "udevInstall",
    "sysctlInstall",
    "firewallInstall",
    "systemdInstall",
    "overlayReload",
    "hooksInstall",
];
const UNINSTALL_STEPS: readonly StepKey[] = [
    "hooksUninstall",
    "systemdUninstall",
    "firewallUninstall",
    "sysctlUninstall",
    "udevUninstall",
    "overlayUninstall",
    "packagesPurge",
];
/** The reverse of an install step (for rollback). `null` = nothing to undo. */
const REVERSE: Record<StepKey, StepKey | null> = {
    packagesCheck: "packagesPurge",
    overlayInstall: "overlayUninstall",
    udevInstall: "udevUninstall",
    sysctlInstall: "sysctlUninstall",
    firewallInstall: "firewallUninstall",
    systemdInstall: "systemdUninstall",
    overlayReload: null,
    hooksInstall: "hooksUninstall",
    hooksUninstall: null,
    systemdUninstall: null,
    firewallUninstall: null,
    sysctlUninstall: null,
    udevUninstall: null,
    overlayUninstall: null,
    packagesPurge: null,
};

export interface InstallOpts {
    providers: InstallProvider[];
    cfg: Record<string, unknown>;
    installDeps?: boolean;
    purge?: boolean;
    root?: string;
    /** Module directory (defaults to the repo's `client/modules`). */
    moduleRoot?: string;
    /**
     * Board the role is installed on (defaults to auto-detection). Lets the
     * plan apply `install/boards/<board>.json` deltas and record the board in
     * state.
     */
    boardId?: BoardId;
}

export interface ModuleResult {
    name: string;
    ok: boolean;
    lines: string[];
}
export interface InstallResult {
    ok: boolean;
    role: string;
    results: ModuleResult[];
    failedAt?: string;
}

const providerFor = (
    providers: InstallProvider[],
    step: StepKey,
): InstallProvider | undefined =>
    providers.find((p) => p.steps.includes(step));

function makeCtx(
    role: string,
    module: string,
    spec: InstallPlan["ordered"][number]["spec"],
    state: InstallState,
    installDir: string,
    baseOpts: ProviderOpts,
): ModuleCtx {
    return {
        spec,
        role,
        module,
        state: (state.modules[module] ??= emptyModuleState()),
        opts: baseOpts,
        transient: {},
    };
}

async function runStep(
    providers: InstallProvider[],
    step: StepKey,
    ctx: ModuleCtx,
): Promise<string[]> {
    const provider = providerFor(providers, step);
    if (!provider) return [];
    const res = await provider.run(step, ctx);
    return res.lines;
}

/**
 * Install every module in `plan`. Persists state after each module. On a
 * module failure, rolls back that module's applied steps and re-throws as an
 * `InstallError`.
 */
export async function installPlan(
    plan: InstallPlan,
    opts: InstallOpts,
): Promise<InstallResult> {
    const state = await loadState(plan.role);
    state.board = plan.board;
    const baseOpts: ProviderOpts = {
        installDir: "",
        installDeps: opts.installDeps ?? false,
        purge: opts.purge ?? false,
        root: opts.root ?? stateRoot(),
    };
    const results: ModuleResult[] = [];
    for (const mod of plan.ordered) {
        const entryBefore = state.modules[mod.name];
        const ctx = makeCtx(plan.role, mod.name, mod.spec, state, mod.installDir ?? "", {
            ...baseOpts,
            installDir: mod.installDir ?? "",
        });
        const applied: StepKey[] = [];
        const lines: string[] = [];
        try {
            for (const step of INSTALL_STEPS) {
                lines.push(...(await runStep(opts.providers, step, ctx)));
                applied.push(step);
            }
            results.push({ name: mod.name, ok: true, lines });
            await saveState(plan.role, state);
        } catch (err) {
            // Roll back the steps that already ran, in reverse.
            let rbLines: string[] = [];
            for (const step of [...applied].reverse()) {
                const rev = REVERSE[step];
                if (rev === null) continue;
                rbLines = rbLines.concat(
                    await runStep(opts.providers, rev, { ...ctx, opts: { ...ctx.opts, rollback: true } }),
                );
            }
            // The module is now fully undone → drop its state entry if we created it.
            if (entryBefore === undefined) delete state.modules[mod.name];
            await saveState(plan.role, state);
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ name: mod.name, ok: false, lines });
            throw new InstallError(mod.name, `[${lines.length ? "install" : "rollback"}] ${msg}`);
        }
    }
    return { ok: true, role: plan.role, results };
}

/**
 * Uninstall every module recorded for `role` (reverse plan order). Persists
 * state after each; removes the role file once no modules remain.
 */
export async function uninstallRole(
    role: string,
    plan: InstallPlan,
    opts: InstallOpts,
): Promise<InstallResult> {
    const state = await loadState(role);
    const baseOpts: ProviderOpts = {
        installDir: "",
        installDeps: opts.installDeps ?? false,
        purge: opts.purge ?? false,
        root: opts.root ?? stateRoot(),
    };
    const results: ModuleResult[] = [];
    // Reverse of the install order; only modules that have a state entry.
    const order = reverseOrder(plan).ordered.filter((m) => state.modules[m.name]);
    for (const mod of order) {
        const ctx = makeCtx(role, mod.name, mod.spec, state, mod.installDir ?? "", {
            ...baseOpts,
            installDir: mod.installDir ?? "",
        });
        const lines: string[] = [];
        for (const step of UNINSTALL_STEPS)
            lines.push(...(await runStep(opts.providers, step, ctx)));
        delete state.modules[mod.name];
        await saveState(role, state);
        results.push({ name: mod.name, ok: true, lines });
    }
    return { ok: true, role, results };
}

/** Convenience: build the plan, then install it. */
export async function install(
    roleDef: RoleDefinition,
    opts: InstallOpts,
): Promise<InstallResult> {
    const plan = await buildPlan(roleDef, opts.cfg, {
        moduleRoot: opts.moduleRoot,
        boardId: opts.boardId,
    });
    return installPlan(plan, opts);
}

/** Convenience: build the plan, then uninstall. */
export async function uninstall(
    roleDef: RoleDefinition,
    opts: InstallOpts,
): Promise<InstallResult> {
    const plan = await buildPlan(roleDef, opts.cfg, {
        moduleRoot: opts.moduleRoot,
        boardId: opts.boardId,
    });
    return uninstallRole(plan.role, plan, opts);
}

/** Thrown when a module's install fails mid-sequence (after rollback). */
export class InstallError extends Error {
    constructor(
        public readonly module: string,
        public readonly cause: string,
        stack?: string,
    ) {
        super(`install of module ${module} failed: ${cause}`);
        this.name = "InstallError";
        this.stack = stack;
    }
}

export { stateFile };
export type { InstallState, ModuleInstallState };
