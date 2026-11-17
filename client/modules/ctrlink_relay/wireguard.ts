/*
 * Relay-side WireGuard multi-uplink transport (spec TODO/wireguard.md §5,§6,
 * §8,§10,§12). One `wg-<uplink>` netdev per eligible uplink (the relay owns
 * the physical uplinks); one PEER per discovered encoder on each netdev.
 *
 * Model: WG natively supports many peers per netdev, and the per-uplink
 * egress policy route + NAT depend only on the netdev, not on which encoder
 * is using it. So we:
 *   - create/keep one `wg-<if>` per uplink (netdev + local /30 + listen port
 *     + relay-egress policy route + MASQUERADE);
 *   - add a peer per encoder when its WireGuard public key is known (from the
 *     encoder's `encoder_wg_key`), dialing `<encoder link ip>:<listen port>`;
 *   - remove peers / netdevs as encoders or uplinks disappear.
 *
 * The peer's allowed-ips is ONLY the encoder's /30 (never 0.0.0.0/0), so the
 * relay installs no default route via the netdev: outer WG UDP always leaves
 * over the dedicated relay↔encoder link, never via the tunnel (spec §10).
 * All kernel work goes through the lib's `execCmd` seam (tests inject a
 * recorder); `sudo` is prepended at the one `setCmdRunner` seam.
 */
import {
	ensureWireGuardModule,
	setupWireGuardInterface,
	addWireGuardPeer,
	removeWireGuardPeer,
	removeWireGuard,
	ensureWireGuardRelayEgress,
	revokeWireGuardRelayEgress,
	wireGuardTunnelAddress,
	wgListenPort,
	wgRouteTable,
	generateWireGuardKeyPair,
	DEFAULT_WG_MTU,
	DEFAULT_WG_KEEPALIVE_SEC,
} from "@ctrlirl/wireguard";
import type {
	CtrlinkRelayWgSpec,
} from "../../../shared/ctrlink_discovery";

/** One relay `wg-<uplink>` netdev and its egress state. */
interface NetdevState {
	name: string;
	/** 0-based stable uplink index (addressing + routing table + listen port). */
	index: number;
	/** The relay's tunnel IP, e.g. `10.200.1.1`. */
	localIp: string;
	/** The relay's WireGuard PUBLIC key for this netdev. */
	publicKey: string;
	/** The relay's WG UDP listen port for this netdev. */
	listenPort: number;
	/** The encoder's /30 on this tunnel, e.g. `10.200.1.2/30`. */
	encoderSubnet: string;
	routeTable: number;
	rulePriority: number;
}

/** A discovered encoder's WireGuard identity (from `encoder_wg_key`). */
interface EncoderWg {
	ip: string;
	/** Per-uplink public key + listen port (uplink name keyed). */
	keys: Map<string, { publicKey: string; listenPort: number }>;
}

const netdevs = new Map<string, NetdevState>();
const encoderWgs = new Map<string, EncoderWg>();
/** uplink → set of encoder ids we have a peer for on that netdev. */
const peers = new Map<string, Set<string>>();
const inFlight = new Set<string>();

let configured = false;
/** The relay's outer IP on the dedicated relay↔encoder link (WG endpoint the
 * encoder dials). A live getter (the ded-link address is only known after
 * discovery + can change), falling back to a static value. Set by
 * `configureRelayWireGuard`. */
let transportOuterIp: string | (() => string) = "";

/** Resolve the current transport outer IP (dynamic getter or static). */
function currentTransportOuterIp(): string {
	return typeof transportOuterIp === "function"
		? (transportOuterIp() ?? "")
		: transportOuterIp;
}

export interface RelayWgConfig {
	enabled: boolean;
	/** The relay's own IP on the dedicated link to the encoder (e.g.
	 * `192.168.10.100`) — the `endpoint` the encoder dials per uplink. A
	 * getter is preferred: the ded-link address is only known once the
	 * encoder is discovered and can change at runtime. */
	transportOuterIp: string | (() => string);
}

