/*
 * Relay-side plain-UDP↔TUN multi-uplink transport. One `utn-<uplink>` TUN
 * netdev + a `udpip` server pump per eligible uplink (the relay owns the
 * physical uplinks).
 *
 * The pump binds `<uplinkIP>:<port>` and pins a single peer (the first
 * datagram source wins), so the relay installs no default route via the
 * netdev: egress is policy+routed on the relay (per-uplink table + MASQUERADE
 * + FORWARD) and outer UDP always leaves over the physical uplink. No crypto,
 * no key exchange, no per-encoder peers.
 *
 * All kernel work goes through the lib's `execCmd` seam (tests inject a
 * recorder); `sudo` is prepended at the one `setCmdRunner` seam.
 */
import {
	setupTunnelVif,
	removeTunnelVif,
	ensureTunnelRelayEgress,
	revokeTunnelRelayEgress,
	tunnelAddress,
	tunnelListenPort,
	tunnelRouteTable,
	DEFAULT_TUN_MTU,
} from "@ctrlirl/udpip";
import type { CtrlinkTunnelSpec } from "../../../shared/ctrlink_discovery";

/** One relay `utn-<uplink>` netdev and its egress state. */
interface NetdevState {
	name: string;
	/** 0-based stable uplink index (addressing + routing table + listen port). */
	index: number;
	/** The relay's tunnel IP, e.g. `10.200.1.1`. */
	localIp: string;
	/** The relay's tunnel UDP listen port for this netdev. */
	listenPort: number;
	/** The encoder's /30 on this tunnel, e.g. `10.200.1.2/30`. */
	encoderSubnet: string;
	routeTable: number;
	rulePriority: number;
}

const netdevs = new Map<string, NetdevState>();
const inFlight = new Set<string>();

let configured = false;
/** The relay's outer IP on the dedicated relay↔encoder link (tunnel endpoint
 * the encoder dials). A live getter (the ded-link address is only known after
 * discovery + can change), falling back to a static value. Set by
 * `configureRelayTunnels`. */
let transportOuterIp: string | (() => string) = "";

/** Resolve the current transport outer IP (dynamic getter or static). */
function currentTransportOuterIp(): string {
	return typeof transportOuterIp === "function"
		? (transportOuterIp() ?? "")
		: transportOuterIp;
}

export interface RelayTunnelConfig {
	enabled: boolean;
	/** The relay's own IP on the dedicated link to the encoder (e.g.
	 * `192.168.10.100`) — the `endpoint` the encoder dials per uplink. A
	 * getter is preferred: the ded-link address is only known once the
	 * encoder is discovered and can change at runtime. */
	transportOuterIp: string | (() => string);
}

/** Arm the module (bind time). Idempotent. */
export function configureRelayTunnels(cfg: RelayTunnelConfig): void {
	configured = cfg.enabled;
	transportOuterIp = cfg.transportOuterIp;
}

/** Is the relay running the tunnel transport? (Gates the announce offer). */
export function relayTunnelsEnabled(): boolean {
	return configured;
}

/** One eligible uplink the relay can expose as a tunnel. */
export interface RelayUplink {
	/** The physical uplink name (e.g. `eth0`). */
	uplink: string;
	/** The relay's IP on that uplink (the pump's bind address). */
	ip: string;
}

/**
 * The eligible uplinks the relay currently runs on — the set we build a
 * `utn-<if>` netdev for. Supplied by the backend on each reconcile (it owns
 * interface discovery); we persist the last set for reconciles in between.
 */
let lastUplinks: RelayUplink[] = [];

/**
 * Reconcile the relay's tunnel netdevs toward the desired state. `uplinks` is
 * the current eligible-uplink set (each with its physical IP).
 */
export async function reconcileRelayTunnelsNow(
	uplinks: RelayUplink[] = lastUplinks,
): Promise<void> {
	if (!configured) {
		void teardownAll();
		return;
	}
	lastUplinks = uplinks;
	const key = uplinks.map((u) => u.uplink).join("\0");
	if (inFlight.has(key)) return;
	inFlight.add(key);
	try {
		await reconcilePass(uplinks);
	} catch (e) {
		console.warn(`ctrlink_relay udpip: reconcile failed: ${String(e)}`);
	} finally {
		inFlight.delete(key);
	}
}

