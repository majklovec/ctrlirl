/*
 * ctrlink_streamer module (encoder side). For every relay-announced uplink
 * carrying a `tunnel` offer, the encoder builds one per-uplink `utn-<if>`
 * plain-UDP↔TUN vif (udpip.ts), and, with `autoRegisterUplink` on, registers
 * each vif IP as a `network.uplinks` entry via `syncVifUplinks` so
 * `srtla_send` picks the extra paths up without user intervention (spec
 * 100-ctrlink §6, §7.2, §8.3). The tunnel vifs ARE the transport — there is
 * no GRETAP L2/TUN path.
 *
 * The module runs permanently on encoders: discovery listens for relay
 * announces and the vifs reconcile to the offered set as it changes, so the
 * encoder is always able to pick up relay interface updates. There is no
 * start/stop — the module starts with the device process.
 *
 * Relays are learned by UDP announce (discovery.ts) — the encoder listens on
 * the well-known discovery port and keeps a TTL'd registry of the relays it
 * hears. The learned relays are mirrored to the `network.ctrlink` capability
 * so the network card groups the shared interfaces per relay.
 *
 * Control plane (TODO/protocol.md): discovery is bidirectional. The encoder
 * ALSO broadcasts an `encoder_id` announce so relays find us, and runs a
 * small WebSocket server (ws_server.ts) on the configured `wsPort`: each
 * relay connects, sends a `hello` snapshot + `interface_added` /
 * `interface_removed` / `interface_up` / `interface_down` events, which are
 * merged into the same registry (onRelayWsMessage). The `tunnel` offers in
 * those messages drive the per-uplink vif reconcile — down/removed paths
 * stop their vifs (the port mapping survives), re-up paths rebuild them.
 * No key exchange: the relay pins this encoder as a single peer on its side.
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { requireCapability } from "../../../shared/capabilities";
import type {
	BackendModule,
	Params,
} from "../../../shared/contracts/backend_module";
import type {
	CtrlinkRegistry,
	Uplinks,
} from "../../../shared/contracts/module_capabilities";
import {
	CTRLINK_RELAY_WS_PROTOCOL,
	type CtrlinkDiscoveredRelay,
	type CtrlinkRelayWsMessage,
	type CtrlinkSharedEndpoint,
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
	oneOf,
	optionalInt,
	requireBoolean,
	requireString,
} from "../../../shared/params";
import { defaultSourceIp } from "../../../shared/srtla";
import { errorMessage } from "../../../shared/util";
import type { ModuleCore } from "../../backend/module_core";
import {
	type EncoderInfo,
	forgetRelay,
	isIpv4Literal,
	knownRelays,
	lastEncoderUdpAnnounceAt,
	noteMdnsRelay,
	noteRelay,
	startDiscovering,
	startEncoderAnnouncing,
	stopDiscovering,
	stopEncoderAnnouncing,
} from "./discovery";
import log from "./log";
import {
	type CtrlinkLogLevel,
	type CtrlinkStreamerConfig,
	type CtrlinkStreamerRuntimeStatus,
	type CtrlinkStreamerStatusFile,
	type CtrlinkStreamerTunnelStatus,
	type CtrlinkStreamerView,
} from "./types";
import {
	type RelayWsConn,
	startRelayWsServer,
} from "./ws_server";
import {
	configureEncoderTunnels,
	reconcileEncoderTunnels,
	stopEncoderTunnels,
	encoderTunnelStateForTest,
	type EncoderTunnelOffer,
} from "./udpip";
import type {
	CtrlinkTunnelSpec,
	CtrlinkRelayIface,
} from "../../../shared/ctrlink_discovery";

const LOG_LEVELS: readonly CtrlinkLogLevel[] = [
	"trace",
	"debug",
	"info",
	"warn",
	"error",
];

/** Core bag, bound at discovery and re-filled at start. */
let core: ModuleCore;
/** The network module's uplinks layer (bonded file + programmatic add/remove). */
let uplinks: Uplinks;
/** The network module's Ctrlink relays registry (surfaced on the network card). */
let ctrlinkReg: CtrlinkRegistry;
/**
 * The relay `tunnel` offers, keyed by relay host. Populated from the WS
 * `hello` + `interface_*` events; drives the encoder's `utn-<if>` vifs. Each
 * entry carries the relay iface IP (for the on-link filter) + the full
 * `tunnel` spec.
 */
const tunnelOffers = new Map<
	string,
	{ ip: string; spec: CtrlinkTunnelSpec }[]
