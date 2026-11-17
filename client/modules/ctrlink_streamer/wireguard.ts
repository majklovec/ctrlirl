/*
 * Encoder-side WireGuard multi-uplink vifs (spec TODO/wireguard.md §5,§8,§10,
 * §12). For each relay-announced uplink carrying a `wg` offer, the encoder
 * builds ONE `wg-<if>` bare netdev (NOT wg-quick — so the kernel installs NO
 * routes; we own every route):
 *   - local /30 (`10.200.<n>.2`),
 *   - the relay as peer (allowed-ips `0.0.0.0/0` — accepts all Internet, no
 *     auto-route because it's a bare netdev),
 *   - a per-vif routing table (rule `from <localIp> table <t>` + default via
 *     the vif) so `ping -I wg-<if>` egresses through that uplink,
 *   - an explicit transport-isolation route so the outer WG UDP leaves over
 *     the dedicated relay↔encoder link, never via the tunnel (spec §10).
 *
 * On-link filter (earlier explicit requirement): an uplink whose name already
 * exists as one of the encoder's OWN interfaces is ignored — the encoder
 * reaches that subnet directly and doesn't tunnel it.
 *
 * After building vifs the module returns the per-uplink public keys + listen
 * ports; the backend pushes them to the relay via `encoder_wg_key` so the
 * relay can dial this encoder as a peer on each of its netdevs.
 *
 * All kernel work goes through the lib's `execCmd` seam (tests inject a
 * recorder); `sudo` is prepended at the one `setCmdRunner` seam.
 */
import {
	ensureWireGuardModule,
	setupWireGuardInterface,
	removeWireGuard,
	ensureWireGuardEncoderRouting,
	revokeWireGuardEncoderRouting,
	wgListenPort,
	wgRouteTable,
	generateWireGuardKeyPair,
	DEFAULT_WG_MTU,
	DEFAULT_WG_KEEPALIVE_SEC,
} from "../../../shared/lib/gretap_relay";
import type { CtrlinkRelayWgSpec } from "../../../shared/ctrlink_discovery";

export interface EncoderWgOffer {
	relayId: string;
	spec: CtrlinkRelayWgSpec;
}

interface EncoderVif {
	name: string;
	uplink: string;
	index: number;
	localIp: string;
	publicKey: string;
	listenPort: number;
	routeTable: number;
	rulePriority: number;
}

const vifs = new Map<string, EncoderVif>();
let configured = false;
/** The encoder's iface that reaches the relay on the dedicated link (e.g.
 * `eth0`) — the destination of the transport-isolation route. */
let transportDev = "eth0";
let inFlight = false;

/** Arm the module (bind / start). Idempotent. */
export function configureEncoderWireGuard(cfg: {
	enabled: boolean;
	transportDev?: string;
}): void {
	configured = cfg.enabled;
	if (cfg.transportDev) transportDev = cfg.transportDev;
}

/**
 * Reconcile the encoder's `wg-<if>` vifs toward the offered set. `ownIfaces`
 * is the encoder's own interface-name set (the on-link filter). Returns the
 * per-uplink key payload for the `encoder_wg_key` message (the caller pushes
 * it to connected relays).
 */
export async function reconcileEncoderWireGuard(
	offers: EncoderWgOffer[],
	ownIfaces: Set<string>,
): Promise<{ uplink: string; public_key: string; listen_port: number }[]> {
	if (!configured) {
		await teardownAll();
		return [];
	}
	if (inFlight) return keyPayload();
	inFlight = true;
	try {
		await ensureWireGuardModule();

		// Desired: one offer per uplink, skipping any that collide with an
		// interface the encoder already owns (on-link filter).
		const desired = new Map<string, CtrlinkRelayWgSpec>();
		for (const { spec } of offers) {
			const uplink = spec.virtualInterface.replace(/^wg-/, "");
			if (ownIfaces.has(uplink)) continue; // on-link: don't tunnel it
			if (!desired.has(uplink)) desired.set(uplink, spec);
		}

		// Remove vifs no longer offered.
		for (const uplink of [...vifs.keys()])
			if (!desired.has(uplink)) await teardownVif(uplink);

		// Build the rest (idempotent: existing vifs are kept as-is).
		for (const [uplink, spec] of desired)
			if (!vifs.has(uplink)) await ensureVif(uplink, spec);

		return keyPayload();
	} catch (e) {
		console.warn(
			`ctrlink_streamer wireguard: reconcile failed: ${String(e)}`,
		);
		return keyPayload();
	} finally {
		inFlight = false;
	}
}

