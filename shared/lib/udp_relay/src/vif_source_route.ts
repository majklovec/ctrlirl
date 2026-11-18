/**
 * Per-source egress routing for ENCODER-side vifs (the `relay<X>_<iface>` TUNs
 * carrying `10.{90+x}.{y}.1`).
 *
 * Why the kernel needs this: `srtla_send` binds its sources to the vif IPs
 * (the uplinks file), and a `sendto()` from a strictly-bound source fails the
 * FIB lookup unless an `ip rule from <vifIp>` steers egress onto the TUN -
 * the main-table default (LAN gateway) carries a different preferred source,
 * so the socket gets ENETUNREACH and the TUN stays completely idle. With the
 * per-source table in place:
 *
 *   srtla (src vif) → `ip rule from <vifIp> lookup <T>`
 *       → `default dev <tun>` in <T> → TUN reader → UDP frame → relay leg
 *
 * The reply direction needs nothing here: the relay serves the `to vif/32
 * dev rltun` route and the encoder's vif UDP socket writes replies straight
 * into the TUN for the local (bound) socket.
 *
 * Table numbering: network module owns ≥ 100, relay legs use 40-99
 * (LEG_TABLE_BASE), so encoder vif source tables live at 20 + ordinal -
 * disjoint from both.
 *
 * The library is rootless: plans are pure (unit-testable) and applied through
 * an injected command runner, mirroring `nat_rules.ts`.
 */

import { CTRLINK_TUN_NAME_RE } from "../../../ctrlink_discovery";
import type { CommandRunner } from "./types.js";

/** Lower bound of the encoder vif source tables (below the leg base of 40). */
export const VIF_SOURCE_TABLE_BASE = 20;
/** Max ordinal: tables 20-39 (the leg range starts at 40). */
export const VIF_SOURCE_TABLE_MAX_ORDINAL = 19;
/** `ip rule` priority - irrelevant among `from` rules (disjoint sources),
 * only needs to sit ahead of the main table. */
export const VIF_SOURCE_RULE_PRIORITY = 300;

/** Source-routing table for vif ordinal `n` (20 + n, bounded below 40). */
export function vifSourceTable(ordinal: number): number {
    if (
        !Number.isInteger(ordinal) ||
        ordinal < 0 ||
        ordinal > VIF_SOURCE_TABLE_MAX_ORDINAL
    )
        throw new Error(
            `vif source table ordinal out of range [0, ${VIF_SOURCE_TABLE_MAX_ORDINAL}]: ${ordinal}`,
        );
    return VIF_SOURCE_TABLE_BASE + ordinal;
}

/** One encoder vif to steer egress for. */
export interface VifSourceRoute {
    /** TUN device name (`relay<X>_<iface>`, the vif's egress device). */
    name: string;
    /** The vif's local IP (`10.{90+x}.{y}.1`) - the source to pin. */
    vifIp: string;
    /** Routing table (see `vifSourceTable`). */
    table: number;
}

type Cmd = [string, ...string[]];

function assertVifSourceRoute(p: VifSourceRoute): void {
    if (!CTRLINK_TUN_NAME_RE.test(p.name))
        throw new Error(`not an encoder tunnel TUN name: ${p.name}`);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(p.vifIp))
        throw new Error(`vifIp is not IPv4: ${p.vifIp}`);
}

/**
 * Idempotent command plan: any stale rule for the source is dropped first,
 * then the rule + in-table `default dev <tun>` route are (re)added. The
 * in-table default is deleted table-wide (not dev-specific) because table
 * ordinals can shift between runs and a stale `default dev <other-tun>` in
 * the same table would race the new one.
 */
export function planVifSourceRoute(p: VifSourceRoute): Cmd[] {
    assertVifSourceRoute(p);
    return [
        // Clear any previous rule for this source (table can shift).
        ["ip", "rule", "del", "from", p.vifIp],
        [
            "ip",
            "rule",
            "add",
            "from",
            p.vifIp,
            "lookup",
            String(p.table),
            "priority",
            String(VIF_SOURCE_RULE_PRIORITY),
        ],
        // Plain `dev` route - the TUN IS the egress (no gateway on the wire).
        ["ip", "route", "del", "default", "table", String(p.table)],
        ["ip", "route", "add", "default", "dev", p.name, "table", String(p.table)],
    ];
}

/** Teardown plan (best-effort; every step tolerates "not found"). */
export function planVifSourceRouteRemoval(p: VifSourceRoute): Cmd[] {
    assertVifSourceRoute(p);
    return [
        ["ip", "rule", "del", "from", p.vifIp],
        ["ip", "route", "del", "default", "table", String(p.table)],
    ];
}

/**
 * Apply the plan. `del` steps (stale-state clearing) may fail; a failing
 * `add` throws.
 */
export async function applyVifSourceRoute(
    runCommand: CommandRunner,
    p: VifSourceRoute,
): Promise<void> {
    const cmds = planVifSourceRoute(p);
    for (let i = 0; i < cmds.length; i++) {
        const cmd = cmds[i];
        const isDel = cmd.slice(1).includes("del");
        const res = await runCommand(...cmd);
        if (res.exitCode !== 0 && !isDel) {
            throw new Error(
                `vif source route ${p.vifIp} step ${i} failed ` +
                    `(${cmd.slice(1).join(" ")}): exit ${res.exitCode}`,
            );
        }
    }
}

/** Tear a vif's source routing down. All steps best-effort (idempotent). */
export async function removeVifSourceRoute(
    runCommand: CommandRunner,
    p: VifSourceRoute,
): Promise<void> {
    for (const cmd of planVifSourceRouteRemoval(p)) {
        try {
            await runCommand(...cmd);
        } catch {
            // best effort: the TUN may already be gone.
        }
    }
}
