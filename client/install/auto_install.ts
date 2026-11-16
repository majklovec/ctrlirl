/*
 * Auto-install shared by the CLI's `start` path and the setup wizard
 * (`setup.complete`): a role whose install state is missing gets its host
 * rules applied before the device serves traffic. Silent by design — the
 * caller decides how to surface `lines` / `skipped` / `error` (console for
 * the CLI, event-log entries for the web UI).
 */
import type { RoleDefinition } from "../../shared/contracts/roles";
import { ROLES } from "../../shared/registry";
import { detectBoardId, type BoardId } from "../../shared/install/board";
import type { InstallProvider, StepKey } from "./provider";
import { buildPlan } from "./plan";
import { installPlan } from "./installer";
import { loadState } from "./state";
import { isRoot } from "./host";

export interface AutoInstallOpts {
    providers: InstallProvider[];
    cfg: Record<string, unknown>;
    moduleRoot: string;
    boardId?: BoardId;
    installDeps?: boolean;
    /** `--skip-install`: report what is missing without applying it. */
    skip?: boolean;
    /** Receives a module's lines once the module finishes (success or not). */
    onProgress?: (lines: string[]) => void;
    /** Receives a step's lines the moment that step finishes (live log). */
    onStep?: (module: string, step: StepKey, lines: string[]) => void;
}

export interface AutoInstallResult {
    /** Modules of the role's plan that have no install state yet. */
    missing: string[];
    /** True when `installPlan` ran to completion. */
    installed: boolean;
    /** Every provider line of the run install (empty when not installed). */
    lines: string[];
    /** Why nothing was installed: the skip flag, or not running as root. */
    skipped?: "skip" | "not-root";
    /** Install failure (only when not skipped). */
    error?: unknown;
}

export async function autoInstallRole(
    roleId: string,
    opts: AutoInstallOpts,
): Promise<AutoInstallResult> {
    const role = ROLES.find((r) => r.id === roleId);
    if (role === undefined)
        return {
            missing: [],
            installed: false,
            lines: [],
            error: new Error(`unknown role: ${roleId}`),
        };
    const board: BoardId = opts.boardId ?? (await detectBoardId());
    let plan: Awaited<ReturnType<typeof buildPlan>>;
    try {
        plan = await buildPlan(role, opts.cfg, {
            moduleRoot: opts.moduleRoot,
            boardId: board,
        });
    } catch (err) {
        return { missing: [], installed: false, lines: [], error: err };
    }
    if (plan.ordered.length === 0)
        return { missing: [], installed: false, lines: [] };
    const state = await loadState(roleId);
    const missing = plan.ordered
        .filter((mod) => !state.modules[mod.name])
        .map((mod) => mod.name);
    if (missing.length === 0)
        return { missing: [], installed: false, lines: [] };
    if (opts.skip)
        return { missing, installed: false, lines: [], skipped: "skip" };
    if (!isRoot())
        return { missing, installed: false, lines: [], skipped: "not-root" };
    try {
        const res = await installPlan(plan, {
            providers: opts.providers,
            cfg: opts.cfg,
            installDeps: opts.installDeps,
            moduleRoot: opts.moduleRoot,
            boardId: board,
            onModuleResult: opts.onProgress
                ? (result) => opts.onProgress?.(result.lines)
                : undefined,
            onStep: opts.onStep,
        });
        return {
            missing,
            installed: true,
            lines: res.results.flatMap((result) => result.lines),
        };
    } catch (err) {
        return { missing, installed: false, lines: [], error: err };
    }
}
