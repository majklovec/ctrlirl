/**
 * The relay-box side of the MobLink transparent L3 bridge.
 *
 * One relay instance = one leg: one encoder (or group of encoders sharing the
 * vif), one uplink interface. The relay owns:
 *
 *   - ONE UDP socket bound to 0.0.0.0:listenPort (all local addresses), and
 *   - ONE TUN device carrying the virtual-interface /32.
 *
 * The kernel does the rest: a per-leg `ip rule` on iif = tun pins egress to
 * the uplink NIC, `to vif/32 dev tun` + conntrack (masquerade) steer replies
 * back through the TUN, so the user space never touches a packet header.
 * See `NAT.md`.
 *
 * No raw sockets, no user-space NAT: a packet costs one UDP delivery
 * callback + one TUN write (or the reverse).
 */

import { networkInterfaces } from "node:os";
import { bytesToU32, isIpv4 } from "./ip";
import {
    DATA_HEADER_LEN,
    decodeFrame,
    encodeKeepaliveFrame,
    sniffFrameKind,
    writeDataHeader,
} from "./protocol";
import { newRelayStats, noteError } from "./stats";
import { openTun, type TunDevice, type TunFactory } from "./tun_linux";
import type { CommandRunner, RelayStats } from "./types";

// --- Listener-level socket abstraction (tests inject a fake; Bun in prod) ---

/** One delivered UDP datagram plus its sender. */
export interface SocketEvent {
    buf: Uint8Array;
    addr: string;
    port: number;
}

export interface RelaySocket {
    send(buf: Uint8Array, port: number, addr: string): void | boolean;
    close(): void;
}

export type RelaySocketFactory = (
    port: number,
    host: string,
    onEvent: (event: SocketEvent) => void,
    onError: (err: unknown) => void,
) => Promise<RelaySocket>;

/**
 * The production UDP listener. Binds `host:port` - `host: "0.0.0.0"`
 * receives on every local address, so the relay works no matter which NIC
 * the encoder reached through.
 */
export function bunRelaySocketFactory(
    port: number,
    host: string,
    onEvent: (event: SocketEvent) => void,
    onError: (err: unknown) => void,
): Promise<RelaySocket> {
    // Bun 1.4: async constructor; binding happens from the port/hostname
    // options (no `.bind()`). `reusePort` lets a restarting leg grab its
    // port before the old listener fully releases it.
    type UdpOpts = {
        port: number;
        hostname: string;
        reusePort: boolean;
        socket: {
            data: (
                s: unknown,
                buf: Uint8Array,
                port: number,
                addr: string,
            ) => void;
            error: (e: unknown) => void;
        };
    };
    const ctor = Bun.udpSocket as unknown as (
        opts: UdpOpts,
    ) => Promise<RelaySocket>;
    return ctor({
        port,
        hostname: host,
        reusePort: true,
        socket: {
            data: (_s, buf, p, a) => onEvent({ buf, addr: a, port: p }),
            error: (e) => onError(e),
        },
    });
}

// --- Options / public interface ---------------------------------------------

export interface UdpRelayOptions {
    /** Uplink interface this leg exits through (e.g. "eno1"). The backend
     * provisions the routing/conntrack for it; the relay itself only needs
     * the name for reporting. */
    interfaceName: string;
    /** UDP port the encoder dials. Bound on all local addresses. */
    listenPort: number;
    /** The virtual-interface /32 this leg bridges (the TUN address). */
    vifIp: string;
    /** Name of the TUN device backing this leg (the backend provisions it).
     * Default `"rltun0"`. Must be ≤14 chars and match the shared TUN-name
     * matcher so the network module hides it from uplinks. */
    tunName?: string;
    /**
     * Local address to bind the listener to. Default `"0.0.0.0"` - every
     * local address, which is what makes the relay NIC-agnostic. Set a
     * specific IP to restrict the leg (tests).
     */
    listenAddress?: string;
    /** Address shown in status output (default: the listen address). */
    interfaceAddress?: string;
    onStats?: (s: RelayStats) => void;
    /** Periodic stats emission interval in ms (0 = only on lifecycle). */
    statsIntervalMs?: number;
    /**
     * Invoked once with the vif IP, at end of `start()`. The backend
     * installs the `to vif/32 dev tun` route + iif rule there.
     */
    onVifLearned?: (vifIp: string) => void;
    /** TUN factory (tests / non-Linux). */
    tunFactory?: TunFactory;
    /** UDP listener factory (tests / Bun-less runtimes). */
    socketFactory?: RelaySocketFactory;
    /** Command runner for the TUN factory's shell-outs. */
    runCommand?: CommandRunner;
}