/** Arm the module (bind time). Idempotent. */
export function configureRelayWireGuard(cfg: RelayWgConfig): void {
	configured = cfg.enabled;
	transportOuterIp = cfg.transportOuterIp;
}

/** Is the relay running the WG transport? (Gates the announce `wg` offer). */
export function relayWireGuardEnabled(): boolean {
	return configured;
}

/**
 * Feed an encoder's WireGuard identity (from the `encoder_wg_key` WS message)
 * so we can dial it as a peer on each uplink. `keys` is uplink-name → public
 * key + listen port. Triggers a reconcile (coalesced).
 */
export function setRelayWgEncoderKeys(
	encoderId: string,
	ip: string,
	keys: { uplink: string; public_key: string; listen_port: number }[],
): void {
	if (!keys.length) {
		encoderWgs.delete(encoderId);
	} else {
		const keyMap = new Map<string, { publicKey: string; listenPort: number }>();
		for (const k of keys) keyMap.set(k.uplink, { publicKey: k.public_key, listenPort: k.listen_port });
		encoderWgs.set(encoderId, { ip, keys: keyMap });
	}
	void reconcileRelayWireGuardNow(listCurrentUplinks());
}

/** Drop an encoder's learnt key (e.g. its channel closed / TTL expired). */
export function dropRelayWgEncoder(encoderId: string): void {
	if (encoderWgs.delete(encoderId))
		void reconcileRelayWireGuardNow(listCurrentUplinks());
}

/**
 * The eligible uplink names the relay currently runs on — the set we build a
 * `wg-<if>` netdev for. Supplied by the backend on each reconcile (it owns
 * interface discovery); we persist the last set for encoder-key-driven
 * reconciles in between.
 */
let lastUplinks: string[] = [];
function listCurrentUplinks(): string[] {
	return lastUplinks;
}

/**
 * Reconcile the relay's WG netdevs + peers toward the desired state.
 * `uplinks` is the current eligible-uplink set (stable-sorted by the backend).
 * Coalesces concurrent calls per reconcile batch.
 */
export async function reconcileRelayWireGuardNow(
	uplinks: string[] = lastUplinks,
): Promise<void> {
	if (!configured) {
		// Disabled: tear down anything we built.
		void teardownAll();
		return;
	}
	lastUplinks = uplinks;
	const key = uplinks.join("\0");
	if (inFlight.has(key)) return;
	inFlight.add(key);
	try {
		await ensureWireGuardModule();
		await reconcilePass(uplinks);
	} catch (e) {
		console.warn(`ctrlink_relay wireguard: reconcile failed: ${String(e)}`);
	} finally {
		inFlight.delete(key);
	}
}

async function reconcilePass(uplinks: string[]): Promise<void> {
	const desired = new Set(uplinks);

	// 1. Remove netdevs whose uplink is gone.
	for (const name of [...netdevs.keys()])
		if (!desired.has(name)) await teardownNetdev(name);

	// 2. Ensure one netdev + egress per uplink (stable index = sorted pos).
	const sorted = [...uplinks].sort();
	for (let i = 0; i < sorted.length; i++) {
		const uplink = sorted[i];
		const existing = netdevs.get(uplink);
		if (existing && existing.index !== i) await teardownNetdev(uplink);
		if (netdevs.get(uplink)) continue;
		await ensureNetdev(uplink, i);
	}

	// 3. Per uplink: add peers for new encoders, drop vanished ones.
	for (const uplink of sorted) {
		const nd = netdevs.get(uplink);
		if (!nd) continue;
		const have = peers.get(uplink) ?? new Set<string>();
		const want = new Set<string>();
		for (const [encId, enc] of encoderWgs) {
			const k = enc.keys.get(uplink);
			if (!k) continue;
			want.add(encId);
			if (have.has(encId)) continue;
			try {
				await addWireGuardPeer({
					name: nd.name,
					peerKey: k.publicKey,
					// Endpoint = encoder's address on the dedicated link + its
					// per-uplink listen port. Allowed-ips = encoder /30 only.
					endpoint: `${enc.ip}:${k.listenPort}`,
					allowedIps: nd.encoderSubnet,
					keepAliveSec: DEFAULT_WG_KEEPALIVE_SEC,
				});
				have.add(encId);
			} catch (e) {
				console.warn(
					`ctrlink_relay wireguard: peer ${uplink}↔${encId} failed: ${String(e)}`,
				);
			}
		}
		for (const encId of [...have])
			if (!want.has(encId)) {
				await removeWireGuardPeer(nd.name, encId);
				have.delete(encId);
			}
		peers.set(uplink, have);
	}
}

