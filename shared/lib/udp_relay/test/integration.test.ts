//
// End-to-end test of the full relay data path with mock TUN and a mock
// socket factory (no root, no real TUN, no network binding):
//
//   encoder data frame → relay listener → TUN write (bare IP packet)
//   TUN read (reply)   → relay → framed UDP back to the encoder

import { describe, expect, test } from "bun:test";
import {
    createUdpRelay,
    encodeDataFrame,
    encodeKeepaliveFrame,
    buildUdpIpPacket,
} from "../src/index";
import { makeMockTunDevice } from "../src/tun_linux";
import type { UdpRelayOptions } from "../src/relay";

const VIF = "192.168.77.13";

function encoderHarness(opts: Omit<UdpRelayOptions, "socketFactory" | "tunFactory">) {
    const tun = makeMockTunDevice({ name: "rtltun_eth0" });
    const outbound: { buf: Uint8Array; port: number; addr: string }[] = [];
    let inbound:
        | ((b: Uint8Array, a: string, p: number) => void)
        | null = null;

    const relayOpts: UdpRelayOptions = {
        ...opts,
        tunFactory: async () => tun.device,
        socketFactory: (_p, _h, onEvent) =>
            Promise.resolve({
                send: (b: Uint8Array, port: number, addr: string) => {
                    outbound.push({ buf: Uint8Array.from(b), port, addr });
                    return true;
                },
                close() {},
            }),
    };
    // wrap so we can inject
    relayOpts.socketFactory = (_p, _h, onEvent) => {
        inbound = (b, a, p) => onEvent({ buf: b, addr: a, port: p });
        return Promise.resolve({
            send: (b: Uint8Array, port: number, addr: string) => {
                outbound.push({ buf: Uint8Array.from(b), port, addr });
                return true;
            },
            close() {},
        });
    };

    return {
        tun,
        outbound,
        send: (b: Uint8Array, a: string, p: number) => inbound!(b, a, p),
        relayOpts,
    };
}

function ipPacket(src: string, dst: string, payload: string): Uint8Array {
    return buildUdpIpPacket({
        srcIp: src,
        dstIp: dst,
        srcPort: 5001,
        dstPort: 5000,
        payload: new TextEncoder().encode(payload),
    });
}

describe("relay full data path (no root)", () => {
    test("forward + reply round trip", async () => {
        const h = encoderHarness({
            interfaceName: "lo",
            listenPort: 10000,
            vifIp: VIF,
        });
        const relay = await createUdpRelay(h.relayOpts);
        await relay.start();

        // 1. Encoder sends a data frame (source = vif, dest = VPS).
        const fwd = ipPacket(VIF, "83.208.44.38", "forward");
        h.send(encodeDataFrame(fwd, VIF), "192.168.10.101", 40000);

        // The TUN receives the bare IP packet (header stripped).
        expect(h.tun.written.length).toBe(1);
        expect(Array.from(h.tun.written[0])).toEqual(Array.from(fwd));

        // 2. Reply arrives out of the TUN (from VPS, to the vif /32).
        const reply = ipPacket("83.208.44.38", VIF, "reply!");
        h.tun.pushPacket(reply);

        // 3. Encoder receives the framed reply.
        expect(h.outbound.length).toBe(1);
        expect(h.outbound[0].addr).toBe("192.168.10.101");
        expect(h.outbound[0].port).toBe(40000);
        expect(h.outbound[0].buf[0]).toBe(0x01);
        expect(Array.from(h.outbound[0].buf.subarray(8))).toEqual(Array.from(reply));

        const st = relay.stats();
        expect(st.encRxPackets).toBe(1);
        expect(st.vifTxPackets).toBe(1);
        expect(st.vifRxPackets).toBe(1);
        expect(st.encTxPackets).toBe(1);
        await relay.stop();
    });

    test("keepalive keeps the leg alive without touching the TUN", async () => {
        const h = encoderHarness({
            interfaceName: "lo",
            listenPort: 10000,
            vifIp: VIF,
        });
        const relay = await createUdpRelay(h.relayOpts);
        await relay.start();
        h.send(encodeKeepaliveFrame(Date.now()), "192.168.10.101", 40000);
        expect(h.tun.written.length).toBe(0);
        expect(h.outbound.length).toBe(1);
        expect(h.outbound[0].buf[0]).toBe(0x02);
        expect(relay.stats().lastEncoderSeen).toBeGreaterThan(0);
        await relay.stop();
    });

    test("onVifLearned fires at end of start", async () => {
        const learned: string[] = [];
        const h = encoderHarness({
            interfaceName: "lo",
            listenPort: 10000,
            vifIp: "192.168.77.99",
            onVifLearned: (ip) => learned.push(ip),
        });
        const relay = await createUdpRelay(h.relayOpts);
        await relay.start();
        expect(learned).toEqual(["192.168.77.99"]);
        expect(relay.vifName()).toBe("rtltun_eth0");
        await relay.stop();
    });
});
