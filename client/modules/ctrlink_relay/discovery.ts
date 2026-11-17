/*
 * CtrLink relay ↔ encoder discovery (both sides of the wire).
 *
 * SENDING (relay → encoder, v1 announce — spec 100-ctrlink §5): when a relay
 * runs, it periodically broadcasts a small JSON `CtrlinkAnnounce` over UDP to
 * the limited-broadcast address (255.255.255.255) on the fixed well-known
 * `CTRLINK_DISCOVERY_PORT`. Encoders listening on that port learn the relay's
 * shared tunnel interfaces without any control server and without the user
 * having to type the relay's IP.
 *
 * RECEIVING (encoder → relay, protocol.md §2): encoders broadcast a JSON
 * `CtrlinkEncoderAnnounce` on the SAME port carrying their id, IP, WebSocket
 * port and optional auth token. This module's listener keeps a TTL'd registry
 * of the encoders the relay hears and hands each (re)announce to a callback so
 * the backend can dial the encoder's WebSocket. Both announce shapes share the
 * port; the type guards (`isCtrlinkAnnounce` / `isCtrlinkEncoderAnnounce`)
 * keep each side's listener from misparsing the other.
 *
 * Uses `node:dgram` (Bun's `Bun.udp` does not expose `SO_BROADCAST` in 1.4.4):
 * one sender socket per attached segment is bound to that segment's IP and
 * `setBroadcast(true)` — a limited broadcast (255.255.255.255) only egresses
 * on the bind address's subnet, so a multi-homed relay needs one socket per
 * segment to be heard everywhere. The announce is re-sent on an interval so
 * remote TTL entries stay fresh. `buildPayload` is called every tick so the
 * announce always reflects the live interface set.
 */
import dgram from "node:dgram";
import {
	isCtrlinkEncoderAnnounce,
	CTRLINK_ANNOUNCE_INTERVAL_MS,
	CTRLINK_ANNOUNCE_TTL_MS,
	CTRLINK_BROADCAST_ADDR,
	CTRLINK_DISCOVERY_PORT,
	type CtrlinkAnnounce,
	type CtrlinkDiscoveredEncoder,
} from "../../../shared/ctrlink_discovery";
import { execCmd } from "@ctrlirl/udpip";

/** One announce socket PER attached segment: a `255.255.255.255` datagram
 * only egresses on the subnet of the socket's BIND address, so one
 * (announce-host) socket would broadcast on a single segment while every
 * other directly-connected subnet (e.g. an rpi4 on 192.168.10.x behind a
 * multi-homed relay) never hears the relay. */
interface AnnounceSocket {
	s: dgram.Socket;
	/** The IP the socket is bound to ("" = unbound, default-route segment). */
	bind: string;
}
let announceSockets: AnnounceSocket[] = [];
/** The re-broadcast timer. */
let timer: ReturnType<typeof setInterval> | undefined;
/** One UNBOUND socket dedicated to all unicast announces (ARP neighbors,
 * known encoders). A segment-bound socket can only reach its own subnet's
 * addresses, so unicasting a 192.168.10.x neighbor from the 192.168.1.211
 * socket is dropped by the kernel; the unbound socket lets the routing
 * table pick the right egress per destination. */
let unicastSocket: dgram.Socket | undefined;
/** Epoch ms of the last UDP discovery broadcast (surfaced on the card).
 * `undefined` until the first send; cleared on stop. */
let udpAnnounceAt: number | undefined;

/** The relay's last UDP discovery broadcast timestamp, if any. */
export function lastUdpAnnounceAt(): number | undefined {
	return udpAnnounceAt;
}

/** Compact one-line summary of an announce's shared interfaces (debug logs). */
function endpointSummary(eps: CtrlinkAnnounce["interfaces"]): string {
	return eps.map((e) => `${e.name}=${e.address}: ${e.listenPort}`).join(", ");
}

