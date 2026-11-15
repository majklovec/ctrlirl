import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ctrlirl-state-test-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function run(
    script: string,
    args: string[] = [],
    overrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        CONFIG_FILE: join(dir, "config.json"),
        TMPDIR: dir,
        ...overrides,
    };
    if (!("STATE_FILE" in overrides)) delete env.STATE_FILE;
    delete env.DRY_RUN;
    const proc = Bun.spawn([process.execPath, "-e", script, "test", ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr };
}

describe("state file path", () => {
    const printPath = `
        const { STATE_FILE } = await import("./client/backend/config.ts");
        console.log(STATE_FILE);
    `;

    test("defaults to /var/lib independently of TMPDIR", async () => {
        const result = await run(printPath);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toBe("/var/lib/ctrlirl/state.json");
    });

    test("environment overrides the default and CLI overrides the environment", async () => {
        const envPath = join(dir, "env.json");
        const cliPath = join(dir, "cli.json");
        const envResult = await run(printPath, [], { STATE_FILE: envPath });
        const cliResult = await run(printPath, ["--state-file", cliPath], {
            STATE_FILE: envPath,
        });
        expect(envResult.exitCode, envResult.stderr).toBe(0);
        expect(envResult.stdout).toBe(envPath);
        expect(cliResult.exitCode, cliResult.stderr).toBe(0);
        expect(cliResult.stdout).toBe(cliPath);
    });

    test("creates the state directory before migrating legacy config", async () => {
        const configPath = join(dir, "config.json");
        const statePath = join(dir, "new", "nested", "state.json");
        await writeFile(
            configPath,
            JSON.stringify({ uuid: "device", language: "en", relay: { id: 1 } }),
        );
        const result = await run(
            `await import("./client/backend/state.ts");`,
            ["--state-file", statePath],
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
            relay: { id: 1 },
        });
        expect(JSON.parse(await readFile(configPath, "utf8")).relay).toBeUndefined();
    });

    test("a failed state write preserves the legacy config", async () => {
        const configPath = join(dir, "config.json");
        const parent = join(dir, "not-a-directory");
        const original = JSON.stringify({
            uuid: "device",
            language: "en",
            relay: { id: 1 },
        });
        await writeFile(configPath, original);
        await writeFile(parent, "block directory creation");
        const result = await run(
            `await import("./client/backend/state.ts");`,
            ["--state-file", join(parent, "state.json")],
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("EEXIST");
        expect(await readFile(configPath, "utf8")).toBe(original);
    });

    test("a failed save can be retried after the directory is fixed", async () => {
        const parent = join(dir, "not-a-directory");
        const statePath = join(parent, "state.json");
        await writeFile(parent, "block directory creation");
        const result = await run(
            `
                const { unlink } = await import("node:fs/promises");
                const { state, saveState } = await import("./client/backend/state.ts");
                state.data.relay = { id: 1 };
                try {
                    await saveState();
                    throw new Error("expected first save to fail");
                } catch (error) {
                    if (error.code !== "EEXIST") throw error;
                }
                await unlink(${JSON.stringify(parent)});
                await saveState();
            `,
            ["--state-file", statePath],
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
            relay: { id: 1 },
        });
    });
});
