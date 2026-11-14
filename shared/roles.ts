/*
 * Environment-independent helpers over role definitions (browser-safe: no
 * discovery, no disk access). Callers pass the role list — the Bun runtime
 * gets it from shared/registry.ts (ROLES), the web bundles from
 * generated/roles.
 */
import type { Role, RoleDefinition } from "./contracts/roles";

/** Whether `moduleId` runs on `role` (listed in `requires.modules` or `optionalModules`). */
export const roleServesModule = (
    roles: readonly RoleDefinition[],
    role: Role,
    moduleId: string,
): boolean => {
    const def = roles.find((r) => r.id === role);
    if (def === undefined) return false;
    return (
        def.requires.modules.includes(moduleId) ||
        (def.requires.optionalModules ?? []).includes(moduleId)
    );
};

/** Whether `moduleId` is enabled by default on `role` (listed in `requires.modules`). */
export const roleEnablesModule = (
    roles: readonly RoleDefinition[],
    role: Role,
    moduleId: string,
): boolean =>
    roles.find((r) => r.id === role)?.requires.modules.includes(moduleId) ?? false;

/** The roles on which `moduleId` runs (default-on or optional). */
export const rolesWithModule = (
    roles: readonly RoleDefinition[],
    moduleId: string,
): readonly Role[] =>
    roles
        .filter(
            (r) =>
                r.requires.modules.includes(moduleId) ||
                (r.requires.optionalModules ?? []).includes(moduleId),
        )
        .map((r) => r.id);
