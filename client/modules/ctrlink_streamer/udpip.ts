/*
 * Encoder-side plain-UDP↔TUN multi-uplink vifs. For each relay-announced
 * uplink carrying a `tunnel` spec, the encoder builds ONE `utn-<if>` TUN
 * netdev + a `udpip` client pump that forwards IP datagrams to the relay:
 *   - local /30 (`10.200.<n>.2`),
 *   - a per-vif routing table (rule `from <localIp> table <t>` + default via
 *     the vif) so `ping -I utn-<if>` egresses through that uplink,
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
 * Reconcile the encoder's `utn-<if>` vifs toward the offered set. `ownIfaces`
 * is the encoder's own interface-name set (the on-link filter).
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
		// interface the encoder already owns (on-link filter).
		const desired = new Map<
			string,
			{ spec: CtrlinkTunnelSpec; relayId: string }
		>();
		for (const { spec, relayId } of offers) {
			const uplink = spec.virtualInterface.replace(/^utn-/, "");
			if (ownIfaces.has(uplink)) continue; // on-link: don't tunnel it
			if (!desired.has(uplink)) desired.set(uplink, { spec, relayId });
		}

		// Remove vifs no longer offered.
		for (const uplink of [...vifs.keys()])
			if (!desired.has(uplink)) await teardownVif(uplink);

		// Build the rest (idempotent: existing vifs are kept as-is).
		for (const [uplink, d] of desired)
			if (!vifs.has(uplink)) await ensureVif(uplink, d.spec, d.relayId);
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
): Promise<void> {
	const name = spec.virtualInterface;
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