export interface UdpRelay {
    readonly interfaceName: string;
    readonly interfaceAddress: string;
    /** Address the single UDP listener binds (all NICs in the NIC-agnostic design). */
    readonly listenAddress: string;
    readonly listenPort: number;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): RelayStats;
    isRunning(): boolean;
    /** Name of the TUN device backing this leg. */
    vifName(): string;
    readonly lastError: string | null;
}

const InterfaceRe = /^[a-zA-Z0-9_.-]{1,15}$/;

/** Resolve `interfaceName` → its first IPv4 address via os.networkInterfaces(). */
export function resolveInterfaceAddress(
    interfaceName: string,
    family: 4 | 6 = 4,
): string {
    if (!InterfaceRe.test(interfaceName)) {
        throw new Error(`unsafe interface name: ${interfaceName}`);
    }
    const ifaces = networkInterfaces();
    const addrs = ifaces[interfaceName];
    const match = (addrs ?? []).find((a) => a.family === `IPv${family}`);
    if (!match)
        throw new Error(
            `no IPv${family} address on interface ${interfaceName} to bind`,
        );
    return match.address;
}

// --- Pure forwarding decisions (unit-testable, no sockets / root) ------------

export type EncoderDecision =
    | { action: "forward"; vifIp: string; packet: Uint8Array }
    | { action: "liveness" } // keepalive, nothing to forward
    | { action: "drop"; reason: string };

/** What to do with a frame the ENCODER sent. Pure: no side effects. */
export function decideEncoderFrame(buf: Uint8Array): EncoderDecision {
    const frame = decodeFrame(buf);
    if (frame.type === "malformed")
        return { action: "drop", reason: frame.reason };
    if (frame.type === "keepalive") return { action: "liveness" };
    return { action: "forward", vifIp: frame.vifIp, packet: frame.payload };
}

// --- The relay ---------------------------------------------------------------

interface RelayEndpoint {
    addr: string;
    port: number;
}

const TX_MAX = DATA_HEADER_LEN + 65535;

/**
 * Construct a transparent L3 relay. Validates input; sockets and the TUN
 * are created in `start()`.
 */
export async function createUdpRelay(opts: UdpRelayOptions): Promise<UdpRelay> {
    const listenAddress = opts.listenAddress ?? "0.0.0.0";
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(listenAddress)) {
        throw new TypeError(
            `listenAddress must be an IPv4 address (got \`${listenAddress}\`)`,
        );
    }
    if (!isIpv4(opts.vifIp)) {
        throw new TypeError(
            `vifIp must be an IPv4 address (got \`${opts.vifIp}\`)`,
        );
    }
    void InterfaceRe.test(opts.interfaceName);
    return new RelayImpl(opts, listenAddress);
}

class RelayImpl implements UdpRelay {
    readonly interfaceName: string;
    readonly interfaceAddress: string;
    readonly listenAddress: string;
    readonly listenPort: number;
    readonly tunName: string;

    private listenSocket: RelaySocket | null = null;
    private tun: TunDevice | null = null;

    // u32 (network byte order) of the vif /32 → the most recent encoder that
    // sent us a packet for this vif. The kernel only delivers to this TUN
    // packets addressed to vifIp, so one entry per vif suffices and the map
    // can never grow unbounded.
    private readonly vifEndpoints = new Map<number, RelayEndpoint>();
    private lastEncoder: string | null = null;
    private lastEncoderSeen = 0;

    // Two reusable buffers for the TUN→encoder path: the TUN delivers into
    // `rxBuf`; the frame (header + packet) is assembled in `txBuf` - a
    // distinct buffer, so the `.set()` can never overlap.
    // Bun.udpSocket.send() copies synchronously, so reusing txBuf on the
    // next packet is safe.
    private readonly rxBuf = new Uint8Array(65535);
    private readonly txBuf = new Uint8Array(TX_MAX);

    private counters: RelayStats;
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private stopping = false;
    lastError: string | null = null;

    constructor(
        private readonly options: UdpRelayOptions,
        listenAddress: string,
    ) {
        this.interfaceName = options.interfaceName;
        this.interfaceAddress = options.interfaceAddress ?? listenAddress;
        this.listenAddress = listenAddress;
        this.listenPort = options.listenPort;
        this.tunName = options.tunName ?? "rltun0";
        this.counters = newRelayStats();
        this.counters.startedAt = Date.now();
    }