async function ensureVif(uplink: string, spec: CtrlinkRelayWgSpec): Promise<void> {
	const name = spec.virtualInterface;
	const { publicKey } = await generateWireGuardKeyPair();
	const listenPort = wgListenPort(spec.uplinkIndex);
	const routeTable = wgRouteTable(spec.uplinkIndex);
	// Encoder vif: local /30 `.2`, relay as peer (allowed-ips 0.0.0.0/0 — a
	// bare netdev never auto-routes, so this hijacks no default route).
	await setupWireGuardInterface({
		name,
		localIp: spec.peerAddr,
		prefix: spec.prefix,
		peerKey: spec.publicKey,
		endpoint: `${spec.endpoint}:${spec.udpPort}`,
		allowedIps: "0.0.0.0/0",
		mtu: spec.mtu ?? DEFAULT_WG_MTU,
		keepAliveSec: spec.keepaliveSec ?? DEFAULT_WG_KEEPALIVE_SEC,
		listenPort,
	});
	await ensureWireGuardEncoderRouting({
		wgName: name,
		localIp: spec.peerAddr,
		routeTable,
		rulePriority: 1000 + spec.uplinkIndex,
		endpointIp: spec.endpoint,
		endpointDev: transportDev,
	});
	vifs.set(uplink, {
		name,
		uplink,
		index: spec.uplinkIndex,
		localIp: spec.peerAddr,
		publicKey,
		listenPort,
		routeTable,
		rulePriority: 1000 + spec.uplinkIndex,
	});
	console.log(
		`ctrlink_streamer wireguard: ${name} up (${spec.peerAddr}) → relay ${spec.endpoint}:${spec.udpPort}`,
	);
}

async function teardownVif(uplink: string): Promise<void> {
	const v = vifs.get(uplink);
	if (!v) return;
	await revokeWireGuardEncoderRouting({
		localIp: v.localIp,
		routeTable: v.routeTable,
		wgName: v.name,
		endpointIp: "",
		endpointDev: transportDev,
	});
	await removeWireGuard(v.name);
	vifs.delete(uplink);
}

async function teardownAll(): Promise<void> {
	for (const uplink of [...vifs.keys()]) await teardownVif(uplink);
}

/** The `encoder_wg_key` payload: per-uplink public key + listen port. */
function keyPayload(): {
	uplink: string;
	public_key: string;
	listen_port: number;
}[] {
	return [...vifs.values()].map((v) => ({
		uplink: v.uplink,
		public_key: v.publicKey,
		listen_port: v.listenPort,
	}));
}

/** Tear everything down (module stop / disable). */
export async function stopEncoderWireGuard(): Promise<void> {
	await teardownAll();
}

// --- Test seams -------------------------------------------------------------

export function encoderWireGuardStateForTest(): {
	vifs: Array<{ uplink: string; name: string; localIp: string; listenPort: number }>;
} {
	return {
		vifs: [...vifs.values()].map((v) => ({
			uplink: v.uplink,
			name: v.name,
			localIp: v.localIp,
			listenPort: v.listenPort,
		})),
	};
}

/** Test reset: clear all module state. */
export function resetEncoderWireGuardTestState(): void {
	vifs.clear();
	configured = false;
	transportDev = "eth0";
	inFlight = false;
}
