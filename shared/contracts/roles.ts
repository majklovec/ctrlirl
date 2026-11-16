import type { ModuleInstallSpec } from "../install/types";

/** A role id is owned by the role's own directory under `client/roles` (ROLE_ROOT). */
export type Role = string;

/**
 * Role-wide install rules not owned by any single module (handoff §6.3).
 * Any `ModuleInstallSpec` field except `services` and `hooks`, which are
 * strictly module-scoped. Merged into a synthetic `__role__` plan entry.
 */
export type RoleInstallSpec = Omit<Partial<ModuleInstallSpec>, "services" | "hooks">;

/** A role's declared dependencies and contributions. */
export interface RoleDefinition {
    id: Role;
    titleKey: string;
    taglineKey?: string;
    order: number;
    default?: boolean;
    setupSelectable?: boolean;
    /**
     * Role-wide install rules (declared in the role.json file). Optional;
     * the device installer merges it as a synthetic `__role__` spec. Never
     * names `services` or `hooks` (module-scoped).
     */
    install?: RoleInstallSpec;
    /** What this role needs from its modules. */
    requires: {
        /** Modules that run on this role and are enabled by default (all must exist). */
        modules: readonly string[];
        /** Modules that run on this role but are disabled by default. */
        optionalModules?: readonly string[];
        /** Capabilities this role's modules consume; the union of their `services.consumes`. */
        capabilities: readonly string[];
    };
    /** Capabilities this role's modules register on the capability bus. */
    provides: {
        capabilities: readonly string[];
    };
}
