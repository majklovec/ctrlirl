/*
 * Module ordering for install (and its exact reverse for uninstall).
 *
 * The base order is the role's declaration order. When a module's install
 * spec declares a dependency on *another module in the same role*, a
 * topological sort moves it after that module (ties break by id). This
 * matches the registry's own topological style for backend modules.
 *
 * The input is the plan's `ordered` list (already in declaration order); the
 * output preserves the relative declaration order except where forced by a
 * module-to-module dependency.
 */
import type { InstallPlan, ModulePlan } from "../../shared/install/types";

/**
 * Topologically sort `plan.ordered` over the `dependencies` declared in each
 * module's install spec (only edges to modules present in the plan count).
 * Throws on a cycle. No dependencies → the input order is returned unchanged.
 */
export function orderByModuleDependencies(plan: InstallPlan): InstallPlan {
    const byName = new Map(plan.ordered.map((m) => [m.name, m]));
    const order: ModulePlan[] = [];
    const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 on stack, 2 done

    const visit = (m: ModulePlan, stack: ModulePlan[]): void => {
        const s = state.get(m.name) ?? 0;
        if (s === 2) return;
        if (s === 1)
            throw new Error(
                `install dependency cycle: ${[...stack, m].map((x) => x.name).join(" -> ")}`,
            );
        state.set(m.name, 1);
        for (const dep of m.spec.dependencies ?? []) {
            // Only edges to modules actually in the plan (a dependency is a
            // *module* id, not an OS package).
            const depMod = byName.get(dep);
            if (depMod && depMod.name !== m.name) visit(depMod, [...stack, m]);
        }
        state.set(m.name, 2);
        order.push(m);
    };

    for (const m of plan.ordered) visit(m, []);
    return { ...plan, ordered: order };
}

/** The reverse of a plan's install order (the uninstall order). */
export function reverseOrder(plan: InstallPlan): InstallPlan {
    return { ...plan, ordered: [...plan.ordered].reverse() };
}
