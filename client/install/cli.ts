/*
 * The device CLI's install surface (handoff §13). `client.ts` calls
 * `installCli()` BEFORE the app graph loads:
 *
 *   bun client/backend/client.ts --role <role> [start]
 *   bun client/backend/client.ts --role <role> install   [--dry-run] [--install-deps]
 *   bun client/backend/client.ts --role <role> uninstall [--dry-run] [--purge]
 *   bun client/backend/client.ts --role <role> reinstall [--dry-run]
 *   bun client/backend/client.ts --role <new> switch-from <old> [--dry-run]
 *   bun client/backend/client.ts install validate
 *
 * Returning "handled" means the subcommand finished (the caller exits the
 * process); "start" means the process continues into the normal app
 * (auto-installing the role first when its state is missing — §13).
 *
 * Exit codes: 0 success, 1 validation error, 2 install error (state
 * preserved), 3 not root.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAllInstallSpecs } from "../../scripts/validate_install";
import { arg, argEnv, flag, argv as fullArgv } from "../../shared/args";
import type { RoleDefinition } from "../../shared/contracts/roles";
import {
    BOARD_IDS,
    type BoardId,
    detectBoardId,
    isBoardId,
} from "../../shared/install/board";
import type { InstallPlan } from "../../shared/install/types";
import { appPath, MODULE_ROOTS } from "../../shared/paths";
import { defaultRole, ROLES } from "../../shared/registry";
import { autoInstallRole } from "./auto_install";
import { renderDryRun } from "./dryrun";
import { isRoot } from "./host";
import { InstallError, installPlan, uninstallRole } from "./installer";
import { buildPlan } from "./plan";
import { realProviderBundle } from "./providers";
import { switchRole } from "./switch";

export type CliOutcome = "start" | "handled";

/** Flags that consume the next argv token as their value.
 * Must stay in sync with the value-taking args of shared/args.ts and the
 * modules (e.g. --pipelines, --encoder) — a missing entry makes the flag's
 * value look like a positional subcommand and `installCli` aborts the start. */
const VALUE_FLAGS = new Set([
    "--config",
    "--role",
    "--port",
    "--host",
    "--state-file",
    "--log-file",
    "--board",
    "--remote",
    "--encoder",
    "--ceracoder-conf",
    "--pipelines",
    "--bitrate-file",
    "--allow-origin",
    "--encoder-destination-host",
    "switch-from",
]);

/**
 * Resolve the board for the install surface. `--board`/`BOARD_ID` overrides
 * auto-detection (validated against the known board ids); otherwise the
 * running board is detected. `generic` is always accepted.
 */
const resolveBoard = async (): Promise<BoardId> => {
    const explicit = arg("board") ?? process.env.BOARD_ID;
    if (explicit !== undefined) {
        if (!isBoardId(explicit)) {
            console.error(
                `install: unknown board "${explicit}" (expected ${BOARD_IDS.join(" | ")})`,
            );
            process.exit(1);
        }
        return explicit;
    }
    return await detectBoardId();
};

const positional = (argv: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("-")) {
            // A dash-flag that consumes a value token: skip the value (when
            // given in `--flag value` form, not `--flag=value`).
            if (
                VALUE_FLAGS.has(a) &&
                i + 1 < argv.length &&
                !argv[i + 1].startsWith("-")
            )
                i++;
            continue;
        }
        out.push(a);
        if (a === "switch-from") i++; // the old role is a value, not a command
    }
    return out;
};

const roleDef = (roleId: string): RoleDefinition => {
    const def = ROLES.find((r) => r.id === roleId);
    if (!def) {
        console.error(
            `unknown role: ${roleId} (registered: ${ROLES.map((r) => r.id).join(", ")})`,
        );
        process.exit(1);
    }
    return def;
};

/** The device config (top level) for {{cfg:…}} — same file main.ts would read. */
const loadCfg = async (): Promise<Record<string, unknown>> => {
    const file = argEnv(
        "--config",
        "CONFIG_FILE",
        join(tmpdir(), "config.json"),
    );
    const data = await Bun.file(file)
        .json()
        .catch((): null => null);
    return (typeof data === "object" && data !== null ? data : {}) as Record<
        string,
        unknown
    >;
};

const dryRun = (): boolean => flag("--dry-run");

