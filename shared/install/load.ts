/*
 * Load a module's install spec for one role:
 *
 *   1. read `install/install.json` (base) and `install/install.<role>.json`
 *      (role delta);
 *   2. merge (role wins — `merge.ts`);
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
 * Load + merge + validate + resolve one module's spec for `role`.
 *
 * @param moduleDir the module directory (the parent of its `install/`).
 * @param role the role id this spec is resolved for.
 * @param cfg the role's runtime config (top level of the config file) for `{{cfg:…}}`.
 */
export async function loadInstallSpec(
    moduleDir: string,
    role: string,
    cfg: Record<string, unknown>,
): Promise<ModuleInstallSpec | null> {
    const base = await readJsonIfExists(`${moduleDir}/install/install.json`);
    const roleSpec = await readJsonIfExists(`${moduleDir}/install/install.${role}.json`);
    if (base === null && roleSpec === null) return null;
    const merged = validateSpec(
        mergeSpec(
            (base ?? { version: 1 }) as unknown as ModuleInstallSpec,
            roleSpec,
        ),
    );
    return resolveSpec(merged, `${moduleDir}/install`, cfg);
}
