/*
 * M5 tests: the two providers the orchestrator exercises last (packages,
 * hooks) against the real implementations via the RunOpts seam, plus an
 * end-to-end role switch through the real orchestrator + fake bundle (no root,
 * no host). `CTRLIRL_ROOT_OVERRIDE` keeps every state file inside a temp dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleInstallSpec, ModuleInstallState } from "../shared/install/types";
import type { ModuleCtx, ProviderOpts } from "../client/install/provider";
import type { RunOpts } from "../client/install/host";
import { packagesProvider } from "../client/install/providers/packages";
import { hooksProvider } from "../client/install/providers/hooks";
import { switchRole } from "../client/install/switch";
import { buildPlan } from "../client/install/plan";
import { installPlan } from "../client/install/installer";
import {
    fakeProviderBundle,
    fakeHooks,
    freshLog,
} from "../client/install/providers/fake";
import { emptyModuleState } from "../client/install/state";

process.env.CTRLIRL_TEST = "1";

let root: string;
let installDir: string;

beforeEach(async () => {
    root = await mktemp();
    installDir = join(root, "install");
    await mkdir(join(installDir, "hooks"), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function mktemp(): Promise<string> {
    const d = join(tmpdir(), `ctrlirl-m5-${Math.random().toString(36).slice(2)}`);
    await mkdir(d, { recursive: true });
    return d;
}

const ctx = (
    spec: ModuleInstallSpec,
    state: ModuleInstallState = emptyModuleState(),
): ModuleCtx => ({
    spec,
    role: "testrole",
    module: "mod",
    state,
    opts: {
        installDir,
        installDeps: false,
        purge: false,
        root,
    } as ProviderOpts,
    transient: {},
});

describe("packages provider", () => {
    test("present dependency is a no-op (no apt)", async () => {
        const calls: string[] = [];
        const opts: RunOpts = {
            fake: (cmd, args) => {
                calls.push(`${cmd} ${args.join(" ")}`);
                if (cmd === "dpkg" && args[0] === "-s")
                    return { exitCode: 0, stdout: "ok", stderr: "" };
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const p = packagesProvider(opts);
        const c = ctx({ version: 1, dependencies: ["ffmpeg"] });
        const res = await p.run("packagesCheck" as never, c);
        expect(calls.some((l) => l.startsWith("apt-get"))).toBe(false);
        expect(c.state.packagesAdded).toHaveLength(0);
        expect(res.lines.join()).toContain("(present)");
    });

    test("missing dependency without --install-deps throws", async () => {
        const opts: RunOpts = {
            fake: (cmd, args) => {
                if (cmd === "dpkg" && args[0] === "-s")
                    return { exitCode: 1, stdout: "", stderr: "no package" };
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const p = packagesProvider(opts);
        const c = ctx({ version: 1, dependencies: ["ffmpeg"] });
        await expect(p.run("packagesCheck" as never, c)).rejects.toThrow(
            /not installed/,
        );
    });

    test("missing dependency with --install-deps apt-installs and records it", async () => {
        const calls: string[] = [];
        const opts: RunOpts = {
            fake: (cmd, args) => {
                calls.push(`${cmd} ${args.join(" ")}`);
                if (cmd === "dpkg" && args[0] === "-s")
                    return { exitCode: 1, stdout: "", stderr: "no package" };
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const p = packagesProvider(opts);
        const c = ctx({ version: 1, dependencies: ["ffmpeg"] });
        c.opts.installDeps = true;
        await p.run("packagesCheck" as never, c);
        expect(calls).toContain("apt-get install -y ffmpeg");
        expect(c.state.packagesAdded).toEqual(["ffmpeg"]);
    });

    test("purge removes only the packages we added", async () => {
        const calls: string[] = [];
        const opts: RunOpts = {
            fake: (cmd, args) => {
                calls.push(`${cmd} ${args.join(" ")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const p = packagesProvider(opts);
        const c = ctx({ version: 1 });
        c.state.packagesAdded = ["ffmpeg", "libav-tools"];
        c.opts.purge = true;
        await p.run("packagesPurge" as never, c);
        expect(calls).toContain("apt-get remove -y ffmpeg");
        expect(calls).toContain("apt-get remove -y libav-tools");
        expect(c.state.packagesAdded).toHaveLength(0);
    });

    test("purge without the flag is a no-op", async () => {
        const calls: string[] = [];
        const opts: RunOpts = {
            fake: (cmd, args) => {
                calls.push(`${cmd} ${args.join(" ")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const p = packagesProvider(opts);
        const c = ctx({ version: 1 });
        c.state.packagesAdded = ["ffmpeg"];
        c.opts.purge = false;
        const res = await p.run("packagesPurge" as never, c);
        expect(calls).toHaveLength(0);
        expect(res.changed).toBe(false);
        expect(c.state.packagesAdded).toEqual(["ffmpeg"]); // untouched
    });
});

describe("hooks provider", () => {
    test("install hook runs with the env and is recorded", async () => {
        const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> =
            [];
        const opts: RunOpts = {
            fake: (cmd, args) => {
                calls.push({ cmd, args });
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const p = hooksProvider(opts);
        const c = ctx({ version: 1, hooks: { install: "hooks/install.sh" } });
        await p.run("hooksInstall" as never, c);
        expect(calls).toHaveLength(1);
        expect(calls[0].cmd).toBe("sh");
        expect(calls[0].args).toEqual([join(installDir, "hooks/install.sh")]);
        expect(c.state.hooksRun).toContain("mod:install");
    });

    test("passes hook arguments literally on install and uninstall", async () => {
        const calls: string[][] = [];
        const p = hooksProvider({
            fake: (_cmd, args) => {
                calls.push(args);
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        });
        const c = ctx({
            version: 1,
            hooks: {
                install: ["hooks/install script.sh", "arm64", "argument with spaces", "", "$(echo unsafe)"],
                uninstall: ["hooks/uninstall.sh", "arm64"],
            },
        });
        expect(await p.dryRun("install", c)).toEqual([{
            mark: "*",
            target: join(installDir, "hooks/install script.sh"),
            detail: 'arguments: "arm64" "argument with spaces" "" "$(echo unsafe)"',
        }]);
        await p.run("hooksInstall", c);
        await p.run("hooksUninstall", c);
        expect(calls).toEqual([
            [join(installDir, "hooks/install script.sh"), "arm64", "argument with spaces", "", "$(echo unsafe)"],
            [join(installDir, "hooks/uninstall.sh"), "arm64"],
        ]);
    });

    test("fake hooks support argument arrays", async () => {
        const c = ctx({ version: 1, hooks: { install: ["hooks/install.sh", "arm64"] } });
        const p = fakeHooks(freshLog());
        expect(await p.dryRun("install", c)).toEqual([
            { mark: "*", target: "hooks/install.sh", detail: 'arguments: "arm64"' },
        ]);
        await p.run("hooksInstall", c);
        expect(c.state.hooksRun).toEqual(["hooks/install.sh arm64"]);
    });

    test("uninstall hook runs only if the install hook ran", async () => {
        const calls: string[] = [];
        const opts: RunOpts = {
            fake: (cmd, args) => {
                calls.push(`${cmd} ${args.join(" ")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const p = hooksProvider(opts);
        const c = ctx({
            version: 1,
            hooks: { install: "hooks/install.sh", uninstall: "hooks/uninstall.sh" },
        });
        // No install record → uninstall hook stays put.
        await p.run("hooksUninstall" as never, c);
        expect(calls).toHaveLength(0);
        // Record the install having run, then uninstall.
        c.state.hooksRun.push("mod:install");
        await p.run("hooksUninstall" as never, c);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain("hooks/uninstall.sh");
        expect(c.state.hooksRun).not.toContain("mod:install");
    });

    test("a failing hook throws and is not recorded", async () => {
        const opts: RunOpts = {
            fake: () => ({
                exitCode: 1,
                stdout: "",
                stderr: "boom",
            }),
        };
        const p = hooksProvider(opts);
        const c = ctx({ version: 1, hooks: { install: "hooks/install.sh" } });
        await expect(p.run("hooksInstall" as never, c)).rejects.toThrow(/failed/);
        expect(c.state.hooksRun).toHaveLength(0);
    });
});

describe("switchRole (orchestrator + fake bundle)", () => {
    let moduleRoot: string;

    beforeEach(async () => {
        // State files (loadState/saveState) honor this override.
        process.env.CTRLIRL_ROOT_OVERRIDE = root;
        moduleRoot = await mktemp();
        // shared: a sysctl rule present in both roles (byte-identical).
        await writeModuleSpec(moduleRoot, "shared", {
            version: 1,
            sysctl: { "net.ipv4.ip_forward": 1 },
        });
        // oldonly: present only in the old role.
        await writeModuleSpec(moduleRoot, "oldonly", {
            version: 1,
            udev: [
                {
                    file: "60-ctrlirl-old.rules",
                    content: "KERNEL==\"x\"\n",
                },
            ],
        });
        // newonly: present only in the new role.
        await writeModuleSpec(moduleRoot, "newonly", {
            version: 1,
            udev: [
                {
                    file: "60-ctrlirl-new.rules",
                    content: "KERNEL==\"y\"\n",
                },
            ],
        });
    });

    afterEach(async () => {
        await rm(moduleRoot, { recursive: true, force: true });
    });

    async function writeModuleSpec(
        rootDir: string,
        id: string,
        spec: ModuleInstallSpec,
    ): Promise<void> {
        const dir = join(rootDir, id, "install");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "install.json"), JSON.stringify(spec, null, 2));
    }

    const roleDef = (
        id: "old" | "new",
        modules: readonly string[],
    ): import("../shared/contracts/roles").RoleDefinition => ({
        id,
        titleKey: id,
        order: 0,
        requires: { modules, capabilities: [] },
        provides: { capabilities: [] },
    });

    test("shared module survives; old-only torn down; new-only installed", async () => {
        const log = freshLog();
        const providers = fakeProviderBundle(log);
        const base = {
            providers,
            cfg: {},
            moduleRoot,
            root,
        };

        // 1. Install the OLD role first (establishes its state file).
        const oldDef = roleDef("old", ["shared", "oldonly"]);
        const oldPlan = await buildPlan(oldDef, {}, { moduleRoot });
        await installPlan(oldPlan, base);

        // The old role now owns shared + oldonly.
        const sharedBefore = await stat(join(root, "etc/sysctl.d/90-ctrlirl-shared.conf"));

        // 2. Switch old → new.
        const newDef = roleDef("new", ["shared", "newonly"]);
        const res = await switchRole("old", "new", newDef, {
            ...base,
            oldRoleDef: oldDef,
        });

        expect(res.unchanged).toEqual(["shared"]);
        expect(res.removed).toEqual(["oldonly"]);
        expect(res.added).toEqual(["newonly"]);

        // The shared sysctl file is untouched (still present, identical).
        const sharedAfter = await stat(join(root, "etc/sysctl.d/90-ctrlirl-shared.conf"));
        expect(sharedAfter.mtimeMs).toBe(sharedBefore.mtimeMs);

        // oldonly's udev rule is gone; newonly's is present.
        expect(
            await stat(join(root, "etc/udev/rules.d/60-ctrlirl-old.rules")).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
        expect(
            await stat(join(root, "etc/udev/rules.d/60-ctrlirl-new.rules")).then(
                () => true,
                () => false,
            ),
        ).toBe(true);
    });

    test("switch from null role is a plain install", async () => {
        const log = freshLog();
        const providers = fakeProviderBundle(log);
        const newDef = roleDef("new", ["shared", "newonly"]);
        const res = await switchRole(null, "new", newDef, {
            providers,
            cfg: {},
            moduleRoot,
            root,
        });
        expect(res.unchanged).toEqual([]);
        expect(res.added).toEqual(["shared", "newonly"]);
        expect(
            await stat(join(root, "etc/sysctl.d/90-ctrlirl-shared.conf")).then(
                () => true,
                () => false,
            ),
        ).toBe(true);
    });
});
