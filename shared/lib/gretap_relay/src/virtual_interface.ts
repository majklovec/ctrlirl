/* The tunnel side (both boxes): a kernel GRETAP tunnel bridged into the
 * local LAN.
 *
 * Replaces the legacy `@ctrlirl/udp-relay` virtual interface: where one side
 * used to open a TUN and pump framed IP packets over UDP to a relay process,
 * each side now asks the kernel for a GRETAP device (`gretap<name>`), a
 * bridge (`br-<name>`) and attaches both the tunnel and the local LAN NIC to
 * it. All forwarding is in-kernel; this module only manages the topology and
 * reports the kernel's counters.
 *
 * The public surface (`createVirtualInterface` + `VirtualInterface`) matches
 * the legacy API so callers compile unchanged. Options the kernel supersedes
 * (`bindAddress`, `keepaliveIntervalMs`, `tunDevice`, `relay.port`) are
 * accepted and ignored.
 */
import {
	IFACE_NAME_RE,
	ipRunner,
	readIfaceStats,
	removeGretap,
	setUpGretap,
} from "./gretap";
import { noteError, newVifStats } from "./stats";
import type { Endpoint, VifStats } from "./types";

export interface VirtualInterfaceOptions {
    /** Tunnel device suffix, 1..15 chars (the kernel iface limit). */
    name: string;
    /**
     * The IPv4 address of this box's WDS-facing (tunnel-peer) interface —
     * used to find the LAN NIC to bridge in. Must be the IP on the link to
     * the peer, not the LAN IP the bridge will extend.
     */
    localIp: string;
    /** Prefix length (accepted for API compatibility; not applied). */
    prefixLength: number;
    /**
     * The peer box: `host` is its WDS-link IP (the GRETAP remote); `port`
     * is legacy and ignored (GRETAP is portless).
     */
    relay: Endpoint;
    /** Legacy: ignored (there is no userspace socket to bind). */
    bindAddress?: string;
    /**
     * GRE key shared by both tunnel ends (keyed demux: outer addresses are
     * ignored by the kernel, so the tunnel works across asymmetric subnets).
     * Derive it with `greKeyForEndpoints(peerIp, localIp)`. Default: none.
     */
    greKey?: number;
    /**
     * The relay IP the GRETAP outer header is **addressed at** (`remote`).
     * When this box reaches the relay over a segment other than the one the
     * relay advertises on (GRETAP exposure, `GRETAP-RESEARCH.md`), that IP is
     * the relay's ON-PATH egress IP, not the advertised `relay.host`. Without
     * it the kernel drops tunnel-egress frames addressed to a non-local
     * address. Default: `relay.host` (direct / same-segment tunnel).
     */
    remoteIp?: string;
    /** Tunnel MTU (default 1500). */
    mtu?: number;
    /** Legacy: ignored (GRE keepalives are kernel-side). */
    keepaliveIntervalMs?: number;
    onStats?: (s: VifStats) => void;
    /**
     * The LAN NIC to bridge into `br-<name>` (default: auto-detected as the
     * interface holding `localIp`).
     */
    localIface?: string;
    /**
     * Legacy test seam: ignored. GRETAP is managed through `ip` — unit tests
     * inject a fake `ip` runner via `setIpRunner()` instead.
     */
    tunDevice?: unknown;
}

export interface VirtualInterface {
    readonly name: string;
    readonly localIp: string;
    /**
     * Legacy field: the old relay-facing UDP socket's bound address. GRETAP
     * has no userspace socket — always `null` (callers must not depend on it).
     */
    readonly socketAddress: { host: string; port: number } | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): VifStats;
    isRunning(): boolean;
}

const DEFAULT_MTU = 1500;

/** The network address of `ip/prefix` (for `ip route replace <net>/<prefix>`). */
function cidrNetwork(ip: string, prefix: number): string {
    const octets = ip.split(".").map((o) => Number.parseInt(o, 10) | 0);
    const bits = prefix & ~7;
    const mask = bits === 0
        ? 0
        : 0xffffffff ^ (0xffffffff >>> (Math.min(bits, 32))) | 0;
    return octets
        .map((o, i) => (o & (mask >>> (24 - 8 * i)) & 0xff) & 0xff)
        .join(".");
}

/**
 * Construct a tunnel handle. Cheap: validates input only. Runtime failures
 * (`ip` calls, missing privileges) surface from `start()`.
 */
