/*
 * `bun run validate:install` — schema-check every `install*.json` in the
 * repo (both standalone and post-merge), catching typos in CI without a
 * host. Exits 1 when any file has issues (all issues are printed).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateSpecDetailed } from "../shared/install/validate";
import { mergeSpec, InstSpecError } from "../shared/install/merge";
import type { ModuleInstallSpec } from "../shared/install/types";
import { appPath } from "../shared/paths";

/**
 * Validate every `install*.json` in the repo (standalone + post-merge).
 * Returns the number of files checked; sets `failed = true` (and prints) on
 * any issue. Used by the `validate:install` script and the CLI
 * `validate` subcommand.
 */
export function validateAllInstallSpecs(
    modulesRoot: string = appPath("client/modules"),
): { checked: number; failed: boolean } {
let checked = 0;
let failed = false;

const fail = (
    where: string,
    msg?: string,
    issues?: Array<{ path: string; message: string }>,
): void => {
    failed = true;
    console.error(`FAIL ${where}${msg ? `: ${msg}` : ""}`);
    for (const i of issues ?? []) console.error(`   ${i.path || "(root)"} ${i.message}`);
};

    // Validate + merge-check one spec file against the module's base spec.
    // `where` labels the file in the output; `withBase` is the file the merge
    // is checked against (the base spec for role/board deltas).
    const checkFile = (file: string, withBase: string | null): void => {
        checked++;
        let data: unknown;
        try {
            data = JSON.parse(readFileSync(file, "utf8"));
        } catch (e) {
            fail(file, e instanceof Error ? e.message : String(e));
            return;
        }
        const issues = validateSpecDetailed(data);
        if (issues.length) {
            fail(file, undefined, issues);
            return;
        }
        if (withBase && existsSync(withBase)) {
            try {
                const base = JSON.parse(
                    readFileSync(withBase, "utf8"),
                ) as ModuleInstallSpec;
                const merged = mergeSpec(base, data as Partial<ModuleInstallSpec>);
                const mi = validateSpecDetailed(merged);
                if (mi.length) fail(file, `merged with install.json`, mi);
            } catch (e) {
                fail(
                    file,
                    `merge with install.json: ${e instanceof InstSpecError ? e.message : String(e)}`,
                );
            }
        }
    };

for (const moduleId of readdirSync(modulesRoot, { withFileTypes: true })) {
    if (!moduleId.isDirectory()) continue;
    const installDir = join(modulesRoot, moduleId.name, "install");
    if (!existsSync(installDir)) continue;
    // Top-level specs: install.json, install.<role>.json (role delta) and
    // board.<board>.json (board delta). Deltas are merge-checked against the
    // module's base spec.
    for (const name of readdirSync(installDir)) {
        if (!/^(install|install\.[a-z0-9_]+|board\.[a-z0-9_]+)\.json$/.test(name)) continue;
        checkFile(
            join(installDir, name),
            name === "install.json" ? null : join(installDir, "install.json"),
        );
    }
}

    return { checked, failed };
}

if (import.meta.main) {
    const { checked, failed } = validateAllInstallSpecs();
    if (!checked) {
        console.log("validate:install — no install specs found");
        process.exit(0);
    }
    if (failed) {
        console.error(`\nvalidate:install — FAILED (${checked} file(s) checked)`);
        process.exit(1);
    }
    console.log(`validate:install — OK (${checked} file(s) checked)`);
}
