/* @irlctrl/udp-relay - micro-benchmark.
 *
 * Measures the relay's forward hot path (encoder frame in → IP packet out the
 * TUN) for: sustained pps, CPU %, heap slope (KB per 10k pkts), and
 * per-packet p99 latency (µs).
 *
 * Rootless: the relay listener is a REAL UDP socket on loopback (the part we
 * optimize); egress is an in-memory mock TUN (no root, no /dev/net/tun). Keep
 * the API surface used here stable so the before/after comparison in
 * BASELINE.md is apples-to-apples.
 *
 * Usage:
 *   bun bench/bench.ts
 */
import {
    createUdpRelay,
    encodeDataFrame,
    makeMockTunDevice,
} from "../src/index";

const PAYLOAD_SIZE = Number(process.env.BENCH_SIZE ?? 1200);
const TOTAL_PACKETS = Number(process.env.BENCH_TOTAL ?? 200_000);
const LISTEN_PORT = Number(process.env.BENCH_PORT ?? 40990);
const VIF_IP = "10.20.30.40";
const DIAL_HOST = "127.0.0.1";

/** A minimal IPv4 header + payload so the relay sees a real packet. */
function makeIpPacket(size: number): Uint8Array {
    const buf = new Uint8Array(size);
    buf[0] = 0x45; // version 4, IHL 5
    buf[2] = (size >> 8) & 0xff;
    buf[3] = size & 0xff;
    buf[8] = 64; // TTL
    buf[9] = 17; // UDP
    buf[12] = 10;
    buf[13] = 20;
    buf[14] = 30;
    buf[15] = 40;
    buf[16] = 8;
    buf[17] = 8;
    buf[18] = 8;
    buf[19] = 8;
    return buf;
}

function cpuSeconds(
    a: { user: number; system: number },
    b: { user: number; system: number },
): number {
    return (b.user - a.user + (b.system - a.system)) / 1e6;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Yield one event-loop turn so the relay's recv handler can drain. */
async function yieldLoop(): Promise<void> {
    return new Promise((r) => setImmediate(r));
}

/** Build a relay with a real loopback listener + mock TUN egress. */
async function buildRelay(tun: ReturnType<typeof makeMockTunDevice>) {
    const relay = await createUdpRelay({
        interfaceName: "lo",
        listenPort: LISTEN_PORT,
        vifIp: VIF_IP,
        listenAddress: DIAL_HOST,
        tunFactory: async () => tun.device,
    });
    await relay.start();
    return relay;
}

/**
 * Send in chunks, yielding after each chunk so the relay keeps up. This paces
 * the producer to the relay's drain rate (the kernel UDP recv buffer is small,
 * so a firehose drops everything). Measures sustainable throughput, not a burst.
 */
async function pacedSend(
    encoder: Bun.UDPSocket,
    frame: Uint8Array,
    total: number,
    chunk = 2_000,
): Promise<void> {
    let sent = 0;
    while (sent < total) {
        const end = Math.min(sent + chunk, total);
        for (; sent < end; sent++) encoder.send(frame, LISTEN_PORT, DIAL_HOST);
        await yieldLoop();
    }
}

async function measureForwardPps(): Promise<{
    pps: number;
    cpuPct: number;
    heapKbPer10k: number;
}> {
    const tun = makeMockTunDevice({ name: "rtltun_eth0" });
    const relay = await buildRelay(tun);

    const encoder = await Bun.udpSocket({
        hostname: DIAL_HOST,
        port: 0,
        binaryType: "uint8array",
    });
    const ipPacket = makeIpPacket(PAYLOAD_SIZE);
    const frame = encodeDataFrame(ipPacket, VIF_IP);

    // Warm up (JIT + first-send path).
    await pacedSend(encoder, frame, 5_000);
    await sleep(150);
    tun.written.length = 0;

    const heapBefore = performance.memory?.usedHeap ?? 0;
    const cpuBefore = process.cpuUsage();
    const t0 = performance.now();
    await pacedSend(encoder, frame, TOTAL_PACKETS);
    // Final yield so the last in-flight frames are processed before we stop the clock.
    await yieldLoop();
    const t1 = performance.now();
    const heapAfter = performance.memory?.usedHeap ?? 0;
    const cpuAfter = process.cpuUsage();

    const received = tun.written.length;
    const seconds = (t1 - t0) / 1000;
    const pps = received / seconds;
    const cpuPct = cpuSeconds(cpuBefore, cpuAfter) / seconds;
    const heapKbPer10k =
        ((heapAfter - heapBefore) / 1024) * (10_000 / TOTAL_PACKETS);

    await relay.stop();
    encoder.close();
    return { pps, cpuPct, heapKbPer10k };
}

/**
 * Per-packet latency in a single-threaded event loop: send ONE packet, then YIELD
 * (never busy-wait - a spin starves the relay's own handler) until it has been
 * processed. Wall-clock includes one event-loop cycle; it is a stable proxy for
 * hot-path latency on the same machine.
 */
async function measurePerPacketLatency(
    samples = 4_000,
): Promise<{ p50: number; p99: number }> {
    const tun = makeMockTunDevice({ name: "rtltun_eth0" });
    const relay = await buildRelay(tun);
    const encoder = await Bun.udpSocket({
        hostname: DIAL_HOST,
        port: 0,
        binaryType: "uint8array",
    });
    const ipPacket = makeIpPacket(PAYLOAD_SIZE);
    const frame = encodeDataFrame(ipPacket, VIF_IP);
    await pacedSend(encoder, frame, 2_000);
    await sleep(150);

    const latencies: number[] = [];
    for (let i = 0; i < samples; i++) {
        const before = tun.written.length;
        const t0 = performance.now();
        encoder.send(frame, LISTEN_PORT, DIAL_HOST);
        let guard = 0;
        while (tun.written.length <= before && guard++ < 200) await yieldLoop();
        latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    await relay.stop();
    encoder.close();
    return {
        p50: latencies[Math.floor(latencies.length * 0.5)],
        p99: latencies[Math.floor(latencies.length * 0.99)],
    };
}

async function main(): Promise<void> {
    const { pps, cpuPct, heapKbPer10k } = await measureForwardPps();
    const { p50, p99 } = await measurePerPacketLatency();
    const out = {
        mode: "real-listener+mock-tun",
        payloadSize: PAYLOAD_SIZE,
        pps: Math.round(pps),
        cpuPctOfOneCore: Math.round(cpuPct * 100) / 100,
        heapKbPer10k: Math.round(heapKbPer10k * 100) / 100,
        p50Us: Math.round(p50 * 1000),
        p99Us: Math.round(p99 * 1000),
    };
    console.log(JSON.stringify(out, null, 2));
}

void main();
