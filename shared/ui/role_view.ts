// Browser-safe read of the roles' own module lists (generated/roles, emitted
// by scripts/gen_modules.ts). A module gates its own UI with `roleServes` —
// "does the live role run me?" — the inverse of the module listing the roles
// it belongs to. The registry (module_registry.ts) uses the same helper for
// cards and widgets.
import ROLES from "../../generated/roles";
import type { Role, RoleDefinition } from "../contracts/roles";
import { roleServesModule } from "../roles";

/** Whether the live `role` runs `moduleId` per the role's own module list
 * (false for an unknown/legacy role). Accepts a raw `string` so dashboard
 * widgets (which read `DeviceSummary.role`) can gate without a cast. */
export const roleServes = (role: string | undefined, moduleId: string): boolean =>
    role !== undefined &&
    roleServesModule(ROLES as readonly RoleDefinition[], role as Role, moduleId);

/** Like `roleServes`, but also offers the module when the device reports no
 * role (legacy/unknown) — preserves the pre-inversion
 * `device.role === "X" || device.role === undefined` gating on dashboard
 * widgets and summary columns. */
export const roleServesOrLegacy = (
    role: string | undefined,
    moduleId: string,
): boolean => role === undefined || roleServes(role, moduleId);
