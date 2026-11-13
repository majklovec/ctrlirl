/**
 * udp_bothways_relay.ts - start a single-socket MobLink UDP relay leg on the
 * relay host, egressing via the given uplink NIC (kernel NAT), and keep it
 * alive for a fixed window so the RPi4 → (relay) → server round-trip can be
 * observed. Prints relay stats periodically and a verdict at the end.
 *
 * One UDP socket on 0.0.0.0 + a bare-L3 TUN; the kernel netplan (leg table +
 * iif rule + MASQUERADE + FORWARD) routes vif traffic out the uplink and
 * de-NATs replies back through the TUN - so the reply path works with no
 * user-space NAT.
 *
 * Usage:
 *   sudo bun scripts/udp_bothways_relay.ts [iface] [port] [seconds] [vif_ip]
 */
import { execFileSync } from "node:child_process";
import {
    applyLegPlan,
    applyVifPlan,
    type CommandRunner,
    createUdpRelay,
    relayTunName,
} from "../shared/lib/udp_relay/src/index.js";

const IFACE = process.argv[2] ?? "enx7eafd60ad1a2";
const PORT = Number(process.argv[3] ?? 4150);
const SECONDS = Number(process.argv[4] ?? 40);
const VIF_IP = process.argv[5] ?? "10.3.3.1";
const TUN = relayTunName(0);

const rootRun: CommandRunner = async (cmd, ...args) => {
    try {
        return {
            stdout: execFileSync(cmd, args, { encoding: "utf8" }),
            exitCode: 0,
        };
    } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return {
            stdout: err.stdout ?? err.stderr ?? "",
            exitCode: err.status ?? 1,
        };
    }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(
    `[relay] iface=${IFACE} vif=${VIF_IP} tun=${TUN} socket=0.0.0.0:${PORT} window=${SECONDS}s`,
);
const relay = await createUdpRelay({
    interfaceName: IFACE,
    listenPort: PORT,
    vifIp: VIF_IP,
    tunName: TUN,
    listenAddress: "0.0.0.0",
    runCommand: rootRun,
});
await relay.start();
await rootRun("ip", "link", "set", TUN, "up");
// Resolve the uplink gateway for the leg egress table (required for
// public/CGNAT destinations). Best-effort: falls back to no-gateway.
let gw: string | undefined;
try {
    const out = await rootRun("ip", "-4", "route", "show", "default", "dev", IFACE);
    gw = /\bvia\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(out.stdout)?.[1];
} catch {
    /* no gateway */
}
const leg = { slot: 0, tun: TUN, uplinkIface: IFACE, uplinkGateway: gw };
await applyLegPlan(rootRun, leg);
await applyVifPlan(rootRun, leg, VIF_IP);
console.log(
    `[relay] running (leg netplan installed). Waiting ${SECONDS}s for traffic...`,
);
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(5000);
    const s = relay.stats();
    console.log(
        `[relay] t=${Math.round((Date.now() - t0) / 1000)}s encRx=${s.encRxPackets} vifTx=${s.vifTxPackets} vifRx=${s.vifRxPackets} encTx=${s.encTxPackets} drops=${s.drops}`,
    );
}
const s = relay.stats();
console.log(
    `[relay] FINAL encRx=${s.encRxPackets} vifTx=${s.vifTxPackets} vifRx=${s.vifRxPackets} encTx=${s.encTxPackets} drops=${s.drops}`,
);
console.log(
    `[relay] bothways: ${s.encTxPackets >= 1 && s.vifRxPackets >= 1 ? "REPLY_RETURNED (encTx>=1, vifRx>=1)" : "no reply yet"}`,
);
await relay.stop();
process.exit(0);