>();
/** The encoder's ded-link iface (destination of the transport-isolation
 * route). Derived from the first relay's WS peer address's iface. */
let tunnelTransportDev = "eth0";
/** SRTLA uplink ids registered for the tunnel vifs (vif IP → id), for cleanup. */
const tunnelUplinkIds = new Map<string, string>();

// ----------------------------------------------------------------------
// Config (persisted as `state.data.ctrlinkStreamer`; §6.4)
// ----------------------------------------------------------------------
function defaultConfig(): CtrlinkStreamerConfig {
	return {
		prefixLength: 24,
		mtu: 1400,
		keepaliveIntervalMs: 5_000,
		autoRegisterUplink: true,
		tunnel: true,
		runtimeStatusFile: "/tmp/ctrlink-status.json",
		logLevel: "info",
		wsPort: 8190,
		announceToken: "",
	};
}

const stored = (): Partial<CtrlinkStreamerConfig> =>
	(core.state.data.ctrlinkStreamer ?? {}) as Partial<CtrlinkStreamerConfig>;

/** Defaults + stored values; never throws on missing config. */
function config(): CtrlinkStreamerConfig {
	return { ...defaultConfig(), ...stored() };
}

/** Merge `patch` into the section and persist it complete (stable file). */
async function save(patch: Partial<CtrlinkStreamerConfig>): Promise<void> {
	const s = { ...config(), ...patch };
	core.state.data.ctrlinkStreamer = { ...s } satisfies CtrlinkStreamerConfig;
	await core.saveState();
}

// ----------------------------------------------------------------------
// Runtime status file (§9.1) — output only, best-effort.
// ----------------------------------------------------------------------
function statusFile(): CtrlinkStreamerStatusFile {
	const entry = tunnelStatuses();
	return {
		connected: entry.some((e) => e.uplinkRegistered),
		relays: entry,
	};
}

/** Warn at most once per process so a persistently unwritable path (e.g. a
 * `/tmp` file owned by a different UID) doesn't spam every reconcile tick. */
let statusFileWarned = false;
function writeStatusFile(): void {
	if (core.config.DRY_RUN) return;
	const body = JSON.stringify(statusFile(), null, 2);
	try {
		writeFileSync(config().runtimeStatusFile, body);
		statusFileWarned = false;
		return;
	} catch (e) {
		const reason = errorMessage(e);
		// The path is a fixed shared location; when a previous run (often a
		// different UID, e.g. dev vs. prod root) left the file in place, a
		// write over it can fail. Clear it and try once more — that is the
		// common cross-user /tmp conflict.
		try {
			unlinkSync(config().runtimeStatusFile);
			writeFileSync(config().runtimeStatusFile, body);
			statusFileWarned = false;
			return;
		} catch {
			// fall through to the (warn-once) message below
		}
		if (statusFileWarned) return;
		statusFileWarned = true;
		console.warn(
			`ctrlink_streamer: status file write failed: ${reason}`,
		);
	}
}

// ----------------------------------------------------------------------
// Runtime status
// ----------------------------------------------------------------------
function tunnelStatuses(): CtrlinkStreamerTunnelStatus[] {
	const { vifs } = encoderTunnelStateForTest();
	const out: CtrlinkStreamerTunnelStatus[] = [];
	for (const v of vifs) {
		// The relay that owns this vif (its WS control-channel host). The
		// spec — if the relay is still offering it — carries the UDP port.
		const spec = (tunnelOffers.get(v.relayId) ?? []).find(
			(e) => e.spec.peerAddr === v.localIp,
		)?.spec;
		out.push({
			interfaceName: v.name,
			interfaceAddress: v.localIp,
			relayHost: v.relayId,
			relayPort: spec?.udpPort ?? 0,
			uplinkRegistered: tunnelUplinkIds.has(v.localIp),
			// Per-vif L3 counters live in the kernel; the module surfaces
			// none, so these read 0 by design.
			stats: { txPackets: 0, rxPackets: 0 },
		});
	}
	return out;
}

function runtimeStatus(): CtrlinkStreamerRuntimeStatus {
	const statuses = tunnelStatuses();
	const running = statuses.length > 0;
	return {
		state: running ? "running" : "idle",
		running,
		tunnels: statuses,
		// The kernel owns the tunnel vifs' L3 counters; the module surfaces none.
		txPackets: 0,
		rxPackets: 0,
		txBytes: 0,
		rxBytes: 0,
		// How recently this encoder announced itself so relays stay in touch.
		lastMdnsAnnounceAt,
		lastUdpAnnounceAt: lastEncoderUdpAnnounceAt(),
	};
}

