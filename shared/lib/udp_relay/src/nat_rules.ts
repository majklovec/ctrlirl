/**
 * Kernel-side provisioning for one relay leg (TUN + per-leg routing +
 * conntrack NAT). The library is rootless: these build command plans (pure,
 * unit-testable) and apply them through an injected command runner (the
 * `moblink_relay` backend runs them with elevated privileges).
 *
 * Why the kernel does this (see NAT.md):
 *
 *   encoder → UDP → [relay listener 0.0.0.0:port] → TUN (vif /32)
 *       → `ip rule iif <tun> table <T>` → `default dev <uplink>` in <T>
 *       → MASQUERADE (s=vif/32, o=uplink) → uplink NIC
 *   reply  → conntrack de-NAT (dst=vif) → `to vif/32 dev <tun>` (main)
 *       → TUN → relay → encoder
 *
 * This is what fixes the b6db3 leg: replies leave the uplink NIC with the
 * uplink's source IP (no source-routing pinning to the leg listener), and
 * the kernel answers the flow - no user-space NAT, no ICMP port-unreachable.
 *
 * Table numbering: the network module claims tables ≥ 100 (TABLE_BASE), so
 * relay leg tables live at 40 + slot (always < 100).
 */

import { MOBLINK_TUN_NAME_RE } from "../../../moblink_discovery";
import type { CommandRunner } from "./types.js";

/** Lower bound of the relay-leg routing tables (must stay < 100). */
export const LEG_TABLE_BASE = 40;
/** Upper bound - keep clear of the network module's TABLE_BASE (100). */
export const LEG_TABLE_MAX = 99;

/**
 * Relay-side leg TUN name: `relay<slot>_<uplink iface>`, truncated to 15
 * chars (the Linux limit). Matches `MOBLINK_TUN_NAME_RE` so the network
 * module hides it from "own interfaces" (same convention the encoders use).
 */
export function relayTunName(slot: number, uplinkIface: string): string {
    if (!Number.isInteger(slot) || slot < 0)
        throw new Error(`slot must be a non-negative integer (${slot})`);
    // Mirror the encoders' naming (truncated to 15 chars) so both sides
    // derive the same device name.
    const name = `relay${slot}_${uplinkIface}`.slice(0, 15);
    if (!MOBLINK_TUN_NAME_RE.test(name))
        throw new Error(
            `relay TUN name does not match the shared pattern: ${name}`,
        );
    return name;
}

/** Routing table for leg `slot` (40 + slot, bounded below 100). */
export function legTable(slot: number): number {
    const t = LEG_TABLE_BASE + slot;
    if (t >= LEG_TABLE_MAX)
        throw new Error(
            `leg table out of range for slot ${slot} (max ${LEG_TABLE_MAX - LEG_TABLE_BASE - 1})`,
        );
    return t;
}

export interface LegPlan {
    /** Leg index (0-based; selects the routing table). */
    slot: number;
    /** TUN device name (see `relayTunName`). */
    tun: string;
    /** Uplink interface the leg exits through. */
    uplinkIface: string;
    /** The vif /32 this leg bridges. */
    vifIp: string;
    /**
     * MASQUERADE the vif to the uplink's source (default). When false, the leg
     * forwards the vif's source IP unmodified (no NAT) - the uplink must then
     * be able to route the vif directly.
     */
    nat?: boolean;
}

type Cmd = [string, ...string[]];

/**
 * The command plan that provisions one leg. Order matters: routes before
 * rules, NAT before FORWARD accepts. Idempotent: every add is preceded by
 * a best-effort del (the runner ignores del failures).
 */