/** Per-target throttle: a permanently-unreachable encoder IP must not spam
 * the log on every announce tick (60 s). */
const lastUnicastWarn = new Map<string, number>();

/** True once a limited broadcast has been refused (EACCES — the kernel
 * denies 255.255.255.255 sends without CAP_NET_BROADCAST). Sticky: the
 * capability does not change at runtime. */
let broadcastRefused = false;
/** Cached ARP-neighbor table (30 s TTL) for the unicast fallback. */
let neighborCache: { at: number; ips: string[] } | undefined;
const NEIGHBOR_CACHE_MS = 30_000;

/** Refresh the ARP-neighbor cache: the IPv4 addresses of every RESOLVED
 * neighbor on any local interface. */
async function refreshNeighbors(): Promise<string[]> {
	if (neighborCache && Date.now() - neighborCache.at < NEIGHBOR_CACHE_MS)
		return neighborCache.ips;
	let out = "";
	try {
		out = await execCmd("ip", ["-4", "neigh", "show"]);
	} catch (e) {
		neighborCache = { at: Date.now(), ips: neighborCache?.ips ?? [] };
		return neighborCache.ips;
	}
	const ips: string[] = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s/);
		// Only RESOLVED entries carry a MAC (`lladdr`); stale/FAILED
		// neighbors are not reachable unicast targets.
		if (m && line.includes("REACHABLE") && line.includes("lladdr"))
			ips.push(m[1]);
	}
	neighborCache = { at: Date.now(), ips: Array.from(new Set(ips)) };
	return neighborCache.ips;
}

/** Open one announce socket bound to `bindIp` ("" = unbound). Resolves to
 * null when the bind fails (segment vanished / busy) — the other segments
 * keep advertising. */
function openAnnounceSocket(bindIp: string): Promise<AnnounceSocket | null> {
	return new Promise((resolve) => {
		const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
		let settled = false;
		const finish = (err?: Error): void => {
			if (settled) return;
			settled = true;
			if (err) {
				try {
					s.close();
				} catch {
					/* already closed */
				}
				resolve(null);
				return;
			}
			try {
				s.setBroadcast(true);
			} catch {
				/* best-effort — the unicast path below covers encoders */
			}
			resolve({ s, bind: bindIp });
		};
		s.on("error", (e) => {
			if (!settled) {
				finish(e);
				return;
			}
			console.warn(
				`ctrlink_relay: discovery socket ${bindIp || "(unbound)"} error: ${e.message}`,
			);
		});
		if (bindIp) s.bind(0, bindIp, finish);
		else s.bind(0, finish);
	});
}

/** Drop a socket whose send failed (segment vanished). Best-effort —
 * `stopAnnouncing` closes leftovers either way. */
function dropDeadSocket(s: dgram.Socket): void {
	announceSockets = announceSockets.filter((a) => a.s !== s);
}

/** One announce tick: broadcast on every segment socket, unicast the known
 * encoders from the first socket (its routing table picks the egress, so
 * one egress suffices and a single `announceHost` override does not stop
 * the unicast from reaching encoders on other subnets). Sockets whose send
 * fails (segment vanished) are dropped via `dropDeadSocket`. */
