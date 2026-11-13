import { describe, expect, test } from "bun:test";
import {
    applyVifSourceRoute,
    planVifSourceRoute,
    planVifSourceRouteRemoval,
    removeVifSourceRoute,
    VIF_SOURCE_RULE_PRIORITY,
    VIF_SOURCE_TABLE_BASE,
    VIF_SOURCE_TABLE_MAX_ORDINAL,
    vifSourceTable,
    type VifSourceRoute,
} from "../src/vif_source_route";
import type { CommandRunner } from "../src/types";

const vif: VifSourceRoute = {
    name: "relay0_enx76ae2",
    vifIp: "10.90.0.1",
    table: vifSourceTable(0),
};

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

describe("vifSourceTable", () => {
    test("lives below the relay-leg base (40), above the local table", () => {
        for (let n = 0; n <= VIF_SOURCE_TABLE_MAX_ORDINAL; n++)
            expect(vifSourceTable(n)).toBeGreaterThanOrEqual(20);
        for (let n = 0; n <= VIF_SOURCE_TABLE_MAX_ORDINAL; n++)
            expect(vifSourceTable(n)).toBeLessThan(40);
    });
    test("is monotonically increasing and bounded", () => {
        expect(vifSourceTable(0)).toBe(VIF_SOURCE_TABLE_BASE);
        expect(vifSourceTable(1)).toBe(VIF_SOURCE_TABLE_BASE + 1);
        expect(vifSourceTable(VIF_SOURCE_TABLE_MAX_ORDINAL)).toBe(39);
    });
    test("rejects out-of-range ordinals", () => {
        expect(() => vifSourceTable(-1)).toThrow();
        expect(() => vifSourceTable(VIF_SOURCE_TABLE_MAX_ORDINAL + 1)).toThrow();
    });
});

describe("planVifSourceRoute", () => {
    test("steers the vif source onto the TUN via a dedicated table", () => {
        const cmds = planVifSourceRoute(vif).map((c) => c.join(" "));
        expect(cmds).toEqual([
            "ip rule del from 10.90.0.1",
            `ip rule add from 10.90.0.1 lookup ${vif.table} priority ${VIF_SOURCE_RULE_PRIORITY}`,
            `ip route del default table ${vif.table}`,
            `ip route add default dev relay0_enx76ae2 table ${vif.table}`,
        ]);
    });
    test("rejects non-encoder TUN names", () => {
        expect(
            () =>
                planVifSourceRoute({ name: "rltun0", vifIp: "10.90.0.1", table: 20 }),
        ).toThrow();
        expect(
            () =>
                planVifSourceRoute({ name: "eth0", vifIp: "10.90.0.1", table: 20 }),
        ).toThrow();
    });
    test("rejects non-IPv4 vif addresses", () => {
        expect(
            () =>
                planVifSourceRoute({ name: "relay0_eth0", vifIp: "nope", table: 20 }),
        ).toThrow();
    });
});

describe("planVifSourceRouteRemoval", () => {
    test("drops the rule and the table default", () => {
        const cmds = planVifSourceRouteRemoval(vif).map((c) => c.join(" "));
        expect(cmds).toEqual([
            "ip rule del from 10.90.0.1",
            `ip route del default table ${vif.table}`,
        ]);
    });
});

describe("applyVifSourceRoute", () => {
    test("applies all steps", async () => {
        const { run, calls } = recordingRunner();
        await applyVifSourceRoute(run, vif);
        expect(calls).toHaveLength(4);
        expect(calls[1]).toContain("rule add from 10.90.0.1");
    });
    test("tolerates failing del steps (stale-state clearing)", async () => {
        const { run, calls } = recordingRunner((_cmd, args) =>
            args.includes("del"),
        );
        await expect(applyVifSourceRoute(run, vif)).resolves.toBeUndefined();
        expect(calls).toHaveLength(4);
    });
    test("throws on a failing add", async () => {
        const { run } = recordingRunner((_cmd, args) =>
            args.includes("add"),
        );
        await expect(applyVifSourceRoute(run, vif)).rejects.toThrow();
    });
});

describe("removeVifSourceRoute", () => {
    test("is fully best-effort (never throws)", async () => {
        const { run, calls } = recordingRunner(() => true);
        await expect(removeVifSourceRoute(run, vif)).resolves.toBeUndefined();
        expect(calls).toHaveLength(2);
    });
});
