/*
 * M3 provider tests: systemd, sysctl, overlay — each with an idempotency pair
 * (install→install = no-op) and a reversal pair (install→uninstall = clean),
 * plus overlay's safety rails. All run without root: files land in a temp
 * root and every external command is faked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleInstallSpec, ModuleInstallState } from "../shared/install/types";
import type { ModuleCtx, ProviderOpts, StepKey } from "../client/install/provider";
import { fake, runLog, resetRunLog } from "../client/install/testrun";

// Hard guarantee: no test may ever spawn a real host command (systemctl, sysctl, …).
process.env.CTRLIRL_TEST = "1";
import { systemdProvider } from "../client/install/providers/systemd";
import { sysctlProvider } from "../client/install/providers/sysctl";
import { overlayProvider } from "../client/install/providers/overlay";
import { udevProvider } from "../client/install/providers/udev";
import { firewallProvider } from "../client/install/providers/firewall";
import type { RunOpts } from "../client/install/host";
import { emptyModuleState } from "../client/install/state";

let root: string;
let installDir: string;
let sysctlRoot: string; // a root that has a /proc/sys tree for prev-value reads

beforeEach(async () => {
    resetRunLog();
    root = await mkdtemp(join(tmpdir(), "ctrlirl-prov-"));
    installDir = join(root, "install");
    await mkdir(join(installDir, "overlay"), { recursive: true });
    // sysctlRoot mirrors /proc/sys for prev-value reads.
    sysctlRoot = root;
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function ctx(
    spec: ModuleInstallSpec,
    state: ModuleInstallState,
    over: Partial<ProviderOpts> = {},
): ModuleCtx {
    return {
        spec,
        role: "testrole",
        module: "mod",
        state,
        opts: {
            installDir,
            installDeps: false,
            purge: false,
            root,
            ...over,
        },
        transient: {},
    };
}

const svcSpec: ModuleInstallSpec = {
    version: 1,
    services: [{ name: "mmod", unit: "systemd", content: "[Service]\nExecStart=/bin/true\n" }],
};
const sysctlSpec: ModuleInstallSpec = {
    version: 1,
    sysctl: { "net.ipv4.ip_forward": 1 },
};

describe("systemd provider", () => {
    test("install → install is idempotent (no duplicate daemon-reload/enable)", async () => {
        const p = systemdProvider(fake());
        const state = emptyModuleState();
        const c1 = ctx(svcSpec, state);
        const r1 = await p.run("systemdInstall" as StepKey, c1);
        expect(r1.changed).toBe(true);
        const unit = join(root, "etc/systemd/system/mmod.service");
        expect(await readFile(unit, "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
        expect(runLog).toContain("systemctl daemon-reload");
        expect(runLog).toContain("systemctl enable mmod.service");
        // Second install: same content → no rewrite, state unchanged in count.
        const before = runLog.length;
        const r2 = await p.run("systemdInstall" as StepKey, ctx(svcSpec, state));
        expect(r2.lines.join()).toContain("unchanged, skip");
        expect(state.services).toHaveLength(1);
    });

    test("install → uninstall restores the pre-install state", async () => {
        const p = systemdProvider(fake());
        const state = emptyModuleState();
        await p.run("systemdInstall" as StepKey, ctx(svcSpec, state));
        const unit = join(root, "etc/systemd/system/mmod.service");
        expect(await stat(unit).then(() => true, () => false)).toBe(true);
        await p.run("systemdUninstall" as StepKey, ctx(svcSpec, state));
        expect(await stat(unit).then(() => true, () => false)).toBe(false);
        expect(state.services).toHaveLength(0);
        expect(runLog).toContain("systemctl disable --now mmod.service");
    });

    test("refuses to overwrite an unmanaged, pre-existing unit", async () => {
        const unitDir = join(root, "etc/systemd/system");
        await mkdir(unitDir, { recursive: true });
        await writeFile(join(unitDir, "mmod.service"), "operator unit\n");
        const p = systemdProvider(fake());
        const state = emptyModuleState();
        await expect(p.run("systemdInstall" as StepKey, ctx(svcSpec, state))).rejects.toThrow(
            /refusing to overwrite/,
        );
    });
});

describe("sysctl provider", () => {
    test("install → install is idempotent; records prev value", async () => {
        // Seed a current kernel value so prev is captured.
        const procKey = join(sysctlRoot, "proc/sys/net/ipv4/ip_forward");
        await mkdir(join(sysctlRoot, "proc/sys/net/ipv4"), { recursive: true });
        await writeFile(procKey, "1\n");
        const p = sysctlProvider(fake());
        const state = emptyModuleState();
        await p.run("sysctlInstall" as StepKey, ctx(sysctlSpec, state));
        expect(state.sysctl["net.ipv4.ip_forward"].prev).toBe("1");
        const conf = join(root, "etc/sysctl.d/90-ctrlirl-mod.conf");
        expect(await readFile(conf, "utf8")).toBe("net.ipv4.ip_forward = 1\n");
        expect(runLog).toContain("sysctl --system");
    });

    test("install → uninstall removes the file and restores prev", async () => {
        const procKey = join(sysctlRoot, "proc/sys/net/ipv4/ip_forward");
        await mkdir(join(sysctlRoot, "proc/sys/net/ipv4"), { recursive: true });
        await writeFile(procKey, "0\n");
        const p = sysctlProvider(fake());
        const state = emptyModuleState();
        await p.run("sysctlInstall" as StepKey, ctx(sysctlSpec, state));
        const conf = join(root, "etc/sysctl.d/90-ctrlirl-mod.conf");
        expect(await stat(conf).then(() => true, () => false)).toBe(true);
        await p.run("sysctlUninstall" as StepKey, ctx(sysctlSpec, state));
        expect(await stat(conf).then(() => true, () => false)).toBe(false);
        expect(state.sysctl).toEqual({});
    });
});

describe("overlay provider", () => {
    test("install writes files; second install is a no-op (skip-if-identical)", async () => {
        await writeFile(join(installDir, "overlay", "etc", "mod.env"), "A=1\n").catch(async () => {
            await mkdir(join(installDir, "overlay", "etc"), { recursive: true });
            await writeFile(join(installDir, "overlay", "etc", "mod.env"), "A=1\n");
        });
        const p = overlayProvider(fake());
        const state = emptyModuleState();
        const c = ctx({ version: 1 }, state);
        const r1 = await p.run("overlayInstall" as StepKey, c);
        expect(r1.changed).toBe(true);
        const dest = join(root, "etc", "mod.env");
        expect(await readFile(dest, "utf8")).toBe("A=1\n");
        const r2 = await p.run("overlayInstall" as StepKey, c);
        expect(r2.changed).toBe(false);
        expect(r2.lines.join()).toContain("unchanged, skip");
    });

    test("install → uninstall removes recorded files and prunes created dirs", async () => {
        const etc = join(installDir, "overlay", "etc");
        await mkdir(join(etc, "ctrlirl"), { recursive: true });
        await writeFile(join(etc, "ctrlirl", "mod.env"), "A=1\n");
        const p = overlayProvider(fake());
        const state = emptyModuleState();
        const c = ctx({ version: 1 }, state);
        await p.run("overlayInstall" as StepKey, c);
        const dest = join(root, "etc", "ctrlirl", "mod.env");
        expect(await stat(dest).then(() => true, () => false)).toBe(true);
        await p.run("overlayUninstall" as StepKey, c);
        expect(await stat(dest).then(() => true, () => false)).toBe(false);
        // The `etc/ctrlirl` dir we created should be pruned (empty now).
        expect(await stat(join(root, "etc", "ctrlirl")).then(() => true, () => false)).toBe(false);
    });

    test("symlink in the source is rejected", async () => {
        const outside = join(root, "outside.txt");
        await writeFile(outside, "secret\n");
        await mkdir(join(installDir, "overlay", "etc"), { recursive: true });
        await symlink(outside, join(installDir, "overlay", "etc", "link.txt"));
        const p = overlayProvider(fake());
        const state = emptyModuleState();
        await expect(
            p.run("overlayInstall" as StepKey, ctx({ version: 1 }, state)),
        ).rejects.toThrow(/symlink|escapes/);
    });

    test("protected path is refused unless in allowProtected", async () => {
        await mkdir(join(installDir, "overlay", "etc"), { recursive: true });
        await writeFile(join(installDir, "overlay", "etc", "passwd"), "root::0:0\n");
        const p = overlayProvider(fake());
        // Refused by default.
        await expect(
            p.run("overlayInstall" as StepKey, ctx({ version: 1 }, emptyModuleState())),
        ).rejects.toThrow(/protected path/);
        // Allowed with opt-in.
        const allowed = ctx(
            { version: 1, overlay: { allowProtected: ["/etc/passwd"] } },
            emptyModuleState(),
        );
        const r = await p.run("overlayInstall" as StepKey, allowed);
        expect(r.changed).toBe(true);
    });

    test("preserve skips a modified existing file with a warning", async () => {
        // Destination already exists with different content.
        const destDir = join(root, "etc");
        await mkdir(destDir, { recursive: true });
        await writeFile(join(destDir, "app.conf"), "operator edited\n");
        const srcDir = join(installDir, "overlay", "etc");
        await mkdir(srcDir, { recursive: true });
        await writeFile(join(srcDir, "app.conf"), "our default\n");
        const p = overlayProvider(fake());
        const state = emptyModuleState();
        const c = ctx({ version: 1, overlay: { preserve: ["etc/app.conf"] } }, state);
        const r = await p.run("overlayInstall" as StepKey, c);
        expect(r.lines.join()).toContain("preserve");
        // The operator's content survives.
        expect(await readFile(join(destDir, "app.conf"), "utf8")).toBe("operator edited\n");
    });
});

const udevSpec: ModuleInstallSpec = {
    version: 1,
    udev: [
        {
            file: "90-ctrlirl-mod.rules",
            content: "KERNEL==\"usb0\", NAME=\"wlan0\"\n",
            trigger: { subsystem: "usb", action: "change" },
        },
    ],
};

describe("udev provider", () => {
    test("install writes the headered rule; reload + trigger only then", async () => {
        const p = udevProvider(fake());
        const state = emptyModuleState();
        await p.run("udevInstall" as StepKey, ctx(udevSpec, state));
        const file = join(root, "etc/udev/rules.d/90-ctrlirl-mod.rules");
        const text = await readFile(file, "utf8");
        expect(text.startsWith("# managed by ctrlirl (testrole/mod)\n")).toBe(true);
        expect(runLog).toContain("udevadm control --reload-rules");
        expect(runLog).toContain(
            "udevadm trigger --subsystem-match=usb --action=change",
        );
    });

    test("install → install is idempotent (no second reload/trigger)", async () => {
        const p = udevProvider(fake());
        const state = emptyModuleState();
        await p.run("udevInstall" as StepKey, ctx(udevSpec, state));
        const before = runLog.length;
        const r2 = await p.run("udevInstall" as StepKey, ctx(udevSpec, state));
        expect(runLog.slice(before)).toHaveLength(0); // nothing re-executed
        expect(r2.lines.join()).toContain("unchanged, skip");
    });

    test("install → uninstall removes the rule and reloads exactly once", async () => {
        const p = udevProvider(fake());
        const state = emptyModuleState();
        await p.run("udevInstall" as StepKey, ctx(udevSpec, state));
        const file = join(root, "etc/udev/rules.d/90-ctrlirl-mod.rules");
        expect(await stat(file).then(() => true, () => false)).toBe(true);
        const before = runLog.length;
        await p.run("udevUninstall" as StepKey, ctx(udevSpec, state));
        expect(await stat(file).then(() => true, () => false)).toBe(false);
        expect(state.udevFiles).toHaveLength(0);
        expect(runLog.slice(before)).toEqual(["udevadm control --reload-rules"]);
    });

    test("uninstall with nothing recorded does not reload", async () => {
        const p = udevProvider(fake());
        const state = emptyModuleState();
        const before = runLog.length;
        await p.run("udevUninstall" as StepKey, ctx(udevSpec, state));
        expect(runLog.slice(before)).toHaveLength(0);
    });

    test("refuses to overwrite an unmanaged, pre-existing rule file", async () => {
        const dir = join(root, "etc/udev/rules.d");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "90-ctrlirl-mod.rules"), "operator rule\n");
        const p = udevProvider(fake());
        const state = emptyModuleState();
        await expect(
            p.run("udevInstall" as StepKey, ctx(udevSpec, state)),
        ).rejects.toThrow(/refusing to overwrite/);
    });

    test("rejects a filename outside the ctrlirl pattern", async () => {
        const p = udevProvider(fake());
        const state = emptyModuleState();
        const bad: ModuleInstallSpec = {
            version: 1,
            udev: [{ file: "5x-ctrlirl-mod.rules", content: "a\n" }],
        };
        await expect(p.run("udevInstall" as StepKey, ctx(bad, state))).rejects.toThrow(
            /does not match/,
        );
    });
});

describe("firewall provider (nft)", () => {
    const nftSpec: ModuleInstallSpec = {
        version: 1,
        firewall: [
            { tool: "nft", chain: "input", rule: "tcp dport 2000 accept" },
            { tool: "nft", chain: "input", rule: "tcp dport 2001 accept" },
            { tool: "nft", chain: "forward", rule: "ct state established accept" },
        ],
    };

    test("install applies one atomic batch; state records the table", async () => {
        const p = firewallProvider(fake());
        const state = emptyModuleState();
        await p.run("firewallInstall" as StepKey, ctx(nftSpec, state));
        expect(runLog.some((l) => l.startsWith("nft -f /"))).toBe(true);
        expect(state.firewall).toEqual({ type: "nft", table: "ctrlirl_testrole_mod" });
    });

    test("install → install is idempotent (no second batch)", async () => {
        const p = firewallProvider(fake());
        const state = emptyModuleState();
        await p.run("firewallInstall" as StepKey, ctx(nftSpec, state));
        const before = runLog.length;
        const r2 = await p.run("firewallInstall" as StepKey, ctx(nftSpec, state));
        expect(runLog.slice(before)).toHaveLength(0);
        expect(r2.lines.join()).toContain("unchanged, skip");
    });

    test("install → uninstall deletes the table (exit 2 tolerated)", async () => {
        // fake() answers every command with exit 0; the provider must accept
        // exit 2 (table absent) too — verify via a custom fake.
        const nftFake: RunOpts = {
            fake: (cmd, args) => {
                runLog.push(`${cmd} ${args.join(" ")}`);
                if (cmd === "nft" && args[0] === "delete" && args[1] === "table")
                    return { exitCode: 2, stdout: "", stderr: "No such file or directory" };
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const p = firewallProvider(nftFake);
        const state = emptyModuleState();
        await p.run("firewallInstall" as StepKey, ctx(nftSpec, state));
        await p.run("firewallUninstall" as StepKey, ctx(nftSpec, state));
        expect(runLog).toContain("nft delete table inet ctrlirl_testrole_mod");
        expect(state.firewall).toEqual({ type: "nft", table: "" });
    });

    test("fails clearly when nft is unavailable", async () => {
        const nftFake: RunOpts = {
            fake: (cmd, args) => {
                runLog.push(`${cmd} ${args.join(" ")}`);
                if (cmd === "nft" && args[0] === "list")
                    return { exitCode: 1, stdout: "", stderr: "nft: command not found" };
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
        const p = firewallProvider(nftFake);
        const state = emptyModuleState();
        await expect(
            p.run("firewallInstall" as StepKey, ctx(nftSpec, state)),
        ).rejects.toThrow(/nftables is required/);
    });
});

describe("firewall provider (iptables)", () => {
    const iptSpec: ModuleInstallSpec = {
        version: 1,
        firewall: [
            {
                tool: "iptables",
                chain: "INPUT",
                rule: "-p tcp --dport 2000 -j ACCEPT",
                comment: "ctrlirl mod 2000",
            },
        ],
    };

    /** Fake that replays appended tagged rules on `-S` so uninstall can find them. */
    const iptFake = (): RunOpts => {
        const tags: string[] = [];
        return {
            fake: (cmd, args) => {
                runLog.push(`${cmd} ${args.join(" ")}`);
                if (cmd === "iptables" && args.includes("-A")) {
                    const i = args.indexOf("--comment");
                    if (i >= 0) tags.push(args[i + 1]);
                }
                if (cmd === "iptables" && args.includes("-S"))
                    return {
                        exitCode: 0,
                        stdout:
                            "-P INPUT DROP\n" +
                            tags
                                .map(
                                    (t) =>
                                        `-A INPUT -p tcp -m comment --comment ${t} -j ACCEPT`,
                                )
                                .join("\n") +
                            "\n",
                        stderr: "",
                    };
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        };
    };

    test("install appends comment-tagged rules; state records the tags", async () => {
        const p = firewallProvider(iptFake());
        const state = emptyModuleState();
        await p.run("firewallInstall" as StepKey, ctx(iptSpec, state));
        expect(runLog[0]).toMatch(
            /^iptables -t filter -A INPUT -p tcp --dport 2000 -j ACCEPT -m comment --comment ctrlirl:testrole:mod:[0-9a-f]{8}$/,
        );
        expect(state.firewall).toEqual({
            type: "iptables",
            comments: [expect.stringMatching(/^ctrlirl:testrole:mod:[0-9a-f]{8}$/)],
        });
    });

    test("install → install is idempotent (no duplicate append)", async () => {
        const f = iptFake();
        const p = firewallProvider(f);
        const state = emptyModuleState();
        await p.run("firewallInstall" as StepKey, ctx(iptSpec, state));
        const appends = () => runLog.filter((l) => l.includes("-A INPUT")).length;
        expect(appends()).toBe(1);
        const before = appends();
        await p.run("firewallInstall" as StepKey, ctx(iptSpec, state));
        expect(appends()).toBe(before);
    });

    test("install → uninstall deletes exactly the tagged rule by position", async () => {
        const f = iptFake();
        const p = firewallProvider(f);
        const state = emptyModuleState();
        await p.run("firewallInstall" as StepKey, ctx(iptSpec, state));
        const before = runLog.length;
        await p.run("firewallUninstall" as StepKey, ctx(iptSpec, state));
        expect(runLog.slice(before)).toEqual([
            "iptables -t filter -S INPUT",
            "iptables -t filter -D INPUT 1",
        ]);
        expect(state.firewall).toEqual({ type: "iptables", comments: [] });
    });
});

// A fake `sh`/`systemctl`/etc. runner: records calls, always succeeds.
