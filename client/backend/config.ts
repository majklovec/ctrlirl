/*
 * Device process settings: the core's CLI arguments (with env / config-file
 * fallbacks) and derived values. Modules parse their own arguments with
 * shared/args.
 *
 * Every setting resolves in the same order: CLI flag > env var > config file
 * > default.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    argEnv,
    argFail,
    argv,
    flagOrEnv,
    intArgEnv,
} from "../../shared/args";
import { isRegisteredRole, registeredRoleIds } from "../../shared/registry";
import { REMOTE_URL_RE, type Role } from "../../shared/validate";
import { removeStaleTmps } from "./files";

export { argv, type Role };

const TMP = tmpdir();

// Device config: the permanent parameters (core settings + per-module config
// slices). The mutable per-module data sections (`state.data.*`) live in the
// separate state file. Live process state (pids, counters) is memory-only and
// never written to either file.
export const CONFIG_FILE = argEnv("--config", "CONFIG_FILE", join(TMP, "config.json"));
/** State file: the per-module data sections, separate from the config file. */
export const STATE_FILE = argEnv("--state-file", "STATE_FILE", "/var/lib/ctrlirl/state.json");
// A crashed run leaves `<file>.<hex>.tmp` orphans; a fresh boot is the safe
// moment to clear them (nothing else is mid-save on a single-device file).
await removeStaleTmps(CONFIG_FILE);
await removeStaleTmps(STATE_FILE);
// A fresh device (no config file) shows the setup wizard first
export const CONFIG_EXISTS = await Bun.file(CONFIG_FILE).exists();
export const STATE_EXISTS = await Bun.file(STATE_FILE).exists();
/** Config file contents at startup (null when missing or unreadable); state.ts builds on it. */
export const INITIAL_CONFIG = CONFIG_EXISTS
    ? ((await Bun.file(CONFIG_FILE)
          .json()
          .catch(() => null)) as Record<string, unknown> | null)
    : null;
/** State file contents at startup (null when missing/unreadable): the module data sections. */
export const INITIAL_STATE = STATE_EXISTS
    ? ((await Bun.file(STATE_FILE)
          .json()
          .catch(() => null)) as Record<string, unknown> | null)
    : null;
const persisted = (
    key: "role" | "remoteUrl" | "remoteToken",
): string | undefined => INITIAL_CONFIG?.[key] as string | undefined;

// Event log shown in the web UI
export const LOG_FILE = argEnv("--log-file", "LOG_FILE", join(TMP, "srtla_log.json"));
export const DRY_RUN = flagOrEnv("--dry-run", "DRY_RUN");
export const API_PORT = intArgEnv("--port", "API_PORT", 8085, 1, 65535);
export const API_HOST = argEnv("--host", "API_HOST", "127.0.0.1");
// Extra browser origins allowed to open the WebSocket (comma-separated, `*` = any)
export const ALLOWED_ORIGINS = argEnv("--allow-origin", "ALLOWED_ORIGINS", "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
// Outbound control connection: status is pushed to and requests accepted from this server.
// CLI > env > config file: the env vars (e.g. from docker-compose) override the
// persisted config; an explicit CLI flag still wins over both.
export const REMOTE_URL = argEnv(
    "--remote",
    "CONTROL_SERVER_URL",
    persisted("remoteUrl") ?? "",
);
export const REMOTE_TOKEN = argEnv(
    "--remote-token",
    "CONTROL_SERVER_TOKEN",
    persisted("remoteToken") ?? "",
);
export const REMOTE_INTERVAL = intArgEnv(
    "--remote-interval",
    "CONTROL_SERVER_INTERVAL",
    30,
); // periodic status push, seconds (0 = off)
// Throttled module pushes (e.g. link telemetry) to the control server, seconds (0 = off)
export const REMOTE_STATS_INTERVAL = intArgEnv(
    "--remote-stats-interval",
    "CONTROL_SERVER_STATS_INTERVAL",
    2,
);
if (REMOTE_URL && !REMOTE_URL_RE.test(REMOTE_URL))
    argFail("--remote", REMOTE_URL, "ws:// or wss:// URL");

// No role is a valid state: a fresh device (no config file) opens the setup
// wizard with no role selected and runs no modules until one is picked — the
// default role is only a CLI/install convenience, never a silent device role.
const rawRole = argEnv("--role", "ROLE") ?? persisted("role");
export const ROLE: Role | undefined =
    rawRole === undefined
        ? undefined
        : isRegisteredRole(rawRole)
          ? rawRole
          : argFail(
                "--role",
                rawRole,
                registeredRoleIds().join(" | "),
            );
