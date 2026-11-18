/**
 * Kernel-side provisioning for one relay leg (TUN + per-leg routing +
 * conntrack NAT). The library is rootless: these build command plans (pure,
 * unit-testable) and apply them through an injected command runner (the
 * `moblink_relay` backend runs them with elevated privileges).
 *
 * Why the kernel does this (see NAT.md):
 *
 *   encoder → UDP → [relay listener 0.0.0.0:port] → TUN (vif /32)
 *       → `ip rule iif <tun> table <T>` → `default via <gw> dev <uplink>` in <T>
 *       → MASQUERADE (s=encoder-vif/32, o=uplink) → uplink NIC
 *   reply  → conntrack de-NAT (dst=vif) → `to vif/32 dev <tun>` (main)
 *       → TUN → relay → encoder
 *
 * The vif is the ENCODER's dedicated non-local address (`10.{90+x}.{y}.1`),
 * learned from the first frame - NOT the uplink's own local IP (that is the
 * b6db3 dead end: local source fails strict rp_filter on the forward path
 * and a reply to it is local delivery, never forwarded - see §16). The egress
 * table carries the uplink gateway (required for public/CGNAT destinations).
 *
 * This is what fixes the b6db3 leg: replies leave the uplink NIC with the
 * uplink's source IP (no source-routing pinning to the leg listener), and
 * the kernel answers the flow - no user-space NAT, no ICMP port-unreachable.
 *
 * Table numbering: the network module claims tables ≥ 100 (TABLE_BASE), so
 * relay leg tables live at 40 + slot (always < 100).
 */

import { CTRLINK_TUN_NAME_RE } from "../../../ctrlink_discovery";
import type { CommandRunner } from "./types.js";

/** Lower bound of the relay-leg routing tables (must stay < 100). */
export const LEG_TABLE_BASE = 40;
/** Upper bound - keep clear of the network module's TABLE_BASE (100). */
export const LEG_TABLE_MAX = 99;

/**
 * Relay-side leg TUN name: `rtltun_<iface>` (`rtltun_eth0`, `rtltun_wwan2`,
 * ...). Named after the uplink interface the leg exits through, so the leg TUN
 * maps 1:1 to the physical uplink. Deliberately distinct from the
 * encoder-side tunnel TUNs (`rltun<R>_<iface>`, `CTRLINK_TUN_NAME_RE`):
 * `rltun*` devices exist ONLY on encoders (the vifs srtla sends through),
 * while `rtltun_*` devices exist ONLY on relay boxes. Matching the encoder
 * pattern used to blur the two - a relay box showed encoder-style interfaces
 * while the encoder had none, which is wrong.
 */
export const LEG_TUN_NAME_RE = /^rtltun_[a-z0-9_.-]+$/u;

