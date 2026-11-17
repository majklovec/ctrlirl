/*
 * Encoder-side plain-UDP↔TUN multi-uplink vifs. For each relay-announced
 * uplink carrying a `tunnel` spec, the encoder builds ONE `utn<R>-<if>` TUN
 * netdev (`R` = the relay's stable 0-based index on this encoder, so two
 * relays exposing the same uplink name can't clash) + a `udpip` client pump
 * that forwards IP datagrams to the relay:
 *   - local /30 (`10.200.<n>.2`),
 *   - a per-vif routing table (rule `from <localIp> table <t>` + default via
 *     the vif) so `ping -I utn<R>-<if>` egresses through that uplink,
 *   - an explicit transport-isolation route so the outer tunnel UDP leaves
 *     over the dedicated relay↔encoder link, never via the tunnel.
 *
 * On-link filter: an uplink whose name already exists as one of the encoder's
 * OWN interfaces is ignored — the encoder reaches that subnet directly and
 * doesn't tunnel it.
 *
 * No crypto, no key exchange — the relay pins this encoder as a single peer
 * on its side. All kernel work goes through the lib's `execCmd` seam (tests
 * inject a recorder); `sudo` is prepended at the one `setCmdRunner` seam.
 */
import {
	setupTunnelVif,
	removeTunnelVif,
	ensureTunnelEncoderRouting,
	revokeTunnelEncoderRouting,
	tunnelListenPort,
	tunnelRouteTable,
	DEFAULT_TUN_MTU,
} from "@ctrlirl/udpip";
import type { CtrlinkTunnelSpec } from "../../../shared/ctrlink_discovery";

export interface EncoderTunnelOffer {
	relayId: string;
	/** The relay's stable 0-based index on this encoder — names the vif
	 * `utn<index>-<if>` so two relays exposing the same uplink name can't clash. */
	relayIndex: number;
	spec: CtrlinkTunnelSpec;
}

interface EncoderVif {
	relayId: string;
	name: string;
	uplink: string;
	index: number;
	localIp: string;
	listenPort: number;
	routeTable: number;
	rulePriority: number;
}

/** The `utn<relayIndex>-<uplink>` netdev name for one (relay, uplink) pair. */
export function encoderVifName(relayIndex: number, uplink: string): string {
	return `utn${relayIndex}-${uplink}`;
}

const vifs = new Map<string, EncoderVif>();
let configured = false;
/** The encoder's iface that reaches the relay on the dedicated link (e.g.
 * `eth0`) — the destination of the transport-isolation route. */
let transportDev = "eth0";
let inFlight = false;

/** Arm the module (bind / start). Idempotent. */
export function configureEncoderTunnels(cfg: {
	enabled: boolean;
	transportDev?: string;
}): void {
	configured = cfg.enabled;
	if (cfg.transportDev) transportDev = cfg.transportDev;
}

/**
 * Reconcile the encoder's `utn<R>-<if>` vifs toward the offered set.
 * `ownIfaces` is the encoder's own interface-name set (the on-link filter).
 */
export async function reconcileEncoderTunnels(
	offers: EncoderTunnelOffer[],
	ownIfaces: Set<string>,
): Promise<void> {
	if (!configured) {
		await teardownAll();
		return;
	}
	if (inFlight) return;
	inFlight = true;
	try {
		// Desired: one offer per uplink, skipping any that collide with an
		// interface the encoder already owns (on-link filter). The uplink is
		// derived from the relay's `utn-<if>` spec name; the ENCODER's own
		// netdev is renamed `utn<relayIndex>-<if>` (below) so two relays that
		// both expose `eth0` never produce a clashing name.
		const desired = new Map<
			string,
			{
				spec: CtrlinkTunnelSpec;
				relayId: string;
				relayIndex: number;
			}
		>();
		for (const { spec, relayId, relayIndex } of offers) {
			const uplink = spec.virtualInterface.replace(/^utn-/, "");
			if (ownIfaces.has(uplink)) continue; // on-link: don't tunnel it
			if (!desired.has(uplink))
				desired.set(uplink, { spec, relayId, relayIndex });
		}

		// Remove vifs no longer offered.
		for (const uplink of [...vifs.keys()])
			if (!desired.has(uplink)) await teardownVif(uplink);

		// Build the rest (idempotent: existing vifs are kept as-is).
		for (const [uplink, d] of desired)
			if (!vifs.has(uplink))
				await ensureVif(uplink, d.spec, d.relayId, d.relayIndex);
	} catch (e) {
		console.warn(`ctrlink_streamer udpip: reconcile failed: ${String(e)}`);
	} finally {
		inFlight = false;
	}
}

async function ensureVif(
	uplink: string,
	spec: CtrlinkTunnelSpec,
	relayId: string,
	relayIndex: number,
): Promise<void> {
	// The relay's spec name is `utn-<if>`; the encoder's netdev is renamed to
	// `utn<relayIndex>-<if>` so a second relay exposing the same uplink name
	// (e.g. `eth0`) can't collide with the first.
	const name = encoderVifName(relayIndex, uplink);
	const routeTable = tunnelRouteTable(spec.uplinkIndex);
	const listenPort = tunnelListenPort(spec.uplinkIndex);
	// Encoder vif: local /30 `.2`, the relay as the tunnel remote.
	await setupTunnelVif({
		name,
		localIp: spec.peerAddr,
		prefix: spec.prefix,
		mtu: spec.mtu ?? DEFAULT_TUN_MTU,
		mode: "client",
		remote: `${spec.endpoint}:${spec.udpPort}`,
	});
	await ensureTunnelEncoderRouting({
		tunName: name,
		localIp: spec.peerAddr,
		routeTable,
		rulePriority: 1000 + spec.uplinkIndex,
		endpointIp: spec.endpoint,
		endpointDev: transportDev,
	});
	vifs.set(uplink, {
		relayId,
		name,
		uplink,
		index: spec.uplinkIndex,
		localIp: spec.peerAddr,
		listenPort,
		routeTable,
		rulePriority: 1000 + spec.uplinkIndex,
	});
	console.log(
		`ctrlink_streamer udpip: ${name} up (${spec.peerAddr}) → relay ${spec.endpoint}:${spec.udpPort}`,
	);
}

async function teardownVif(uplink: string): Promise<void> {
	const v = vifs.get(uplink);
	if (!v) return;
	await revokeTunnelEncoderRouting({
		localIp: v.localIp,
		routeTable: v.routeTable,
		tunName: v.name,
		endpointIp: "",
		endpointDev: transportDev,
	});
	await removeTunnelVif(v.name);
	vifs.delete(uplink);
}

async function teardownAll(): Promise<void> {
	for (const uplink of [...vifs.keys()]) await teardownVif(uplink);
}

/** Tear everything down (module stop / disable). */
export async function stopEncoderTunnels(): Promise<void> {
	await teardownAll();
}

// --- Test seams -------------------------------------------------------------

export function encoderTunnelStateForTest(): {
	vifs: Array<{
		relayId: string;
		uplink: string;
		name: string;
		localIp: string;
		listenPort: number;
	}>;
} {
	return {
		vifs: [...vifs.values()].map((v) => ({
			relayId: v.relayId,
			uplink: v.uplink,
			name: v.name,
			localIp: v.localIp,
			listenPort: v.listenPort,
		})),
	};
}

/** Test reset: clear all module state. */
export function resetEncoderTunnelTestState(): void {
	vifs.clear();
	configured = false;
	transportDev = "eth0";
	inFlight = false;
}
