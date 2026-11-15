/*
 * Load a module's install spec for one role on one board:
 *
 *   1. read `install/install.json` (base), `install/install.<role>.json`
 *      (role delta) and `install/boards/<board>.json` (board delta);
 *   2. merge — role wins over base, board wins over role (`merge.ts`);
 *   3. validate the merged result against `schema.json`;
 *   4. resolve `{{file:}}` / `{{env:}}` / `{{cfg:}}` placeholders.
 *
 * Returns `null` when the module has no `install/` directory — modules
 * without install rules keep working as before.
 */
import type { ModuleInstallSpec } from "./types";
import { mergeSpec } from "./merge";
import { resolveSpec } from "./resolve";
import { validateSpec } from "./validate";

const readJsonIfExists = async (path: string): Promise<Record<string, unknown> | null> => {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    try {
        const data = await file.json();
        return (typeof data === "object" && data !== null ? data : null) as Record<
            string,
            unknown
        > | null;
    } catch (err) {
        throw new Error(
            `cannot parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
};

/**
 * Load + merge + validate + resolve one module's spec for `role` on `board`.
 *
 * @param moduleDir the module directory (the parent of its `install/`).
 * @param role the role id this spec is resolved for.
 * @param cfg the role's runtime config (top level of the config file) for `{{cfg:…}}`.
 * @param board the board id; `install/boards/<board>.json` (when present) is
 *   merged last (board wins). `undefined`/`"generic"` apply no board delta.
 */
export async function loadInstallSpec(
    moduleDir: string,
    role: string,
    cfg: Record<string, unknown>,
    board?: string,
): Promise<ModuleInstallSpec | null> {
    const base = await readJsonIfExists(`${moduleDir}/install/install.json`);
    const roleSpec = await readJsonIfExists(`${moduleDir}/install/install.${role}.json`);
    const boardSpec =
        board && board !== "generic"
            ? await readJsonIfExists(`${moduleDir}/install/boards/${board}.json`)
            : null;
    if (base === null && roleSpec === null && boardSpec === null) return null;
    const merged = validateSpec(
        mergeSpec(
            mergeSpec(
                (base ?? { version: 1 }) as unknown as ModuleInstallSpec,
                roleSpec,
            ),
            boardSpec,
        ),
    );
    return resolveSpec(merged, `${moduleDir}/install`, cfg);
}
