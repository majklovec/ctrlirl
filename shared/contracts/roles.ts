/** A role id is owned by the role's own directory under `client/roles` (ROLE_ROOT). */
export type Role = string;

/** A role's declared dependencies and contributions. */
export interface RoleDefinition {
    id: Role;
    titleKey: string;
    taglineKey?: string;
    order: number;
    default?: boolean;
    setupSelectable?: boolean;
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
