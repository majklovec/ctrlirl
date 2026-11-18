import { describe, expect, test } from "bun:test";
import {
    applyLegPlan,
    applyVifPlan,
    LEG_TUN_NAME_RE,
    legTable,
    planLegBaseCommands,
    planLegCommands,
    planLegRemoval,
    planVifCommands,
    planVifRemoval,
    relayTunName,
    removeLegPlan,
    removeVifPlan,
    sweepStaleLegTuns,
} from "../src/nat_rules";
import type { CommandRunner } from "../src/types";
import type { LegPlan } from "../src/nat_rules";

// The base leg plan is vif-independent; the vif is applied separately.
// Leg TUNs are `rtltun_<iface>` (relay-side) - the `rltun<R>_<iface>` names
// are the ENCODER-side tunnels (CTRLINK_TUN_NAME_RE) and never appear here.
const plan: LegPlan = { slot: 0, tun: "rtltun_eno1", uplinkIface: "eno1" };
const VIF = "192.168.77.13";

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
    test("is the relay-side leg name rtltun_<iface> (named after the uplink)", () => {
        expect(relayTunName("eth0")).toBe("rtltun_eth0");
        expect(relayTunName("wwan2")).toBe("rtltun_wwan2");
        // The `rltun<R>_<iface>` encoder-side namespace must never collide
        // with the relay leg name.
        expect(relayTunName("eth0").startsWith("rltun")).toBe(false);
    });
    test("matches the leg TUN pattern", () => {
        for (const ifc of ["eth0", "eno1", "wwan2", "wlan0"])
            expect(LEG_TUN_NAME_RE.test(relayTunName(ifc))).toBe(true);
    });
    test("rejects bad ifaces", () => {
        expect(() => relayTunName("")).toThrow();
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

describe("planLegBaseCommands (vif-independent)", () => {
    const cmds = () => planLegBaseCommands(plan).map((c) => c.join(" "));
    test("egress table + iif rule + FORWARD, no vif/NAT", () => {
        expect(cmds()).toContain("ip route add default dev eno1 table 40");
        expect(cmds()).toContain("ip rule add iif rtltun_eno1 table 40");
        expect(cmds()).toContain("iptables -I FORWARD 1 -i rtltun_eno1 -j ACCEPT");
        expect(cmds()).toContain("iptables -I FORWARD 2 -o rtltun_eno1 -j ACCEPT");
        // The base never references a vif or MASQUERADE.
        expect(cmds().some((c) => c.includes("192.168.77.13"))).toBe(false);
        expect(cmds().some((c) => c.includes("MASQUERADE"))).toBe(false);
    });
    test("carries the uplink gateway when provided", () => {
        const g = planLegBaseCommands({ ...plan, uplinkGateway: "172.21.254.48" })
            .map((c) => c.join(" "));
        expect(g).toContain(
            "ip route add default via 172.21.254.48 dev eno1 table 40",
        );
        expect(g.some((c) => c.includes("default dev eno1"))).toBe(false);
    });
    test("dels precede their adds", () => {
        const c = cmds();
        const i = (s: string) => c.findIndex((x) => x.includes(s));
        expect(i("route del default")).toBeLessThan(i("route add default"));
        expect(i("rule del lookup")).toBeLessThan(i("rule add iif"));
    });
});

describe("planVifCommands (learned encoder vif)", () => {
    test("reply route + MASQUERADE keyed on the vif", () => {
        const c = planVifCommands(plan, VIF).map((x) => x.join(" "));
        expect(c).toContain("ip route add 192.168.77.13/32 dev rtltun_eno1");
        expect(c).toContain(
            "iptables -t nat -I POSTROUTING 1 -s 192.168.77.13/32 -o eno1 -j MASQUERADE",
        );
        // del precedes add for both.
        const i = (s: string) => c.findIndex((x) => x.includes(s));
        expect(i("route del 192.168.77.13/32")).toBeLessThan(
            i("route add 192.168.77.13/32"),
        );
        expect(i("-D POSTROUTING")).toBeLessThan(i("-I POSTROUTING"));
    });
    test("nat=false omits MASQUERADE (reply route stays)", () => {
        const c = planVifCommands({ ...plan, nat: false }, VIF).map((x) =>
            x.join(" "),
        );
        expect(c.some((x) => x.includes("MASQUERADE"))).toBe(false);
        expect(c).toContain("ip route add 192.168.77.13/32 dev rtltun_eno1");
    });
});

describe("planLegCommands (base + vif, when known up front)", () => {
    test("full ordering: routes→rules→FORWARD→vif route→NAT", () => {
        const cmds = planLegCommands(plan, VIF).map((c) => c.join(" "));
        expect(cmds).toContain("ip route add default dev eno1 table 40");
        expect(cmds).toContain("ip rule add iif rtltun_eno1 table 40");
        expect(cmds).toContain("ip route add 192.168.77.13/32 dev rtltun_eno1");
        expect(cmds).toContain(
            "iptables -t nat -I POSTROUTING 1 -s 192.168.77.13/32 -o eno1 -j MASQUERADE",
        );
        expect(cmds).toContain("iptables -I FORWARD 1 -i rtltun_eno1 -j ACCEPT");
        expect(cmds).toContain("iptables -I FORWARD 2 -o rtltun_eno1 -j ACCEPT");
        // FORWARD comes before the vif-specific NAT (base first).
        const i = (s: string) => cmds.findIndex((c) => c.includes(s));
        expect(i("FORWARD 1 -i")).toBeLessThan(i("route add 192.168.77.13/32"));
    });
    test("no vif arg → base only", () => {
        expect(planLegCommands(plan).map((c) => c.join(" ")).some((c) =>
            c.includes("192.168.77.13"),
        )).toBe(false);
    });
    test("removal is the inverse (base) + vif removal is separate", () => {
        const base = planLegRemoval(plan).map((c) => c.join(" "));
        expect(base).toContain("ip rule del lookup 40");
        expect(base).toContain("ip route del default table 40");
        expect(base.some((c) => c.includes("192.168.77.13"))).toBe(false);
        const vif = planVifRemoval(plan, VIF).map((c) => c.join(" "));
        expect(vif).toContain("ip route del 192.168.77.13/32 dev rtltun_eno1");
        expect(vif).toContain(
            "iptables -t nat -D POSTROUTING -s 192.168.77.13/32 -o eno1 -j MASQUERADE",
        );
    });
    test("vif removal with nat=false drops only the reply route", () => {
        const vif = planVifRemoval({ ...plan, nat: false }, VIF).map((c) =>
            c.join(" "),
        );
        expect(vif).toContain("ip route del 192.168.77.13/32 dev rtltun_eno1");
        expect(vif.some((c) => c.includes("MASQUERADE"))).toBe(false);
    });
});

describe("applyLegPlan / applyVifPlan", () => {
    test("base apply tolerates del failures", async () => {
        const { run, calls } = recordingRunner((cmd, args) =>
            args.includes("del") || args.includes("-D"),
        );
        await applyLegPlan(run, plan);
        // 8 base steps: 2 route, 2 rule, 4 FORWARD.
        expect(calls).toHaveLength(8);
    });
    test("a real base add failure throws", async () => {
        const { run } = recordingRunner((cmd, args) =>
            args.includes("add") && args.includes("table"),
        );
        await expect(applyLegPlan(run, plan)).rejects.toThrow(/leg plan step/);
    });
    test("applyVifPlan issues the vif part", async () => {
        const { run, calls } = recordingRunner();
        await applyVifPlan(run, { ...plan, nat: true }, VIF);
        expect(calls).toContain("ip route add 192.168.77.13/32 dev rtltun_eno1");
        expect(calls).toContain(
            "iptables -t nat -I POSTROUTING 1 -s 192.168.77.13/32 -o eno1 -j MASQUERADE",
        );
    });
    test("removeLegPlan never throws", async () => {
        const { run } = recordingRunner(() => true);
        await expect(removeLegPlan(run, plan)).resolves.toBeUndefined();
    });
    test("removeVifPlan never throws", async () => {
        const { run } = recordingRunner(() => true);
        await expect(removeVifPlan(run, plan, VIF)).resolves.toBeUndefined();
    });
});

describe("sweepStaleLegTuns", () => {
    test("deletes current (rtltun_*) leg TUNs only", async () => {
        const { run, calls } = recordingRunner();
        // monkeypatch: the runner returns a fake `ip -o link show` once.
        const orig: CommandRunner = run;
        const fake: CommandRunner = async (cmd, ...args) => {
            if (cmd === "ip" && args[0] === "-o" && args[1] === "link") {
                return {
                    stdout:
                        "1: lo: <LOOPBACK,UP> mtu 65536\n" +
                        "2: eno1: <BROADCAST,UP> mtu 1500\n" +
                        "3: rtltun_eno1: <_TUN,UP> mtu 1500\n" +
                        "4: rtltun_wwan2: <TUN,UP> mtu 1500\n" +
                        "5: wg0: <POINTOPOINT,UP> mtu 1420\n",
                    exitCode: 0,
                };
            }
            return orig(cmd, ...args);
        };
        const removed = await sweepStaleLegTuns(fake);
        expect(removed.sort()).toEqual(["rtltun_eno1", "rtltun_wwan2"]);
        expect(calls).toContain("ip link del rtltun_eno1");
        expect(calls).toContain("ip link del rtltun_wwan2");
        expect(calls.some((c) => c.includes("eno1 "))).toBe(false);
    });
});
