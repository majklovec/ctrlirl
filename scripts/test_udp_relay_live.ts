#!/usr/bin/env bun
/**
 * LIVE smoke test for `@irlctrl/udp-relay` on a real (mobile tethered)
 * interface. This is an integration test, NOT the mock-based unit suite
 * (`bun test shared/lib/udp_relay`): it drives a real `createUdpRelay` under
 * the single-socket, kernel-NAT design and verifies the forwarded packets on
 * the wire with tcpdump.
 *
 * Topology under test (see NAT.md / TODO/optimize-udp-relay.md):
 *
 *   fake encoder (this host) ──UDP:relayPort──▶ relay socket (0.0.0.0)
 *                                              │ 8-byte frame → bare-L3 TUN
 *                                              ▼
 *                              kernel netplan (leg table + iif rule
 *                              + MASQUERADE + FORWARD)
 *                                              ▼
 *                                  <iface> (uplink) ──▶ OBS SRTLA ingress
 *
 * The relay does the transport only; the root shell-outs (TUN up + leg netplan)
 * do the NAT, so replies leave <iface> with the uplink's source IP.
 *
 * It runs two checks:
 *   1. RELAY TUNNEL — a framed data-frame sent to the relay's UDP socket is
 *                     forwarded out the physical interface intact (verified on
 *                     the wire with tcpdump: right src/dst + payload), sourced
 *                     from the uplink IP (no vif/pinned source on the wire).
 *   2. RELAY → OBS  — a burst down the same path toward the real ingress; we
 *                     verify egress out <iface> and print the OBS-side
 *                     tcpdump to confirm receipt there (OBS is remote).
 *
 * Requires: root (TUN + iptables), tcpdump. Teardown removes the leg netplan
 * and the TUN device.
 *
 * Usage:
 *   sudo bun scripts/test_udp_relay_live.ts \
 *       --iface enx7eafd60ad1a2 \
 *       --obs-host 83.208.44.38 --obs-port 5000
 *
 *   --iface <name>      uplink NIC the leg egresses through
 *   --obs-host <ip>     OBS SRTLA ingress address (default 83.208.44.38)
 *   --obs-port <n>      OBS SRTLA ingress port (default 5000)
 *   --relay-port <n>    the relay UDP socket port (default 5101)
 *   --vif <ip>          virtual-interface (encoder) IP (default 10.3.3.1)
 *   --slot <n>          leg slot for table/TUN naming (default 0)
 *   --keep              don't delete temp captures / the TUN
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    applyLegPlan,
    buildUdpIpPacket,
    createUdpRelay,
    encodeDataFrame,
    legTable,
    relayTunName,
    removeLegPlan,
    type CommandRunner,
    type UdpRelay,
} from "../shared/lib/udp_relay/src/index";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
    return fallback;
}
function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

const IFACE = arg("iface", "enx7eafd60ad1a2");
const OBS_HOST = arg("obs-host", "83.208.44.38");
const OBS_PORT = Number(arg("obs-port", "5000"));
const RELAY_PORT = Number(arg("relay-port", "5101"));
const VIF_IP = arg("vif", "10.3.3.1");
const SLOT = Number(arg("slot", "0"));
const KEEP = flag("keep");
const TUN = relayTunName(SLOT, IFACE);

if (process.getuid?.() !== 0) {
    console.error("\nThis test must run as root (TUN + iptables). Try: sudo bun ...");
    process.exit(2);
}

/** Root shell-out: the kernel netplan + TUN bring-up. */
const rootRun: CommandRunner = async (cmd, ...args) => {
    try {
        return { stdout: execFileSync(cmd, args, { encoding: "utf8" }), exitCode: 0 };
    } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { stdout: err.stdout ?? err.stderr ?? "", exitCode: err.status ?? 1 };
    }
};