    async start(): Promise<void> {
        if (this.listenSocket || this.stopping) return;

        // The relay TUN is a bare L3 pipe (no address of its own): the
        // backend provisions it (up, routing, conntrack) around start.
        const tunFactory: TunFactory = this.options.tunFactory ?? openTun;
        this.tun = await tunFactory(this.tunName, this.options.runCommand);

        const socketFactory: RelaySocketFactory =
            this.options.socketFactory ?? bunRelaySocketFactory;
        this.listenSocket = await socketFactory(
            this.listenPort,
            this.listenAddress,
            (event) => this.onListenEvent(event),
            (err) => this.onSocketError(err),
        );

        // TUN→listener direction: synchronous per packet.
        this.tun.onPacket(this.rxBuf, (len) =>
            this.onTunPacket(this.rxBuf, len),
        );

        const interval = this.options.statsIntervalMs ?? 0;
        if (interval > 0) {
            this.statsTimer = setInterval(() => this.emitStats(), interval);
        }
        this.options.onVifLearned?.(this.options.vifIp);
    }

    async stop(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        const tun = this.tun;
        this.tun = null;
        tun?.close();
        const sock = this.listenSocket;
        this.listenSocket = null;
        sock?.close();
        this.emitStats();
    }

    stats(): RelayStats {
        return {
            ...this.counters,
            lastEncoderSeen: this.lastEncoderSeen,
            lastEncoder: this.lastEncoder ?? undefined,
            lastError: this.lastError
                ? { at: Date.now(), message: this.lastError }
                : undefined,
        };
    }

    isRunning(): boolean {
        return this.listenSocket !== null && !this.stopping;
    }

    vifName(): string {
        return this.tun?.name ?? this.tunName;
    }

    private emitStats(): void {
        this.options.onStats?.(this.stats());
    }

    private onSocketError(err: unknown): void {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.emitStats();
    }

    /** UDP datagram from (presumably) the encoder. */
    private onListenEvent(event: SocketEvent): void {
        const buf = event.buf;
        const kind = sniffFrameKind(buf);
        if (kind === "data") {
            if (buf.length < DATA_HEADER_LEN) {
                this.counters.drops++;
                return;
            }
            // Header carries the vif /32 this frame is for.
            const vifU32 = bytesToU32(buf, 4);
            if (vifU32 === null) {
                this.counters.drops++;
                return;
            }
            const now = Date.now();
            this.lastEncoder = event.addr;
            this.lastEncoderSeen = now;
            const prev = this.vifEndpoints.get(vifU32);
            if (!prev || prev.addr !== event.addr || prev.port !== event.port) {
                this.vifEndpoints.set(vifU32, {
                    addr: event.addr,
                    port: event.port,
                });
            }
            this.counters.encRxPackets++;
            this.counters.encRxBytes += buf.length;
            // Strip the 8-byte frame header; the kernel picks up the rest.
            this.counters.vifTxPackets++;
            this.counters.vifTxBytes += buf.length - DATA_HEADER_LEN;
            this.tun?.write(buf, DATA_HEADER_LEN, buf.length - DATA_HEADER_LEN);
            return;
        }
        if (kind === "keepalive") {
            this.lastEncoder = event.addr;
            this.lastEncoderSeen = Date.now();
            this.counters.encRxPackets++;
            this.counters.encRxBytes += buf.length;
            this.listenSocket?.send(
                encodeKeepaliveFrame(Date.now()),
                event.port,
                event.addr,
            );
            return;
        }
        this.counters.drops++;
    }

    /**
     * IP packet the kernel handed out of our TUN - a reply destined for the
     * vif /32 (conntrack de-NATed it back). Frame it and send to the
     * encoder.
     */
    private onTunPacket(buf: Uint8Array, len: number): void {
        if (len < 20 || buf[0] >> 4 !== 4) {
            this.counters.drops++;
            return;
        }
        // Destination address (IPv4 header offset 16) must be the vif /32.
        const vifU32 = bytesToU32(buf, 16);
        if (vifU32 === null) {
            this.counters.drops++;
            return;
        }
        const endpoint = this.vifEndpoints.get(vifU32);
        if (!endpoint) {
            this.counters.drops++;
            return;
        }
        if (len + DATA_HEADER_LEN > this.txBuf.length) {
            this.counters.drops++;
            return;
        }
        writeDataHeader(this.txBuf, vifU32);
        this.txBuf.set(buf.subarray(0, len), DATA_HEADER_LEN);
        this.counters.vifRxPackets++;
        this.counters.vifRxBytes += len;
        this.counters.encTxPackets++;
        this.counters.encTxBytes += len + DATA_HEADER_LEN;
        this.listenSocket?.send(
            this.txBuf.subarray(0, len + DATA_HEADER_LEN),
            endpoint.port,
            endpoint.addr,
        );
    }
}