function tickAnnounce(buildPayload: () => CtrlinkAnnounce | null): void {
	if (announceSockets.length === 0) return;
	const announce = buildPayload();
	if (!announce) return;
	const payload = JSON.stringify(announce);
	udpAnnounceAt = Date.now();
	const via = announceSockets.map((a) => a.bind || "default").join(", ");
	console.log(
		`ctrlink_relay: advertising host=${announce.host} ifaces=[${endpointSummary(announce.interfaces)}] → ${CTRLINK_BROADCAST_ADDR}:${CTRLINK_DISCOVERY_PORT} via [${via}]`,
	);
	announceSockets.forEach((a, i) => {
		try {
			a.s.send(payload, CTRLINK_DISCOVERY_PORT, CTRLINK_BROADCAST_ADDR, (e) => {
				if (!e) return;
				const code = (e as NodeJS.ErrnoException).code;
				// EACCES is NOT a dead segment — the kernel only refuses the
				// limited broadcast (no CAP_NET_BROADCAST). Swallow it (and
				// remember it for the neighbor-unicast fallback); a dead
				// interface surfaces as EDESTADDRREQ/ENETUNREACH/ENOBUF.
				if (code === "EACCES") {
					if (!broadcastRefused) {
						broadcastRefused = true;
						console.warn(
							"ctrlink_relay: discovery broadcast denied (EACCES); falling back to ARP-neighbor unicast",
						);
					}
					return;
				}
				// The segment's socket is dead (interface vanished): drop it
				// — the other segments keep advertising.
				dropDeadSocket(a.s);
				console.warn(
					`ctrlink_relay: discovery announce (${a.bind || "default"}) failed: ${e.message}`,
				);
			});
		} catch (e) {
			dropDeadSocket(a.s);
			console.warn(`ctrlink_relay: discovery announce failed: ${String(e)}`);
		}
	});
	// Unicast (ARP neighbors + known encoders) goes through the dedicated
	// UNBOUND socket: a segment-bound socket can only reach its own subnet's
	// addresses, so the 192.168.10.x neighbor is unreachable from the
	// 192.168.1.211 socket — the unbound socket lets the routing table pick
	// the egress per destination.
	const us = unicastSocket;
	if (!us) return;
	// Unicast to every ARP neighbor UNCONDITIONALLY: the limited
	// broadcast (255.255.255.255) needs CAP_NET_BROADCAST and, on this
	// runtime, Bun's dgram swallows the refusal — no callback, no packet.
	// A neighbor that merely answered ARP is a live candidate encoder on a
	// directly-connected segment; on a point-to-point relay link this
	// unicast IS the entire discovery path. Cheap (a few small datagrams
	// per 5 s) and non-encoder neighbors simply drop the port-10333 UDP.
	void (async (): Promise<void> => {
		for (const ip of await refreshNeighbors()) {
			try {
				us.send(payload, CTRLINK_DISCOVERY_PORT, ip, (e) => {
					if (!e) return;
					const now = Date.now();
					if (now - (lastUnicastWarn.get(ip) ?? 0) < 60_000) return;
					lastUnicastWarn.set(ip, now);
					console.warn(
						`ctrlink_relay: neighbor unicast ${ip} failed: ${e.message}`,
					);
				});
			} catch {
				/* socket gone mid-tick — next tick retries */
			}
		}
	})();
	// Unicast to every KNOWN encoder: the limited broadcast does not
	// cross subnets and mDNS is L2-only — once any path (same-L2
	// broadcast, mDNS, control server) seeds an entry, this keeps the
	// pair alive across routed links. Symmetric mirror of the
	// encoder's unicast fallback.
	for (const ip of knownEncoderIps()) {
		try {
			us.send(payload, CTRLINK_DISCOVERY_PORT, ip, (e) => {
				if (!e) return;
				const now = Date.now();
				if (now - (lastUnicastWarn.get(ip) ?? 0) < 60_000) return;
				lastUnicastWarn.set(ip, now);
				console.warn(
					`ctrlink_relay: encoder announce to ${ip} failed: ${e.message}`,
				);
			});
		} catch (e) {
			console.warn(
				`ctrlink_relay: encoder unicast announce failed: ${String(e)}`,
			);
		}
	}
}

/**
 * Start advertising `buildPayload()` on EVERY attached segment until
 * `stopAnnouncing`: one socket bound to each unique segment address. A
 * single bind would only cover its own segment; per-segment sockets make
 * the limited broadcast reach each directly-connected subnet.
 *
 * `opts.binds` should be the host's REAL interface addresses — the announce
 * payload's addresses are NOT a reliable source: a manual `announceHost`
 * override collapses every announced interface to one IP, which would
 * silently put every socket back on a single segment.
 */