const isRunning = (): boolean =>
	encoderTunnelStateForTest().vifs.length > 0;

// ----------------------------------------------------------------------
// Encoder tunnel vif sync (one vif per offered uplink)
// ----------------------------------------------------------------------
/**
 * True when `destIp` is directly on-link on one of THIS host's own interfaces
 * (the kernel answers `ip route get <destIp>` with a plain `dev <iface>` and no
 * `via` gateway), and that interface is a real LAN NIC — not loopback, a
 * tunnel vif, or a relay bridge. Used to skip relay-announced interfaces whose
 * subnet the encoder already reaches locally: the tunnel would just add a
 * competing path, so it is not created.
 *
 * Fails closed (`false` → keep the tunnel) on `ip` failure, an empty
 * (DRY_RUN) result, or a gateway route, so an ambiguous routing state never
 * silently drops a path.
 */
async function isLocallyOnLink(destIp: string): Promise<boolean> {
	if (!destIp) return false;
	let out = "";
	try {
		out = (await core.run("ip", ["route", "get", destIp], true)).trim();
	} catch {
		return false;
	}
	if (!out) return false;
	if (/\bvia\s/.test(out)) return false; // routed via a gateway, not on-link.
	const m = out.match(/\bdev\s+([A-Za-z0-9_.-]+)/);
	return !!m && m[1] !== "lo" && !/^br-/.test(m[1]);
}

/**
 * Reconcile the encoder's tunnel vifs: build a `utn-<if>` per offered uplink
 * (skipping on-link ones) and register each vif IP as an SRTLA uplink.
 * Coalesced + best-effort: a failure never blocks the TUN reconcile.
 */
async function doSyncEncoderTunnels(): Promise<void> {
	const c = config();
	// Compat alias: `tunnel` replaces `wireGuard`; read `tunnel ?? wireGuard`.
	configureEncoderTunnels({
		enabled: c.tunnel ?? c.wireGuard ?? true,
		transportDev: tunnelTransportDev,
	});
	const offers: EncoderTunnelOffer[] = [];
	for (const [host, list] of tunnelOffers) {
		for (const { ip, spec } of list) {
			// On-link filter (explicit requirement): an uplink the encoder
			// already reaches directly is not tunnelled.
			if (ip && (await isLocallyOnLink(ip))) continue;
			offers.push({ relayId: host, spec });
		}
	}
	await reconcileEncoderTunnels(offers, new Set<string>());
	await syncVifUplinks(c.autoRegisterUplink);
}

// Single-flight + re-run: the tunnel reconcile is triggered from several
// asynchronous paths (boot, WS hello, relay updates). The udpip module's
// `inFlight` guard would silently drop a reconcile that arrives while one is
// already running — losing any offers that landed in the gap. Serializing here
// and re-running after each flush guarantees the freshest `tunnelOffers`
// always wins, so a WS hello is never dropped and the state converges.
let tunnelSyncChain: Promise<void> = Promise.resolve();
function syncEncoderTunnels(): Promise<void> {
	const run = tunnelSyncChain.then(() => doSyncEncoderTunnels());
	// Keep the chain alive even if one pass throws, and never surface the
	// (best-effort) failure to callers.
	tunnelSyncChain = run.catch(() => {});
	return run.catch(() => {});
}

/** Register / drop the tunnel vif IPs as SRTLA uplinks. */
async function syncVifUplinks(autoRegister: boolean): Promise<void> {
	const live = new Map<string, string>(); // vif IP → uplink id
	const { vifs } = encoderTunnelStateForTest();
	for (const v of vifs) live.set(v.localIp, `ctrlink:tun:${v.name}`);
	// Drop stale uplink registrations.
	for (const [ip, id] of [...tunnelUplinkIds]) {
		if (!live.has(ip)) {
			try {
				await uplinks.remove(id);
			} catch (e) {
				console.warn(`ctrlink_streamer: tunnel uplink remove failed: ${e}`);
			}
			tunnelUplinkIds.delete(ip);
		}
	}
	if (!autoRegister) return;
	// Add missing ones.
	for (const [ip, id] of live) {
		if (tunnelUplinkIds.has(ip)) continue;
		try {
			const name = id.replace("ctrlink:tun:", "");
			await uplinks.add({ id, source: ip, label: `Ctrlink (${name})` });
			tunnelUplinkIds.set(ip, id);
		} catch (e) {
			console.warn(`ctrlink_streamer: tunnel uplink add failed: ${e}`);
		}
	}
}