export async function createVirtualInterface(
    opts: VirtualInterfaceOptions,
): Promise<VirtualInterface> {
    if (process.platform !== "linux")
        throw new Error(
            `@ctrlirl/gretap-relay requires Linux (running on ${
                process.platform
            })`,
        );
    if (!IFACE_NAME_RE.test(opts.name))
        throw new Error(
            `name ${JSON.stringify(opts.name)} is not a valid interface name`,
        );
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(opts.localIp))
        throw new Error(`localIp ${JSON.stringify(opts.localIp)} is not IPv4`);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(opts.relay.host))
        throw new Error(
            `relay.host ${JSON.stringify(
                opts.relay.host,
            )} must be the peer's WDS-link IPv4 address`,
        );
    if (
        opts.remoteIp !== undefined &&
        !/^\d+\.\d+\.\d+\.\d+$/.test(opts.remoteIp)
    )
        throw new Error(
            `remoteIp ${JSON.stringify(opts.remoteIp)} is not IPv4`,
        );
    if (
        !Number.isInteger(opts.prefixLength) ||
        opts.prefixLength < 8 ||
        opts.prefixLength > 32
    )
        throw new Error(`prefixLength ${opts.prefixLength} out of [8,32]`);
    const mtu = opts.mtu ?? DEFAULT_MTU;
    if (!Number.isInteger(mtu) || mtu < 68 || mtu > 65535)
        throw new Error(`mtu ${mtu} out of [68,65535]`);
    return new VifImpl(opts, mtu);
}

class VifImpl implements VirtualInterface {
    readonly name: string;
    readonly localIp: string;
    readonly socketAddress: { host: string; port: number } | null = null;
    private running = false;
    private _stats: VifStats = newVifStats();

    constructor(
        private opts: VirtualInterfaceOptions,
        private mtu: number,
    ) {
        // `name` is the FULL device name (e.g. `gretap_eno2`); the bridge is
        // `br-<name>` (e.g. `br-gretap_eno2`). `IFACE_NAME_RE` already
        // validated it in `createVirtualInterface`.
        this.name = opts.name;
        this.localIp = opts.localIp;
    }

    async start(): Promise<void> {
        if (this.running) return;
        try {
            const { bridge } = await setUpGretap({
                name: this.opts.name,
                // Address outer GRE at the relay's ON-PATH IP when the relay
                // told us to (GRETAP exposure); else the advertised link IP.
                peerIp: this.opts.remoteIp ?? this.opts.relay.host,
                localIp: this.localIp,
                localIface: this.opts.localIface,
                mtu: this.mtu,
                greKey: this.opts.greKey,
            });
            // Give the bridge an address in the tunnel subnet + a route for it.
            // Without this the GRETAP device carries no IP and the LAN (or the
            // exposed remote-LAN prefix) is unreachable — the L2 bridge extends
            // the LAN, but nothing has an address on it yet. `localIp` is the
            // virtual address (legacy 10.x or the exposed remote-LAN .200) and
            // `prefixLength` the matching netmask (the exposed prefix, not the
            // default /24, when the relay exposes a remote LAN).
            await ipRunner([
                "addr",
                "replace",
                `${this.localIp}/${this.opts.prefixLength}`,
                "dev",
                bridge,
            ]);
            // The route for `localIp/prefix` is the connected route on the
            // bridge; make it explicit so it wins over the default/LAN route.
            const network = cidrNetwork(this.localIp, this.opts.prefixLength);
            await ipRunner([
                "route",
                "replace",
                `${network}/${this.opts.prefixLength}`,
                "dev",
                bridge,
            ]).catch(() => {});
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            noteError(this._stats, message);
            throw new Error(
                `gretap ${this.name} start failed: ${message}`,
            );
        }
        this.running = true;
        this._stats.startedAt = Date.now();
        this._stats.lastError = undefined;
        this.emitStats();
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        try {
            await removeGretap(this.opts.name);
        } catch (e) {
            noteError(
                this._stats,
                `teardown: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
        this.emitStats();
    }

    isRunning(): boolean {
        return this.running;
    }

    stats(): VifStats {
        if (this.running) this.refreshStats();
        return { ...this._stats };
    }

    private refreshStats(): void {
        try {
            const s = readIfaceStats(this.name);
            this._stats = {
                ...this._stats,
                txPackets: s.txPackets,
                txBytes: s.txBytes,
                rxPackets: s.rxPackets,
                rxBytes: s.rxBytes,
                drops: s.drops,
            };
        } catch {
            // Counters are best-effort; keep the last reading.
        }
    }

    private emitStats(): void {
        this.opts.onStats?.(this.stats());
    }
}
