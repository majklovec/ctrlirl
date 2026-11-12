import { describe, expect, test } from "bun:test";
import {
    applyLegPlan,
    legTable,
    planLegCommands,
    planLegRemoval,
    relayTunName,
    removeLegPlan,
    sweepStaleLegTuns,
} from "../src/nat_rules";
import type { CommandRunner } from "../src/types";
import type { LegPlan } from "../src/nat_rules";

const plan = { slot: 0, tun: "relay0_eno1", uplinkIface: "eno1", vifIp: "192.168.77.13" };

function recordingRunner(
    failOn?: (cmd: string, args: string[]) => boolean,
): { run: CommandRunner; calls: string[] } {
    const calls: string[] = [];
    const run: CommandRunner = async (cmd, ...args) => {
        calls.push([cmd, ...args].join(" "));
        if (failOn?.(cmd, args)) return { stdout: "boom", exitCode: 1 };
        return { stdout: "", exitCode: 0 };
    };
    return { run, calls };
}

describe("relayTunName", () => {
    test("matches the shared MobLink TUN pattern", () => {
        expect(relayTunName(0, "eno1")).toBe("relay0_eno1");
        expect(relayTunName(1, "enxb6db32817e7a")).toBe("relay1_enxb6db3");
    });
    test("caps at 15 chars", () => {
        const n = relayTunName(1, "enxb6db32817e7a");
        expect(n.length).toBeLessThanOrEqual(15);
    });
    test("rejects bad slots", () => {
        expect(() => relayTunName(-1, "eno1")).toThrow();
    });
});

describe("legTable", () => {
    test("stays below the network module's TABLE_BASE (100)", () => {
        for (let s = 0; s < 50; s++) expect(legTable(s)).toBeLessThan(100);
    });
    test("rejects overflow slots", () => {
        expect(() => legTable(70)).toThrow();
    });
});

describe("planLegCommands", () => {
    test("full ordering: routes→rules→NAT→FORWARD", () => {
        const cmds = planLegCommands(plan).map((c) => c.join(" "));
        expect(cmds).toContain("ip route add default dev eno1 table 40");
        expect(cmds).toContain("ip rule add iif relay0_eno1 table 40");
        expect(cmds).toContain("ip route add 192.168.77.13/32 dev relay0_eno1");
        expect(cmds).toContain(
            "iptables -t nat -I POSTROUTING 1 -s 192.168.77.13/32 -o eno1 -j MASQUERADE",
        );
        expect(cmds).toContain("iptables -I FORWARD 1 -i relay0_eno1 -j ACCEPT");
        expect(cmds).toContain("iptables -I FORWARD 2 -o relay0_eno1 -j ACCEPT");
        // dels always precede their adds.
        const i = (s: string) => cmds.findIndex((c) => c.includes(s));
        expect(i("route del default")).toBeLessThan(i("route add default"));
        expect(i("rule del lookup")).toBeLessThan(i("rule add iif"));
        expect(i('-D POSTROUTING')).toBeLessThan(i('-I POSTROUTING'));
    });

    test("removal is the inverse", () => {
        const p: LegPlan = { slot: 0, tun: "relay0_eno1", uplinkIface: "eno1", vifIp: "192.168.77.13" };
        const cmds = planLegRemoval(p).map((c) => c.join(" "));
        expect(cmds).toContain("ip rule del lookup 40");
        expect(cmds).toContain("ip route del default table 40");
        expect(cmds).toContain("ip route del 192.168.77.13/32 dev relay0_eno1");
        expect(cmds.some((c) => c.includes("-D POSTROUTING"))).toBe(true);
    });
});

describe("applyLegPlan", () => {
    test("del failures are tolerated", async () => {
        const { run, calls } = recordingRunner((cmd, args) =>
            args.includes("del") || args.includes("-D"),
        );
        await applyLegPlan(run, plan);
        expect(calls.length).toBeGreaterThan(8);
    });

    test("a real add failure throws", async () => {
        const { run } = recordingRunner((cmd, args) =>
            args.includes("add") && args.includes("table"),
        );
        await expect(applyLegPlan(run, plan)).rejects.toThrow(/leg plan step/);
    });

    test("removeLegPlan never throws", async () => {
        const { run } = recordingRunner(() => true);
        await expect(removeLegPlan(run, plan)).resolves.toBeUndefined();
    });
});

describe("sweepStaleLegTuns", () => {
    test("deletes only MobLink-pattern TUNs", async () => {
        const { run, calls } = recordingRunner();
        // monkeypatch: the runner returns a fake `ip -o link show` once.
        const orig: CommandRunner = run;
        const fake: CommandRunner = async (cmd, ...args) => {
            if (cmd === "ip" && args[0] === "-o" && args[1] === "link") {
                return {
                    stdout:
                        "1: lo: <LOOPBACK,UP> mtu 65536\n" +
                        "2: eno1: <BROADCAST,UP> mtu 1500\n" +
                        "3: relay0_wg0: <_TUN,UP> mtu 1500\n" +
                        "4: relay1_enxb6db3: <TUN,UP> mtu 1500\n" +
                        "5: wg0: <POINTOPOINT,UP> mtu 1420\n",
                    exitCode: 0,
                };
            }
            return orig(cmd, ...args);
        };
        const removed = await sweepStaleLegTuns(fake);
        expect(removed.sort()).toEqual(["relay0_wg0", "relay1_enxb6db3"]);
        expect(calls).toContain("ip link del relay0_wg0");
        expect(calls).toContain("ip link del relay1_enxb6db3");
        expect(calls.some((c) => c.includes("eno1"))).toBe(false);
    });
});