// ----------------------------------------------------------------------
// Discovery wiring
// ----------------------------------------------------------------------
/** Mirror the discovered relays to the network card's per-relay grouping.
 * `wsConnected` marks the relays with a live control-channel WebSocket so the
 * card can show a green "connected" dot (protocol.md §3). */
function syncRegistry(relays: CtrlinkDiscoveredRelay[]): void {
	try {
		const seen = new Set(relays.map((r) => r.host));
		// Registry keys inside the hello→close WS window (protocol.md §3).
		const wsConnectedHosts = new Set(wsRelayHosts.values());
		// Drop stale registry entries no longer present.
		for (const r of ctrlinkReg.listRelays()) {
			if (!seen.has(r.host)) ctrlinkReg.dropRelay(r.host);
		}
		for (const r of relays) {
			ctrlinkReg.upsertRelay({
				host: r.host,
				hostname: r.hostname,
				interfaces: r.interfaces,
				lastSeen: r.lastSeen,
				wsConnected: wsConnectedHosts.has(r.host),
			});
		}
	} catch (e) {
		console.warn(`ctrlink_streamer: registry sync failed: ${errorMessage(e)}`);
	}
}

/**
 * Re-publish the network-card relay registry with fresh `wsConnected` flags.
 * Called when a control-channel WebSocket CLOSES: the relay entry stays in the
 * registry until its TTL sweeps it, but the green "connected" dot must go away
 * immediately. (The OPEN path needs no extra call — the relay's `hello`
 * re-registers it, which re-syncs with the flag already set.)
 */
function pushWsStatus(): void {
	syncRegistry(knownRelays());
	core.notifyStateChange();
}

/** A discovery shape change: re-sync the registry + reconcile the WG vifs.
 *
 * The card must list discovered relays as soon as they appear, so the state
 * is pushed immediately — the vif reconcile runs in the background and
 * notifies when it settles.
 */
async function onDiscoveredRelays(
	relays: CtrlinkDiscoveredRelay[],
): Promise<void> {
	syncRegistry(relays);
	// Push immediately so the card lists the discovered relays. This is a
	// display update and must NOT be gated behind the vif reconcile, which
	// creates netdevs and can be slow.
	console.log(
		`ctrlink_streamer: ${relays.length} relays discovered — notifying + reconciling vifs`,
	);
	core.notifyStateChange();
	// Reconcile the tunnel vif set in the background: a stuck/failed vif never
	// blocks the UI, and the state is pushed once it settles.
	void syncEncoderTunnels()
		.catch((error) => {
			console.warn(
				`ctrlink_streamer: vif reconcile after discovery failed: ${errorMessage(error)}`,
			);
		})
		.finally(() => core.notifyStateChange());
}

let mdnsBrowseStop: (() => void) | undefined;
let mdnsAdvertiseStop: (() => void) | undefined;
/** Epoch ms of the encoder's last mDNS self-advertise (so relays find it).
 * The UDP one lives in `discovery.lastEncoderUdpAnnounceAt()`. Both surface
 * on the Network card (encoder role). */
let lastMdnsAnnounceAt: number | undefined;
/** True once the discovery UDP socket + mDNS browser are up. `startDiscovering`
 * wipes the registry (see `stopDiscovering`), so re-running it on every 5s
 * autostart `resume()` evicted the WS relay (and its tunnel state) — the
 * tunnel path fell back to nothing. Guard it like `ensureControlPlane`. */
let discoveryStarted = false;

function ensureDiscovery(): void {
	if (discoveryStarted) return;
	discoveryStarted = true;
	// Always wire the change callback: it also serves as the registration
	// path for relays handed over via the control server (`noteRelay`). In
	// dry-run the UDP socket is skipped, but relaying still converges.
	startDiscovering((rels) => void onDiscoveredRelays(rels), {
		dryRun: core.config.DRY_RUN,
		protectedHosts: () => wsLivePeers,
	});
	// mDNS path (protocol.md §3): browse for relay services. TXT is compact
	// (≤255 B) and may truncate the endpoint list, so `noteMdnsRelay` keeps
	// the longer of the known / seen endpoint sets (the WS hello stays
	// authoritative).
	mdnsBrowseStop?.();
	mdnsBrowseStop = startMdnsBrowser({
		service: MDNS_RELAY_SERVICE,
		dryRun: core.config.DRY_RUN,
		onFound: (f: MdnsFound): void => {
			const host = f.fields.get("ip");
			if (!host || !isIpv4Literal(host)) return;
			const endpoints: CtrlinkSharedEndpoint[] = [];
			for (const part of (f.fields.get("i") ?? "").split(";")) {
				const m = /^(.+)=([0-9.]+):(\d+)$/u.exec(part.trim());
				if (m && isIpv4Literal(m[2]))
					endpoints.push({
						name: m[1],
						address: m[2],
						listenPort: Number(m[3]),
					});
			}
			noteMdnsRelay(host, f.fields.get("h") ?? undefined, endpoints);
		},
	});
}

