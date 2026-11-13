/*
 * Executable resolution for the bundled media binaries.
 *
 * Backend only: spawns nothing, just turns a bare/relative binary name into an
 * absolute path that `Bun.spawn` can launch.
 */
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Resolve an executable name to an absolute path for spawning.
 *
 * A bare name (`belacoder`, `srtla_send`) is looked up along `PATH`; if it is
 * not there it falls back to the process working directory. `client-arm` is
 * launched with `cwd = /home/pi/app` and the service `PATH` does not include
 * that directory, so the bundled binaries that sit next to the executable
 * resolve via the cwd fallback even when the service was started without
 * `ENCODER_BIN` / `SRTLA_SEND_BIN`.
 *
 * Absolute names are returned as-is. Relative names (e.g. `./srtla_send`, the
 * dev `run.sh` form) are tried as given, then against the cwd.
 */
export function resolveBinary(name: string): string {
    if (isAbsolute(name)) return name;
    if (name.includes("/") || name.includes("\\")) {
        const abs = join(process.cwd(), name);
        return existsSync(abs) ? abs : name;
    }
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (!dir) continue;
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
    }
    return join(process.cwd(), name);
}
