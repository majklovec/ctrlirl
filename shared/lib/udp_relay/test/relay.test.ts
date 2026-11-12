import { describe, expect, test } from "bun:test";
import {
    createUdpRelay,
    decideEncoderFrame,
    encodeDataFrame,
    encodeKeepaliveFrame,
    bytesToU32,
    ipToU32,
    buildUdpIpPacket,
} from "../src/index";
import { makeMockTunDevice } from "../src/tun_linux";
import type {
    RelaySocket,
    RelaySocketFactory,
    SocketEvent,
    UdpRelay,
    UdpRelayOptions,
} from "../src/relay";

const VIF = "192.168.77.13";

/** A mock UDP listener capturing sends and allowing injected receives. */
function makeMockSocket() {
    const sent: { buf: Uint8Array; port: number; addr: string }[] = [];
    let onEvent: ((e: SocketEvent) => void) | null = null;
    const socket: RelaySocket = {
        send(b: Uint8Array, port: number, addr: string) {
            sent.push({ buf: Uint8Array.from(b), port, addr });
            return true;
        },
        close() {},
    };
    const socketFactory: RelaySocketFactory = (_p, _h, ev) => {
        onEvent = ev;
        return Promise.resolve(socket);
    };
    return {
        sent,
        socketFactory,
        deliver(buf: Uint8Array, addr: string, port: number) {
            onEvent!({ buf, addr, port });
        },
    };
}

function relaySetup(
    extra: Partial<UdpRelayOptions> = {},
): {
    opts: UdpRelayOptions;
    tun: ReturnType<typeof makeMockTunDevice>;
    sock: ReturnType<typeof makeMockSocket>;
} {
    const tun = makeMockTunDevice({ name: "rltun0" });
    const sock = makeMockSocket();
    const opts: UdpRelayOptions = {
        interfaceName: "lo",
        listenPort: 10000,
        vifIp: VIF,
        tunFactory: async () => tun.device,
        socketFactory: sock.socketFactory,
        ...extra,
    };
    return { opts, tun, sock };
}

function ipPacket(src: string, dst: string, payload = "hello"): Uint8Array {
    return buildUdpIpPacket({
        srcIp: src,
        dstIp: dst,
        srcPort: 5001,
        dstPort: 5000,
        payload: new TextEncoder().encode(payload),
    });
}

function frame(pkt: Uint8Array): Uint8Array {
    return encodeDataFrame(pkt, VIF);
}

describe("decideEncoderFrame (pure)", () => {
    test("data frame → forward with vif + payload", () => {
        const pkt = ipPacket(VIF, "10.0.0.1");
        const d = decideEncoderFrame(frame(pkt));
        expect(d.action).toBe("forward");
        if (d.action === "forward") {
            expect(d.vifIp).toBe(VIF);
            expect(Array.from(d.packet)).toEqual(Array.from(pkt));
        }
    });

    test("keepalive → liveness", () => {
        expect(decideEncoderFrame(encodeKeepaliveFrame(123)).action).toBe(
            "liveness",
        );
    });

    test("garbage → drop", () => {
        expect(decideEncoderFrame(new Uint8Array([0x7f])).action).toBe("drop");
    });
});

describe("createUdpRelay validation", () => {
    test("rejects non-IPv4 listenAddress", async () => {
        await expect(
            createUdpRelay({ interfaceName: "lo", listenPort: 1, vifIp: "10.0.0.1", listenAddress: "nonsense" }),
        ).rejects.toThrow(TypeError);
    });

    test("rejects non-IPv4 vifIp", async () => {
        await expect(
            createUdpRelay({ interfaceName: "lo", listenPort: 1, vifIp: "10.0.0" }),
        ).rejects.toThrow(TypeError);
    });
});