export function relayTunName(iface: string): string {
    if (typeof iface !== "string" || iface.length === 0)
        throw new Error(`iface must be a non-empty string (${String(iface)})`);
    const name = `rtltun_${iface}`;
    if (!LEG_TUN_NAME_RE.test(name))
        throw new Error(
            `relay TUN name does not match the leg pattern: ${name}`,
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

/**
 * The vif-independent kernel plan for one leg. The vif-specific parts
 * (MASQUERADE + the `to vif/32 dev tun` reply route) are applied separately
 * once the encoder's vif is learned from the wire (`applyVifPlan`) - the
 * relay cannot know `10.{90+x}.{y}.1` up front (only the encoder knows the
 * ordinals x, y), and keying NAT on the uplink's own local IP is the b6db3
 * dead end (see NAT.md §16 / optimize-udp-relay.md §16).
 */
export interface LegPlan {
    /** Leg index (0-based; selects the routing table). */
    slot: number;
    /** TUN device name (see `relayTunName`). */
    tun: string;
    /** Uplink interface the leg exits through. */
    uplinkIface: string;
    /**
     * Uplink gateway for the leg egress table (`default via gw dev uplink`).
     * Required when the destination is off the uplink's own subnet (public /
     * CGNAT peers); a no-gateway `scope link` default ARPs for the destination
     * directly on the uplink segment and fails. Resolved by the backend at
     * provision time; omit for a no-gateway `default dev uplink` (direct-attach).
     */
    uplinkGateway?: string;
    /**
     * MASQUERADE the vif to the uplink's source (default). When false, the leg
     * forwards the vif's source IP unmodified (no NAT) - the uplink must then
     * be able to route the vif directly.
     */
    nat?: boolean;
}

type Cmd = [string, ...string[]];

/**
 * The vif-INDEPENDENT command plan for one leg, applied up-front at provision
 * time: the egress table (default via the uplink gateway), the iif rule, and
 * the FORWARD accepts. Idempotent: every add is preceded by a best-effort del
 * (the runner ignores del failures).
 */
export function planLegBaseCommands(p: LegPlan): Cmd[] {
    const table = legTable(p.slot);
    const egressAdd: Cmd = p.uplinkGateway
        ? [
            "ip",
            "route",
            "add",
            "default",
            "via",
            p.uplinkGateway,
            "dev",
            p.uplinkIface,
            "table",
            String(table),
        ]
        : [
            "ip",
            "route",
            "add",
            "default",
            "dev",
            p.uplinkIface,
            "table",
            String(table),
        ];
    return [
        // 1. Leg table: egress pin for packets arriving on the TUN.
        ["ip", "route", "del", "default", "table", String(table)],
        egressAdd,
        ["ip", "rule", "del", "lookup", String(table)],
        ["ip", "rule", "add", "iif", p.tun, "table", String(table)],
        // 2. FORWARD accepts (host default policy is DROP under Docker).
        // Always on: the forward path exists even when NAT is off.
        ["iptables", "-D", "FORWARD", "-i", p.tun, "-j", "ACCEPT"],
        ["iptables", "-I", "FORWARD", "1", "-i", p.tun, "-j", "ACCEPT"],
        ["iptables", "-D", "FORWARD", "-o", p.tun, "-j", "ACCEPT"],
        ["iptables", "-I", "FORWARD", "2", "-o", p.tun, "-j", "ACCEPT"],
    ];
}

/**
 * The vif-SPECIFIC command plan, applied once the encoder's vif is learned
 * from the wire: the `to vif/32 dev tun` reply route (main table) and, when
 * NAT is on, the MASQUERADE keyed on that vif. This is the piece that the
 * up-front `vifIp = uplink IP` design got wrong - it must be keyed on the
 * ENCODER's dedicated non-local vif (e.g. `10.{90+x}.{y}.1`).
 */
export function planVifCommands(p: LegPlan, vifIp: string): Cmd[] {
    const vif = `${vifIp}/32`;
    const cmds: Cmd[] = [
        // 1. Reply routing in the main table: vif /32 out the TUN.
        ["ip", "route", "del", vif, "dev", p.tun],
        ["ip", "route", "add", vif, "dev", p.tun],
    ];
    if (p.nat ?? true) {
        // 2. Conntrack NAT: masquerade the encoder vif to the uplink's source.
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
    return cmds;
}

/**
 * The full command plan that provisions one leg (base + the vif part, when a
 * vif is known up front). Order matters: egress/rules → FORWARD → vif route →
 * NAT. Kept for callers that know the vif at provision time (tests) - the
 * production backend applies base and vif separately (`applyLegPlan` +
 * `applyVifPlan`).
 */
export function planLegCommands(p: LegPlan, vifIp?: string): Cmd[] {
    const cmds = planLegBaseCommands(p);
    if (vifIp !== undefined) cmds.push(...planVifCommands(p, vifIp));
    return cmds;
}

/**
 * The vif-specific teardown (inverse of `planVifCommands`, best-effort). Called
 * when the learned vif may no longer be served (leg stop / vif change).
 */
export function planVifRemoval(p: LegPlan, vifIp: string): Cmd[] {
    const vif = `${vifIp}/32`;
    const cmds: Cmd[] = [["ip", "route", "del", vif, "dev", p.tun]];
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
    return cmds;
}

/** The command plan that tears a leg down (base, inverse, best-effort). */
export function planLegRemoval(p: LegPlan): Cmd[] {
    const table = legTable(p.slot);
    const cmds: Cmd[] = [
        ["ip", "rule", "del", "lookup", String(table)],
        ["ip", "route", "del", "default", "table", String(table)],
    ];
    cmds.push(
        ["iptables", "-D", "FORWARD", "-i", p.tun, "-j", "ACCEPT"],
        ["iptables", "-D", "FORWARD", "-o", p.tun, "-j", "ACCEPT"],
    );
    return cmds;
}

/**
 * Apply a command plan. `del`/`-D` steps (the ones that clear stale state)
 * may fail; the real `add`/`insert` failures are surfaced.
 */
async function applyCommands(
    runCommand: CommandRunner,
    label: string,
    cmds: Cmd[],
): Promise<void> {
    for (let i = 0; i < cmds.length; i++) {
        const args = cmds[i].slice(1);
        const isDel = args.includes("del") || args.includes("-D");
        const res = await runCommand(...cmds[i]);
        if (res.exitCode !== 0 && !isDel) {
            throw new Error(
                `${label} step ${i} failed (${cmds[i][0]} ${cmds[i].slice(1).join(" ")}): ` +
                    `exit ${res.exitCode} ${res.stdout.trim().split("\n").pop() ?? ""}`,
            );
        }
    }
}

/**
 * Apply the vif-independent base plan (egress table + iif rule + FORWARD).
 * Idempotent; the vif-specific parts are applied separately via
 * `applyVifPlan` once the encoder's vif is learned.
 */
export async function applyLegPlan(
    runCommand: CommandRunner,
    p: LegPlan,
): Promise<void> {
    await applyCommands(runCommand, "leg plan", planLegBaseCommands(p));
}

/**
 * Apply the vif-specific plan (reply route + MASQUERADE) for a learned
 * encoder vif. Idempotent - re-applying the same vif is a no-op (the `del`
 * precedes the `add`). Called from the relay's `onEncoderVifLearned`.
 */
export async function applyVifPlan(
    runCommand: CommandRunner,
    p: LegPlan,
    vifIp: string,
): Promise<void> {
    await applyCommands(
        runCommand,
        `vif plan ${vifIp}`,
        planVifCommands(p, vifIp),
    );
}

/** Tear a leg's base down. All steps are best-effort (idempotent). */
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

/** Tear down a learned vif's route + NAT. Best-effort (idempotent). */
export async function removeVifPlan(
    runCommand: CommandRunner,
    p: LegPlan,
    vifIp: string,
): Promise<void> {
    for (const cmd of planVifRemoval(p, vifIp)) {
        try {
            await runCommand(...cmd);
        } catch {
            // best effort: the vif may never have been provisioned.
        }
    }
}

/**
 * Startup sweep: delete TUN devices on this host that match the CtrLink
 * leg pattern from a previous (crashed) run. Returns the names removed.
 *
 * Matches the relay leg TUNs `rtltun_<iface>`. `CTRLINK_TUN_NAME_RE` is
 * checked too so encoder-side `rltun<R>_<iface>` TUNs are swept if one were
 * ever left on a relay host - a relay host never runs encoder-side tunnels,
 * so any TUN matching here is stale.
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
        if (LEG_TUN_NAME_RE.test(name) || CTRLINK_TUN_NAME_RE.test(name))
            names.push(name);
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
