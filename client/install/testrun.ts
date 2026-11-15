/*
 * Test seam for provider command execution. `fake()` returns a full `RunOpts`
 * that intercepts every external command (no real process is spawned, so tests
 * run without root and without the tools present) and records each call in
 * `runLog` for assertions.
 *
 * SAFETY (do not test the host): while `CTRLIRL_TEST=1` (set by the test
 * suites), `host.run` throws if it is ever asked to execute a real command
 * without a fake — a real `systemctl`/`sysctl`/`nft` can never be spawned.
 */
import type { RunOpts } from "./host";

export const runLog: string[] = [];

export const resetRunLog = (): void => {
    runLog.length = 0;
};

/** A `RunOpts` whose `fake` records the invocation and reports success. */
export function fake(): RunOpts {
    return {
        fake: (cmd, args) => {
            runLog.push(`${cmd} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
        },
    };
}