export function planLegCommands(p: LegPlan): Cmd[] {
    const table = legTable(p.slot);
    const vif = `${p.vifIp}/32`;
    const nat = p.nat ?? true;
    const cmds: Cmd[] = [
        // 1. Leg table: egress pin for packets arriving on the TUN.
        ["ip", "route", "del", "default", "table", String(table)],
        [
            "ip",
            "route",
            "add",
            "default",
            "dev",
            p.uplinkIface,
            "table",
            String(table),
        ],
        ["ip", "rule", "del", "lookup", String(table)],
        ["ip", "rule", "add", "iif", p.tun, "table", String(table)],
        // 2. Reply routing in the main table: vif /32 out the TUN.
        ["ip", "route", "del", vif, "dev", p.tun],
        ["ip", "route", "add", vif, "dev", p.tun],
    ];
    if (nat) {
        // 3. Conntrack NAT: masquerade the vif to the uplink's source.
        cmds.push(
            [
                "iptables",
                "-t",
                "nat",
                "-D",
                "POSTROUTING",
                "-s",
                vif,
                "-o",
                p.uplinkIface,
                "-j",
                "MASQUERADE",
            ],
            [
                "iptables",
                "-t",
                "nat",
                "-I",
                "POSTROUTING",
                "1",
                "-s",
                vif,
                "-o",
                p.uplinkIface,
                "-j",
                "MASQUERADE",
            ],
        );
    }
    // FORWARD accepts (the host default policy is DROP under Docker). Always on:
    // the FORWARD path exists even when NAT is off (the vif is routed directly).
    cmds.push(
        ["iptables", "-D", "FORWARD", "-i", p.tun, "-j", "ACCEPT"],
        ["iptables", "-I", "FORWARD", "1", "-i", p.tun, "-j", "ACCEPT"],
        ["iptables", "-D", "FORWARD", "-o", p.tun, "-j", "ACCEPT"],
        ["iptables", "-I", "FORWARD", "2", "-o", p.tun, "-j", "ACCEPT"],
    );
    return cmds;
}

/** The command plan that tears a leg down (inverse, best-effort). */
export function planLegRemoval(p: LegPlan): Cmd[] {
    const table = legTable(p.slot);
    const vif = `${p.vifIp}/32`;
    const cmds: Cmd[] = [
        ["ip", "rule", "del", "lookup", String(table)],
        ["ip", "route", "del", "default", "table", String(table)],
        ["ip", "route", "del", vif, "dev", p.tun],
    ];
    if (p.nat ?? true)
        cmds.push([
            "iptables",
            "-t",
            "nat",
            "-D",
            "POSTROUTING",
            "-s",
            vif,
            "-o",
            p.uplinkIface,
            "-j",
            "MASQUERADE",
        ]);
    cmds.push(
        ["iptables", "-D", "FORWARD", "-i", p.tun, "-j", "ACCEPT"],
        ["iptables", "-D", "FORWARD", "-o", p.tun, "-j", "ACCEPT"],
    );
    return cmds;
}

/**
 * Apply a leg plan. `ignoreDel` commands (the ones that clear stale state)
 * may fail; the real `add`/`insert` failures are surfaced.
 */
export async function applyLegPlan(
    runCommand: CommandRunner,
    p: LegPlan,
): Promise<void> {
    const cmds = planLegCommands(p);
    for (let i = 0; i < cmds.length; i++) {
        // Best-effort steps: `ip ... del ...` and `iptables -D ...`.
        const args = cmds[i].slice(1);
        const isDel = args.includes("del") || args.includes("-D");
        const res = await runCommand(...cmds[i]);
        if (res.exitCode !== 0 && !isDel) {
            throw new Error(
                `leg plan step ${i} failed (${cmds[i][0]} ${cmds[i].slice(1).join(" ")}): ` +
                    `exit ${res.exitCode} ${res.stdout.trim().split("\n").pop() ?? ""}`,
            );
        }
    }
}

/** Tear a leg down. All steps are best-effort (idempotent). */
export async function removeLegPlan(
    runCommand: CommandRunner,
    p: LegPlan,
): Promise<void> {
    for (const cmd of planLegRemoval(p)) {
        try {
            await runCommand(...cmd);
        } catch {
            // best effort: tearing down a half-provisioned leg is normal.
        }
    }
}

/**
 * Startup sweep: delete TUN devices on this host that match the MobLink
 * leg pattern from a previous (crashed) run. Returns the names removed.
 *
 * Safe: a relay host never runs encoder-side MobLink tunnels, so any TUN
 * matching `relay\d+_<iface>` here is ours.
 */
export async function sweepStaleLegTuns(
    runCommand: CommandRunner,
): Promise<string[]> {
    const res = await runCommand("ip", "-o", "link", "show");
    if (res.exitCode !== 0) return [];
    const names: string[] = [];
    for (const line of res.stdout.split("\n")) {
        const m = /^\d+:\s+([a-zA-Z0-9_.@-]+):/.exec(line);
        if (!m) continue;
        const name = m[1].split("@")[0];
        if (MOBLINK_TUN_NAME_RE.test(name)) names.push(name);
    }
    for (const name of names) {
        try {
            await runCommand("ip", "link", "del", name);
        } catch {
            // already gone
        }
    }
    return names;
}
