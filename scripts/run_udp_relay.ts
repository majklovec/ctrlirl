#!/usr/bin/env bun
/**
 * Persistent UDP relay runner (`@irlctrl/udp-relay`) for the relay box.
 *
 * Single-socket, kernel-NAT design (see TODO/optimize-udp-relay.md): ONE UDP
 * listener on 0.0.0.0 + one bare-L3 TUN per uplink leg. The kernel does the
 * NAT per leg (leg routing table + iif rule + MASQUERADE + FORWARD), so replies
 * leave each uplink with that uplink's source IP — no user-space NAT, no
 * source-routing pin (the b6db3 fix).
 *
 * The encoder's TUN (vif /32) dials each leg on (vifIp, listenPort); the kernel
 * forwards vif traffic out the leg's uplink. `LEG_A vif 10.3.3.2 :4010`
 * egresses enx7eafd60ad1a2, `LEG_B vif 10.3.3.3 :4000` egresses eth0.
 *
 * Usage (root — TUN + iptables):
 *   sudo bun scripts/run_udp_relay.ts
 *
 * Env:
 *   LEGS  comma list of iface:port (default "enx7eafd60ad1a2:4010,eth0:4000")
 *   VIF_BASE  /24 the per-leg vif /32s come from (default 10.3.3.0)
 */
import { execFileSync } from "node:child_process";
import {
    applyLegPlan,
    createUdpRelay,
    relayTunName,
    type CommandRunner,
} from "../shared/lib/udp_relay/src/index";

const LEGS = (process.env.LEGS ?? "enx7eafd60ad1a2:4010,eth0:4000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
// Per-leg vif /32s from a /24 base: leg 0 → <base>.2, leg 1 → <base>.3, …
const VIF_BASE = process.env.VIF_BASE ?? "10.3.3.0";

/** Root command runner (this script is invoked under sudo). */
const rootRun: CommandRunner = async (cmd, ...args) => {
    try {
        const stdout = execFileSync(cmd, args, { encoding: "utf8" });
        return { stdout, exitCode: 0 };
    } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return {
            stdout: err.stdout ?? err.stderr ?? "",
            exitCode: err.status ?? 1,
        };
    }
};

const vifIpFor = (slot: number): string => {
    const [a, b, c] = VIF_BASE.split(".").map(Number);
    return `${a}.${b}.${c}.${slot + 2}`;
};

const relays = [] as Awaited<ReturnType<typeof createUdpRelay>>[];

for (let slot = 0; slot < LEGS.length; slot++) {
    const [iface, portStr] = LEGS[slot].split(":");
    const port = Number(portStr);
    if (!iface || !port) throw new Error(`bad LEGS entry: ${LEGS[slot]}`);
    const tunName = relayTunName(slot, iface);
    const vifIp = vifIpFor(slot);
    const relay = await createUdpRelay({
        interfaceName: iface,
        listenPort: port,
        vifIp,
        tunName,
        // One socket, all NICs: the kernel pins egress per leg (applyLegPlan).
        listenAddress: "0.0.0.0",
        runCommand: rootRun,
        onVifLearned: (vif) =>
            console.log(`[relay ${iface}:${port}] vif ${vif} leg on ${iface}`),
        onStats: (s) => {
            if (s.encRxPackets > 0 && s.encRxPackets % 500 === 0)
                process.stderr.write(
                    `[relay ${iface}:${port}] encRx=${s.encRxPackets} encTx=${s.encTxPackets} vifRx=${s.vifRxPackets} vifTx=${s.vifTxPackets} drops=${s.drops}\n`
                );
        },
    });
    await relay.start();
    // Bring the leg's TUN up + install its kernel netplan.
    await rootRun("ip", "link", "set", tunName, "up");
    await applyLegPlan(rootRun, { slot, tun: tunName, uplinkIface: iface, vifIp });
    relays.push(relay);
    console.log(
        `[relay] leg up: ${iface} vif ${vifIp} :${port} (tun ${tunName}, table ${slot + 40})`
    );
}

setInterval(() => {
    for (const r of relays) {
        const s = r.stats();
        process.stderr.write(
            `[stats ${r.interfaceName}] encRx=${s.encRxPackets} encTx=${s.encTxPackets} vifRx=${s.vifRxPackets} vifTx=${s.vifTxPackets} drops=${s.drops}\n`
        );
    }
}, 15000);

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
        console.log(`[relay] ${sig}, stopping`);
        for (const r of relays) await r.stop();
        process.exit(0);
    });
}
console.log(`[relay] running ${relays.length} leg(s), socket 0.0.0.0`);