// ----------------------------------------------------------------------
// Encoder → relay control plane (protocol.md §2–§5)
// ----------------------------------------------------------------------
/**
 * The encoder's discoverable endpoint for the announce broadcast (protocol.md
 * §2.1): id, IP, WS port, protocol version + optional token. The IP is the
 * machine's LAN egress address (`defaultSourceIp`) — the address a relay
 * reaches this box on. Returns null when there is nothing to advertise.
 */
export function encoderInfo(): EncoderInfo | null {
	const c = config();
	const ip = defaultSourceIp() ?? undefined;
	if (!ip) return null;
	return {
		encoderId: hostname() || "ctrlirl-encoder",
		ip,
		wsPort: c.wsPort,
		proto: CTRLINK_RELAY_WS_PROTOCOL,
		token: c.announceToken || undefined,
	};
}

/** The relay WS server (stopped on port/token change at module restart). */
let wsServer: Bun.Server<RelayWsConn> | null = null;
/**
 * Identity of the control plane currently running (port + token), so
 * `ensureControlPlane()` is idempotent: the per-5s autostart retry re-runs
 * `resume()` → `ensureControlPlane()`, and naively recreating the server
 * every time dropped the live relay WS mid-handshake.
 * Null = no (usable) control plane → build below.
 */
let controlPlaneKey: string | null = null;

/**
 * Start (or restart) the relay WebSocket server + the encoder announce
 * broadcast. The WS server's message callback merges relay interface state
 * into the discovered-relay registry, so the TUN reconcile reacts to
 * `interface_down` / `interface_removed` / `interface_added` / `interface_up`
 * (protocol.md §4–§5) — and a full `hello` snapshot replaces the relay's
 * known interface set wholesale.
 */
function ensureControlPlane(): void {
	const c = config();
	// Idempotent guard: a live server with the same port/token is left
	// untouched. The per-5s autostart retry (resume → ensureControlPlane)
	// otherwise tore down the server every cycle, dropping the live relay
	// WS mid-handshake before it could deliver the tunnel-offer hello.
	const key = `${c.wsPort}\u0000${c.announceToken}`;
	if (wsServer !== null && controlPlaneKey === key) return;
	controlPlaneKey = key;
	wsServer?.stop(true);
	wsServer = null;
	// A stopped server has no peers — never sweep-protect a stale IP, and no
	// relay is WS-connected across the restart (its channel is gone).
	wsLivePeers.clear();
	wsRelayHosts.clear();
	if (core.config.DRY_RUN) return;
	wsServer = startRelayWsServer({
		port: c.wsPort,
		token: c.announceToken,
		onMessage: (conn, msg: CtrlinkRelayWsMessage) => {
			onRelayWsMessage(conn.relayId, msg, conn.remoteAddress);
		},
		onOpen: (conn) => {
			if (conn.remoteAddress && isIpv4Literal(conn.remoteAddress))
				wsLivePeers.add(conn.remoteAddress);
		},
		onClose: (conn) => {
			if (conn.relayId) wsRelayHosts.delete(conn.relayId);
			if (conn.remoteAddress) wsLivePeers.delete(conn.remoteAddress);
			// Drop the green "connected" dot now, before the TTL sweep reaps
			// the registry entry (protocol.md §3).
			pushWsStatus();
		},
	});
	startEncoderAnnouncing(() => encoderInfo(), { dryRun: core.config.DRY_RUN });
	// mDNS advertise (protocol.md §3): relays browse for us.
	mdnsAdvertiseStop?.();
	mdnsAdvertiseStop = startMdnsAdvertiser({
		instance: hostname() || "ctrlirl-encoder",
		service: MDNS_ENCODER_SERVICE,
		servicePort: c.wsPort,
		dryRun: core.config.DRY_RUN,
		onAdvertise: (ts) => {
			lastMdnsAnnounceAt = ts;
		},
		buildTxt: (): string[] | null => {
			const info = encoderInfo();
			if (!info) return null;
			const fields = [
				`id=${info.encoderId}`,
				`ip=${info.ip}`,
				`port=${info.wsPort}`,
				`proto=${info.proto}`,
			];
			if (info.token) fields.push(`tok=${info.token}`);
			return fields;
		},
	});
}