async function reconcilePass(uplinks: RelayUplink[]): Promise<void> {
	const desired = new Set(uplinks.map((u) => u.uplink));

	// 1. Remove netdevs whose uplink is gone.
	for (const name of [...netdevs.keys()])
		if (!desired.has(name)) await teardownNetdev(name);

	// 2. Ensure one netdev + egress per uplink (stable index = sorted pos).
	const sorted = [...uplinks].sort((a, b) =>
		a.uplink.localeCompare(b.uplink),
	);
	for (let i = 0; i < sorted.length; i++) {
		const { uplink, ip } = sorted[i];
		const existing = netdevs.get(uplink);
		if (existing && existing.index !== i) await teardownNetdev(uplink);
		if (netdevs.get(uplink)) continue;
		await ensureNetdev(uplink, ip, i);
	}
}

async function ensureNetdev(
	uplink: string,
	bindIp: string,
	index: number,
): Promise<void> {
	const addr = tunnelAddress(index);
	const name = `utn-${uplink}`;
	const listenPort = tunnelListenPort(index);
	// Server pump: bind the physical uplink's IP on the per-uplink port; the
	// first datagram source wins (single-peer pin on the trusted link).
	await setupTunnelVif({
		name,
		localIp: addr.relayIp,
		prefix: 30,
		mtu: DEFAULT_TUN_MTU,
		mode: "server",
		bind: `${bindIp}:${listenPort}`,
		allow: "first",
	});
	// Per-uplink egress: policy route tunnel-sourced traffic out the physical
	// uplink + MASQUERADE + FORWARD (idempotent).
	await ensureTunnelRelayEgress({
		uplink,
		tunName: name,
		encoderSubnet: `${addr.encoderIp}/30`,
		routeTable: tunnelRouteTable(index),
		rulePriority: 1000 + index,
	});
	netdevs.set(uplink, {
		name,
		index,
		localIp: addr.relayIp,
		listenPort,
		encoderSubnet: `${addr.encoderIp}/30`,
		routeTable: tunnelRouteTable(index),
		rulePriority: 1000 + index,
	});
}

async function teardownNetdev(uplink: string): Promise<void> {
	const nd = netdevs.get(uplink);
	if (!nd) return;
	await revokeTunnelRelayEgress({
		uplink,
		tunName: nd.name,
		encoderSubnet: nd.encoderSubnet,
		routeTable: nd.routeTable,
	});
	await removeTunnelVif(nd.name);
	netdevs.delete(uplink);
}

async function teardownAll(): Promise<void> {
	for (const uplink of [...netdevs.keys()]) await teardownNetdev(uplink);
}

/** Tear everything down (module stop / disable). */
export async function stopRelayTunnels(): Promise<void> {
	await teardownAll();
}

/**
 * The tunnel offer for one uplink (the announce payload attaches it).
 * `undefined` when the netdev isn't up (the encoder then has no tunnel for
 * that uplink).
 */
export function relayTunnelSpecFor(uplink: string): CtrlinkTunnelSpec | undefined {
	const nd = netdevs.get(uplink);
	if (!nd || !configured) return undefined;
	const addr = tunnelAddress(nd.index);
	return {
		virtualInterface: nd.name,
		endpoint: currentTransportOuterIp(),
		udpPort: nd.listenPort,
		localAddr: nd.localIp,
		peerAddr: addr.encoderIp,
		prefix: 30,
		mtu: DEFAULT_TUN_MTU,
		uplinkIndex: nd.index,
	};
}

// --- Test seams -------------------------------------------------------------

export function relayTunnelStateForTest(): {
	netdevs: Array<{
		uplink: string;
		name: string;
		localIp: string;
		index: number;
		listenPort: number;
	}>;
} {
	return {
		netdevs: [...netdevs.entries()].map(([u, s]) => ({
			uplink: u,
			name: s.name,
			localIp: s.localIp,
			index: s.index,
			listenPort: s.listenPort,
		})),
	};
}

/** Test reset: clear all module state. */
export function resetRelayTunnelTestState(): void {
	netdevs.clear();
	inFlight.clear();
	lastUplinks = [];
	configured = false;
	transportOuterIp = "";
}