async function ensureNetdev(uplink: string, index: number): Promise<void> {
	const addr = wireGuardTunnelAddress(index);
	const name = `wg-${uplink}`;
	const { publicKey } = await generateWireGuardKeyPair();
	await setupWireGuardInterface({
		name,
		localIp: addr.relayIp,
		prefix: 30,
		mtu: DEFAULT_WG_MTU,
		listenPort: wgListenPort(index),
	});
	// Per-uplink egress: policy route tunnel-sourced traffic out the physical
	// uplink + MASQUERADE (idempotent).
	await ensureWireGuardRelayEgress({
		uplink,
		wgName: name,
		encoderSubnet: `${addr.encoderIp}/30`,
		routeTable: wgRouteTable(index),
		rulePriority: 1000 + index,
	});
	netdevs.set(uplink, {
		name,
		index,
		localIp: addr.relayIp,
		publicKey,
		listenPort: wgListenPort(index),
		encoderSubnet: `${addr.encoderIp}/30`,
		routeTable: wgRouteTable(index),
		rulePriority: 1000 + index,
	});
}

async function teardownNetdev(uplink: string): Promise<void> {
	const nd = netdevs.get(uplink);
	if (!nd) return;
	const have = peers.get(uplink);
	if (have) for (const encId of [...have]) await removeWireGuardPeer(nd.name, encId);
	peers.delete(uplink);
	await revokeWireGuardRelayEgress({
		uplink,
		wgName: nd.name,
		encoderSubnet: nd.encoderSubnet,
		routeTable: nd.routeTable,
	});
	await removeWireGuard(nd.name);
	netdevs.delete(uplink);
}

async function teardownAll(): Promise<void> {
	for (const uplink of [...netdevs.keys()]) await teardownNetdev(uplink);
}

/** Tear everything down (module stop / disable). */
export async function stopRelayWireGuard(): Promise<void> {
	await teardownAll();
}

/**
 * The `wg` offer for one uplink (the announce payload attaches it). `undefined`
 * when the netdev isn't up (the encoder then has no tunnel for that uplink).
 */
export function relayWgSpecFor(uplink: string): CtrlinkRelayWgSpec | undefined {
	const nd = netdevs.get(uplink);
	if (!nd || !configured) return undefined;
	const addr = wireGuardTunnelAddress(nd.index);
	return {
		virtualInterface: nd.name,
		publicKey: nd.publicKey,
		endpoint: currentTransportOuterIp(),
		udpPort: nd.listenPort,
		localAddr: nd.localIp,
		peerAddr: addr.encoderIp,
		prefix: 30,
		mtu: DEFAULT_WG_MTU,
		keepaliveSec: DEFAULT_WG_KEEPALIVE_SEC,
		uplinkIndex: nd.index,
	};
}

// --- Test seams -------------------------------------------------------------

export function relayWireGuardStateForTest(): {
	netdevs: Array<{ uplink: string; name: string; localIp: string; index: number; listenPort: number }>;
	peers: Record<string, string[]>;
} {
	return {
		netdevs: [...netdevs.entries()].map(([u, s]) => ({
			uplink: u,
			name: s.name,
			localIp: s.localIp,
			index: s.index,
			listenPort: s.listenPort,
		})),
		peers: Object.fromEntries(
			[...peers.entries()].map(([u, s]) => [u, [...s]]),
		),
	};
}

/** Test reset: clear all module state. */
export function resetRelayWireGuardTestState(): void {
	netdevs.clear();
	peers.clear();
	encoderWgs.clear();
	inFlight.clear();
	lastUplinks = [];
	configured = false;
	transportOuterIp = "";
}