/** Relay WS identity (`relay_id`) → discovered-relay registry host. */
const wsRelayHosts = new Map<string, string>();
/** Registry hosts with a LIVE relay WS (peer IP). The TTL sweep must not
 * reap these: the live channel keeps itself fresh via keepalive, and reaping
 * a connected relay is what caused the sweep→reconnect churn. */
const wsLivePeers = new Set<string>();

/**
 * A validated relay → encoder control-channel message (protocol.md §4).
 * Merges the relay's interface state into the discovered-relay registry so
 * `reconcile()` reacts: down/removed endpoints → TUN stopped, added/up →
 * TUN (re)started. The `hello` (full snapshot) replaces the relay's
 * interface list wholesale.
 */
/** Record a relay's full `tunnel` offer set (WS `hello` — replaces prior). */
function setTunnelOffers(
	host: string,
	ifaces: CtrlinkRelayIface[],
): void {
	const specs = ifaces
		.filter((f) => f.tunnel !== undefined)
		.map((f) => ({ ip: f.ip, spec: f.tunnel! }));
	if (specs.length) tunnelOffers.set(host, specs);
	else tunnelOffers.delete(host);
}

/** Record / drop one `tunnel` offer (WS single-interface event). */
function upsertTunnelOffer(
	host: string,
	iface: CtrlinkRelayIface,
	removed: boolean,
): void {
	const list = [...(tunnelOffers.get(host) ?? [])];
	// The vif name is `utn-<ifname>`; a down/removed event may not re-echo the
	// spec, so derive it from the iface name when absent.
	const vi = iface.tunnel?.virtualInterface ?? `utn-${iface.iface_name}`;
	const idx = list.findIndex((e) => e.spec.virtualInterface === vi);
	if (removed) {
		// The relay dropped this uplink (down / removed) → tear the vif down.
		if (idx >= 0) {
			list.splice(idx, 1);
			if (list.length) tunnelOffers.set(host, list);
			else tunnelOffers.delete(host);
		}
	} else if (iface.tunnel) {
		if (idx >= 0) list[idx] = { ip: iface.ip, spec: iface.tunnel };
		else list.push({ ip: iface.ip, spec: iface.tunnel });
		tunnelOffers.set(host, list);
	}
}

/** Learn the encoder's dedicated-link iface (reaches the relay) once. */
async function learnTunnelTransportDev(relayHost: string): Promise<void> {
	if (tunnelTransportDev !== "eth0" || !relayHost) return;
	try {
		const out = (await core.run("ip", ["route", "get", relayHost], true)).trim();
		const m = out.match(/\bdev\s+([A-Za-z0-9_.-]+)/);
		if (m && m[1] !== "lo") tunnelTransportDev = m[1];
	} catch {
		/* keep the default */
	}
}

