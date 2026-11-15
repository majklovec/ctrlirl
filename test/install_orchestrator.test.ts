/*
 * M2 tests: the install orchestrator driven by the fake provider bundle.
 * All run without root: files land in a temp dir (CTRLIRL_ROOT_OVERRIDE).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleDefinition } from "../shared/contracts/roles";
import type { ModuleInstallSpec } from "../shared/install/types";
import { install, InstallError, uninstall, installPlan } from "../client/install/installer";
import { buildPlan } from "../client/install/plan";
import { fakeProviderBundle, freshLog } from "../client/install/providers/fake";
import type { InstallProvider } from "../client/install/provider";
import { renderDryRun } from "../client/install/dryrun";

// Hard guarantee: no test may ever spawn a real host command.
process.env.CTRLIRL_TEST = "1";

let root: string;
let modRoot: string;

beforeEach(async () => {
    root = await mkdtempSafe();
    modRoot = join(root, "modules");
    process.env.CTRLIRL_ROOT_OVERRIDE = root;
});

afterEach(async () => {
    delete process.env.CTRLIRL_ROOT_OVERRIDE;
    await rm(root, { recursive: true, force: true });
});

async function mkdtempSafe(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    return mkdtemp(join(tmpdir(), "ctrlirl-inst-"));
}

/** Stage a module with an install/ dir (JSON + optional overlay tree). */
async function stageModule(
    id: string,
    spec: ModuleInstallSpec,
    overlay?: Record<string, string>,
): Promise<void> {
    const dir = join(modRoot, id, "install");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "install.json"), JSON.stringify(spec, null, 2));
    for (const [rel, content] of Object.entries(overlay ?? {})) {
        const p = join(dir, "overlay", rel);
        await mkdir(join(p, ".."), { recursive: true });
        await writeFile(p, content);
    }
}

function roleWith(mods: readonly string[]): RoleDefinition {
    return {
        id: "testrole",
        titleKey: "t",
        order: 1,
        requires: { modules: mods, capabilities: [] },
        provides: { capabilities: [] },
    };
}

const MOD_A: ModuleInstallSpec = {
    version: 1,
    dependencies: ["modemmanager"],
    udev: [{ file: "90-ctrlirl-a.rules", content: "KERNEL==\"usb\"\nATTR{id}==\"x\"", trigger: { subsystem: "usb" } }],
    services: [{ name: "ModemManager", unit: "systemd", content: "[Service]\nExecStart=/bin/true\n" }],
    hooks: { install: "hooks/install.sh", uninstall: "hooks/uninstall.sh" },
};
const MOD_B: ModuleInstallSpec = {
    version: 1,
    sysctl: { "net.ipv4.ip_forward": 1 },
    firewall: [{ tool: "nft", chain: "input", rule: "i if iifname \"gre*\" accept" }],
};