export function startAnnouncing(
	buildPayload: () => CtrlinkAnnounce | null,
	opts: { dryRun?: boolean; binds?: string[] } = {},
): void {
	stopAnnouncing();
	if (opts.dryRun) {
		console.log("ctrlink_relay: discovery advertise skipped (dry-run)");
		return;
	}
	void (async (): Promise<void> => {
		const binds = new Set<string>();
		for (const b of opts.binds ?? []) if (b) binds.add(b);
		if (binds.size === 0) {
			const payload = buildPayload();
			if (payload) {
				for (const i of payload.interfaces) if (i.address) binds.add(i.address);
				if (payload.host) binds.add(payload.host);
			}
		}
		const [unicast, ...opened] = await Promise.all([
			openAnnounceSocket(""),
			...[...binds].map(openAnnounceSocket),
		]);
		if (unicast) unicastSocket = unicast.s;
		announceSockets = opened.filter((s): s is AnnounceSocket => s !== null);
		if (announceSockets.length === 0) {
			// No segment bindable (all down at startup): fall back to one
			// unbound socket (default-route segment); `ip monitor`-triggered
			// restarts pick up segments when they appear.
			const fb = await openAnnounceSocket("");
			if (fb) announceSockets = [fb];
		}
		if (announceSockets.length === 0) {
			console.warn("ctrlink_relay: discovery advertise failed to start");
			return;
		}
		const via = announceSockets.map((a) => a.bind || "default").join(", ");
		console.log(
			`ctrlink_relay: discovery advertise started → ${CTRLINK_BROADCAST_ADDR}:${CTRLINK_DISCOVERY_PORT} every ${CTRLINK_ANNOUNCE_INTERVAL_MS}ms via [${via}]`,
		);
		tickAnnounce(buildPayload);
		timer = setInterval(
			() => tickAnnounce(buildPayload),
			CTRLINK_ANNOUNCE_INTERVAL_MS,
		);
		timer.unref?.();
	})();
}

/** Stop broadcasting; best-effort (never throws). */
export function stopAnnouncing(): void {
	const had = timer !== undefined || announceSockets.length > 0;
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
	udpAnnounceAt = undefined;
	const socks = announceSockets;
	announceSockets = [];
	neighborCache = undefined;
	if (had) console.log("ctrlink_relay: discovery advertise stopped");
	for (const a of socks) {
		try {
			a.s.close();
		} catch {
			/* already closed */
		}
	}
	const us = unicastSocket;
	unicastSocket = undefined;
	if (us) {
		try {
			us.close();
		} catch {
			/* already closed */
		}
	}
}

// ----------------------------------------------------------------------
// Encoder registry (encoder → relay announces, protocol.md §2)
// ----------------------------------------------------------------------

/** A TTL'd registry of encoders this relay has heard (keyed by `encoder_id`).
 * Encoders re-announce periodically, so entries that stop being heard are
 * swept after `CTRLINK_ANNOUNCE_TTL_MS` (~3× the announce interval). */
const encoderRegistry = new Map<string, CtrlinkDiscoveredEncoder>();

/**
 * Record or refresh an encoder (UDP announce, mDNS, control-server lookup,
 * or a live WS keepalive). The entry's `lastSeen` is taken from `e` (the
 * callers stamp it with the announce time) so the TTL sweep can expire
 * silent encoders. `discoveredAt` merges per path: the incoming stamps
 * win (they are the freshest observation of those paths) and the stored
 * stamps for paths the incoming entry does not carry survive — so a
 * keptalive re-injecting an entry captured before a newer path appeared
 * never erases that path's last-discovery time.
 */
export function noteEncoder(e: CtrlinkDiscoveredEncoder): void {
	const prev = encoderRegistry.get(e.encoderId);
	encoderRegistry.set(e.encoderId, {
		...e,
		discoveredAt: { ...(prev?.discoveredAt ?? {}), ...(e.discoveredAt ?? {}) },
	});
}

