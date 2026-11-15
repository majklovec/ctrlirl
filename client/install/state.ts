/*
 * Per-role install state: `/var/lib/ctrlirl/installed/<role>.json` (mode 0600,
 * root-owned). Saved after every module so a crash leaves a recoverable file.
 *
 * The destination root honors `CTRLIRL_ROOT_OVERRIDE` (tests): when set, the
 * file lives at `<override>/var/lib/ctrlirl/installed/<role>.json`. Providers
 * use the same override so a full run stays inside the test root.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallState, ModuleInstallState } from "../../shared/install/types";

/** The destination root: `CTRLIRL_ROOT_OVERRIDE` or `/`. */
export const stateRoot = (): string =>
    process.env.CTRLIRL_ROOT_OVERRIDE ?? "/";

/** Absolute path of a role's state file. */
export const stateFile = (role: string): string =>
    join(stateRoot(), "var/lib/ctrlirl/installed", `${role}.json`);

/** The state directory (created on demand by `saveState`). */
export const stateDir = (): string =>
    join(stateRoot(), "var/lib/ctrlirl/installed");

const emptyModuleState = (): ModuleInstallState => ({
    services: [],
    sysctl: {},
    firewall: { type: "nft", table: "" },
    udevFiles: [],
    overlayFiles: [],
    overlayDirs: [],
    packagesAdded: [],
    hooksRun: [],
});

/** Load a role's state; missing file yields an empty (valid) state. */
export async function loadState(role: string): Promise<InstallState> {
    const file = stateFile(role);
    const text = await readFile(file, "utf8").catch((): string | null => null);
    if (text === null)
        return { role, updatedAt: new Date(0).toISOString(), modules: {} };
    const data = JSON.parse(text) as Partial<InstallState>;
    return {
        role,
        updatedAt: data.updatedAt ?? new Date(0).toISOString(),
        modules: (data.modules ?? {}) as Record<string, ModuleInstallState>,
    };
}

/**
 * Save a role's state atomically (write temp, rename). Deletes the file when
 * `modules` is empty, so a clean uninstall leaves no state behind.
 */
export async function saveState(role: string, state: InstallState): Promise<void> {
    if (Object.keys(state.modules).length === 0) {
        await rm(stateFile(role), { force: true }).catch(() => {});
        return;
    }
    state.updatedAt = new Date().toISOString();
    const file = stateFile(role);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await writeFile(file, await readFile(tmp, "utf8").catch(() => "{}"));
    await rm(tmp, { force: true }).catch(() => {});
}

/** A fresh, empty state slice for a module (used by the orchestrator). */
export { emptyModuleState };