export async function installCli(): Promise<CliOutcome> {
    const argv = fullArgv;
    const words = positional(argv);
    const cmd = words[0] ?? "start";

    // `install validate` — repo-wide spec check, no root, no host.
    if (cmd === "install" && words[1] === "validate") {
        const { failed } = validateAllInstallSpecs();
        process.exit(failed ? 1 : 0);
    }
    if (cmd === "validate") {
        const { failed } = validateAllInstallSpecs();
        process.exit(failed ? 1 : 0);
    }

    const roleId = arg("role", defaultRole());
    const role = roleDef(roleId);
    const cfg = await loadCfg();
    const providers = realProviderBundle();
    const moduleRoot = appPath(MODULE_ROOTS[0]);
    const board = await resolveBoard();
    const installOpts = {
        providers,
        cfg,
        installDeps: flag("--install-deps"),
        purge: flag("--purge"),
        moduleRoot,
        boardId: board,
    };
    let plan: InstallPlan;
    try {
        plan = await buildPlan(role, cfg, { moduleRoot, boardId: board });
    } catch (err) {
        console.error(
            `install: plan validation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
    }

    switch (cmd) {
        case "install": {
            if (dryRun()) {
                console.log(
                    await renderDryRun(plan, "install", {
                        providers,
                        cfg,
                    }),
                );
                process.exit(0);
            }
            requireRoot();
            try {
                const res = await installPlan(plan, installOpts);
                for (const m of res.results)
                    for (const l of m.lines) console.log(l);
                console.log(`installed role ${res.role}`);
                process.exit(0);
            } catch (err) {
                failInstall(err);
            }
            break;
        }
        case "uninstall": {
            if (dryRun()) {
                console.log(
                    await renderDryRun(plan, "uninstall", { providers, cfg }),
                );
                process.exit(0);
            }
            requireRoot();
            try {
                const res = await uninstallRole(roleId, plan, installOpts);
                for (const m of res.results)
                    for (const l of m.lines) console.log(l);
                console.log(`uninstalled role ${res.role}`);
                process.exit(0);
            } catch (err) {
                failInstall(err);
            }
            break;
        }
        case "reinstall": {
            if (dryRun()) {
                console.log(
                    await renderDryRun(plan, "install", { providers, cfg }),
                );
                process.exit(0);
            }
            requireRoot();
            try {
                const un = await uninstallRole(roleId, plan, {
                    ...installOpts,
                    installDeps: false,
                });
                for (const m of un.results)
                    for (const l of m.lines) console.log(l);
                const in2 = await installPlan(plan, installOpts);
                for (const m of in2.results)
                    for (const l of m.lines) console.log(l);
                console.log(`reinstalled role ${roleId}`);
                process.exit(0);
            } catch (err) {
                failInstall(err);
            }
            break;
        }
        case "switch-from": {
            const oldRole = words[1];
            if (!oldRole) {
                console.error("switch-from: missing the old role name");
                process.exit(1);
            }
            if (dryRun()) {
                const old = roleDef(oldRole);
                const [a, b] = await Promise.all([
                    buildPlan(role, cfg, { moduleRoot, boardId: board }),
                    buildPlan(old, cfg, { moduleRoot, boardId: board }),
                ]);
                console.log(
                    await renderDryRun(b, "uninstall", { providers, cfg }),
                );
                console.log();
                console.log(
                    await renderDryRun(a, "install", { providers, cfg }),
                );
                process.exit(0);
            }
            requireRoot();
            try {
                const res = await switchRole(oldRole, roleId, role, {
                    ...installOpts,
                    oldRoleDef: roleDef(oldRole),
                });
                console.log(
                    `switched ${oldRole} → ${roleId} (shared: ${res.unchanged.join(", ") || "none"}; removed: ${res.removed.join(", ") || "none"}; added: ${res.added.join(", ") || "none"})`,
                );
                process.exit(0);
            } catch (err) {
                failInstall(err);
            }
            break;
        }
        case "start":
            break;
        default:
            console.error(`unknown subcommand: ${cmd}`);
            process.exit(1);
    }

    // `start` (explicit or implicit): auto-install the role when its state is
    // missing or incomplete, then hand over to the app.
    const auto = await autoInstallRole(roleId, installOpts);
    if (auto.error !== undefined) failInstall(auto.error);
    if (auto.missing.length === 0) return "start";
    if (auto.skipped === "skip") {
        console.warn(
            `install: state for role ${roleId} is incomplete (${auto.missing.join(", ")}) but --skip-install was given — continuing`,
        );
        return "start";
    }
    if (auto.skipped === "not-root") {
        // The explicit `install` command hard-requires root, but `start`
        // must not break non-root dev runs: warn and continue as before.
        console.warn(
            `install: state for role ${roleId} is missing (${auto.missing.join(", ")} have no rules applied) and this process is not root — continuing without installing; run \`sudo ${process.argv[1]} --role ${roleId} install\` to apply the rules`,
        );
        return "start";
    }
    console.log(
        `install: no state for role ${roleId} — auto-installing before start`,
    );
    for (const line of auto.lines) console.log(line);
    return "start";
}

/* ── shared helpers ─────────────────────────────────────────────────────── */

function requireRoot(): void {
    if (!isRoot()) {
        console.error(
            "install: this operation changes the host and must run as root (try `sudo`)",
        );
        process.exit(3);
    }
}

function failInstall(err: unknown): never {
    console.error(
        `install failed: ${err instanceof InstallError ? `[${err.module}] ${err.message}` : err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
}
