/*
 * CtrLink encoder-side WebSocket SERVER (protocol.md §3: the encoder runs
 * the server, the relay connects as a client). Relays dial
 * `ws://<encoder-ip>:<wsPort>/ctrlink[?token=...]` and send their identity,
 * protocol version and the full uplink interface list (`hello`), plus
 * `interface_added` / `interface_removed` / `interface_up` / `interface_down`
 * events. The message shape + guard live in `shared/ctrlink_discovery.ts`
 * so both sides can never drift.
 *
 * The server is deliberately thin: it authenticates (optional token),
 * validates the messages, and hands them to the backend callback with the
 * connection's relay identity (learned from the first `hello`).
 */
import {
	isCtrlinkRelayWsMessage,
	type CtrlinkRelayWsMessage,
} from "../../../shared/ctrlink_discovery";

/** The WS path relays dial (fixed; the token is a query parameter). */
export const CTRLINK_RELAY_WS_PATH = "/ctrlink";

/**
 * Open relay connections (the encoder is the server). Kept so the encoder can
 * PUSH a control-channel message (currently: `encoder_wg_key`) to a connected
 * relay without waiting for a relay-initiated frame.
 */
const liveRelays = new Set<Bun.ServerWebSocket<RelayWsConn>>();

/** Per-connection state (the relay identity from its hello). */
export interface RelayWsConn {
	/** The relay identity (from the `hello`), once known. */
	relayId?: string;
	/** The relay's protocol version (from the `hello`), once known. */
	proto?: number;
	/** The relay's source IP as seen by the encoder (WS peer address) —
	 * routable, unlike the `relay_id` hostname. */
	remoteAddress?: string;
}

interface Options {
	port: number;
	/** Expected token (empty = open, LAN-internal). */
	token: string;
	/** A validated relay → encoder message (the identity may be undefined
	 * until the relay's first `hello`). */
	onMessage: (conn: RelayWsConn, msg: CtrlinkRelayWsMessage) => void;
	/** A relay connected and was accepted. */
	onOpen?: (conn: RelayWsConn) => void;
	/** A relay connection closed. */
	onClose?: (conn: RelayWsConn) => void;
}

/**
 * Start the relay WebSocket server on `port`. Returns the `Bun.Server` (for
 * `stop()` on config changes) or null on failure (the encoder keeps working
 * without the control channel — the UDP announce path is independent).
 */
export function startRelayWsServer(
	opts: Options,
): Bun.Server<RelayWsConn> | null {
	try {
		const server = Bun.serve<RelayWsConn>({
			port: opts.port,
			hostname: "0.0.0.0",
			fetch(req, srv): Response | undefined {
				const url = new URL(req.url);
				if (url.pathname !== CTRLINK_RELAY_WS_PATH)
					return new Response("not found", { status: 404 });
				if (opts.token !== "") {
					const given = url.searchParams.get("token") ?? "";
					if (given !== opts.token) {
						console.warn("ctrlink_streamer: rejecting relay WS — bad token");
						return new Response("unauthorized", { status: 401 });
					}
				}
				const conn: RelayWsConn = {
					remoteAddress: req.socket?.remoteAddress,
				};
				if (!srv.upgrade(req, { data: conn }))
					return new Response("websocket only", { status: 400 });
				opts.onOpen?.(conn);
				return undefined;
			},
			websocket: {
				open(ws) {
					const conn = ws.data as RelayWsConn;
					liveRelays.add(ws);
					console.log(
						`ctrlink_streamer: relay WS connected${conn.relayId ? ` (${conn.relayId})` : ""}`,
					);
				},
				message(ws, msg) {
					let parsed: unknown;
					try {
						const text =
							typeof msg === "string"
								? msg
								: new TextDecoder().decode(
										// Bun types the binary frame as `Buffer<ArrayBuffer>`
										msg as unknown as ArrayBuffer,
									);
						parsed = JSON.parse(text);
					} catch {
						return; // not JSON — ignore
					}
					if (!isCtrlinkRelayWsMessage(parsed)) {
						console.warn(
							"ctrlink_streamer: ignoring malformed relay WS message",
						);
						return;
					}
					const conn = ws.data;
					if (parsed.type === "hello") {
						conn.relayId = parsed.relay_id;
						conn.proto = parsed.proto;
					}
					// Keepalive (protocol.md §3): answer the relay's ping so
					// both directions carry frames that refresh the registry
					// TTL. The backend still sees the message (onMessage).
					if (parsed.type === "ping") {
						try {
							ws.send(JSON.stringify({ type: "pong" }));
						} catch {
							/* closing */
						}
					}
					opts.onMessage(conn, parsed);
				},
				close(ws) {
					const conn = ws.data;
					liveRelays.delete(ws);
					console.log(
						`ctrlink_streamer: relay WS closed${conn.relayId ? ` (${conn.relayId})` : ""}`,
					);
					opts.onClose?.(conn);
				},
			},
		});
		console.log(
			`ctrlink_streamer: relay WS server listening on 0.0.0.0:${server.port}${opts.token ? " (token auth)" : ""}`,
		);
		return server;
	} catch (e) {
		console.warn(
			`ctrlink_streamer: relay WS server failed to start: ${String(e)}`,
		);
		return null;
	}
}

/**
 * Push a control-channel message to a connected relay (e.g. `encoder_wg_key`).
 * `relayId` undefined = broadcast to every connected relay. Returns the number
 * of relays the frame was handed to (a send failure on a closing socket does
 * not count).
 */
export function sendRelayWsMessage(
	relayId: string | undefined,
	msg: unknown,
): number {
	const text = JSON.stringify(msg);
	let sent = 0;
	for (const ws of liveRelays) {
		const conn = ws.data;
		if (relayId !== undefined && conn.relayId !== relayId) continue;
		try {
			ws.send(text);
			sent++;
		} catch {
			/* socket closing — the next frame / reconnect picks it up */
		}
	}
	return sent;
}
