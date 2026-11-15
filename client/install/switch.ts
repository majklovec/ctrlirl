/*
 * Role switching (handoff §12): move from `oldRole` to `newRole` with a
 * module-for-module diff. Modules present in BOTH roles whose fully-resolved
 * specs are byte-identical are left on disk — their state entry is copied to
 * the new role's state file; everything else is torn down / installed as
 * usual. This is what makes a switch cheap (no service churn on shared
 * modules).
 */
import type { RoleDefinition } from "../../shared/contracts/roles";
import type { ModuleInstallSpec } from "../../shared/install/types";
import { buildPlan } from "./plan";
import { installPlan, uninstallRole, type InstallOpts } from "./installer";
import { loadState, saveState } from "./state";
import type { InstallPlan } from "../../shared/install/types";

/** Deterministic identity for a resolved spec (deep, key-order independent). */
export function specsEqual(a: ModuleInstallSpec, b: ModuleInstallSpec): boolean {
    return stableJson(a) === stableJson(b);
}

const stableJson = (v: unknown): string =>
    JSON.stringify(
        v === null || typeof v !== "object"
            ? v
            : Array.isArray(v)
                ? v.map(stableJson)
                : Object.fromEntries(
                      Object.keys(v as Record<string, unknown>)
                          .sort()
                          .map((k) => [k, stableJson((v as Record<string, unknown>)[k])]),
                  ),
    );

export interface SwitchResult {
    role: string;
    unchanged: string[];
    removed: string[];
    added: string[];
}

/**
 * Switch roles. `oldRole` may be null (first install). Shared modules are
 * skipped: their artifacts stay on disk and their state entry is copied into
 * the new role's state file so a later `uninstall <newRole>` removes them.
 */
export async function switchRole(
    oldRole: string | null,
    newRole: string,
    roleDef: RoleDefinition,
    opts: InstallOpts & { oldRoleDef?: RoleDefinition },
): Promise<SwitchResult> {
    if (!oldRole || oldRole === newRole) {
        const plan = await buildPlan(roleDef, opts.cfg, {
            moduleRoot: opts.moduleRoot,
        });
        await installPlan(plan, opts);
        return {
            role: newRole,
            unchanged: [],
            removed: [],
            added: plan.ordered.map((m) => m.name),
        };
    }
    const oldDef = opts.oldRoleDef;
    if (!oldDef)
        throw new Error(`switch: no role definition for old role "${oldRole}"`);
    const oldPlan = await buildPlan(oldDef, opts.cfg, { moduleRoot: opts.moduleRoot });
    const newPlan = await buildPlan(roleDef, opts.cfg, { moduleRoot: opts.moduleRoot });

    const oldNames = new Set(oldPlan.ordered.map((m) => m.name));
    const newNames = new Set(newPlan.ordered.map((m) => m.name));
    const unchanged: string[] = [];
    for (const m of newPlan.ordered) {
        if (!oldNames.has(m.name)) continue;
        const om = oldPlan.ordered.find((x) => x.name === m.name)!;
        if (specsEqual(m.spec, om.spec)) unchanged.push(m.name);
    }
    const unchangedSet = new Set(unchanged);

    const oldState = await loadState(oldRole);
    let newState = await loadState(newRole);

    // 1. Tear down everything old that is not shared.
    const tearPlan: InstallPlan = filterPlan(oldPlan, unchanged);
    if (tearPlan.ordered.length > 0)
        await uninstallRole(oldRole, tearPlan, opts);

    // 2. Copy shared state entries into the new role's file (same artifacts
    //    stay on disk; the new role now owns them).
    for (const name of unchanged) {
        if (oldState.modules[name])
            newState.modules[name] = oldState.modules[name];
    }
    if (unchanged.length > 0) await saveState(newRole, newState);

    // 3. Install everything new that is not shared.
    const addPlan: InstallPlan = filterPlan(newPlan, unchanged);
    if (addPlan.ordered.length > 0) await installPlan(addPlan, opts);

    return {
        role: newRole,
        unchanged,
        removed: oldNames.size
            ? [...oldNames].filter((n) => !unchangedSet.has(n))
            : [],
        added: [...newNames].filter((n) => !unchangedSet.has(n)),
    };
}

const filterPlan = (plan: InstallPlan, drop: readonly string[]): InstallPlan => {
    const dropSet = new Set(drop);
    return { ...plan, ordered: plan.ordered.filter((m) => !dropSet.has(m.name)) };
};
