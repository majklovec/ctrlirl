/* A per-uplink relay handle (data-path state surface).
 *
 * The WireGuard tunnels own the transport, so there is no userspace packet
 * loop: this is a lightweight handle the relay module uses to track a live
 * uplink slot (its resolved address + bookkeeping). The factory validates its
 * options and returns a handle whose `start()`/`stop()` are idempotent no-ops.
 * `createUdpRelay` keeps the historical surface (`stats()`, `isRunning()`, …)
 * so the relay module compiles unchanged.
 */
import { IFACE_NAME_RE, resolveInterfaceAddress } from "./ifaces";
import { isValid as isValidIpv4 } from "./ip";
import { newRelayStats } from "./stats";
import type { IfaceRawSocket } from "./net_linux";
import type { RelayStats } from "./types";

export interface UdpRelayOptions {
    /** The interface name (legacy: the bound physical interface). */
    interfaceName: string;
    /** UDP port (legacy: the encoder-facing socket port; ignored). */
    listenPort: number;
    /**
     * The uplink's peer IPv4 (was: the relay's listen address). Accepted and
     * validated; the WireGuard tunnel is reached at it over the transport IP.
     */
    destination?: { host: string; port: number };
    /** Override the resolved interface IPv4 (skips os.networkInterfaces()). */
    interfaceAddress?: string;
    /** Legacy NAT source override (ignored — the kernel does no NAT here). */
    natAddress?: string;
    /** Legacy: NAT mode flag (ignored). */
    nat?: boolean;
    /** Legacy test seam: accepted (and closed on `stop()`), never used. */
    ifaceSocket?: IfaceRawSocket;
    onStats?: (s: RelayStats) => void;
    /** Legacy: vif-learned callback (never fires — there is no vif concept). */
    onVifLearned?: (vifIp: string) => void;
}

export interface UdpRelay {
    readonly interfaceName: string;
    readonly interfaceAddress: string;
    /** SNAT source (defaults to `interfaceAddress`). Legacy compat. */
    readonly natAddress: string;
    readonly listenPort: number;
    /** Resolved uplink peer IP. */
    readonly destination: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): RelayStats;
    isRunning(): boolean;
}

/**
 * Construct the (no-op) relay handle. Cheap: validates input only. Kept so
 * downstream code that calls `createUdpRelay` compiles and runs unchanged.
 */
export async function createUdpRelay(
    opts: UdpRelayOptions,
): Promise<UdpRelay> {
    if (!IFACE_NAME_RE.test(opts.interfaceName))
        throw new Error(
            `interfaceName ${JSON.stringify(opts.interfaceName)} is not a valid interface name`,
        );
    if (
        typeof opts.listenPort !== "number" ||
        opts.listenPort < 1 ||
        opts.listenPort > 65535
    )
        throw new Error(`listenPort ${opts.listenPort} out of [1,65535]`);
    // Optional: relay-box slots created by the relay module carry no peer
    // (the uplink peer is fixed per slot); validate only when provided.
    if (opts.destination && !isValidIpv4(opts.destination.host))
        throw new Error(
            `destination.host ${JSON.stringify(
                opts.destination.host,
            )} must be the peer's WDS-link IPv4 address`,
        );
    const interfaceAddress = resolveInterfaceAddress(
        opts.interfaceName,
        opts.interfaceAddress,
    );
    return new NoopRelay(opts, interfaceAddress);
}

class NoopRelay implements UdpRelay {
    readonly interfaceName: string;
    readonly interfaceAddress: string;
    readonly natAddress: string;
    readonly listenPort: number;
    readonly destination: string;
    private running = false;
    private _stats: RelayStats = newRelayStats();

    constructor(
        private opts: UdpRelayOptions,
        interfaceAddress: string,
    ) {
        this.interfaceName = opts.interfaceName;
        this.interfaceAddress = interfaceAddress;
        this.natAddress = opts.natAddress ?? interfaceAddress;
        this.listenPort = opts.listenPort;
        this.destination = opts.destination?.host ?? "";
    }

    /** No-op: the WireGuard tunnel owns the data path. */
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this._stats.startedAt = Date.now();
        this.opts.onStats?.(this.stats());
    }

    /** No-op; releases the (never-used) injected socket, if any. */
    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        try {
            this.opts.ifaceSocket?.close();
        } catch {
            // best-effort
        }
        this.opts.onStats?.(this.stats());
    }

    isRunning(): boolean {
        return this.running;
    }

    /** Legacy counters, all zero — see the module doc. */
    stats(): RelayStats {
        return { ...this._stats };
    }
}