describe("relay data path (mocks)", () => {
    test("encoder data frame → TUN gets exact IP payload", async () => {
        const { opts, tun, sock } = relaySetup();
        const relay: UdpRelay = await createUdpRelay(opts);
        await relay.start();

        const pkt = ipPacket(VIF, "83.208.44.38");
        sock.deliver(frame(pkt), "192.168.10.101", 40000);

        expect(tun.written.length).toBe(1);
        expect(Array.from(tun.written[0])).toEqual(Array.from(pkt));
        const st = relay.stats();
        expect(st.encRxPackets).toBe(1);
        expect(st.encRxBytes).toBe(frame(pkt).length);
        expect(st.vifTxPackets).toBe(1);
        expect(st.vifTxBytes).toBe(pkt.length);
        expect(st.lastEncoder).toBe("192.168.10.101");
        await relay.stop();
    });

    test("TUN reply → framed to the encoder with correct vif header", async () => {
        const { opts, tun, sock } = relaySetup();
        const relay = await createUdpRelay(opts);
        await relay.start();

        sock.deliver(frame(ipPacket(VIF, "83.208.44.38")), "192.168.10.101", 40000);
        tun.written.length = 0;

        const reply = ipPacket("83.208.44.38", VIF, "pong");
        tun.pushPacket(reply);

        expect(sock.sent.length).toBe(1);
        const out = sock.sent[0];
        expect(out.addr).toBe("192.168.10.101");
        expect(out.port).toBe(40000);
        expect(out.buf[0]).toBe(0x01);
        expect(bytesToU32(out.buf, 4)).toBe(ipToU32(VIF));
        expect(Array.from(out.buf.subarray(8))).toEqual(Array.from(reply));
        const st = relay.stats();
        expect(st.vifRxPackets).toBe(1);
        expect(st.encTxPackets).toBe(1);
        expect(st.encTxBytes).toBe(reply.length + 8);
        await relay.stop();
    });

    test("keepalive is answered, nothing hits the TUN", async () => {
        const { opts, tun, sock } = relaySetup();
        const relay = await createUdpRelay(opts);
        await relay.start();
        sock.deliver(encodeKeepaliveFrame(999), "192.168.10.101", 40000);
        expect(tun.written.length).toBe(0);
        expect(sock.sent.length).toBe(1);
        expect(sock.sent[0].buf[0]).toBe(0x02);
        expect(sock.sent[0].addr).toBe("192.168.10.101");
        await relay.stop();
    });

    test("truncated data frame → dropped", async () => {
        const { opts, tun, sock } = relaySetup();
        const relay = await createUdpRelay(opts);
        await relay.start();
        sock.deliver(new Uint8Array([0x01, 0x00]), "10.0.0.1", 1);
        expect(tun.written.length).toBe(0);
        expect(relay.stats().drops).toBe(1);
        await relay.stop();
    });

    test("TUN packet not IPv4 → dropped", async () => {
        const { opts, tun, sock } = relaySetup();
        const relay = await createUdpRelay(opts);
        await relay.start();
        sock.deliver(frame(ipPacket(VIF, "10.0.0.1")), "10.0.0.1", 1);
        tun.written.length = 0;
        const v6 = new Uint8Array(40);
        v6[0] = 0x60;
        tun.pushPacket(v6);
        expect(sock.sent.length).toBe(0);
        expect(relay.stats().drops).toBeGreaterThanOrEqual(1);
        await relay.stop();
    });

    test("reply before any encoder → dropped", async () => {
        const { opts, tun, sock } = relaySetup();
        const relay = await createUdpRelay(opts);
        await relay.start();
        tun.pushPacket(ipPacket("83.208.44.38", VIF));
        expect(sock.sent.length).toBe(0);
        expect(relay.stats().drops).toBe(1);
        await relay.stop();
    });

    test("two encoders: most recent wins the endpoint", async () => {
        const { opts, tun, sock } = relaySetup();
        const relay = await createUdpRelay(opts);
        await relay.start();
        sock.deliver(frame(ipPacket(VIF, "10.0.0.1")), "10.0.0.1", 1111);
        sock.deliver(frame(ipPacket(VIF, "10.0.0.1")), "10.0.0.2", 2222);
        tun.written.length = 0;
        tun.pushPacket(ipPacket("83.208.44.38", VIF, "to-b"));
        expect(sock.sent.length).toBe(1);
        expect(sock.sent[0].addr).toBe("10.0.0.2");
        expect(sock.sent[0].port).toBe(2222);
        await relay.stop();
    });

    test("back-to-back TUN packets survive the reused tx buffer", async () => {
        const { opts, tun, sock } = relaySetup();
        const relay = await createUdpRelay(opts);
        await relay.start();
        sock.deliver(frame(ipPacket(VIF, "10.0.0.1")), "10.0.0.1", 1111);
        tun.written.length = 0;
        const a = ipPacket("1.1.1.1", VIF, "AAA");
        const b = ipPacket("2.2.2.2", VIF, "BBBB");
        tun.pushPacket(a);
        tun.pushPacket(b);
        expect(sock.sent.length).toBe(2);
        expect(Array.from(sock.sent[0].buf.subarray(8))).toEqual(Array.from(a));
        expect(Array.from(sock.sent[1].buf.subarray(8))).toEqual(Array.from(b));
        await relay.stop();
    });

    test("start/stop are idempotent", async () => {
        const { opts } = relaySetup();
        const relay = await createUdpRelay(opts);
        await relay.start();
        await relay.start();
        expect(relay.isRunning()).toBe(true);
        await relay.stop();
        await relay.stop();
        expect(relay.isRunning()).toBe(false);
    });

    test("70000-byte TUN packet is truncated to the TUN cap, not thrown", async () => {
        const { opts, tun, sock } = relaySetup();
        const relay = await createUdpRelay(opts);
        await relay.start();
        sock.deliver(frame(ipPacket(VIF, "10.0.0.1")), "10.0.0.1", 1111);
        const huge = new Uint8Array(70_000);
        huge[0] = 0x45;
        huge.set([192, 168, 77, 13], 16);
        tun.pushPacket(huge);
        // The mock TUN truncates to the reader buffer (65535); the relay
        // delivers exactly that as a framed packet, without throwing.
        expect(sock.sent.length).toBe(1);
        expect(sock.sent[0].buf.length).toBe(65535 + 8);
        await relay.stop();
    });
});