export function onRelayWsMessage(
	relayId: string | undefined,
	msg: CtrlinkRelayWsMessage,
	/** The relay's WS peer address (encoder-side source IP), if known. */
	remoteAddress?: string,
): void {
	if (!relayId) return; // before the (required) hello — nothing to match
	if (msg.type === "hello") {
		// The announce `host` (IP) and the WS `relay_id` (hostname) describe
		// the SAME relay; the WS channel is the authoritative, newer source,
		// so it owns the registry entry (key = the announce IP if known).
		// When no UDP announce ever arrived, the key would be the `relay_id`
		// hostname — prefer the routable peer IP instead (the hostname is
		// unusable for UDP dials; dgram performs no resolution).
		const known = knownRelays().find(
			(r) => r.hostname === relayId || r.host === relayId,
		);
		const host =
			known && isIpv4Literal(known.host)
				? known.host
				: remoteAddress && isIpv4Literal(remoteAddress)
					? remoteAddress
					: relayId;
		// Identity keying: `noteRelay` merges any old IP-keyed duplicate for
		// this relay; this explicit drop covers a STALE entry whose host and
		// hostname both differ from the live channel (relay moved subnets).
		if (known && known.host !== host && known.hostname !== relayId)
			forgetRelay(known.host);
		wsRelayHosts.set(relayId, host);
		noteRelay({
			host,
			hostname: relayId,
			interfaces: msg.interfaces.map((f) => ({
				name: f.iface_name,
				address: f.ip,
				listenPort: f.udp_port,
				state: f.state,
			})),
			lastSeen: Date.now(),
		});
		// Publish the green "connected" dot now. A relay re-announcing the
		// SAME interface set over WS leaves the registry shape unchanged, so
		// `noteRelay` alone would not re-sync the network card's flag.
		pushWsStatus();
		// Tunnel offers: record this relay's `tunnel` specs (drive the vif
		// reconcile) + learn the ded-link iface (transport-isolation route
		// destination).
		setTunnelOffers(host, msg.interfaces);
		void learnTunnelTransportDev(host);
		void syncEncoderTunnels();
		return;
	}
	// Keepalive frame (protocol.md §3): proof the channel is live → refresh
	// the TTL (every 5 s; the registry logs once per relay, never per frame).
	if (msg.type === "ping" || msg.type === "pong") {
		const host = wsRelayHosts.get(relayId);
		if (!host) return;
		const relay = knownRelays().find((r) => r.host === host);
		if (relay) noteRelay({ ...relay, lastSeen: Date.now() });
		return;
	}
	// A single-interface event: patch the owning relay's endpoint set
	// (insert on added, drop on removed, replace on up/down).
	const host = wsRelayHosts.get(relayId);
	if (!host) return; // unknown relay (no hello yet)
	const relay = knownRelays().find((r) => r.host === host);
	if (!relay) return;
	const next = [...relay.interfaces];
	const idx = next.findIndex((e) => e.name === msg.iface.iface_name);
	const ep: CtrlinkSharedEndpoint = {
		name: msg.iface.iface_name,
		address: msg.iface.ip,
		listenPort: msg.iface.udp_port,
		state: msg.iface.state,
	};
	if (msg.type === "interface_removed") {
		if (idx >= 0) next.splice(idx, 1);
	} else if (idx >= 0) {
		next[idx] = ep;
	} else {
		next.push(ep);
	}
	noteRelay({
		host,
		hostname: relay.hostname,
		interfaces: next,
		lastSeen: Date.now(),
	});
	// Keep the tunnel offer set in step with the single-interface event, then
	// reconcile the vifs (coalesced no-op when nothing changed).
	upsertTunnelOffer(
		host,
		msg.iface,
		msg.type === "interface_removed" || msg.type === "interface_down",
	);
	void syncEncoderTunnels();
}

// ----------------------------------------------------------------------
// Set config (persist + reconcile when the endpoint set may have changed)
// ----------------------------------------------------------------------
async function setRuntimeConfig(
	patch: Partial<CtrlinkStreamerConfig>,
): Promise<CtrlinkStreamerView> {
	await save(patch);
	// A tunnel / autoRegisterUplink toggle rebuilds the vifs + their SRTLA
	// uplinks. `syncEncoderTunnels()` is best-effort and never blocks.
	void syncEncoderTunnels().catch((e) =>
		core.logEvent("warn", "Relay tunnels", `reconcile failed: ${e}`),
	);
	core.notifyStateChange();
	return view();
}

function view(): CtrlinkStreamerView {
	return {
		running: isRunning(),
		state: runtimeStatus().state,
		config: config(),
		runtime: runtimeStatus(),
		discoveredRelays: knownRelays(),
	};
}

