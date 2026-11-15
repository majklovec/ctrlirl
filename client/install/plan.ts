/*
 * Build a role's install plan: load + resolve every module's spec (per role)
 * and a synthetic `__role__` entry for the role-wide `install` field, then
 * apply module-dependency ordering. Pure aside from reading the spec files —
 * no host mutation, so it's safe under dry-run and in tests.
 */
import { appPath, MODULE_ROOTS } from "../../shared/paths";
import { loadInstallSpec } from "../../shared/install/load";
import { detectBoardId, type BoardId } from "../../shared/install/board";
import type {
    InstallPlan,
    ModuleInstallSpec,
    ModulePlan,
} from "../../shared/install/types";
import type { RoleDefinition } from "../../shared/contracts/roles";
import { orderByModuleDependencies } from "./ordering";

/**
 * Build the install plan for `role`.
 *
 * @param roleDef the role definition (module list + role-wide `install`).
 * @param cfg the role's runtime config (top level) for `{{cfg:…}}` resolution.
 * @param opts `moduleRoot`: the directory whose children are modules (defaults
 *   to the repo's `client/modules`; tests point it at a fixture dir).
 *   `boardId`: the board the role is installed on — `install/boards/<board>.json`
 *   deltas are applied for matching modules. Defaults to auto-detection.
 */
export async function buildPlan(
    roleDef: RoleDefinition,
    cfg: Record<string, unknown>,
    opts: { moduleRoot?: string; boardId?: BoardId } = {},
): Promise<InstallPlan> {
    const board = opts.boardId ?? (await detectBoardId());
    const ordered: ModulePlan[] = [];

    // 1. Every module the role declares (default-on first, optional later).
    const moduleIds = [
        ...roleDef.requires.modules,
        ...(roleDef.requires.optionalModules ?? []),
    ];
    const deviceRoot = opts.moduleRoot ?? appPath(MODULE_ROOTS[0]);
    for (const id of moduleIds) {
        const moduleDir = `${deviceRoot}/${id}`;
        const spec = await loadInstallSpec(moduleDir, roleDef.id, cfg, board);
        if (spec === null) continue; // no install/ → nothing to install
        ordered.push({ name: id, spec, installDir: `${moduleDir}/install` });
    }

    // 2. The synthetic `__role__` entry for the role-wide `install` field.
    const roleSpec = buildRoleSpec(roleDef);
    if (roleSpec !== null) ordered.push({ name: "__role__", spec: roleSpec });

    return orderByModuleDependencies({ role: roleDef.id, board, ordered });
}

/**
 * Shape the role-wide `install` field into a full spec, dropping the two
 * module-scoped fields the handoff forbids (`services`, `hooks`). Returns
 * `null` when the role declares no install rules.
 */
function buildRoleSpec(roleDef: RoleDefinition): ModuleInstallSpec | null {
    const r = roleDef.install;
    if (r === undefined) return null;
    const out: ModuleInstallSpec = { version: 1 };
    if (r.dependencies) out.dependencies = [...r.dependencies];
    if (r.capabilities) out.capabilities = r.capabilities;
    if (r.sysctl) out.sysctl = { ...r.sysctl };
    if (r.firewall) out.firewall = [...r.firewall];
    if (r.udev) out.udev = [...r.udev];
    if (r.overlay) out.overlay = r.overlay;
    return Object.keys(out).length > 1 ? out : null; // only version → nothing
}
