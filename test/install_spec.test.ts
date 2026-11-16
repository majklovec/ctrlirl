/*
 * M1 tests: merge, placeholder resolution and schema validation for install
 * specs. All pure — no host access.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstSpecError, mergeSpec } from "../shared/install/merge";
import {
    resolvePlaceholdersIn,
    resolveSpec,
} from "../shared/install/resolve";
import type { ModuleInstallSpec } from "../shared/install/types";
import { validateSpec, validateSpecDetailed } from "../shared/install/validate";

describe("mergeSpec", () => {
    const base = (): ModuleInstallSpec => ({
        version: 1,
        dependencies: ["modemmanager"],
        services: [{ name: "ModemManager", unit: "systemd", content: "base" }],
        sysctl: { "net.ipv4.ip_forward": 1 },
        firewall: [
            { tool: "nft", chain: "input", rule: "i rule" },
            { tool: "iptables", chain: "INPUT", rule: "i2", comment: "c" },
        ],
        udev: [{ file: "90-ctrlirl-modems.rules", content: "u" }],
        hooks: { install: "hooks/install.sh" },
    });

    test("role wins on objects; arrays concatenate and dedupe", () => {
        const merged = mergeSpec(base(), {
            version: 1,
            dependencies: ["modemmanager", "libqmi"],
            services: [
                { name: "ModemManager", unit: "systemd", content: "role" },
                { name: "NetworkManager", unit: "systemd", content: "nm" },
            ],
            sysctl: { "net.ipv4.ip_forward": 2 },
            firewall: [
                { tool: "nft", chain: "input", rule: "i rule" },
                { tool: "nft", chain: "forward", rule: "f rule" },
            ],
            udev: [{ file: "90-ctrlirl-modems.rules", content: "u2" }],
        });
        expect(merged.dependencies).toEqual(["modemmanager", "libqmi"]);
        // services dedupe by name, role entry wins (later in the concat)
        expect(merged.services).toHaveLength(2);
        expect(merged.services?.[0]?.name).toBe("ModemManager");
        expect(merged.services?.[0]?.content).toBe("role");
        expect(merged.sysctl?.["net.ipv4.ip_forward"]).toBe(2);
        // firewall dedupe by (tool, table, chain, rule), udev by file
        expect(merged.firewall).toHaveLength(3);
        expect(merged.udev).toHaveLength(1);
        expect(merged.udev?.[0]?.content).toBe("u2");
    });

    test("hooks: a role key overrides the base key wholesale", () => {
        const merged = mergeSpec(base(), {
            version: 1,
            hooks: { install: "hooks/role-install.sh" },
        });
        // role set `install` -> replaced; `uninstall` absent on both -> absent
        expect(merged.hooks?.install).toBe("hooks/role-install.sh");
        expect(merged.hooks?.uninstall).toBeUndefined();

        const merged2 = mergeSpec(
            { ...base(), hooks: { install: "a.sh", uninstall: "u.sh" } },
            { version: 1, hooks: { install: "b.sh" } },
        );
        expect(merged2.hooks?.install).toBe("b.sh");
        // role did NOT set uninstall -> base's survives
        expect(merged2.hooks?.uninstall).toBe("u.sh");
    });

    test("version mismatch throws", () => {
        expect(() => mergeSpec({ version: 2 } as never, { version: 1 })).toThrow(
            InstSpecError,
        );
    });

    test("overlay arrays concatenate and dedupe; hooks survive without role hooks", () => {
        const merged = mergeSpec(
            {
                version: 1,
                overlay: { preserve: ["etc/a"], reload: ["x"], allowProtected: ["/etc/passwd"] },
            },
            {
                version: 1,
                overlay: { preserve: ["etc/b", "etc/a"], reload: ["y", "x"] },
                hooks: { uninstall: "u.sh" },
            },
        );
        expect(merged.overlay?.preserve).toEqual(["etc/a", "etc/b"]);
        expect(merged.overlay?.reload).toEqual(["x", "y"]);
        expect(merged.overlay?.allowProtected).toEqual(["/etc/passwd"]);
        expect(merged.hooks?.uninstall).toBe("u.sh");
    });
});

describe("resolve", () => {
    test("[[file:]] inlines a file under install/; [[env:]] and [[cfg:]] resolve", async () => {
        const dir = await (await import("node:fs/promises")).mkdtemp(
            join(tmpdir(), "ctrlirl-resolve-"),
        );
        await mkdir(join(dir, "udev"));
        await writeFile(join(dir, "udev", "a.rules"), "KERNEL==\"usb\"");
        process.env.CTRLIRL_TEST_TOKEN = "abc";
        const out = await resolvePlaceholdersIn(
            "head {{file:udev/a.rules}} token:{{env:CTRLIRL_TEST_TOKEN}} port:{{cfg:relay.port}}",
            dir,
            { relay: { port: 9999 } },
        );
        expect(out).toBe('head KERNEL=="usb" token:abc port:9999');
        delete process.env.CTRLIRL_TEST_TOKEN;
        await import("node:fs/promises").then((m) => m.rm(dir, { recursive: true, force: true }));
    });

    test("[[env:]] throws when unset; [[cfg:]] throws on missing path", async () => {
        await expect(
            resolvePlaceholdersIn("{{env:CTRLIRL_DOES_NOT_EXIST_}}", "/tmp", {}),
        ).rejects.toThrow(/CTRLIRL_DOES_NOT_EXIST_/);
        await expect(
            resolvePlaceholdersIn("{{cfg:no.such.path}}", "/tmp", { a: 1 }),
        ).rejects.toThrow(/no\.such\.path/);
    });

    test("{{file:}} cannot escape the install directory", async () => {
        await expect(
            resolvePlaceholdersIn("{{file:../evil.txt}}", "/tmp/inst", {}),
        ).rejects.toThrow(/escapes the install directory/);
    });

    test("resolveSpec resolves service content, firewall rules and udev content", async () => {
        const dir = await (await import("node:fs/promises")).mkdtemp(
            join(tmpdir(), "ctrlirl-resolve-spec-"),
        );
        await mkdir(join(dir, "units"));
        await writeFile(join(dir, "units", "x.service"), "ExecStart=/bin/true {{cfg:ssh.user}}");
        const spec: ModuleInstallSpec = {
            version: 1,
            services: [{ name: "x", unit: "systemd", contentFile: "units/x.service" }],
            firewall: [{ tool: "nft", chain: "input", rule: "port {{cfg:port}}" }],
            udev: [{ file: "90-ctrlirl-x.rules", content: "ENV{{env:CTRLIRL_R_}}" }],
        };
        process.env.CTRLIRL_R_ = "usb";
        const resolved = await resolveSpec(spec, dir, { ssh: { user: "pi" }, port: 1234 });
        delete process.env.CTRLIRL_R_;
        expect(resolved.services?.[0]?.content).toBe("ExecStart=/bin/true pi");
        expect(resolved.firewall?.[0]?.rule).toBe("port 1234");
        expect(resolved.udev?.[0]?.content).toBe("ENVusb");
        await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
    });
});

describe("validateSpec", () => {
    test("unknown key rejected", () => {
        const issues = validateSpecDetailed({ version: 1, familly: "inet" });
        expect(issues.some((i) => i.message === "unknown key" && i.path.endsWith("familly"))).toBe(
            true,
        );
    });

    test("udev filename pattern enforced; version mismatch rejected", () => {
        // `99-ctrlirl-x.rules` is a legal name (two digits) ...
        expect(
            validateSpecDetailed({ version: 1, udev: [{ file: "99-ctrlirl-x.rules" }] }),
        ).toHaveLength(0);
        // ... but one without the ctrlirl prefix is not.
        const badName = validateSpecDetailed({
            version: 1,
            udev: [{ file: "zz-ctrlirl-bad.rules" }],
        });
        expect(badName.some((i) => i.path.includes("file"))).toBe(true);
        const badVersion = validateSpecDetailed({ version: 2 });
        expect(badVersion.some((i) => i.path.endsWith("version"))).toBe(true);
    });

    test("iptables rules require a comment", () => {
        const issues = validateSpecDetailed({
            version: 1,
            firewall: [{ tool: "iptables", chain: "INPUT", rule: "-j ACCEPT" }],
        });
        expect(issues.some((i) => i.path.includes("comment") && i.message === "is required")).toBe(
            true,
        );
    });

    test("hooks accept script paths or nonempty argument arrays", () => {
        expect(validateSpecDetailed({
            version: 1,
            hooks: { install: ["hooks/install.sh", "arm64", ""], uninstall: "hooks/uninstall.sh" },
        })).toHaveLength(0);
        for (const hook of [[], [""], [123], ["hooks/install.sh", 123]]) {
            expect(validateSpecDetailed({ version: 1, hooks: { install: hook } }).length)
                .toBeGreaterThan(0);
        }
    });

    test("a fully valid spec passes and validateSpec returns it", () => {
        const spec: ModuleInstallSpec = {
            version: 1,
            dependencies: ["modemmanager"],
            services: [{ name: "ModemManager", unit: "systemd", content: "# x" }],
            sysctl: { "net.ipv4.ip_forward": 1 },
            firewall: [
                { tool: "nft", chain: "input", rule: "i if iifname \"gre*\" accept" },
            ],
            udev: [{ file: "10-ctrlirl-modems.rules", content: "KERNEL==\"usb\"" }],
            overlay: { reload: ["systemd-tmpfiles --create"] },
            hooks: { install: "hooks/install.sh" },
        };
        expect(validateSpecDetailed(spec)).toHaveLength(0);
        expect(validateSpec(spec)).toBe(spec);
    });
});
