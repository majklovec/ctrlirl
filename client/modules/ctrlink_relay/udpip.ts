/*
 * Relay-side plain-UDP↔TUN multi-uplink transport — slot / offer bookkeeping.
 *
 * The actual forwarding leg per uplink (a `createUdpRelay` TUN + UDP socket +
 * kernel routing/NAT) is owned by the backend's per-interface relay lifecycle
 * (`startRelay` / `stopRelay`). This module owns the STABLE per-uplink slot
 * (`10.200.<slot+1>.x` addressing, the leg TUN name `rtltun_<if>`) and builds
 * the `CtrlinkTunnelSpec` offer the relay attaches to its announce so the
 * encoder knows exactly which vif to build (endpoint / port / peer IP / MTU).
 *
 * There is exactly ONE leg per uplink (subsuming the old raw-tap bridge leg
 * and the old separate TUN leg). Slots are assigned monotonically and never
 * reindex on removal — the same philosophy as the persistable listen-port
 * allocator.
 */
import { relayTunName } from "@ctrlirl/udp-relay";
import type { CtrlinkTunnelSpec } from "../../../shared/ctrlink_discovery";

export interface RelayTunnelConfig {
	enabled: boolean;
	/** The relay's own IP on the dedicated link to the encoder (e.g.
	 * `192.168.10.100`) — the `endpoint` the encoder dials per uplink. A
	 * getter is preferred: the ded-link address is only known once the
	 * encoder is discovered and can change at runtime. */
	transportOuterIp: string | (() => string);
}

/** One eligible uplink the relay can expose as a tunnel. */
export interface RelayUplink {
	/** The physical uplink name (e.g. `eth0`) — egress leaves over it. */
	uplink: string;
}

const slotMap = new Map<string, number>();
const upUplinks = new Set<string>();
let configured = false;
let transportOuterIp: string | (() => string) = "";

function currentTransportOuterIp(): string {
	return typeof transportOuterIp === "function"
		? (transportOuterIp() ?? "")
		: transportOuterIp;
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

/** Stable 0-based slot for an uplink (monotonic, never reindexes on removal). */
function slotFor(uplink: string): number {
	const existing = slotMap.get(uplink);
	if (existing !== undefined) return existing;
	const max = [...slotMap.values()].reduce((m, v) => Math.max(m, v), -1);
	const slot = max + 1;
	slotMap.set(uplink, slot);
	return slot;
}

/** Linux if_namemax cap for the derived TUN name (mirrors udp-relay's
 * `InterfaceRe`: `[a-zA-Z0-9_.-]`). */
const UPLINK_IFACE_RE = /^[a-zA-Z0-9_.-]+$/;
/** Kernel ifname limit - the `rtltun_<if>` name must fit in it, so a long
 * MAC-style ifname (`enx76ae207e3de7`) that would overflow is rejected here
 * rather than failing deep in `ip tuntap`. */
const TUN_NAME_MAX = 15;

/** The leg TUN name for an uplink.
 * Named after the uplink interface: `rtltun_eth0`, `rtltun_wwan2`, ... */
export function legTunFor(uplink: string): string {
	if (!UPLINK_IFACE_RE.test(uplink))
		throw new Error(`unsafe interfaceName: ${uplink}`);
	const tun = relayTunName(uplink);
	if (tun.length > TUN_NAME_MAX)
		throw new Error(
			`interfaceName ${uplink} would make a TUN name over ${TUN_NAME_MAX} chars: ${tun}`,
		);
	return tun;
}

/** The stable slot ordinal for `uplink` (used to build the leg's `LegPlan`). */
export function uplinkSlot(uplink: string): number {
	return slotFor(uplink);
}

/** The relay's own /32 on this uplink's leg, e.g. `10.200.1.1`. */
export function relayVifIp(uplink: string): string {
	return `10.200.${slotFor(uplink) + 1}.1`;
}

/** The encoder's /32 on this uplink's leg, e.g. `10.200.1.2`. */
export function encoderVifIp(uplink: string): string {
	return `10.200.${slotFor(uplink) + 1}.2`;
}

/** Register a started leg (marks the uplink "up" so its offer is attached). */
export function noteUplinkLeg(uplink: string): void {
	slotFor(uplink);
	upUplinks.add(uplink);
}

/** Clear a stopped leg (slot persists for stable re-assignment on restart). */
export function clearUplinkLeg(uplink: string): void {
	upUplinks.delete(uplink);
}

/**
 * Reconcile the stable slot set toward the desired uplinks. The legs
 * themselves are owned by the backend's per-interface lifecycle; this only
 * pre-allocates slots (cheap and idempotent) so a later `startRelay` reuses
 * them.
 */
export async function reconcileRelayTunnelsNow(
	uplinks: RelayUplink[] = [],
): Promise<void> {
	for (const { uplink } of uplinks) slotFor(uplink);
}

/** Tear everything down (module stop / disable). */
export async function stopRelayTunnels(): Promise<void> {
	upUplinks.clear();
}

/**
 * The tunnel offer for one uplink (the announce payload attaches it).
 * `undefined` when the leg isn't up (the encoder then has no tunnel for that
 * uplink).
 */
export function relayTunnelSpecFor(
	uplink: string,
	port: number,
): CtrlinkTunnelSpec | undefined {
	if (!configured || !upUplinks.has(uplink)) return undefined;
	const slot = slotFor(uplink);
	return {
		virtualInterface: `rtltun-${uplink}`,
		endpoint: currentTransportOuterIp(),
		udpPort: port,
		localAddr: relayVifIp(uplink),
		peerAddr: encoderVifIp(uplink),
		prefix: 32,
		mtu: 1400,
		uplinkIndex: slot,
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
		netdevs: [...upUplinks].map((u) => {
			const slot = slotFor(u);
			return {
				uplink: u,
				name: relayTunName(u),
				localIp: relayVifIp(u),
				index: slot,
				listenPort: 51820 + slot,
			};
		}),
	};
}

/** Test reset: clear all module state. */
export function resetRelayTunnelTestState(): void {
	slotMap.clear();
	upUplinks.clear();
	configured = false;
	transportOuterIp = "";
}