// ----------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------
const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: "ctrlink_streamer",
	title: "Relay tunnels",
	/** Runs always on encoders: it must keep listening for relay interface
	 * updates and reconciling TUNs without any manual start (spec §7.4). */
	/** TUN IPs register through the network module; relays through its registry. */
	dependencies: ["network"],
	methods: [
		"ctrlink_streamer.status",
		"ctrlink_streamer.getConfig",
		"ctrlink_streamer.setConfig",
		"ctrlink_streamer.encoderInfo",
	],
	events: [],
	log,
	/**
	 * `modules.configure`: persist the settings-page fields to the module
	 * section. The core then restarts the module, so a relay/endpoint change
	 * re-reconciles the TUNs (spec §6.3). Only present fields are touched.
	 */
	configure(patch, _s) {
		const c = config();
		const next: CtrlinkStreamerConfig = { ...c };
		if (typeof patch.prefixLength === "number")
			next.prefixLength = patch.prefixLength;
		if (typeof patch.mtu === "number") next.mtu = patch.mtu;
		if (typeof patch.keepaliveIntervalMs === "number")
			next.keepaliveIntervalMs = patch.keepaliveIntervalMs;
		if (typeof patch.autoRegisterUplink === "boolean")
			next.autoRegisterUplink = patch.autoRegisterUplink;
		if (typeof patch.tunnel === "boolean") next.tunnel = patch.tunnel;
		if (typeof patch.wireGuard === "boolean")
			next.wireGuard = patch.wireGuard;
		if (typeof patch.runtimeStatusFile === "string")
			next.runtimeStatusFile = patch.runtimeStatusFile;
		if (typeof patch.wsPort === "number") next.wsPort = patch.wsPort;
		if (typeof patch.announceToken === "string")
			next.announceToken = patch.announceToken;
		if (typeof patch.logLevel === "string")
			next.logLevel = patch.logLevel as CtrlinkLogLevel;
		core.state.data.ctrlinkStreamer = next;
	},
	bind(c) {
		core = c;
		uplinks = requireCapability<Uplinks>("network.uplinks");
		ctrlinkReg = requireCapability<CtrlinkRegistry>("network.ctrlink");
	},
	async start(ctx) {
		core = ctx.core;
		uplinks = requireCapability<Uplinks>("network.uplinks");
		ctrlinkReg = requireCapability<CtrlinkRegistry>("network.ctrlink");
		// Always: listen for relay announces and reconcile the WG vif set, so
		// relay interface updates are picked up without a manual start.
		ensureDiscovery();
		syncRegistry(knownRelays());
		ensureControlPlane();
		// Build the per-uplink tunnel vifs + register the SRTLA uplinks.
		try {
			await syncEncoderTunnels();
		} catch (e) {
			core.logEvent(
				"warn",
				"Relay tunnels",
				`autostart failed: ${errorMessage(e)}`,
			);
		}
	},
	async stop() {
		stopDiscovering();
		discoveryStarted = false; // allow ensureDiscovery to rebuild on next start
		stopEncoderAnnouncing();
		mdnsBrowseStop?.();
		mdnsBrowseStop = undefined;
		mdnsAdvertiseStop?.();
		mdnsAdvertiseStop = undefined;
		wsServer?.stop(true);
		wsServer = null;
		controlPlaneKey = null; // force a rebuild on the next start/resume
		// Tear down the tunnel vifs + their SRTLA uplink registrations.
		for (const id of [...tunnelUplinkIds.values()]) {
			try {
				await uplinks.remove(id);
			} catch {
				/* already gone */
			}
		}
		tunnelUplinkIds.clear();
		tunnelOffers.clear();
		await stopEncoderTunnels();
	},
	/** Resume the tunnel vifs across process restarts. */
	async resume() {
		ensureDiscovery();
		syncRegistry(knownRelays());
		ensureControlPlane();
		if (!isRunning()) await syncEncoderTunnels();
		return true;
	},
	async dispatch(method: string, p: Params) {
		switch (method) {
			case "ctrlink_streamer.status":
				return view();
			case "ctrlink_streamer.getConfig":
				return { config: config() };
			/** The relay's control-server path queries this for the encoder's
			 * IP + WS port after its announce TTL expires (protocol.md §2.1). */
			case "ctrlink_streamer.encoderInfo":
				return encoderInfo();
			case "ctrlink_streamer.setConfig": {
				const patch: Partial<CtrlinkStreamerConfig> = {};
				if (p.prefixLength !== undefined)
					patch.prefixLength = optionalInt(
						p,
						"prefixLength",
						config().prefixLength,
						0,
						32,
					);
				if (p.mtu !== undefined)
					patch.mtu = optionalInt(p, "mtu", config().mtu, 1, 65_535);
				if (p.keepaliveIntervalMs !== undefined)
					patch.keepaliveIntervalMs = optionalInt(
						p,
						"keepaliveIntervalMs",
						config().keepaliveIntervalMs,
						1,
						3_600_000,
					);
				if (p.autoRegisterUplink !== undefined)
					patch.autoRegisterUplink = requireBoolean(p, "autoRegisterUplink");
				if (p.tunnel !== undefined)
					patch.tunnel = requireBoolean(p, "tunnel");
				if (p.wireGuard !== undefined)
					patch.wireGuard = requireBoolean(p, "wireGuard");
				if (p.runtimeStatusFile !== undefined)
					patch.runtimeStatusFile = requireString(p, "runtimeStatusFile");
				if (p.wsPort !== undefined)
					patch.wsPort = optionalInt(p, "wsPort", config().wsPort, 1, 65_535);
				if (p.announceToken !== undefined)
					patch.announceToken = requireString(p, "announceToken");
				if (p.logLevel !== undefined)
					patch.logLevel = oneOf(p.logLevel, "logLevel", LOG_LEVELS);
				if (Object.keys(patch).length === 0)
					throw new ApiError("no config fields provided");
				return setRuntimeConfig(patch);
			}
		}
		throw new Error(`unknown method ${method}`);
	},
	async status() {
		return { state: { ctrlinkStreamer: view() } };
	},
	services: { consumes: ["network.ctrlink", "network.uplinks"] },
};

export default registration;