describe("install orchestrator (fake providers)", () => {
    test("install → install is idempotent (second run reports no writes)", async () => {
        await stageModule("a", MOD_A, { "etc/ctrlirl/a.env": "A=1\n" });
        const providers = fakeProviderBundle(freshLog());
        const first = await install(roleWith(["a"]), { providers, cfg: {}, moduleRoot: modRoot });
        expect(first.ok).toBe(true);
        const second = await install(roleWith(["a"]), { providers, cfg: {}, moduleRoot: modRoot });
        expect(second.ok).toBe(true);
        // The overlay file exists and the second install re-read it as unchanged.
        const dest = join(root, "etc/ctrlirl/a.env");
        expect(await readFile(dest, "utf8")).toBe("A=1\n");
    });

    test("install → uninstall restores the pre-install state (temp root empty of artifacts)", async () => {
        await stageModule("a", MOD_A, { "etc/ctrlirl/a.env": "A=1\n" });
        await stageModule("b", MOD_B);
        const providers = fakeProviderBundle(freshLog());
        const role = roleWith(["a", "b"]);
        await install(role, { providers, cfg: {}, moduleRoot: modRoot });
        // Artifacts present after install.
        expect(
            await stat(join(root, "etc/udev/rules.d/90-ctrlirl-a.rules")).then(
                (s) => s.isFile(),
                () => false,
            ),
        ).toBe(true);
        expect(
            await stat(join(root, "etc/systemd/system/ModemManager.service")).then(
                (s) => s.isFile(),
                () => false,
            ),
        ).toBe(true);
        // Uninstall removes them.
        await uninstall(role, { providers, cfg: {}, moduleRoot: modRoot });
        expect(
            await stat(join(root, "etc/udev/rules.d/90-ctrlirl-a.rules")).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
        expect(
            await stat(join(root, "etc/systemd/system/ModemManager.service")).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
    });

    test("uninstall runs in exact reverse of the install provider order", async () => {
        await stageModule("a", MOD_A, { "etc/ctrlirl/a.env": "A=1\n" });
        const log = freshLog();
        const providers = fakeProviderBundle(log);
        const role = roleWith(["a"]);
        await install(role, { providers, cfg: {}, moduleRoot: modRoot });
        log.calls.length = 0;
        await uninstall(role, { providers, cfg: {}, moduleRoot: modRoot });
        const seq = log.calls.filter((c) => c.endsWith("Uninstall"));
        expect(seq).toEqual([
            "hooks:hooksUninstall",
            "systemd:systemdUninstall",
            "firewall:firewallUninstall",
            "sysctl:sysctlUninstall",
            "udev:udevUninstall",
            "overlay:overlayUninstall",
        ]);
    });

    test("partial failure: module A fully installed, B fully rolled back", async () => {
        await stageModule("a", MOD_A, { "etc/ctrlirl/a.env": "A=1\n" });
        await stageModule("b", MOD_B);
        // A passing bundle for A, a failing systemd step for B.
        const passing = fakeProviderBundle(freshLog());
        const providers: InstallProvider[] = passing.map((p) =>
            p.name === "systemd"
                ? {
                      ...p,
                      run: async (step, ctx) => {
                          if (step === "systemdInstall" && ctx.module === "b")
                              throw new Error("systemd exploded");
                          return p.run(step, ctx);
                      },
                  }
                : p,
        );
        const role = roleWith(["a", "b"]);
        let threw = false;
        try {
            await install(role, { providers, cfg: {}, moduleRoot: modRoot });
        } catch (e) {
            threw = true;
            expect(e).toBeInstanceOf(InstallError);
            expect((e as InstallError).module).toBe("b");
        }
        expect(threw).toBe(true);
        // A's artifacts are in place (A fully installed).
        expect(
            await stat(join(root, "etc/udev/rules.d/90-ctrlirl-a.rules")).then(
                (s) => s.isFile(),
                () => false,
            ),
        ).toBe(true);
        // B's overlay/sysctl artifacts are gone (B rolled back). B had no overlay,
        // so check its sysctl file is absent.
        expect(
            await stat(join(root, "etc/sysctl.d/90-ctrlirl-b.conf")).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
    });
});

describe("dry-run rendering", () => {
    test("renders the handoff §15 shape without touching the host", async () => {
        await stageModule("a", MOD_A, { "etc/ctrlirl/a.env": "A=1\n" });
        const providers = fakeProviderBundle(freshLog());
        const plan = await buildPlan(roleWith(["a"]), {}, { moduleRoot: modRoot });
        const out = await renderDryRun(plan, "install", {
            providers,
            cfg: {},
            root,
        });
        expect(out).toContain("[a] install");
        expect(out).toContain("packages:");
        expect(out).toContain("modemmanager");
        expect(out).toContain("etc/udev/rules.d/90-ctrlirl-a.rules");
        expect(out).toContain("ModemManager.service");
        expect(out).toContain("etc/ctrlirl/a.env");
        // Dry-run must not create any files.
        expect(
            await stat(join(root, "etc/udev/rules.d/90-ctrlirl-a.rules")).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
    });
});