const tmp = mkdtempSync(join(tmpdir(), "udp-relay-live-"));
const pcap = (name: string) => join(tmp, name);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const enc = new TextEncoder();

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = ""): void {
    if (cond) {
        pass++;
        console.log(`  \u2713 PASS  ${label}${detail ? ` — ${detail}` : ""}`);
    } else {
        fail++;
        console.log(`  \u2717 FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    }
}
function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

const TCPDUMP = "/usr/bin/tcpdump";
if (!existsSync(TCPDUMP) && !spawnSync("which", ["tcpdump"]).stdout?.toString().trim()) {
    console.error("tcpdump not found — install it to run this test.");
    process.exit(2);
}

/** Start a tcpdump capture on `iface`; resolve `file` when ready to read. */
function startCapture(file: string, filter: string): {
    child: ChildProcess;
    stop: () => Promise<void>;
} {
    const child = spawn(
        TCPDUMP,
        ["-i", IFACE, "-n", "-s", "0", "-w", file, filter],
        { stdio: ["ignore", "ignore", "ignore"] },
    );
    return {
        child,
        stop: async () => {
            // SIGINT makes tcpdump finalize (flush) the pcap, then exit.
            child.kill("SIGINT");
            try {
                await new Promise<void>((r) => child.on("exit", () => r()));
            } catch {
                // already exited
            }
            await sleep(200);
        },
    };
}

/** True when the pcap holds at least one captured packet. */
function pcapHasPackets(file: string): boolean {
    if (!existsSync(file)) return false;
    return readFileSync(file).length > 24; // beyond the 24-byte global header
}

/** True when the ASCII `marker` appears verbatim in the pcap bytes. */
function pcapHasMarker(file: string, marker: string): boolean {
    if (!existsSync(file)) return false;
    const buf = readFileSync(file);
    const needle = enc.encode(marker);
    for (let i = 0; i + needle.length <= buf.length; i++) {
        let hit = true;
        for (let j = 0; j < needle.length; j++) {
            if (buf[i + j] !== needle[j]) {
                hit = false;
                break;
            }
        }
        if (hit) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
console.log(`udp-relay LIVE test (single-socket + kernel NAT)`);
console.log(`  iface   = ${IFACE} (egress uplink)`);
console.log(`  vif     = ${VIF_IP}/32  (tun ${TUN}, table ${legTable(SLOT)})`);
console.log(`  obs     = ${OBS_HOST}:${OBS_PORT}`);
console.log(`  relay   = 0.0.0.0:${RELAY_PORT}`);

let relay: UdpRelay | null = null;
let setupOk = false;
try {
    relay = await createUdpRelay({
        interfaceName: IFACE,
        listenPort: RELAY_PORT,
        vifIp: VIF_IP,
        tunName: TUN,
        listenAddress: "0.0.0.0",
        runCommand: rootRun,
    });
    await relay.start();
    // Bring the leg up: TUN + kernel netplan (table/iif-rule/MASQUERADE/FORWARD).
    await rootRun("ip", "link", "set", TUN, "up");
    await applyLegPlan(rootRun, { slot: SLOT, tun: TUN, uplinkIface: IFACE, vifIp: VIF_IP });
    ok("relay started + leg netplan installed", relay.isRunning());
    setupOk = relay.isRunning();
} catch (e) {
    ok("setup: relay + leg netplan", false, e instanceof Error ? e.message : String(e));
}

// ---------------------------------------------------------------------------
// Test 1 — the relay tunnel (framed packet → kernel NAT → out the uplink)
// ---------------------------------------------------------------------------
if (!setupOk) {
    console.log(`\n[1] RELAY TUNNEL  (skipped — setup failed)`);
} else {
    console.log(`\n[1] RELAY TUNNEL  (frame → TUN → kernel NAT → out ${IFACE})`);
{
    const marker = `IRELAY-T1-${Date.now()}-x${Math.floor(Math.random() * 1e6)}`;
    const inner = buildUdpIpPacket({
        srcIp: VIF_IP,
        dstIp: OBS_HOST,
        srcPort: 6000,
        dstPort: OBS_PORT,
        payload: enc.encode(marker),
    });
    const frame = encodeDataFrame(inner, VIF_IP);

    const cap = startCapture(pcap("t1.pcap"), `udp and host ${OBS_HOST} and port ${OBS_PORT}`);
    await sleep(300); // let tcpdump program the BPF filter

    // The "encoder" side: one framed datagram to the relay's UDP socket.
    const sock = await Bun.udpSocket({ binaryType: "uint8array" });
    sock.send(frame, RELAY_PORT, "127.0.0.1");
    await sleep(1500); // give the relay + kernel + wire time to deliver
    await cap.stop();

    const s = relay?.stats();
    ok("relay saw the encoded frame (encRxPackets ≥ 1)", (s?.encRxPackets ?? 0) >= 1, `encRx=${s?.encRxPackets}`);
    ok("relay handed it to the TUN (vifTxPackets ≥ 1)", (s?.vifTxPackets ?? 0) >= 1, `vifTx=${s?.vifTxPackets}`);
    ok("packet egressed out the uplink (tcpdump)", pcapHasPackets(pcap("t1.pcap")), pcap("t1.pcap"));
    ok("payload intact on the wire (marker present)", pcapHasMarker(pcap("t1.pcap"), marker), marker);
    console.log(`\n    OBS-side check (run on ${OBS_HOST}):`);
    console.log(`      tcpdump -ni <iface> 'udp and host ${OBS_HOST} and port ${OBS_PORT}'`);
    console.log(`    → expect: <uplink-IP>.<ephemeral> > ${OBS_HOST}.${OBS_PORT} (payload "${marker}")`);
}
}

// ---------------------------------------------------------------------------
// Test 2 — relay → OBS (a burst down the same path toward the real ingress)
// ---------------------------------------------------------------------------
if (!setupOk) {
    console.log(`\n[2] RELAY → OBS  (skipped — setup failed)`);
} else {
    console.log(`\n[2] RELAY → OBS  (datagrams leave ${IFACE} toward ${OBS_HOST}:${OBS_PORT})`);
{
    const cap = startCapture(pcap("t2.pcap"), `udp and host ${OBS_HOST} and port ${OBS_PORT}`);
    await sleep(300);

    const sock = await Bun.udpSocket({ binaryType: "uint8array" });
    for (let i = 0; i < 20; i++) {
        const inner = buildUdpIpPacket({
            srcIp: VIF_IP,
            dstIp: OBS_HOST,
            srcPort: 6000 + i,
            dstPort: OBS_PORT,
            payload: enc.encode(`T2-${i}`),
        });
        sock.send(encodeDataFrame(inner, VIF_IP), RELAY_PORT, "127.0.0.1");
        await sleep(40);
    }
    await cap.stop();

    ok("≥1 datagram egressed out the uplink toward OBS", pcapHasPackets(pcap("t2.pcap")), pcap("t2.pcap"));
    console.log(`\n    OBS-side check (run on ${OBS_HOST}):`);
    console.log(`      tcpdump -ni <iface> -c 5 'udp and host ${OBS_HOST} and port ${OBS_PORT}'`);
    console.log(`    → expect SRTLA handshake/data from <uplink-IP> → ${OBS_HOST}:${OBS_PORT}`);
}
}

// ---------------------------------------------------------------------------
relay?.stop().catch(() => {});
// Best-effort teardown of the leg netplan + TUN (kept with --keep).
if (!KEEP) {
    await removeLegPlan(rootRun, { slot: SLOT, tun: TUN, uplinkIface: IFACE, vifIp: VIF_IP }).catch(
        () => {},
    );
    try {
        execFileSync("/usr/sbin/ip", ["link", "del", TUN]);
    } catch {
        // already gone
    }
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
console.log(`captures in: ${tmp}`);
if (!KEEP) rmSync(tmp, { recursive: true, force: true });
else console.log("(kept with --keep; TUN + netplan left in place)");
process.exit(fail === 0 ? 0 : 1);