/** The current registry entries (a copy — safe to iterate freely). */
export function knownEncoders(): CtrlinkDiscoveredEncoder[] {
	return [...encoderRegistry.values()];
}

/** The known encoders' IPs — unicast announce targets (protocol.md §2.1). */
export function knownEncoderIps(): string[] {
	return [...encoderRegistry.values()]
		.map((e) => e.ip)
		.filter((ip): ip is string => typeof ip === "string" && ip !== "");
}

/** Drop every entry not (re)announced within TTL; returns the dropped ids. */
export function sweepEncoders(): string[] {
	const now = Date.now();
	const dropped: string[] = [];
	for (const [id, e] of encoderRegistry) {
		if (now - e.lastSeen > CTRLINK_ANNOUNCE_TTL_MS) {
			encoderRegistry.delete(id);
			dropped.push(id);
		}
	}
	return dropped;
}

let encoderSocket: dgram.Socket | undefined;
let encoderSweepTimer: ReturnType<typeof setInterval> | undefined;
let encoderCb: ((e: CtrlinkDiscoveredEncoder) => void) | undefined;

/**
 * Listen on the well-known discovery port for encoder announces (protocol.md
 * §2). Each parsed `CtrlinkEncoderAnnounce` is recorded in the registry and
 * handed to `cb` so the backend can dial the encoder's WebSocket. Relay
 * announces (`{v:1, host, interfaces}`) share the port and are filtered out
 * by `isCtrlinkEncoderAnnounce`. A TTL sweep drops encoders that stop
 * announcing.
 */
export function startListeningForEncoders(
	cb: (e: CtrlinkDiscoveredEncoder) => void,
	opts: { dryRun?: boolean } = {},
): void {
	stopListeningForEncoders();
	if (opts.dryRun) {
		console.log("ctrlink_relay: encoder discovery listen skipped (dry-run)");
		return;
	}
	encoderCb = cb;
	try {
		const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
		s.on("error", (e) =>
			console.warn(
				`ctrlink_relay: encoder-discovery socket error: ${e.message}`,
			),
		);
		s.on("message", (msg) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(msg.toString("utf8"));
			} catch {
				return; // not JSON — noise on a shared port
			}
			if (!isCtrlinkEncoderAnnounce(parsed)) return;
			const e: CtrlinkDiscoveredEncoder = {
				encoderId: parsed.encoder_id,
				ip: parsed.ip,
				wsPort: parsed.ws_port,
				proto: parsed.proto,
				token: parsed.token,
				discoveredAt: { udp: Date.now() },
				lastSeen: Date.now(),
			};
			noteEncoder(e);
			encoderCb?.(e);
		});
		s.bind(CTRLINK_DISCOVERY_PORT, "0.0.0.0", () => {
			console.log(
				`ctrlink_relay: encoder discovery listening on :${CTRLINK_DISCOVERY_PORT}`,
			);
		});
		encoderSocket = s;
		const sweep = (): void => {
			for (const id of sweepEncoders())
				console.log(`ctrlink_relay: encoder ${id} expired (no announce)`);
		};
		encoderSweepTimer = setInterval(sweep, CTRLINK_ANNOUNCE_INTERVAL_MS);
		encoderSweepTimer.unref?.();
	} catch (e) {
		console.warn(
			`ctrlink_relay: encoder discovery listen failed: ${String(e)}`,
		);
		stopListeningForEncoders();
	}
}

/** Stop listening; best-effort (never throws). */
export function stopListeningForEncoders(): void {
	if (encoderSweepTimer) {
		clearInterval(encoderSweepTimer);
		encoderSweepTimer = undefined;
	}
	encoderCb = undefined;
	const s = encoderSocket;
	encoderSocket = undefined;
	if (s) {
		try {
			s.close();
		} catch {
			/* already closed */
		}
	}
}