describe("onEncoderVifLearned (wire-learned vif)", () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const ENC_VIF = "10.90.50.1";
    const encFrame = () =>
        encodeDataFrame(
            ipPacket(ENC_VIF, "144.91.123.190"),
            ENC_VIF,
        );

    test("fires once per distinct vif, on the frame-header vif", async () => {
        const learned: string[] = [];
        const { opts, sock } = relaySetup({
            onEncoderVifLearned: (ip) => {
                learned.push(ip);
            },
        });
        const relay = await createUdpRelay(opts);
        await relay.start();
        sock.deliver(encFrame(), "10.0.0.1", 1111);
        await tick();
        // Fired with the ENCODER's vif (from the frame header), not the
        // uplink IP the leg was provisioned with.
        expect(learned).toEqual([ENC_VIF]);
        // Same vif again: no re-announce.
        sock.deliver(encFrame(), "10.0.0.1", 1111);
        await tick();
        expect(learned).toEqual([ENC_VIF]);
        // A second distinct vif: announced separately.
        const enc2 = encodeDataFrame(
            ipPacket("10.90.51.2", "144.91.123.190"),
            "10.90.51.2",
        );
        sock.deliver(enc2, "10.0.0.1", 1111);
        await tick();
        expect(learned).toEqual([ENC_VIF, "10.90.51.2"]);
        await relay.stop();
    });

    test("await rejects do not poison the hot path", async () => {
        let rejected = false;
        const { opts, sock } = relaySetup({
            onEncoderVifLearned: () => {
                rejected = true;
                return Promise.reject(new Error("vif apply failed"));
            },
        });
        const relay = await createUdpRelay(opts);
        await relay.start();
        sock.deliver(encFrame(), "10.0.0.1", 1111);
        await tick();
        expect(rejected).toBe(true);
        // Relay keeps running after the callback rejects.
        expect(relay.isRunning()).toBe(true);
        await relay.stop();
    });
});
