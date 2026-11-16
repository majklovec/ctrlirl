import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlan } from "../client/install/installer";
import { buildPlan } from "../client/install/plan";
import { hooksProvider } from "../client/install/providers/hooks";
import type { RunResult } from "../client/install/host";
import type { RoleDefinition } from "../shared/contracts/roles";
import { appPath } from "../shared/paths";

const installScript = appPath("client/modules/encoder/install/install.sh");
const uninstallScript = appPath("client/modules/encoder/install/uninstall.sh");
const releaseRoot = "https://github.com/irlserver/srtla_send/releases/download/v4.1.0";
const releaseApi = "https://api.github.com/repos/irlserver/srtla_send/releases/latest";
const debName = (arch: string): string => `srtla_4.1.0_${arch}.deb`;
const assetUrl = (arch: string): string => `${releaseRoot}/${debName(arch)}`;

let root: string;
let bin: string;
let log: string;
let release: string;
let checksums: string;
let deb: string;

const scripts: Record<string, string> = {
    dpkg: `#!/bin/sh
printf 'dpkg:%s\\n' "$*" >> "$TEST_LOG"
[ "$1" = "--print-architecture" ] || exit 90
printf '%s\\n' "$TEST_ARCH"
`,
    "dpkg-deb": `#!/bin/sh
printf 'dpkg-deb:%s\\n' "$*" >> "$TEST_LOG"
[ "$1" = "-f" ] || exit 91
case "$3" in
    Package) printf '%s\\n' "\${TEST_PACKAGE_NAME:-srtla}" ;;
    Architecture) printf '%s\\n' "\${TEST_PACKAGE_ARCH:-$TEST_ARCH}" ;;
    *) exit 92 ;;
esac
`,
    curl: `#!/bin/sh
output=
url=
while [ "$#" -gt 0 ]; do
    case "$1" in
        -fsSL) shift ;;
        --retry|--connect-timeout|--max-time|--proto|--proto-redir) shift 2 ;;
        -o) output=$2; shift 2 ;;
        *) url=$1; shift ;;
    esac
done
printf 'curl:%s\\n' "$url" >> "$TEST_LOG"
case "$url" in
    "$TEST_RELEASE_API") kind=release; source=$TEST_RELEASE ;;
    "$TEST_RELEASE_ROOT/sha256sums.txt") kind=checksums; source=$TEST_CHECKSUMS ;;
    "$TEST_RELEASE_ROOT/"srtla_*.deb) kind=package; source=$TEST_DEB ;;
    *) echo "unexpected URL: $url" >&2; exit 93 ;;
esac
if [ "\${TEST_CURL_FAIL:-}" = "$kind" ]; then
    echo "simulated $kind download failure" >&2
    exit 94
fi
cp "$source" "$output"
`,
    "apt-get": `#!/bin/sh
printf 'apt-get:%s\\n' "$*" >> "$TEST_LOG"
if [ "\${TEST_APT_FAIL:-}" = 1 ]; then
    echo "simulated apt failure" >&2
    exit 95
fi
if [ "\${TEST_SKIP_EXECUTABLE:-}" != 1 ]; then
    printf '#!/bin/sh\\nexit 0\\n' > "$TEST_BIN/srtla_send"
    chmod +x "$TEST_BIN/srtla_send"
fi
`,
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctrlirl-srtla-test-"));
    bin = join(root, "bin");
    log = join(root, "calls.log");
    release = join(root, "release.json");
    checksums = join(root, "checksums.txt");
    deb = join(root, "fixture.deb");
    await mkdir(bin);
    for (const utility of ["awk", "chmod", "cp", "cut", "grep", "mktemp", "rm", "rmdir", "sh", "sha256sum"]) {
        const path = Bun.which(utility);
        if (!path) throw new Error(`test requires ${utility}`);
        await symlink(path, join(bin, utility));
    }
    for (const [name, content] of Object.entries(scripts))
        await writeFile(join(bin, name), content, { mode: 0o755 });

    const contents = "fixture Debian package";
    const hash = createHash("sha256").update(contents).digest("hex");
    await Promise.all([
        writeFile(log, ""),
        writeFile(deb, contents),
        writeFile(release, JSON.stringify({
            assets: ["amd64", "arm64"].map((arch) => ({ browser_download_url: assetUrl(arch) })),
        })),
        writeFile(checksums, ["amd64", "arm64"].map((arch) => `${hash}  ${debName(arch)}\n`).join("")),
    ]);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function fixtureEnv(
    arch: string,
    extraEnv: Record<string, string> = {},
): Record<string, string> {
    return {
        PATH: bin,
        TMPDIR: root,
        TEST_ARCH: arch,
        TEST_BIN: bin,
        TEST_LOG: log,
        TEST_RELEASE_API: releaseApi,
        TEST_RELEASE_ROOT: releaseRoot,
        TEST_RELEASE: release,
        TEST_CHECKSUMS: checksums,
        TEST_DEB: deb,
        ...extraEnv,
    };
}

async function runScript(
    args: string[],
    arch: string,
    extraEnv: Record<string, string> = {},
): Promise<RunResult> {
    const proc = Bun.spawn(["/bin/sh", ...args], {
        env: fixtureEnv(arch, extraEnv),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
}

const calls = (): Promise<string> => readFile(log, "utf8");

async function expectNoDownloadDir(): Promise<void> {
    expect((await readdir(root)).filter((name) => name.startsWith("ctrlirl-srtla."))).toEqual([]);
}

describe("encoder srtla_send install hook", () => {
    for (const arch of ["amd64", "arm64"]) {
        test(`downloads, verifies, and installs the ${arch} package`, async () => {
            const result = await runScript([installScript, arch], arch);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(`installed srtla_send (${arch})`);
            const commands = await calls();
            expect(commands).toContain(`curl:${assetUrl(arch)}`);
            expect(commands).toContain(`curl:${releaseRoot}/sha256sums.txt`);
            expect(commands).toContain(`apt-get:install -y --reinstall`);
            expect(commands).toContain(debName(arch));
            expect(commands).not.toContain(assetUrl(arch === "amd64" ? "arm64" : "amd64"));
            await expectNoDownloadDir();

            const again = await runScript([installScript, arch], arch);
            expect(again.exitCode).toBe(0);
            expect(again.stdout).toContain("already on PATH");
            expect(await calls()).toBe(commands);
        });

        test(`detects ${arch} when no argument is supplied`, async () => {
            const result = await runScript([installScript], arch);
            expect(result.exitCode).toBe(0);
            expect(await calls()).toContain(`curl:${assetUrl(arch)}`);
        });
    }

    test("uses a configured executable and rejects an invalid override", async () => {
        const custom = join(root, "custom-srtla");
        await writeFile(custom, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const present = await runScript([installScript], "amd64", { SRTLA_SEND_BIN: custom });
        expect(present.exitCode).toBe(0);
        expect(present.stdout).toContain(custom);
        expect(await calls()).toBe("");

        const invalid = await runScript([installScript], "amd64", { SRTLA_SEND_BIN: "" });
        expect(invalid.exitCode).not.toBe(0);
        expect(invalid.stderr).toContain("SRTLA_SEND_BIN");
        expect(await calls()).toBe("");
    });

    test("installs when SRTLA_SEND_BIN names the missing PATH executable", async () => {
        const result = await runScript([installScript], "amd64", { SRTLA_SEND_BIN: "srtla_send" });
        expect(result.exitCode).toBe(0);
        expect(await calls()).toContain(`curl:${assetUrl("amd64")}`);
        expect(await calls()).toContain("apt-get:install -y --reinstall");
    });

    test("rejects unsupported, extra, and mismatched architecture arguments", async () => {
        const invalid = await runScript([installScript, "x86_64"], "amd64");
        expect(invalid.exitCode).not.toBe(0);
        expect(invalid.stderr).toContain("unsupported");
        const extra = await runScript([installScript, "amd64", "arm64"], "amd64");
        expect(extra.exitCode).not.toBe(0);
        expect(extra.stderr).toContain("usage:");
        const mismatch = await runScript([installScript, "arm64"], "amd64");
        expect(mismatch.exitCode).not.toBe(0);
        expect(mismatch.stderr).toContain("does not match");
        const unsupportedHost = await runScript([installScript], "armhf");
        expect(unsupportedHost.exitCode).not.toBe(0);
        expect(unsupportedHost.stderr).toContain("unsupported Debian architecture");
        expect(await calls()).not.toContain("curl:");
        expect(await calls()).not.toContain("apt-get:");
    });

    test("does not install host packages when an alternate root is configured", async () => {
        for (const env of [
            { CTRLIRL_ROOT_OVERRIDE: root, CTRLIRL_INSTALL_ROOT: "" },
            { CTRLIRL_INSTALL_ROOT: root, CTRLIRL_ROOT_OVERRIDE: "/" },
        ]) {
            const result = await runScript([installScript], "amd64", env);
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("non-default install root");
        }
        expect(await calls()).toBe("");
    });

    test("fails if the release does not provide exactly one matching asset", async () => {
        await writeFile(release, JSON.stringify({ assets: [{ browser_download_url: assetUrl("arm64") }] }));
        const missing = await runScript([installScript, "amd64"], "amd64");
        expect(missing.exitCode).not.toBe(0);
        expect(missing.stderr).toContain("no amd64 Debian package");
        await writeFile(release, JSON.stringify({
            assets: [
                { browser_download_url: assetUrl("amd64") },
                { browser_download_url: assetUrl("amd64") },
            ],
        }));
        const duplicate = await runScript([installScript, "amd64"], "amd64");
        expect(duplicate.exitCode).not.toBe(0);
        expect(duplicate.stderr).toContain("multiple amd64 Debian packages");
        expect(await calls()).not.toContain("apt-get:");
        await expectNoDownloadDir();
    });

    test("reports download and checksum failures without installing", async () => {
        for (const step of ["release", "package", "checksums"]) {
            const result = await runScript([installScript, "amd64"], "amd64", { TEST_CURL_FAIL: step });
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("could not");
            await expectNoDownloadDir();
        }
        await writeFile(checksums, `${"0".repeat(64)}  ${debName("amd64")}\n`);
        const badHash = await runScript([installScript, "amd64"], "amd64");
        expect(badHash.exitCode).not.toBe(0);
        expect(badHash.stderr).toContain("checksum verification failed");
        await writeFile(checksums, "");
        const missingHash = await runScript([installScript, "amd64"], "amd64");
        expect(missingHash.exitCode).not.toBe(0);
        expect(missingHash.stderr).toContain("checksum");
        expect(await calls()).not.toContain("apt-get:");
        await expectNoDownloadDir();
    });

    test("rejects a package with the wrong name or architecture", async () => {
        const packages: Record<string, string>[] = [
            { TEST_PACKAGE_NAME: "other" },
            { TEST_PACKAGE_ARCH: "arm64" },
        ];
        for (const env of packages) {
            const result = await runScript([installScript, "amd64"], "amd64", env);
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("unexpected Debian package");
        }
        expect(await calls()).not.toContain("apt-get:");
        await expectNoDownloadDir();
    });

    test("reports an apt failure or a missing executable after installation", async () => {
        const failed = await runScript([installScript, "amd64"], "amd64", { TEST_APT_FAIL: "1" });
        expect(failed.exitCode).not.toBe(0);
        expect(failed.stderr).toContain("apt-get failed");
        const missing = await runScript([installScript, "amd64"], "amd64", { TEST_SKIP_EXECUTABLE: "1" });
        expect(missing.exitCode).not.toBe(0);
        expect(missing.stderr).toContain("not executable on PATH");
        await expectNoDownloadDir();
    });

    test("uninstall leaves existing executables and packages untouched", async () => {
        const existing = join(bin, "srtla_send");
        await writeFile(existing, "existing\n", { mode: 0o755 });
        const result = await runScript([uninstallScript], "amd64");
        expect(result.exitCode).toBe(0);
        expect(await readFile(existing, "utf8")).toBe("existing\n");
        expect(await calls()).toBe("");
    });
});

describe("encoder install plan", () => {
    const role: RoleDefinition = {
        id: "encoder",
        titleKey: "role.encoder",
        order: 1,
        requires: { modules: ["encoder"], capabilities: [] },
        provides: { capabilities: [] },
    };

    test("passes the destination root to the real hook without changing the host", async () => {
        const code = `
            import { hooksProvider } from ${JSON.stringify(appPath("client/install/providers/hooks.ts"))};
            import { emptyModuleState } from ${JSON.stringify(appPath("client/install/state.ts"))};
            const ctx = {
                spec: { version: 1, hooks: { install: "install.sh" } },
                role: "encoder",
                module: "encoder",
                state: emptyModuleState(),
                opts: {
                    installDir: ${JSON.stringify(appPath("client/modules/encoder/install"))},
                    root: process.env.TEST_ROOT,
                    installDeps: false,
                    purge: false,
                },
                transient: {},
            };
            try {
                await hooksProvider().run("hooksInstall", ctx);
                console.error("unexpected hook success");
                process.exitCode = 1;
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
            }
        `;
        const proc = Bun.spawn([process.execPath, "-e", code], {
            cwd: root,
            env: fixtureEnv("amd64", { TEST_ROOT: root, CTRLIRL_ROOT_OVERRIDE: "/" }),
            stdout: "ignore",
            stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stderr).text(),
        ]);
        expect(exitCode).toBe(0);
        expect(stderr).toContain("non-default install root");
        expect(await calls()).toBe("");
    });

    for (const board of ["generic", "raspberry_pi"] as const) {
        test(`the ${board} orchestrator passes the expected hook arguments`, async () => {
            const plan = await buildPlan(role, {}, { boardId: board });
            const commands: string[][] = [];
            const providers = [hooksProvider({
                fake: async (cmd, args) => {
                    expect(cmd).toBe("sh");
                    commands.push(args);
                    return runScript(args, "arm64");
                },
            })];
            const previousRoot = process.env.CTRLIRL_ROOT_OVERRIDE;
            process.env.CTRLIRL_ROOT_OVERRIDE = root;
            try {
                const result = await installPlan(plan, { providers, cfg: {} });
                expect(result.ok).toBe(true);
            } finally {
                if (previousRoot === undefined) delete process.env.CTRLIRL_ROOT_OVERRIDE;
                else process.env.CTRLIRL_ROOT_OVERRIDE = previousRoot;
            }
            expect(commands).toEqual([
                board === "raspberry_pi" ? [installScript, "arm64"] : [installScript],
            ]);
            expect(await calls()).toContain(`curl:${assetUrl("arm64")}`);
        });
    }
});
