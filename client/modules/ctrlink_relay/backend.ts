/*
 * Ctrlink relay module: the per-interface relay slots that track this
 * machine's LAN interfaces for the Ctrlink transport. Since the GRETAP
 * cutover the data plane is a kernel GRETAP tunnel — the streamer side sets
 * up `gretap_<iface>` + `br_gretap` and bridges it into its LAN NIC, so
 * frames flow L2-over-GRE (protocol 47) between the two kernel stacks. The
 * slots no longer forward user-space UDP traffic; they keep the port
 * mapping, discovery and WS roles the encoder needs.
 *
 * This module is the relay-box side of the Ctrlink transport. It enumerates
 * the machine's eligible network interfaces (via the `network.interfaces`
 * capability, filtered by the `interfaceAllow` / `interfaceIgnore` config),
 * and for each one starts a `createUdpRelay()` from `@ctrlirl/gretap-relay`
 * (a no-op slot holder since the GRETAP cutover) for that interface's IP.
 * It owns no TUN, no routing, and no config
 * file beyond `ctx.state.ctrlink`: the relay IDs live in
 * `ctx.state.ctrlink.relayIds` and the runtime status is written to
 * `runtimeStatusFile` on every state change.
 *
 * Protocol (TODO/protocol.md):
 *  - §1  one UDP relay per uplink interface; ports allocated from
 *      `listenPortBase` by a persisted HIGH-WATER-MARK allocator
 *      (`ctx.state.ctrlink.portMap`): adding an interface never reindexes
 *      existing ports, a removed interface frees its slot, and a downed
 *      interface keeps its mapping (marked `state: "down"`).
 *  - §2  the relay discovers ENCODERS: it listens for the encoder's UDP
 *      announces (id, IP, WebSocket port, optional token) on the discovery
 *      port, and may also ask the control server for registered encoders.
 *  - §3–§5  for every discovered encoder the relay connects to the
 *      encoder's WebSocket server as a CLIENT, sends its identity, the
 *      protocol version and the full uplink interface list (interface IP +
 *      UDP port), and propagates `interface_added` / `interface_removed` /
 *      `interface_up` / `interface_down` events; after every reconnect it
 *      re-sends a full snapshot. The encoder sends UDP data to
 *      `interface_ip:udp_port`.
 */
import { readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { requireCapability } from "../../../shared/capabilities";
import type {
	BackendModule,
	Params,
} from "../../../shared/contracts/backend_module";
import type {
	NetworkInterfaces,
	Uplinks,
} from "../../../shared/contracts/module_capabilities";
import { runCommand, setCmdRunner } from "@ctrlirl/wireguard";

import {
	createUdpRelay,
	type IfaceRawSocket,
	resolveInterfaceAddress,
	type UdpRelay,
} from "../../../shared/lib/gretap_relay";
import {
	gretapOuterIpFor,
	reconcileGretaps,
	setGretapIpRunner,
	setGretapLogger,
	setGretapRelayer,
	stopGretaps,
} from "./gretap";
import {
	configureRelayWireGuard,
	dropRelayWgEncoder,
	reconcileRelayWireGuardNow,
	relayWgSpecFor,
	setRelayWgEncoderKeys,
	stopRelayWireGuard,
} from "./wireguard";
import {
	CTRLINK_ANNOUNCE_INTERVAL_MS,
	CTRLINK_DISCOVERY_PORT,
	CTRLINK_RELAY_WS_PROTOCOL,
	isCtrlinkRelayWsMessage,
	type CtrlinkAnnounce,
	type CtrlinkDiscoveredEncoder,
	type CtrlinkRelayIface,
	type CtrlinkRelayIfaceEventType,
	type CtrlinkRelayWsMessage,
} from "../../../shared/ctrlink_discovery";
import {
	MDNS_ENCODER_SERVICE,
	MDNS_RELAY_SERVICE,
	type MdnsFound,
	startMdnsAdvertiser,
	startMdnsBrowser,
} from "../../../shared/ctrlink_mdns";
import {
	ApiError,
	optionalStringList,
	requireBoolean,
	requireHost,
} from "../../../shared/params";
import { errorMessage } from "../../../shared/util";
import type { ModuleCore } from "../../backend/module_core";
import {
	knownEncoders,
	lastUdpAnnounceAt,
	noteEncoder,
	startAnnouncing,
	startListeningForEncoders,
	stopAnnouncing,
	stopListeningForEncoders,
	sweepEncoders,
} from "./discovery";
import log from "./log";
import type {
	CtrlinkRelayConfig,
	CtrlinkRelayFailure,
	CtrlinkRelayState,
	CtrlinkRuntimeStatus,
} from "./types";

// ----------------------------------------------------------------------
// Config (the `ctx.state.ctrlink` slice)
// ----------------------------------------------------------------------
const DEFAULTS: Required<
	Omit<CtrlinkRelayConfig, "interfaceNameOverrides" | "portMap">
> & {
	interfaceNameOverrides: Record<string, string>;
	portMap: Record<string, number>;
} = {
	enabled: false,
	nat: true,
	// WireGuard is the default transport: it REPLACES the legacy L2 GRETAP
	// bridges. GRETAP stays available only as an explicit legacy opt-in
	// (gretap on, wireGuard off).
	gretap: false,
	wireGuard: true,
	announceHost: "",
	listenPortBase: 4000,
	interfaceAllow: [],
	interfaceIgnore: ["docker.*", "veth.*"],
	interfaceNameOverrides: {},
	runtimeStatusFile: join(tmpdir(), "ctrlink-status.json"),
	logLevel: "info",
	portMap: {},
};

let core: ModuleCore;

let netIfaces: NetworkInterfaces;
let netUnsub: (() => void) | undefined;
/** TTL sweeper for the encoder registry (drops encoders we stopped hearing). */
let encoderSweep: ReturnType<typeof setInterval> | undefined;
/** Timestamp of the last control-server encoder lookup. */
let lastControlServerCheck = 0;
/** mDNS advertiser (relay service) / browser (encoder service) stop handles. */
let mdnsBrowseStop: (() => void) | undefined;
let mdnsAdvertiseStop: (() => void) | undefined;
/** Epoch ms of the last mDNS re-advertise (this relay's own record). The
 * UDP one lives in `discovery.lastUdpAnnounceAt()`; the WS one is the last
 * control-channel snapshot (hello) sent. All three surface on the card. */
let lastMdnsAnnounceAt: number | undefined;
let lastWsAdvertiseAt: number | undefined;

/** The running per-interface relays, keyed by interface name. */
const relays = new Map<string, UdpRelay>();

/**
 * Live per-interface RELAYED throughput (the real bytes/sec this relay is
 * forwarding, not the negotiated PHY link speed). Sampled on an interval from
 * the `encRxBytes` / `encTxBytes` counters each `createUdpRelay()` accumulates.
 * `lastSample` holds the previous reading; `liveRates` the derived rate.
 */
const RATE_SAMPLE_MS = 1_000;
const lastSample = new Map<string, { rx: number; tx: number; at: number }>();
const liveRates = new Map<
	string,
	{ rxBytesPerSec: number; txBytesPerSec: number }
>();
let rateTimer: ReturnType<typeof setInterval> | undefined;

/** One throughput sample: rate vs the previous reading, per live relay. */
function sampleRates(): void {
	const now = Date.now();
	for (const [name, relay] of relays) {
		const st = relay.stats();
		const prev = lastSample.get(name);
		if (prev) {
			const dt = (now - prev.at) / 1000;
			if (dt > 0) {
				liveRates.set(name, {
					// Counters are monotonic; clamp against a mid-sample
					// restart (a fresh relay's counters start at 0).
					rxBytesPerSec: Math.max(0, (st.encRxBytes - prev.rx) / dt),
					txBytesPerSec: Math.max(0, (st.encTxBytes - prev.tx) / dt),
				});
			}
		}
		lastSample.set(name, {
			rx: st.encRxBytes,
			tx: st.encTxBytes,
			at: now,
		});
	}
	for (const name of [...lastSample.keys()])
		if (!relays.has(name)) {
			lastSample.delete(name);
			liveRates.delete(name);
		}
}

/** Start the sampler (idempotent); run it for the module's lifetime. */
function startRateSampler(): void {
	if (rateTimer) return;
	rateTimer = setInterval(sampleRates, RATE_SAMPLE_MS);
	rateTimer.unref?.();
}

/** Stop the sampler and drop all samples/rates. */
function stopRateSampler(): void {
	if (rateTimer) {
		clearInterval(rateTimer);
		rateTimer = undefined;
	}
	lastSample.clear();
	liveRates.clear();
}

/**
 * Interfaces marked DOWN (present in the mapping, no live relay): their port
 * mapping is kept (protocol.md §1) and the encoder is told `interface_down`.
 * `reason` distinguishes "downed" (no IP / no carrier) from "failed" (the
 * relay socket could not be bound, e.g. port in use).
 */
const downIfaces = new Map<string, { reason?: string }>();
/** The last interface address each relay was created for (hotplug detection). */
const lastIfaceAddr = new Map<string, string>();
/**
 * Relay interfaces that sit on a known encoder's own segment (the kernel
 * routes to the encoder on-link, no gateway): that encoder reaches the
 * relay through them directly, so the relay must not advertise them — the
 * encoder uses such a path as a plain direct uplink, not a gretap tunnel.
 * Kept fresh by `refreshDirectIfaces()`.
 */
const directIfaces = new Set<string>();
/** Interfaces that failed to start (name → reason), surfaced in status/card. */
const failures = new Map<string, string>();
/**
 * Vif reply-path routes this relay installed, keyed by interface name. We keep
 * the learned vif IP and the dedicated table number so `stopRelay` can tear the
 * rule + route back down (a stale table entry would keep the reply route alive
 * after the relay is gone, mirroring the stale main-table routes the old code
 * left behind).
 */
const vifRoutes = new Map<string, { vifIp: string; table: number }>();
/**
 * Base of the dedicated routing-table range for vif reply paths. Kept in a
 * range the streamer's per-source tables (base 100) never touch, and the rule
 * priority stays well below NetworkManager's per-interface rules (~32760) so
 * ours are consulted first.
 */
const VIF_TABLE_BASE = 200;

type ResolvedConfig = Required<
	Omit<CtrlinkRelayConfig, "interfaceNameOverrides" | "portMap">
> & {
	interfaceNameOverrides: Record<string, string>;
	portMap: Record<string, number>;
};

/** Read the merged config slice (defaults backfilled on first read). */
function config(): ResolvedConfig {
	const raw = (core.state.data.ctrlink ?? {}) as Partial<CtrlinkRelayConfig>;
	const portMap: Record<string, number> = {};
	for (const [name, port] of Object.entries(raw.portMap ?? {}))
		if (Number.isInteger(port) && port >= 1 && port <= 65_535)
			portMap[name] = port;
	return {
		enabled: raw.enabled ?? DEFAULTS.enabled,
		nat: raw.nat ?? DEFAULTS.nat,
		gretap: raw.gretap ?? DEFAULTS.gretap,
		wireGuard: raw.wireGuard ?? DEFAULTS.wireGuard,
		announceHost: raw.announceHost ?? DEFAULTS.announceHost,
		listenPortBase: raw.listenPortBase ?? DEFAULTS.listenPortBase,
		interfaceAllow: raw.interfaceAllow ?? DEFAULTS.interfaceAllow,
		interfaceIgnore: raw.interfaceIgnore ?? DEFAULTS.interfaceIgnore,
		interfaceNameOverrides:
			raw.interfaceNameOverrides ?? DEFAULTS.interfaceNameOverrides,
		runtimeStatusFile: raw.runtimeStatusFile ?? DEFAULTS.runtimeStatusFile,
		logLevel: raw.logLevel ?? DEFAULTS.logLevel,
		portMap,
	};
}

/** Persist the full config slice (for a stable state file). */
function saveConfig(
	patch: Partial<CtrlinkRelayConfig>,
): ReturnType<typeof config> {
	const next = { ...config(), ...patch };
	core.state.data.ctrlink = {
		...next,
		relayIds: (core.state.data.ctrlink as Record<string, unknown>)?.relayIds as
			| Record<string, string>
			| undefined,
	};
	core.saveState();
	return next;
}

/**
 * Which interfaces a relay should run on, given the config. Pure and
 * unit-testable: takes the interface list and a config, returns the
 * eligible names (already filtered and sorted).
 */
export function eligibleInterfaces(
	ifaces: Array<{ name: string; addresses: string[] }>,
	cfg: ReturnType<typeof config>,
): string[] {
	const allow = cfg.interfaceAllow.map((r) => new RegExp(r, "i"));
	const ignore = cfg.interfaceIgnore.map((r) => new RegExp(r, "i"));
	return ifaces
		.filter((i) => i.addresses.length > 0)
		// GRETAP's own devices (the `gretap*` tunnels + `br-*` bridges) are
		// infrastructure, never shareable endpoints — a bridge on the home-LAN
		// subnet would advertise a duplicate of the pass-through NIC it extends.
		// Same for the WireGuard `wg-*` netdevs: they are the transport itself,
		// and treating one as an uplink makes the reconcile build `wg-wg-*`
		// (a second tunnel for the tunnel), colliding listen ports and cascading
		// the per-index addressing.
		.filter(
			(i) =>
				!/^gretap/.test(i.name) &&
				!/^br-/.test(i.name) &&
				!/^wg-/.test(i.name),
		)
		.filter((i) =>
			allow.length > 0
				? allow.some((re) => re.test(i.name))
				: !ignore.some((re) => re.test(i.name)),
		)
		.map((i) => i.name)
		.sort();
}

/**
 * The interfaces this relay advertises: the eligible set minus the
 * directly-connected ones (`directIfaces`). An encoder on the same segment
 * as one of those uses it as a plain direct uplink — tunneling the segment
 * back through the relay would be a L2 loop, so those never reach an
 * encoder (announce, WS snapshot/events, status).
 */
export function advertisedInterfaces(
	ifaces: Array<{ name: string; addresses: string[] }>,
	cfg: ReturnType<typeof config>,
): string[] {
	return eligibleInterfaces(ifaces, cfg).filter((n) => !directIfaces.has(n));
}

/**
 * Refresh `directIfaces`: for each discovered encoder IP, `ip route get
 * <ip>` shows the egress `dev`; when there is no `via` gateway the
 * destination is on-link (same segment as that relay interface), i.e. that
 * interface is directly connected to the encoder. The lookup is read-only;
 * on any failure the previous mapping is kept (an unresolvable encoder IP
 * simply classifies no interface).
 */
export async function refreshDirectIfaces(): Promise<void> {
	try {
		const next = new Set<string>();
		let sawEncoder = false;
		for (const e of knownEncoders()) {
			if (!e.ip) continue;
			sawEncoder = true;
			const out = await core.run("ip", ["route", "get", e.ip], true);
			const m = out.match(/\bdev ([\w.-]+)\b/);
			if (m && !/\bvia\s/.test(out)) next.add(m[1]);
		}
		// No encoder currently known (all TTL-expired) — keep the previous
		// mapping. Collapsing to an empty set would let a directly-connected
		// interface leak back into the advertise during the expiry window,
		// and the encoder would rebuild a redundant tunnel over it.
		if (!sawEncoder) return;
		const prev = [...directIfaces].join(",");
		directIfaces.clear();
		for (const name of next) directIfaces.add(name);
		if (prev !== [...directIfaces].join(","))
			console.log(`[ctrlink_relay] directly-connected ifaces: [${[...directIfaces].join(", ")}]`);
	} catch {
		/* core unbound / lookup failed — keep the previous mapping */
	}
}

/** The interface address a relay should bind to (first IPv4, or the override). */
function ifaceAddress(
	name: string,
	ifaces: Array<{ name: string; addresses: string[] }>,
	cfg: ReturnType<typeof config> = config(),
): string | undefined {
	const override = cfg.interfaceNameOverrides[name];
	if (override) return override;
	return ifaces.find((i) => i.name === name)?.addresses[0];
}

// ----------------------------------------------------------------------
// Port allocator (protocol.md §1: high-water mark, stable mappings)
// ----------------------------------------------------------------------
/**
 * Resolve `name`'s UDP port. A persisted mapping always wins — adding
 * interfaces never reindexes existing ports and a downed interface keeps its
 * port. A NEW interface receives `highest_assigned_port + 1` (the port
 * high-water mark; `listenPortBase` seeds the very first allocation) and the
 * mapping is persisted immediately.
 */
export function allocatePort(name: string): number {
	const cfg = config();
	const existing = cfg.portMap[name];
	if (existing !== undefined) return existing;
	const ports = Object.values(cfg.portMap);
	const highWater =
		ports.length > 0 ? Math.max(...ports) : cfg.listenPortBase - 1;
	let port = highWater + 1;
	// Defense against a corrupted map: never hand out a taken port.
	while (ports.includes(port)) port += 1;
	if (port > 65_535)
		throw new ApiError(
			`no free relay port for ${name} (high water ${highWater})`,
			409,
		);
	saveConfig({ portMap: { ...cfg.portMap, [name]: port } });
	return port;
}

/** Free a removed interface's port mapping (the other mappings stay put). */
export function freePort(name: string): void {
	const cfg = config();
	if (cfg.portMap[name] === undefined) return;
	const next = { ...cfg.portMap };
	delete next[name];
	saveConfig({ portMap: next });
}

/** Root of the per-interface sysfs dir (test seam: point at a fixture). */
let sysfsNetDir = "/sys/class/net";

/** Test seam: point the operstate read at a fixture directory (null restores the default). */
export function setSysfsNetForTest(dir: string | null): void {
	sysfsNetDir = dir ?? "/sys/class/net";
}

/**
 * Carrier state of a machine interface: `false` only when the OS explicitly
 * reports it down. Read failures (missing sysfs entry, e.g. a test-only
 * interface name) are lenient and report `up` — a relay that cannot bind is
 * surfaced as a failure, not a carrier loss.
 */
export function carrierUp(name: string): boolean {
	try {
		return (
			readFileSync(join(sysfsNetDir, name, "operstate"), "utf8").trim() !==
			"down"
		);
	} catch {
		return true;
	}
}

/**
 * Negotiated link speed in Mb/s from sysfs; `undefined` when the kernel
 * reports it unknown (-1 / EINVAL — Wi-Fi, most modems, no carrier). Mirrors
 * the network module's `linkSpeed` so the relay card shows the same value the
 * encoder's interfaces card shows.
 */
function linkSpeed(name: string): number | undefined {
	try {
		const mbps = parseInt(
			readFileSync(join("/sys/class/net", name, "speed"), "utf8").trim(),
			10,
		);
		return mbps > 0 && mbps < 0xffffffff ? mbps : undefined;
	} catch {
		return undefined;
	}
}

// ----------------------------------------------------------------------
// Runtime status (the status file + the `ctrlink_relay.status` RPC)
// ----------------------------------------------------------------------
/**
 * The LAN IP this relay advertises to encoders: the manual `announceHost`
 * override if set, else the auto-detected address (the first running relay's
 * bound address, else the first eligible interface). Empty when there is
 * nothing to advertise.
 */
export function effectiveAnnounceHost(): string {
	const cfg = config();
	const manual = cfg.announceHost.trim();
	if (manual) return manual;
	const ifaces = netIfaces?.list() ?? [];
	const auto =
		[...relays.values()][0]?.interfaceAddress ??
		advertisedInterfaces(ifaces, cfg)
			.map((name) => ifaceAddress(name, ifaces, cfg))
			.find(Boolean);
	return auto ?? "";
}

/**
 * The relay's uplink interfaces as reported to the encoder (protocol.md
 * §3/§4): name, the interface's own IP (the address the encoder dials), the
 * allocated UDP port, and the up/down state. `uplink: true` marks every
 * entry (this list IS the relay's uplink set).
 */
export function relayIfaceList(): CtrlinkRelayIface[] {
	const cfg = config();
	const ifaces = netIfaces?.list() ?? [];
	return advertisedInterfaces(ifaces, cfg).map((name) => {
		const i: CtrlinkRelayIface = {
			iface_name: name,
			ip: ifaceAddress(name, ifaces, cfg) ?? "",
			udp_port: allocatePort(name),
			state: relays.has(name) ? ("up" as const) : ("down" as const),
			uplink: true,
		};
		// Layer-3 WireGuard offer (spec TODO/wireguard.md): when the relay has
		// a `wg-<if>` netdev up for this uplink, advertise it so the encoder
		// builds a WG vif (full Internet) instead of a GRETAP L2 bridge.
		const wg = relayWgSpecFor(name);
		if (wg) i.wg = wg;
		return i;
	});
}

/** Guard so the relayer closure is wired exactly once (module start). */
let gretapConfigured = false;
/**
 * Wire the GRETAP module's relayer closure + `ip` seam (module start, once).
 * The closure reads live state on every reconcile, so the same closure serves
 * the first pass and every network/encoder change.
 */
function configureGretap(): void {
	if (gretapConfigured) return;
	gretapConfigured = true;
	setGretapIpRunner(undefined); // production `ip` runner (lib default)
	setGretapLogger((msg) => core.logEvent("info", "Gretap", msg));
	setGretapRelayer(() => {
		const cfg = config();
		const ifaces = netIfaces?.list() ?? [];
		return {
			// WireGuard REPLACES GRETAP: when the Layer-3 WG transport is on
			// (the default), the legacy L2 GRETAP bridges are suppressed so the
			// uplinks are never bridged/stripped. GRETAP only runs in an
			// explicit legacy mode (gretap on, wireGuard off).
			enabled: cfg.gretap && !cfg.wireGuard && cfg.enabled,
			dryRun: core.config.DRY_RUN,
			endpoints: advertisedInterfaces(ifaces, cfg)
				.filter((n) => !directIfaces.has(n))
				.map((n) => ({ iface: n, ip: ifaceAddress(n, ifaces, cfg) ?? "" }))
				.filter((e) => e.ip),
			encoders: knownEncoders().map((e) => ({ id: e.encoderId, ip: e.ip })),
		};
	});
}

/** Convenience: kick a (coalesced) GRETAP reconcile. No-op when disabled. */
function reconcileGretapsNow(): void {
	void reconcileGretaps();
}

/**
 * The one place the WG transport's kernel commands get elevated: every `ip`
 * / `wg` / `iptables` / `modprobe` / `sysctl` run goes through `sudo -n`
 * (the user runs with `sudo -n` non-interactively on this device). Kept at a
 * single seam so a host without `sudo` can inject its own runner.
 */
const sudoCmdRunner = (bin: string, args: string[]): Promise<string> =>
	runCommand("/usr/bin/sudo", ["-n", bin, ...args]);

/** Guard so the WireGuard module is wired exactly once (module start). */
let wgConfigured = false;
/**
 * Wire the Layer-3 WireGuard transport (module start, once). The relay's
 * outer endpoint on the dedicated link is the advertised (`announceHost`)
 * IP — the encoder dials `<this>:<per-uplink port>` per tunnel (spec §10:
 * the outer UDP always leaves over the dedicated relay↔encoder link).
 */
/**
 * The relay's WG outer endpoint (the address the encoder dials per uplink).
 * The outer UDP always leaves over the dedicated relay↔encoder link, so this
 * is the relay's address on the DIRECTLY-CONNECTED interface (where the
 * encoder reached us) — not an uplink. A manual `announceHost` overrides;
 * with no encoder discovered yet we fall back to the advertised host so the
 * spec's `endpoint` is never empty. Evaluated live on every snapshot (the
 * ded-link address is only known after discovery and can change).
 */
function wgTransportOuterIp(): string {
	const cfg = config();
	const manual = cfg.announceHost.trim();
	if (manual) return manual;
	const ifaces = netIfaces?.list() ?? [];
	for (const name of directIfaces) {
		const addr = ifaceAddress(name, ifaces, cfg);
		if (addr) return addr;
	}
	return effectiveAnnounceHost();
}

function configureRelayWgNow(): void {
	if (wgConfigured) return;
	wgConfigured = true;
	const cfg = config();
	setCmdRunner(sudoCmdRunner);
	configureRelayWireGuard({
		enabled: cfg.wireGuard && cfg.enabled,
		// A live getter: the ded-link address is discovered at runtime and
		// `relayWgSpecFor` resolves it on every snapshot.
		transportOuterIp: wgTransportOuterIp,
	});
}

/** Serialize WG reconciles on a tail promise so passes cannot overlap: an
 * unserialized pass whose `refreshDirectIfaces` ran before the encoder was
 * known would compute the uplink set from an empty `directIfaces` and rebuild
 * a `wg-<dedlink>` tunnel-over-the-tunnel after a correct pass removed it.
 * Chaining them guarantees the final state always reflects the newest
 * `directIfaces`. */
let wgReconcileTail: Promise<void> = Promise.resolve();
function reconcileWireGuardNow(): void {
	wgReconcileTail = wgReconcileTail.then(async () => {
		try {
			// Refresh the direct-link set FIRST — the single authoritative
			// ordering point.
			await refreshDirectIfaces();
			// No encoder known → tear down all WG devices (nothing to tunnel
			// to, and leftovers like wg-<dedlink> are useless).
			if (knownEncoders().length === 0) {
				await reconcileRelayWireGuardNow([]);
				return;
			}
			const cfg = config();
			const ifaces = netIfaces?.list() ?? [];
			const uplinks = advertisedInterfaces(ifaces, cfg).filter(
				(n) => !directIfaces.has(n),
			);
			await reconcileRelayWireGuardNow(uplinks);
		} catch {
			// Never break the reconciliation chain.
		}
	});
}

function buildStatus(): CtrlinkRuntimeStatus {
	const cfg = config();
	const ifaces = netIfaces?.list() ?? [];
	const availableInterfaces = advertisedInterfaces(ifaces, cfg).map((name) => {
		const rate = liveRates.get(name);
		return {
			name,
			address: ifaceAddress(name, ifaces, cfg) ?? "",
			// High-water-mark mapping (protocol.md §1) — never base+index.
			listenPort: allocatePort(name),
			state: relays.has(name) ? ("up" as const) : ("down" as const),
			speed: linkSpeed(name),
			// The REAL relayed throughput (bytes/sec), sampled live — this is
			// what the card shows, not the negotiated `speed` above.
			rxBytesPerSec: rate?.rxBytesPerSec,
			txBytesPerSec: rate?.txBytesPerSec,
		};
	});
	const relaysArr = [...relays.entries()].map(([name, relay]) => {
		const st = relay.stats();
		return {
			interfaceName: name,
			interfaceAddress: relay.interfaceAddress,
			stats: {
				encRxPackets: st.encRxPackets,
				encTxPackets: st.encTxPackets,
				lastEncoderSeen: st.lastEncoderSeen,
			},
		};
	});
	const downList = [...downIfaces.keys()].filter((name) =>
		availableInterfaces.some((i) => i.name === name),
	);
	// The encoders this relay learned about, each with its per-path
	// last-discovery stamps and the live state of the control-channel
	// WebSocket to it (the card shows the relay→encoder links).
	const encoders = knownEncoders().map((e) => {
		const ch = encoderChannels.get(e.encoderId);
		return {
			id: e.encoderId,
			connected: !!ch && ch.ws.readyState === WebSocket.OPEN,
			discoveredAt: { ...e.discoveredAt },
			lastSeen: e.lastSeen,
		};
	});
	return {
		connected: relays.size > 0,
		announceHost: effectiveAnnounceHost(),
		availableInterfaces,
		relays: relaysArr,
		downInterfaces: downList,
		failures: [...failures.entries()].map(([interfaceName, reason]) => ({
			interfaceName,
			reason,
		})),
		lastMdnsAnnounceAt,
		lastUdpAnnounceAt: lastUdpAnnounceAt(),
		lastWsAdvertiseAt,
		encoders,
	};
}

/**
 * The discoverable payload this relay broadcasts to encoders (UDP broadcast
 * on the well-known discovery port). Returns null when there is nothing to
 * offer (no eligible interfaces), so the announce tick is skipped.
 */
export function announcePayload(): CtrlinkAnnounce | null {
	const cfg = config();
	const ifaces = buildStatus().availableInterfaces;
	if (ifaces.length === 0) return null;
	// The announced relay identity: manual override if set, else the
	// auto-detected LAN address (the first eligible interface).
	const host = effectiveAnnounceHost() || ifaces[0].address;
	if (!host) return null;
	// A manual announceHost covers every tunnel (NATted / interconnect-only
	// NIC). In auto mode the encoder dials each interface's OWN IP
	// (protocol.md §3/§5: "the IP address is the address of the relay
	// interface that the encoder should use to reach the relay").
	const perIfaceAddress = cfg.announceHost.trim() === "";
	return {
		v: 1,
		host,
		hostname: hostname(),
		interfaces: ifaces.map((i) => ({
			name: i.name,
			address: perIfaceAddress ? i.address || host : host,
			listenPort: i.listenPort,
			// Down paths stay advertised (port kept) so the encoder keeps the
			// mapping and reuses it when the path returns (protocol.md §1/§5).
			state: i.state,
		})),
		ts: Date.now(),
	};
}

/** Write the runtime status file (best-effort, never throws). */
async function writeStatusFile(): Promise<void> {
	const cfg = config();
	try {
		const status = buildStatus();
		await core.writeFileAtomic(
			cfg.runtimeStatusFile,
			JSON.stringify(status, null, 2),
		);
	} catch (e) {
		core.logEvent("warn", "Relay", `status file: ${errorMessage(e)}`);
	}
}

// ----------------------------------------------------------------------
// Relay lifecycle
// ----------------------------------------------------------------------
/**
 * Inject the per-interface raw socket (tests run without CAP_NET_ADMIN and
 * supply a mock). Production leaves this undefined → the relay opens a real
 * raw socket. `setIfaceSocketFactory` is exported only so the test module can
 * override it (the binding itself is not exported for assignment).
 */
let ifaceSocketFactory: ((name: string) => IfaceRawSocket) | undefined;
export function setIfaceSocketFactory(
	factory: ((name: string) => IfaceRawSocket) | undefined,
): void {
	ifaceSocketFactory = factory;
}

async function startRelay(
	name: string,
	addr: string,
	listenPort: number,
): Promise<UdpRelay> {
	// SNAT source = the egress NIC's *own* IP, not the (possibly overridden)
	// vif bind address. Once a packet leaves the tether, the reply must come
	// back to an address the egress upstream (phone / carrier NAT) can route
	// into that NIC — which is the NIC's real IP. The vif bind address may be
	// an encoder-reachable LAN override that the phone can't route back, in
	// which case replies vanish (forward-only traffic). Best-effort: if the
	// NIC IP can't be resolved (tests, fake iface), fall back to interfaceAddress.
	let natAddress: string | undefined;
	try {
		natAddress = resolveInterfaceAddress(name);
	} catch {
		natAddress = undefined;
	}
	const relay = await createUdpRelay({
		interfaceName: name,
		listenPort,
		interfaceAddress: addr,
		natAddress,
		ifaceSocket: ifaceSocketFactory?.(name),
		// SNAT to the relay's own IP (default on) so a *remote* destination
		// can receive the stream and reply to the relay, not the private vif
		// IP the transparent bridge can't route back through.
		nat: config().nat,
		// When the relay learns the vif IP an encoder bridges through this
		// interface, park a FORWARD-path route in a DEDICATED table (never the
		// main one): the relay egresses whole packets with the vif IP as their
		// SOURCE, but the host's default route is source-pinned
		// (`... src <relayIp>`), so the kernel can't route vif-sourced traffic
		// and emits ICMP host-unreachable (SRT handshake dies, leg 0 kbps). A
		// `from <vif>` rule + source-agnostic `default dev <iface>` in a
		// dedicated table gives that traffic a real egress. Best-effort: a
		// routing failure must not break the relay itself.
		//
		// NAT mode: not needed — the relay SNATs the source to its own IP, so
		// outbound traffic already routes normally through the host default
		// route. Only the transparent bridge (nat=false) egresses vif-sourced
		// packets, which is the case that needs this route.
		onVifLearned: (vifIp) => {
			if (config().nat) return;
			void installVifRoute(name, vifIp).catch((e: unknown) =>
				core.logEvent(
					"warn",
					"Relay",
					`vif reply-route ${vifIp} dev ${name}: ${
						e instanceof Error ? e.message : String(e)
					}`,
				),
			);
		},
	});
	await relay.start();
	relays.set(name, relay);
	lastIfaceAddr.set(name, addr);
	failures.delete(name);
	return relay;
}

async function stopRelay(name: string): Promise<void> {
	const relay = relays.get(name);
	if (!relay) return;
	await relay.stop();
	relays.delete(name);
	liveRates.delete(name);
	lastIfaceAddr.delete(name);
	failures.delete(name);
	downIfaces.delete(name);
	void removeVifRoute(name);
}

// ----------------------------------------------------------------------
// Vif forward-path routing (dedicated table, never the main table)
// ----------------------------------------------------------------------
/**
 * Assign the dedicated routing table for `name`'s vif forward path. Derived
 * from the interface's position in the current eligible list — stable for the
 * life of a relay, and cleaned up on stop, so a later interface shift is
 * harmless.
 */
function vifTableFor(name: string): number {
	const ifaces = netIfaces?.list() ?? [];
	const eligible = eligibleInterfaces(ifaces, config());
	const idx = Math.max(0, eligible.indexOf(name));
	return VIF_TABLE_BASE + idx;
}

/**
 * Install the FORWARD-path route for a learned vif IP so the packets the relay
 * egresses *on behalf of* that vif (source = vif IP) are actually routable:
 *   - `${table}`: a source-AGNOSTIC `default dev <name>` route.
 *   - a `from <vifIp> lookup ${table}` rule.
 *
 * Why: the relay forwards whole IP packets out its physical interface with the
 * ORIGINAL (vif) source address intact. The host's normal default route is
 * source-pinned by DHCP (`... src <relayIp>`), so the kernel refuses to route
 * packets sourced `vifIp` — "Network is unreachable" → ICMP host-unreachable,
 * which kills the SRT handshake and leaves the leg at 0 kbps. A dedicated table
 * with a source-agnostic default plus a `from <vifIp>` rule gives vif-sourced
 * traffic a real egress without touching the main table. The reverse (OBS→vif)
 * needs no route: the raw tap (SO_RCVALL) captures it straight off the
 * interface. Best-effort throughout.
 */
async function installVifRoute(name: string, vifIp: string): Promise<void> {
	// Re-learn of a changed vif: tear down the previous one first.
	const prev = vifRoutes.get(name);
	if (prev && prev.vifIp !== vifIp) await removeVifRoute(name, prev);
	const table = vifTableFor(name);
	vifRoutes.set(name, { vifIp, table });
	const tableStr = String(table);
	// Source-agnostic default out this interface (on-link): works for a routed
	// NIC (nearest-hop / proxy-ARP) and for a WireGuard tunnel (single peer).
	await core
		.run(
			"ip",
			["route", "replace", "default", "dev", name, "table", tableStr],
			true,
		)
		.catch(routeWarn(name, vifIp, "route"));
	// `rule` has no `replace`: del the old one (idempotent) then add.
	await core
		.run("ip", ["rule", "del", "from", vifIp, "lookup", tableStr], true)
		.catch(routeWarn(name, vifIp, "rule-del"));
	await core
		.run("ip", ["rule", "add", "from", vifIp, "lookup", tableStr], true)
		.catch(routeWarn(name, vifIp, "rule-add"));
}

/** Tear down a vif forward-path route + rule. Best-effort, never throws. */
async function removeVifRoute(
	name: string,
	entry?: { vifIp: string; table: number },
): Promise<void> {
	const e = entry ?? vifRoutes.get(name);
	if (!e) return;
	vifRoutes.delete(name);
	const tableStr = String(e.table);
	await core
		.run("ip", ["rule", "del", "from", e.vifIp, "lookup", tableStr], true)
		.catch(routeWarn(name, e.vifIp, "rule-del"));
	await core
		.run("ip", ["route", "flush", "table", tableStr], true)
		.catch(routeWarn(name, e.vifIp, "flush"));
}

/** Build a consistent, non-fatal warning logger for a vif routing failure. */
function routeWarn(name: string, vifIp: string, what: string) {
	return (e: unknown) =>
		core.logEvent(
			"warn",
			"Relay",
			`vif ${what} ${vifIp} dev ${name}: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
}

/**
 * Interfaces this relay has OFFERED before: ever mapped a port, or ever ran a
 * relay. Drives which `interface_added` / `interface_removed` events fire —
 * an interface first announced for the snapshot is not re-announced as
 * "added" (protocol.md §4).
 */
const seenIfaces = new Set<string>();
function markSeen(name: string): void {
	seenIfaces.add(name);
}

/**
 * True once the startup snapshot sync has run. Interfaces first seen in that
 * sync are announced silently — they go out in the WS `hello` snapshot
 * (protocol.md §4). An interface that appears LATER (hotplug, a new segment
 * coming up with the relay already running) is a real change and must reach
 * the connected encoders as `interface_added` immediately. `start()`/`stop()`
 * reset the flag so every module lifetime begins with a silent snapshot.
 */
let runtimeSync = false;

/** Rebuild the "seen" set after a process restart (from persisted mappings).
 * Exported for tests (to reset the history between cases). */
export function reseedSeen(): void {
	seenIfaces.clear();
	for (const name of Object.keys(config().portMap)) seenIfaces.add(name);
}

const ifaceInfo = (
	name: string,
	ifaces: Array<{ name: string; addresses: string[] }>,
): { addr: string; port: number } => ({
	addr: ifaceAddress(name, ifaces) ?? "",
	port: allocatePort(name),
});

/**
 * Bring every eligible interface's relay up to the current config. Idempotent.
 * A per-interface failure is logged and does not stop the others.
 *
 * Port and state semantics (protocol.md §1/§4):
 *  - ports come from the persisted high-water-mark mapping (`allocatePort`)
 *    — an added interface never reindexes the existing ones;
 *  - an ABSENT interface that was offered before is removed (mapping freed,
 *    `interface_removed`);
 *  - a PRESENT interface with no usable path (no IPv4, carrier down, or a
 *    failed bind) is marked DOWN — its mapping is kept, `interface_down`;
 *  - a DOWN interface whose path returned is started on its KEEP port and
 *    reported `interface_up`;
 *  - an interface first seen in the STARTUP snapshot sync is started silently
 *    (it goes out in the WS snapshot / announce, not as `interface_added`);
 *    one that appears later at runtime is reported `interface_added` so the
 *    connected encoders learn about it immediately.
 *
 * The emitted events are returned (and must be forwarded to the connected
 * encoders by the caller — see `startEncoderChannels`).
 */
export async function syncRelays(rollbackOnFailure = false): Promise<{
	started: string[];
	stopped: string[];
	failures: CtrlinkRelayFailure[];
	events: Array<{ type: CtrlinkRelayIfaceEventType; iface: CtrlinkRelayIface }>;
}> {
	const cfg = config();
	const ifaces = netIfaces.list();
	const eligible = new Set(eligibleInterfaces(ifaces, cfg));
	const started: string[] = [];
	const stopped: string[] = [];
	const failuresOut: CtrlinkRelayFailure[] = [];
	const events: Array<{
		type: CtrlinkRelayIfaceEventType;
		iface: CtrlinkRelayIface;
	}> = [];
	/** Relays started by THIS pass — rolled back if a later one fails (spec §10.3). */
	const startedThisPass: string[] = [];

	// Interfaces no longer eligible: stop the relay, free the mapping
	// (protocol.md §1: removals do not reindex the other ports).
	for (const name of [...relays.keys(), ...downIfaces.keys()]) {
		if (!eligible.has(name)) {
			await stopRelay(name);
			stopped.push(name);
			if (seenIfaces.has(name)) {
				const { addr, port } = ifaceInfo(name, ifaces);
				events.push({
					type: "interface_removed",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "down",
						uplink: true,
					},
				});
			}
			freePort(name);
			failures.delete(name);
			seenIfaces.delete(name);
		}
	}

	// Start / update relays for eligible interfaces.
	for (const name of [...eligible]) {
		const addr = ifaceAddress(name, ifaces, cfg);
		const port = allocatePort(name);
		const existed = seenIfaces.has(name);
		markSeen(name);
		if (!addr) {
			// No IPv4: mark down (mapping kept), report the transition.
			failures.set(name, "no IPv4 address");
			failuresOut.push({ interfaceName: name, reason: "no IPv4 address" });
			if (existed) {
				await stopRelay(name);
				downIfaces.set(name, {});
				events.push({
					type: "interface_down",
					iface: {
						iface_name: name,
						ip: "",
						udp_port: port,
						state: "down",
						uplink: true,
					},
				});
			}
			core.logEvent("warn", "Relay", `no IPv4 on ${name}`);
			continue;
		}
		// Carrier down: mark down (mapping kept), report the transition.
		if (!carrierUp(name)) {
			failures.set(name, "interface is down");
			failuresOut.push({ interfaceName: name, reason: "interface is down" });
			if (existed) {
				await stopRelay(name);
				downIfaces.set(name, {});
				events.push({
					type: "interface_down",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "down",
						uplink: true,
					},
				});
			}
			core.logEvent("warn", "Relay", `${name} is down — port ${port} kept`);
			continue;
		}
		const existing = relays.get(name);
		const existingAddr = lastIfaceAddr.get(name);
		if (existing && existingAddr === addr) continue; // already correct
		const wasDown = !existing && (existed || downIfaces.has(name));
		if (existing) {
			// Interface address changed: restart on the SAME (kept) port.
			await stopRelay(name);
		}
		try {
			await startRelay(name, addr, port);
			started.push(name);
			startedThisPass.push(name);
			if (wasDown)
				events.push({
					type: "interface_up",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "up",
						uplink: true,
					},
				});
			else if (existed || runtimeSync)
				// `runtimeSync`: an interface first seen while the relay is
				// already running (hotplug / new segment) must not wait for
				// the next `hello` — connected encoders get it now.
				events.push({
					type: "interface_added",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "up",
						uplink: true,
					},
				});
		} catch (e) {
			const reason = errorMessage(e);
			failures.set(name, reason);
			failuresOut.push({ interfaceName: name, reason });
			if (existed) {
				downIfaces.set(name, { reason });
				events.push({
					type: "interface_down",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "down",
						uplink: true,
					},
				});
			}
			if (rollbackOnFailure) {
				// A start is atomic: a failure stops the relays this pass brought up.
				for (const s of startedThisPass) await stopRelay(s);
				startedThisPass.length = 0;
				started.length = 0;
				// stopRelay() clears the rolled-back entries; re-record this one.
				failures.set(name, reason);
				core.logEvent(
					"error",
					"Relay",
					`start ${name} failed — rolled back: ${reason}`,
				);
				core.notifyStateChange();
				await writeStatusFile();
				throw new ApiError(`cannot start relay on ${name}: ${reason}`, 409);
			}
			core.logEvent("error", "Relay", `start ${name}: ${reason}`);
		}
	}

	core.notifyStateChange();
	await writeStatusFile();
	return { started, stopped, failures: failuresOut, events };
}

async function stopAll(): Promise<void> {
	for (const name of [...relays.keys()]) await stopRelay(name);
	// Tear down the GRETAP tunnels + release the borrowed interfaces (restores
	// their addresses) so the relay keeps full connectivity after a stop.
	await stopGretaps();
	// Sweep any vif reply-routes whose relay left the map (defensive: stopRelay
	// already clears most of these, a re-learn race can linger).
	for (const name of [...vifRoutes.keys()]) await removeVifRoute(name);
	downIfaces.clear();
	failures.clear();
	core.notifyStateChange();
	await writeStatusFile();
}

/** A network interface set changed: resync + forward the interface events.
 * Runs even when no relay is up: that is exactly the moment a recovered or
 * hot-plugged interface must be announced (`interface_up` /
 * `interface_added`) — skipping the sync there is what left the encoders on
 * a dead path until the next reconnect. `enabled` (not relay count) gates it:
 * a disabled module never starts relays from a network event. */
async function onNetworkChange(): Promise<void> {
	if (!config().enabled) return;
	// A segment change can move an encoder on- or off-link from one of our
	// interfaces — reclassify before the events below are fanned out.
	await refreshDirectIfaces();
	const { events } = await syncRelays();
	pushIfaceEvents(events);
	// Endpoints (iface addresses) may have moved — reconcile GRETAP tunnels
	// too (coalesced no-op when the set is unchanged or gretap is off).
	reconcileGretapsNow();
	// The uplink set / addresses may have moved — reconcile the WG netdev set.
	reconcileWireGuardNow();
	// A channel that opened before this change carried a stale snapshot —
	// re-send the full `hello` (the only message carrying `wg` offers).
	resnapshotStaleChannels();
}

// ----------------------------------------------------------------------
// Encoder discovery + relay → encoder WebSocket channels (protocol.md §2–§5)
// ----------------------------------------------------------------------
/** The relay identity sent in the WS hello (hostnames change when the
 * box is renamed; that is acceptable — encoders track the session, not us). */
const RELAY_ID = hostname() || "ctrlirl-relay";

/** Reconnect backoff for a dropped relay → encoder WebSocket. */
const ENCODER_WS_RECONNECT_MS = 5_000;

interface EncoderChannel {
	ws: WebSocket;
	gen: number;
	timer?: ReturnType<typeof setTimeout>;
	/** Keepalive ping timer (cleared when the channel closes). */
	hbeat?: ReturnType<typeof setInterval>;
	/** Signature of the last `hello`'s interface set (names + IPs + whether
	 * each carries a Layer-3 `wg` offer). Compared against the live set to
	 * re-send a full `hello` when it changes — the per-interface events do
	 * NOT carry the `wg` offers, and the WG netdevs (and thus the specs) are
	 * built asynchronously AFTER the first snapshot, so an encoder that got a
	 * bare / pre-WG snapshot would otherwise fall back to GRETAP. */
	announcedSig?: string;
	/** The encoder snapshot the channel was started with (needed to rebuild
	 * a per-encoder `hello` on re-send). */
	encoder: CtrlinkDiscoveredEncoder;
}
/** The live relay → encoder channels, keyed by `encoder_id` (announces are
 * re-sent periodically, so the key is stable). */
const encoderChannels = new Map<string, EncoderChannel>();
/** A pending connect (so overlapping reconciles never open two sockets). */
const pendingConnects = new Set<string>();

/** A stable signature of the current advertise set: each interface's name,
 * IP, and whether it carries a Layer-3 `wg` offer. Two snapshots with the
 * same signature are equivalent as far as the encoder's vif reconcile is
 * concerned. */
function announcedSig(ifaces?: CtrlinkRelayIface[]): string {
	const list = ifaces ?? relayIfaceList();
	return list
		.map((i) => `${i.iface_name}:${i.ip}:wg=${i.wg ? 1 : 0}`)
		.sort()
		.join("|");
}

/**
 * Re-send the FULL `hello` snapshot to any live encoder channel whose last
 * snapshot no longer matches the live set. Closes two races where the
 * per-interface events are insufficient (they never carry the `wg` offers):
 * (1) the WS channel opens before the network list is populated (0 ifaces),
 * and (2) the WG netdevs — and thus the `wg` specs — are built asynchronously
 * AFTER the first snapshot. A stale / pre-WG snapshot would leave the encoder
 * on GRETAP. Idempotent + cheap: a full resend only when the signature moved.
 */
function resnapshotStaleChannels(): void {
	const liveSig = announcedSig();
	for (const [, st] of encoderChannels) {
		if (st.ws.readyState !== WebSocket.OPEN) continue;
		if (st.announcedSig === liveSig) continue;
		// Fresh registry entry (the channel-start snapshot may be stale —
		// `wsPort` in particular); fall back to the stored one.
		const enc =
			knownEncoders().find((x) => x.encoderId === st.encoder.encoderId) ??
			st.encoder;
		const hello = helloMessage(enc);
		let sent: CtrlinkRelayIface[] = [];
		if (hello.type === "hello") sent = hello.interfaces;
		st.announcedSig = announcedSig(sent);
		try {
			st.ws.send(JSON.stringify(hello));
			console.log(
				`ctrlink_relay: re-sent full snapshot to encoder ${enc.encoderId} (${sent.length} iface(s)) — startup snapshot was stale`,
			);
		} catch (e) {
			console.warn(
				`ctrlink_relay: snapshot re-send to ${enc.encoderId} failed: ${errorMessage(e)}`,
			);
		}
	}
}

/** The full snapshot message (protocol.md §3/§4: sent on every (re)connect).
 * `outer_ip` is per-encoder (depends on how we reach THAT encoder), so it is
 * filled from the GRETAP reconcile's cache only when gretap is on. */
function helloMessage(e?: CtrlinkDiscoveredEncoder): CtrlinkRelayWsMessage {
	const interfaces = relayIfaceList().map((i) => {
		if (!e) return i;
		const outer = gretapOuterIpFor(i.iface_name, e.ip);
		return outer ? { ...i, outer_ip: outer } : i;
	});
	return {
		type: "hello",
		relay_id: RELAY_ID,
		proto: CTRLINK_RELAY_WS_PROTOCOL,
		interfaces,
	};
}

function closeEncoderChannel(key: string, gen: number): void {
	const st = encoderChannels.get(key);
	if (!st || st.gen !== gen) return; // already replaced / stopped
	if (st.timer) clearTimeout(st.timer);
	if (st.hbeat) clearInterval(st.hbeat);
	encoderChannels.delete(key);
	try {
		st.ws.close();
	} catch {
		/* already closed */
	}
}

function stopEncoderChannel(key: string): void {
	const st = encoderChannels.get(key);
	if (st) closeEncoderChannel(key, st.gen);
	pendingConnects.delete(key);
}

/**
 * Dial the encoder's WebSocket server (protocol.md §3: the encoder is the
 * server, the relay the client) and send the full snapshot. Failed connects
 * retry with a backoff while the encoder is still known.
 */
function startEncoderChannel(e: CtrlinkDiscoveredEncoder): void {
	if (pendingConnects.has(e.encoderId)) return;
	// An open (or connecting) channel already exists: do NOT dial again. The
	// reconcile runs every announce tick, and a re-dial leaks the previous
	// socket (the relay never closes it), so the encoder sees a fresh
	// "relay WS connected" every 5 s — the flapping pattern. A failed connect
	// removes the entry via `fail()`, which owns the re-dial.
	const existing = encoderChannels.get(e.encoderId);
	if (
		existing &&
		(existing.ws.readyState === WebSocket.OPEN ||
			existing.ws.readyState === WebSocket.CONNECTING)
	)
		return;
	pendingConnects.add(e.encoderId);
	const gen = (existing?.gen ?? 0) + 1;
	const url = `ws://${e.ip}:${e.wsPort}/ctrlink${
		e.token ? `?token=${encodeURIComponent(e.token)}` : ""
	}`;
	let ws: WebSocket;
	try {
		ws = new WebSocket(url);
	} catch {
		pendingConnects.delete(e.encoderId);
		return;
	}
	const st: EncoderChannel = { ws, gen, encoder: e };
	encoderChannels.set(e.encoderId, st);
	ws.onopen = (): void => {
		pendingConnects.delete(e.encoderId);
		// The channel is live: keep the encoder's TTL fresh (a live channel
		// is self-sustaining; discovery only matters for the dial). Stamp
		// NOW — `e` is a snapshot from channel start and goes stale.
		noteEncoder({ ...e, lastSeen: Date.now() });
		// Full snapshot on (re)connect — the encoder has a consistent view.
		// `outer_ip` is resolved for THIS encoder (per-channel).
		st.ws.send(JSON.stringify(helloMessage(e)));
		st.announcedSig = announcedSig();
		lastWsAdvertiseAt = Date.now();
		// Keepalive: the encoder replies `pong`; every frame in both
		// directions refreshes the registry TTL (protocol.md §3).
		st.hbeat = setInterval(() => {
			if (st.ws.readyState !== WebSocket.OPEN) return;
			try {
				st.ws.send(JSON.stringify({ type: "ping" }));
			} catch {
				/* close handler owns the re-dial */
			}
		}, CTRLINK_ANNOUNCE_INTERVAL_MS);
		st.hbeat.unref?.();
		console.log(
			`ctrlink_relay: WS connected to encoder ${e.encoderId} — snapshot sent (${relayIfaceList().length} iface(s))`,
		);
		// The link state surfaced on the card changed — refresh it now
		// (don't wait for the next announce tick).
		core.notifyStateChange();
		void writeStatusFile();
	};
	ws.onmessage = (ev: MessageEvent): void => {
		// Any frame from the encoder (pong / events) proves the channel is
		// alive → refresh the registry TTL so the sweep never reaps a live
		// channel. `e` is a channel-start snapshot — stamp NOW.
		noteEncoder({ ...e, lastSeen: Date.now() });
		// Learn this encoder's per-uplink WireGuard keys so we can dial it
		// as a peer on each `wg-<if>` netdev (spec §12: the encoder sends its
		// public key over the control channel; the relay dials it).
		let raw: unknown;
		try {
			raw = JSON.parse(String(ev.data));
		} catch {
			return;
		}
		if (isCtrlinkRelayWsMessage(raw) && raw.type === "encoder_wg_key") {
			// The encoder's link IP (outer endpoint we dial) is its registry
			// entry IP (announce / WS source), falling back to the channel
			// snapshot. `setRelayWgEncoderKeys` triggers a coalesced reconcile.
			const encIp =
				knownEncoders().find((x) => x.encoderId === raw.encoder_id)?.ip ?? e.ip;
			setRelayWgEncoderKeys(raw.encoder_id, encIp, raw.public_keys);
			// The encoder is now known → recompute the uplink set (excluding
			// the freshly-learnt transport link) so the WG netdevs + this
			// peer are built immediately, not on the next sweep.
			void reconcileWireGuardNow();
		}
	};
	const fail = (why: string): void => {
		if (encoderChannels.get(e.encoderId) !== st) return; // replaced
		closeEncoderChannel(e.encoderId, st.gen);
		// The link state surfaced on the card changed — refresh it now.
		core.notifyStateChange();
		void writeStatusFile();
		if (knownEncoders().some((x) => x.encoderId === e.encoderId)) {
			console.warn(
				`ctrlink_relay: WS to encoder ${e.encoderId} lost (${why}) — retrying in ${ENCODER_WS_RECONNECT_MS / 1000}s`,
			);
			st.timer = setTimeout(
				() => startEncoderChannel(e),
				ENCODER_WS_RECONNECT_MS,
			);
			st.timer.unref?.();
		}
	};
	ws.onerror = (): void => {}; // the close handler carries the reason
	ws.onclose = (ev): void => fail(ev.reason || "closed");
}

/**
 * Reconcile the channel set to the known encoders: start missing, stop the
 * ones we stopped hearing (or that left the registry). An OPEN/CONNECTING
 * channel is never stopped here: it refreshes its own TTL (keepalive), so an
 * "unknown" encoder behind a live socket is a registry artifact, and a truly
 * dead peer closes itself (the `fail` handler then owns the cleanup).
 */
function reconcileEncoderChannels(): void {
	for (const enc of knownEncoders()) startEncoderChannel(enc);
	for (const [key, st] of [...encoderChannels]) {
		if (
			!knownEncoders().some((e) => e.encoderId === key) &&
			st.ws.readyState !== WebSocket.OPEN &&
			st.ws.readyState !== WebSocket.CONNECTING
		)
			stopEncoderChannel(key);
	}
	// The encoder set changed (appeared / dropped) — reconcile GRETAP tunnels
	// (coalesced no-op when the set is unchanged or gretap is off).
	reconcileGretapsNow();
	// New encoders may already carry learnt WG keys → reconcile the peer set.
	reconcileWireGuardNow();
}

/**
 * Control-server path (protocol.md §2.2): ask the control server for
 * registered encoders and hand them to the encoder registry. Best-effort —
 * a down / unreachable control server must never block UDP discovery.
 * Throttled to one poll per 30 s.
 */
/**
 * MUST stay well under the encoder registry TTL (15 s) — a control-server-
 * only link (both boxes reachable, no LAN discovery) must be able to keep
 * the entry fresh on its own.
 */
const CONTROL_SERVER_INTERVAL_MS = 10_000;
/** Reset the control-server poll throttle (tests — the timestamp persists across cases). */
export function resetControlServerCheck(): void {
	lastControlServerCheck = 0;
}
async function ensureControlServerEncoders(): Promise<void> {
	if (Date.now() - lastControlServerCheck < CONTROL_SERVER_INTERVAL_MS) return;
	lastControlServerCheck = Date.now();
	if (core.config.DRY_RUN) return;
	try {
		const devs = await core.listDevices();
		// The bridge target runs the ctrlink_streamer module; the roles that
		// run it come from the roles' own module lists (the module never names
		// a role).
		const streamerRoles = new Set(core.roleRuns("ctrlink_streamer"));
		for (const d of devs) {
			if (d.role === undefined || !streamerRoles.has(d.role) || !d.online)
				continue;
			const info = (await core.requestDevice(
				d.id,
				"ctrlink_streamer.encoderInfo",
			)) as {
				encoderId?: string;
				ip?: string;
				wsPort?: number;
				token?: string;
			} | null;
			if (!info?.ip || !info.wsPort) continue;
			// Canonical identity: the encoder's OWN `encoder_id` (what its
			// UDP / mDNS announces carry), NOT the control server's device
			// name — a renamed device (the server entry saying
			// "moblin-encoder" while the box announces "rpi4") would
			// otherwise register under two ids and show twice.
			const id = info.encoderId ?? d.hostname ?? d.id;
			if (knownEncoders().some((x) => x.encoderId === id)) continue;
			noteEncoder({
				encoderId: id,
				ip: info.ip,
				wsPort: info.wsPort,
				proto: CTRLINK_RELAY_WS_PROTOCOL,
				token: info.token,
				discoveredAt: { "control-server": Date.now() },
				lastSeen: Date.now(),
			});
			void refreshDirectIfaces();
			const enc = knownEncoders().find((x) => x.encoderId === id);
			if (enc) {
				startEncoderChannel(enc);
				reconcileGretapsNow();
				reconcileWireGuardNow();
			}
		}
	} catch {
		/* control server down or link closed — UDP discovery keeps working */
	}
}

/** The events the last `pushIfaceEvents` call handed to the encoder WS
 * channels (test seam). */
let lastPushEvents: Array<{
	type: CtrlinkRelayIfaceEventType;
	iface: CtrlinkRelayIface;
}> = [];

/** Test seam: the events the last `pushIfaceEvents` forwarded to the
 * connected encoders (empty after a push with no changes). */
export function lastWsPushEvents(): Array<{
	type: CtrlinkRelayIfaceEventType;
	iface: CtrlinkRelayIface;
}> {
	return lastPushEvents;
}

/** Forward interface change events to every connected encoder (§4).
 * Directly-connected interfaces are dropped: advertising them (e.g. an
 * `interface_added` for hot-plugged media) would make the encoder tunnel a
 * segment it already owns — it must stay a plain direct uplink. */
export function pushIfaceEvents(
	events: Array<{ type: CtrlinkRelayIfaceEventType; iface: CtrlinkRelayIface }>,
): void {
	const visible = events.filter((ev) => !directIfaces.has(ev.iface.iface_name));
	lastPushEvents = visible;
	for (const ev of visible) {
		// `outer_ip` is per-encoder (the channel key is `encoderId:ip`):
		// annotate a copy per channel so each encoder learns the address to
		// send GRETAP outer headers at for `ev.iface` (empty = none/direct).
		for (const [key, st] of encoderChannels) {
			const encIp = key.slice(key.lastIndexOf(":") + 1);
			const outer = gretapOuterIpFor(ev.iface.iface_name, encIp);
			const iface = outer
				? { ...ev.iface, outer_ip: outer }
				: ev.iface;
			const msg = JSON.stringify({ type: ev.type, iface });
			try {
				if (st.ws.readyState === WebSocket.OPEN) st.ws.send(msg);
			} catch (e) {
				console.warn(
					`ctrlink_relay: WS send to ${key} failed: ${errorMessage(e)}`,
				);
			}
		}
	}
}

/**
 * An encoder (re-)announced itself (UDP discovery) — dial it if new.
 * Exposed for tests.
 */
export function onEncoderAnnounced(e: CtrlinkDiscoveredEncoder): void {
	const isNew = !encoderChannels.has(e.encoderId) && !pendingConnects.has(e.encoderId);
	void (async () => {
		// A (new) encoder may sit on one of our segments — reclassify the
		// direct set before the snapshot/events go out to it.
		await refreshDirectIfaces();
		// The encoder is now known → the transport link is classified.
		// Recompute the WG uplink set NOW (excluding the transport link) so
		// we never build a `wg-<dedlink>` tunnel-over-the-tunnel; this also
		// refreshes `lastUplinks` for the encoder-key-driven reconcile below.
		reconcileWireGuardNow();
		if (!isNew) return;
		// Build this encoder's GRETAP tunnels + populate the per-iface
		// `outer_ip` cache BEFORE the first hello, so the encoder learns the
		// on-path address on connect (not in a later, possibly-absent event).
		await reconcileGretaps();
		startEncoderChannel(e);
	})();
}

/** Stop all relay → encoder channels (module stop). */
export function stopEncoderChannels(): void {
	for (const key of [...encoderChannels.keys()]) stopEncoderChannel(key);
	lastWsAdvertiseAt = undefined;
	pendingConnects.clear();
}

/** mDNS browse callback (protocol.md §2/§3): encoder TXT is flat
 * (id/ip/port/proto/tok). */
function onMdnsEncoder(f: MdnsFound): void {
	const encoderId = f.fields.get("id");
	const ip = f.fields.get("ip");
	const wsPort = Number(f.fields.get("port") ?? "");
	if (!encoderId || !ip || !Number.isInteger(wsPort) || wsPort <= 0) return;
	const enc: CtrlinkDiscoveredEncoder = {
		encoderId,
		ip,
		wsPort,
		proto: Number(f.fields.get("proto") ?? "1") || 1,
		token: f.fields.get("tok") ?? undefined,
		discoveredAt: { mdns: Date.now() },
		lastSeen: Date.now(),
	};
	noteEncoder(enc);
	onEncoderAnnounced(enc);
}

/**
 * Start encoder discovery (protocol.md §2/§3): the UDP-announce listener on
 * the well-known port, the mDNS encoder-service browser, and the TTL sweep /
 * control-server reconciler. Idempotent.
 */
function startDiscovery(): void {
	startListeningForEncoders(onEncoderAnnounced, {
		dryRun: core.config.DRY_RUN,
	});
	// mDNS path: encoders advertise `_ctrlirl-encoder._udp.local`.
	mdnsBrowseStop?.();
	mdnsBrowseStop = startMdnsBrowser({
		service: MDNS_ENCODER_SERVICE,
		dryRun: core.config.DRY_RUN,
		onFound: onMdnsEncoder,
	});
	if (!encoderSweep) {
		encoderSweep = setInterval(async () => {
			const dropped = sweepEncoders();
			// Drop learnt WG keys for encoders we stopped hearing (their
			// peers are removed on the next reconcile pass).
			for (const id of dropped) dropRelayWgEncoder(id);
			// Self-heal the direct set: a sweep may have dropped encoders,
			// releasing interfaces that were filtered out for them. Await it
			// so the WG reconcile below sees a fresh transport-link exclusion.
			await refreshDirectIfaces();
			reconcileEncoderChannels();
			reconcileWireGuardNow();
			// A channel that opened before the network list was populated got
			// a bare `hello` (0 `wg` offers). Re-send the full snapshot now
			// that the uplink set is known — this is the guaranteed catch-up
			// for the startup race (runs every announce tick, idempotent).
			resnapshotStaleChannels();
			void ensureControlServerEncoders();
		}, CTRLINK_ANNOUNCE_INTERVAL_MS);
		encoderSweep.unref?.();
	}
}

/** Stop encoder discovery and tear down every relay → encoder channel. */
function stopDiscovery(): void {
	stopListeningForEncoders();
	mdnsBrowseStop?.();
	mdnsBrowseStop = undefined;
	if (encoderSweep) {
		clearInterval(encoderSweep);
		encoderSweep = undefined;
	}
	stopEncoderChannels();
}

/**
 * Advertise this relay to encoders via BOTH paths (protocol.md §3): UDP
 * broadcasts on 10333 AND the mDNS `_ctrlirl-relay._udp.local` service. mDNS
 * TXT is compact (`h`; `ip`; `i=name=addr:port;...`), so the endpoint list is
 * truncated at 255 B — the encoder keeps the longer set across sources (the
 * full list comes back with the next WS hello).
 */
function startAdvertiseAll(): void {
	// Per-segment announce sockets: bind addresses are the REAL interface
	// addresses, not the announce payload's (a manual `announceHost`
	// override collapses the payload to one IP — see `startAnnouncing`).
	const segs = buildStatus()
		.availableInterfaces.map((i) => i.address)
		.filter((a): a is string => typeof a === "string" && a.length > 0);
	startAnnouncing(announcePayload, {
		dryRun: core.config.DRY_RUN,
		binds: segs,
	});
	mdnsAdvertiseStop?.();
	mdnsAdvertiseStop = startMdnsAdvertiser({
		instance: hostname() || "ctrlirl-relay",
		service: MDNS_RELAY_SERVICE,
		servicePort: CTRLINK_DISCOVERY_PORT,
		dryRun: core.config.DRY_RUN,
		onAdvertise: (ts) => {
			lastMdnsAnnounceAt = ts;
		},
		buildTxt: (): string[] | null => {
			const p = announcePayload();
			if (!p) return null;
			const fields = [`h=${p.hostname ?? p.host}`, `ip=${p.host}`];
			const i = p.interfaces
				.map((e) => `${e.name}=${e.address}:${e.listenPort}`)
				.join(";");
			if (i) fields.push(`i=${i}`);
			return fields;
		},
	});
}

/** Stop both relay-advertise paths (UDP + mDNS). */
function stopAdvertiseAll(): void {
	stopAnnouncing();
	mdnsAdvertiseStop?.();
	mdnsAdvertiseStop = undefined;
	lastMdnsAnnounceAt = undefined;
}

// ----------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------
const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: "ctrlink_relay",
	title: "Ctrlink Relay",
	/** Depends on the network module for the interface list + uplinks file. */
	dependencies: ["network"],
	methods: [
		"ctrlink_relay.start",
		"ctrlink_relay.stop",
		"ctrlink_relay.status",
		"ctrlink_relay.getConfig",
		"ctrlink_relay.setConfig",
	],
	events: ["ctrlink_relay.stats"],
	configDefaults: {
		enabled: false,
		nat: true,
		// WireGuard is the default transport (replaces GRETAP).
		gretap: false,
		wireGuard: true,
		listenPortBase: 4000,
		interfaceAllow: [],
		interfaceIgnore: ["docker.*", "veth.*"],
		interfaceNameOverrides: {},
		logLevel: "info",
	},
	log,
	bind(c) {
		core = c;
		netIfaces = requireCapability<NetworkInterfaces>("network.interfaces");
		// Bind-time validation only: the relay needs the network uplinks
		// capability to exist (TUN IPs surface through it) but never calls it.
		requireCapability<Uplinks>("network.uplinks");
	},
	/**
	 * `modules.configure`: persist the settings-page fields to the module slice.
	 * Without this hook the settings page would only save `enabled`. The core
	 * restarts the module afterwards, so a port-base change
	 * re-syncs the relays (spec §5.4).
	 */
	configure(patch, s) {
		const next: Partial<CtrlinkRelayConfig> = {};
		if (typeof patch.enabled === "boolean") {
			next.enabled = patch.enabled;
			s.enabled = patch.enabled;
		}
		if (typeof patch.nat === "boolean") next.nat = patch.nat;
		if (typeof patch.gretap === "boolean") {
			next.gretap = patch.gretap;
			s.gretap = patch.gretap;
		}
		if (typeof patch.wireGuard === "boolean") {
			next.wireGuard = patch.wireGuard;
			s.wireGuard = patch.wireGuard;
		}
		if (typeof patch.announceHost === "string")
			next.announceHost = patch.announceHost.trim();
		if (typeof patch.listenPortBase === "number")
			next.listenPortBase = patch.listenPortBase;
		if (Array.isArray(patch.interfaceAllow))
			next.interfaceAllow = (patch.interfaceAllow as string[]).filter(
				(v) => typeof v === "string",
			);
		if (Array.isArray(patch.interfaceIgnore))
			next.interfaceIgnore = (patch.interfaceIgnore as string[]).filter(
				(v) => typeof v === "string",
			);
		if (typeof patch.logLevel === "string")
			next.logLevel = patch.logLevel as CtrlinkRelayConfig["logLevel"];
		if (Object.keys(next).length > 0) saveConfig(next);
	},
	async start(ctx) {
		core = ctx.core;
		// Make sure the interface monitor is running (it may not be if the
		// network module's slice is disabled on this role).
		await netIfaces.ensureMonitoring();
		netUnsub = netIfaces.onChanged(() => void onNetworkChange());
		// Wire the GRETAP module (once) and run its first reconcile — the
		// tunnels key off the encoder + endpoint set, which is empty at boot
		// and grows as encoders announce.
		configureGretap();
		reconcileGretapsNow();
		// Layer-3 WireGuard multi-uplink transport (spec TODO/wireguard.md):
		// one `wg-<if>` netdev per advertised uplink + per-encoder peer +
		// per-uplink egress policy route / NAT. First pass is empty (no
		// encoders yet) and grows as they announce their WG keys.
		configureRelayWgNow();
		reconcileWireGuardNow();
		// Sample each relay's live forwarded throughput (bytes/sec) for the
		// card's "real speed" — the negotiated link speed is not what matters.
		startRateSampler();
		// Interface history: an interface that got a port mapping before this
		// process started must not be re-announced as `interface_added` — it
		// goes out in the WS snapshot (protocol.md §4).
		reseedSeen();
		runtimeSync = false; // the snapshot sync below is silent for first-seen ifaces
		// Learn encoders (protocol.md §2): UDP announces on the discovery
		// port + a throttled control-server lookup. The listener callback
		// dials each new encoder's WebSocket; the sweep drops encoders that
		// stop announcing and reconciles the channel set.
		if (config().enabled) startDiscovery();
		// Autostart if the slice is enabled. Best-effort: a single interface's
		// bind conflict must not crash the client on boot — the failed interface
		// is recorded in status (`failures`) and the others keep running.
		if (config().enabled) {
			const res = await syncRelays(false);
			pushIfaceEvents(res.events);
			if (res.started.length > 0) startAdvertiseAll();
			void ensureControlServerEncoders();
			// A WS channel that opened before the network list was populated
			// got a `hello` with few/no `wg` offers (the startup race) —
			// re-send the full snapshot now that the set is known.
			resnapshotStaleChannels();
		}
		// From here on, interface changes are runtime events: first-seen
		// interfaces are announced `interface_added` to the connected
		// encoders instead of waiting for the next `hello`.
		runtimeSync = true;
	},
	async stop() {
		netUnsub?.();
		netUnsub = undefined;
		runtimeSync = false;
		stopRateSampler();
		stopAdvertiseAll();
		stopDiscovery();
		void stopRelayWireGuard();
		await stopAll();
	},
	async status() {
		return {
			state: {
				ctrlink: buildStatus() as unknown as CtrlinkRelayState,
			},
		};
	},
	async dispatch(method: string, p: Params) {
		switch (method) {
			case "ctrlink_relay.status":
				return { ctrlink: buildStatus() };
			case "ctrlink_relay.getConfig":
				return { config: config() };
			case "ctrlink_relay.start": {
				core.cancelAutostart();
				const patch: Partial<CtrlinkRelayConfig> = {};
				if (p.announceHost !== undefined && p.announceHost !== "") {
					patch.announceHost = requireHost(p, "announceHost");
				}
				if (Object.keys(patch).length > 0) saveConfig(patch);
				saveConfig({ enabled: true });
				startDiscovery();
				void ensureControlServerEncoders();
				// Best-effort: never throw on a per-interface bind conflict — the
				// failed interface is surfaced in `ctrlink.failures`, others run.
				const result = await syncRelays(false);
				pushIfaceEvents(result.events);
				// Both UDP + mDNS advertise paths (per-segment sockets), so a
				// UI start (e.g. after an announceHost change) is consistent
				// with the autostart path.
				if (result.started.length > 0) startAdvertiseAll();
				return { ctrlink: buildStatus(), ...result };
			}
			case "ctrlink_relay.stop":
				core.cancelAutostart();
				saveConfig({ enabled: false });
				stopAnnouncing();
				stopDiscovery();
				await stopAll();
				return { ctrlink: buildStatus() };
			case "ctrlink_relay.setConfig": {
				const patch: Partial<CtrlinkRelayConfig> = {};
				if (p.enabled !== undefined)
					patch.enabled = requireBoolean(p, "enabled");
				if (p.nat !== undefined) patch.nat = requireBoolean(p, "nat");
				if (p.gretap !== undefined) patch.gretap = requireBoolean(p, "gretap");
				if (p.announceHost !== undefined) {
					const ip = String(p.announceHost).trim();
					patch.announceHost = ip === "" ? "" : requireHost(p, "announceHost");
				}
				if (p.listenPortBase !== undefined) {
					const base = Number(p.listenPortBase);
					if (!Number.isInteger(base) || base < 1 || base > 65535)
						throw new ApiError("listenPortBase out of range", 400);
					patch.listenPortBase = base;
				}
				if (p.interfaceAllow !== undefined)
					patch.interfaceAllow = optionalStringList(p, "interfaceAllow") ?? [];
				if (p.interfaceIgnore !== undefined)
					patch.interfaceIgnore =
						optionalStringList(p, "interfaceIgnore") ?? [];
				if (p.interfaceNameOverrides !== undefined) {
					const overrides = p.interfaceNameOverrides as Record<string, unknown>;
					if (typeof overrides !== "object" || overrides === null)
						throw new ApiError("interfaceNameOverrides must be an object", 400);
					patch.interfaceNameOverrides = Object.fromEntries(
						Object.entries(overrides).map(([k, v]) => [k, String(v)]),
					);
				}
				if (p.runtimeStatusFile !== undefined) {
					const path = String(p.runtimeStatusFile);
					if (!path.startsWith("/"))
						throw new ApiError(
							"runtimeStatusFile must be an absolute path",
							400,
						);
					patch.runtimeStatusFile = path;
				}
				if (p.logLevel !== undefined) {
					const level = String(p.logLevel);
					if (!["trace", "debug", "info", "warn", "error"].includes(level))
						throw new ApiError("invalid logLevel", 400);
					patch.logLevel = level as CtrlinkRelayConfig["logLevel"];
				}
				saveConfig(patch);
				// Restart affected relays if the config that affects them changed
				// and forward the resulting interface events to the connected
				// encoders (a config change can add/drop interfaces — the
				// encoder must not wait for the next `hello` for that).
				if (
					patch.listenPortBase !== undefined ||
					patch.interfaceAllow !== undefined ||
					patch.interfaceIgnore !== undefined ||
					patch.interfaceNameOverrides !== undefined
				) {
					if (config().enabled) {
						const res = await syncRelays();
						pushIfaceEvents(res.events);
						if (res.started.length > 0) startAdvertiseAll();
					} else await stopAll();
				}
				// A gretap toggle changes the tunnel set (reads live config) —
				// reconcile now so tunnels appear/disappear without a re-announce.
				if (patch.gretap !== undefined) reconcileGretapsNow();
				// A wireGuard toggle (re)loads the WG transport: re-bind the
				// enabled state + reconcile the netdev set now.
				if (patch.wireGuard !== undefined) {
					configureRelayWgNow();
					reconcileWireGuardNow();
				}
				return { config: config(), ctrlink: buildStatus() };
			}
			default:
				throw new ApiError(`unknown method ${method}`, 404);
		}
	},
	services: { consumes: ["network.interfaces", "network.uplinks"] },
};

export default registration;
