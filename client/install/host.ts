/*
 * Host primitives shared by the real providers. Every filesystem path is
 * resolved against `opts.root` (default `/`, overridden in tests); every
 * external command goes through `run` so it can be faked in tests.
 */
import { spawn } from "bun";
import {
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/** Resolve a `/`-prefixed host path against the destination root. */
export const resolvePath = (root: string, hostRel: string): string =>
    join(root, hostRel.replace(/^\//, ""));

/** Write a file (creating parents), with a mode. Returns true if content changed. */
export async function writeManagedFile(
    root: string,
    hostRel: string,
    content: string,
    mode: number = 0o644,
): Promise<boolean> {
    const full = resolvePath(root, hostRel);
    const existing = await readFile(full, "utf8").catch((): string | null => null);
    if (existing === content) return false;
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, { mode });
    return true;
}

export const fileExists = async (full: string): Promise<boolean> =>
    (await stat(full).catch(() => null)) !== null;

export const readHostFile = (
    root: string,
    hostRel: string,
): Promise<string | null> =>
    readFile(resolvePath(root, hostRel), "utf8").catch((): string | null => null);

export const removeHostFile = (root: string, hostRel: string): Promise<void> =>
    rm(resolvePath(root, hostRel), { force: true });

/**
 * Run an external command. Returns `{ exitCode, stdout, stderr }`. `args` are
 * not run through a shell. `opts.fake` (tests) intercepts and returns a canned
 * result without executing — the command is still recorded in `opts.log` when
 * provided, so tests can assert the exact invocation.
 */
export interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export interface RunOpts {
    /** Test seam: intercept invocations (no real process) and return a result. */
    fake?: (cmd: string, args: string[]) => RunResult | Promise<RunResult>;
    /** Record raw command lines here (for assertions / logs). */
    log?: string[];
    /** Extra environment for the spawned process (hooks). */
    env?: Record<string, string>;
}
export async function run(
    cmd: string,
    args: string[],
    opts: RunOpts = {},
): Promise<RunResult> {
    if (opts.log) opts.log.push(`${cmd} ${args.join(" ")}`);
    if (opts.fake) return opts.fake(cmd, args);
    // SAFETY: under the test suites, a real command is never spawned. This is
    // the backstop that guarantees providers are never exercised against the
    // host machine from a test (do not remove).
    if (process.env.CTRLIRL_TEST === "1")
        throw new Error(
            `host.run: refusing to execute real command in a test: ${cmd} ${args.join(" ")}`,
        );
    try {
        const proc = spawn([cmd, ...args], {
            stdout: "pipe",
            stderr: "pipe",
            env: opts.env ? { ...process.env, ...opts.env } : process.env,
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
    } catch (err) {
        return {
            exitCode: 1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
        };
    }
}

/** True only when we are effectively root (needed for real host mutation). */
export const isRoot = (): boolean => (process.getuid?.() ?? 1) === 0;
