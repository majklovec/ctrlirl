/*
 * WireGuard transport primitive (L3): one independent WireGuard tunnel per
 * relay uplink, each with its own /30 addressing, so the encoder gets a
 * `wg-<if>` virtual interface that provides full Internet egress through that
 * relay uplink.
 *
 * There is NO userspace packet path — the kernel WireGuard module owns the
 * data path. This module only programs the kernel (`ip` for the netdev +
 * address, `wg` for the peer, `modprobe` for the module) through the
 * `command.ts` runner seam, so unit tests record the exact argv with no live
 * kernel.
 *
 * Addressing / routing isolation (spec TODO/wireguard.md §5, §8, §10):
 *  - each tunnel uses its own /30 (`10.200.<n>.1/30` relay, `.2/30` encoder);
 *  - the RELAY peer's AllowedIPs is ONLY the tunnel /30 — never 0.0.0.0/0 —
 *    so the relay installs no default route via the WG device (no loop, no
 *    egress hijack); Internet egress is done by relay policy-routing + NAT
 *    (client/modules/ctrlink_relay), not by the WG route;
 *  - the ENCODER peer's AllowedIPs is 0.0.0.0/0 so Internet traffic routes
 *    out the tunnel; per-source policy tables (network/routing.ts) pick WHICH
 *    tunnel a given source uses, avoiding conflicting global defaults.
 *  - outer UDP always leaves over the dedicated relay↔encoder link (a
 *    separate L2 segment), never through the tunnel it transports.
 */
import { access } from "node:fs/promises";
import { execCmd } from "./command";

export const IFACE_NAME_RE = /^[a-zA-Z0-9_.-]{1,15}$/;

/**
 * Deterministic WG UDP listen port for uplink `i` (0-based). Shared by relay
 * and encoder so the two sides agree without a negotiation round-trip: the
 * relay sets its `wg-<if>` netdev to this and announces it in `udpPort`; the
 * encoder sets the matching netdev to the same and reports it in
 * `encoder_wg_key`. Configurable via the base for deployments that avoid
 * 51820+.
 */
export const WG_LISTEN_PORT_BASE = 51820;
export function wgListenPort(uplinkIndex: number): number {
	return WG_LISTEN_PORT_BASE + uplinkIndex;
}

/** Deterministic per-tunnel routing-table id (spec §8: 101,102,103 for
 * `i`=0,1,2). Relay and encoder derive the same number from the index. */
export function wgRouteTable(uplinkIndex: number): number {
	return 101 + uplinkIndex;
}
/** Tunnel MTU: cellular-friendly (spec §16); 24+ bytes of WG+IP overhead. */
export const DEFAULT_WG_MTU = 1360;
/** Persistent keepalive (seconds) so cellular NAT tables don't drop the peer
 * during brief signal dips (spec §16). */
export const DEFAULT_WG_KEEPALIVE_SEC = 25;

/**
 * Deterministic per-uplink /30 tunnel subnet (spec §5), shared by relay and
 * encoder so they agree on addresses without a negotiation round-trip.
 * `uplinkIndex` is 0-based, assigned by the relay in a stable order; the
 * relay's announce payload carries each iface's index and the encoder uses the
 * same number. The relay netdev takes `.1`, the encoder netdev takes `.2`.
 */
export function wireGuardTunnelAddress(uplinkIndex: number): {
	relayIp: string;
	encoderIp: string;
	subnet: string;
} {
	const n = 1 + uplinkIndex;
	return {
		relayIp: `10.200.${n}.1`,
		encoderIp: `10.200.${n}.2`,
		subnet: `10.200.${n}.1/30`,
	};
}

/** Binaries (absolute paths). */
const IP_BIN = "/usr/sbin/ip";
const WG_BIN = "/usr/bin/wg";
const MODPROBE_BIN = "/sbin/modprobe";

/** The `ip` argv that creates + addresses + raises one side (pure). */
export function wireGuardSetupCommands(
	name: string,
	localIp: string,
	prefix: number,
	mtu: number,
): string[][] {
	return [
		["link", "add", name, "type", "wireguard"],
		["addr", "add", `${localIp}/${prefix}`, "dev", name],
		["link", "set", name, "mtu", String(mtu)],
		["link", "set", name, "up"],
	];
}

/**
 * The `wg set … peer` argv for one peer (pure). `allowedIps` is a comma-joined
 * CIDR list (the side decides it — see the file header). `keepAliveSec` is
 * normally set on the encoder side (the non-initiator) to keep the NAT pin
 * alive; the relay side may omit it. `endpoint` is the peer's on-path outer
 * IP on the dedicated link.
 */
export function wireGuardPeerCommand(
	name: string,
	peerKey: string,
	endpoint: string,
	allowedIps: string,
	keepAliveSec = 0,
): string[] {
	const args = [
		"set",
		name,
		"peer",
		peerKey,
		"endpoint",
		endpoint,
		"allowed-ips",
		allowedIps,
	];
	if (keepAliveSec > 0) args.push("persistent-keepalive", String(keepAliveSec));
	return args;
}

/** The `ip` argv that tears one side down (pure; reverse/irrelevant order). */
export function wireGuardTeardownCommands(name: string): string[][] {
	return [["link", "del", name]];
}

/**
 * The `wg set … listen-port` argv (pure). Each per-uplink netdev owns one
 * listen port so the encoder dials the right tunnel (the relay's high-water-
 * mark port allocator hands out distinct ports).
 */
export function wireGuardListenPortCommand(
	name: string,
	port: number,
): string[] {
	return ["set", name, "listen-port", String(port)];
}

/** Set the netdev's listen port (`wg set <name> listen-port <port>`). */
export async function setWireGuardListenPort(
	name: string,
	port: number,
): Promise<void> {
	await execCmd(WG_BIN, wireGuardListenPortCommand(name, port));
}

/**
 * Ensure the kernel WireGuard module is loaded. No-op when
 * `/sys/module/wireguard` already exists; otherwise `modprobe wireguard`.
 * Best-effort callers catch failures (the tunnel then reports degraded).
 */
export async function ensureWireGuardModule(): Promise<void> {
	try {
		// A present module dir means it is loaded — skip the privileged call.
		const { access } = await import("node:fs/promises");
		await access("/sys/module/wireguard");
		return;
	} catch {
		// Not loaded — fall through to modprobe.
	}
	await execCmd(MODPROBE_BIN, ["wireguard"]);
}

/**
 * Bring up ONE side of a WireGuard tunnel: netdev `name` (e.g. `wg-eth0`),
 * addressed `localIp/prefix`, MTU `mtu`, with a single peer. Idempotent-ish:
 * a `File exists` from a leftover netdev is healed by tearing down and
 * retrying once.
 *
 * Returns the netdev name. Callers add/remove further peers with
 * `addWireGuardPeer` / `removeWireGuardPeer`.
 */
export async function setupWireGuardInterface(opts: {
	name: string;
	localIp: string;
	prefix: number;
	/** Peer is optional: the relay creates the netdev first, then adds one peer
	 * per encoder as they announce their WireGuard public key. */
	peerKey?: string;
	endpoint?: string;
	allowedIps?: string;
	mtu?: number;
	keepAliveSec?: number;
	/** The netdev's WG UDP listen port (per-uplink; from the relay allocator). */
	listenPort?: number;
}): Promise<{ name: string }> {
	if (!IFACE_NAME_RE.test(opts.name))
		throw new Error(`wireguard iface name too long / bad: ${opts.name}`);
	const mtu = opts.mtu ?? DEFAULT_WG_MTU;
	const keepAliveSec = opts.keepAliveSec ?? DEFAULT_WG_KEEPALIVE_SEC;

	const runAll = async () => {
		for (const args of wireGuardSetupCommands(opts.name, opts.localIp, opts.prefix, mtu))
			await execCmd(IP_BIN, args);
		if (opts.listenPort !== undefined)
			await execCmd(WG_BIN, wireGuardListenPortCommand(opts.name, opts.listenPort));
		if (opts.peerKey && opts.endpoint && opts.allowedIps)
			await execCmd(WG_BIN, wireGuardPeerCommand(opts.name, opts.peerKey, opts.endpoint, opts.allowedIps, keepAliveSec));
	};
	try {
		await runAll();
	} catch (first) {
		const msg = first instanceof Error ? first.message : String(first);
		if (!msg.includes("File exists") && !msg.includes("ENODEV"))
			throw first;
		// Leftover from a previous run — heal and retry once.
		await removeWireGuard(opts.name);
		await runAll();
	}
	return { name: opts.name };
}

/**
 * Add (or replace) a peer on an existing WireGuard netdev (`wg set … peer`).
 * Used when the peer's key/endpoint changes without rebuilding the netdev
 * (spec §7: a dynamic uplink IP must not rebuild unrelated tunnels).
 */
export async function addWireGuardPeer(opts: {
	name: string;
	peerKey: string;
	endpoint: string;
	allowedIps: string;
	keepAliveSec?: number;
}): Promise<void> {
	await execCmd(
		WG_BIN,
		wireGuardPeerCommand(
			opts.name,
			opts.peerKey,
			opts.endpoint,
			opts.allowedIps,
			opts.keepAliveSec ?? 0,
		),
	);
}

/** Remove a single peer from the netdev (`wg set <name> peer … remove`). */
export async function removeWireGuardPeer(
	name: string,
	peerKey: string,
): Promise<void> {
	try {
		await execCmd(WG_BIN, ["set", name, "peer", peerKey, "remove"]);
	} catch {
		// Peer wasn't present — fine (idempotent teardown).
	}
}

/** Best-effort teardown of one side (ENOENT / ENODEV from a gone netdev is OK). */
export async function removeWireGuard(name: string): Promise<void> {
	for (const args of wireGuardTeardownCommands(name)) {
		try {
			await execCmd(IP_BIN, args);
		} catch {
			// Already gone — the netdev is what we wanted to remove.
		}
	}
}

/**
 * Generate a WireGuard keypair by shelling out to `wg`. Returns the PRIVATE
 * key (the caller must persist it) and the derived PUBLIC key (the one shared
 * over the control plane).
 */
// ---------------------------------------------------------------------------
// Relay egress: per-tunnel policy routing + NAT (spec §6, §9, §10).
//
// Traffic arriving on `wg-<uplink>` (source = the encoder's /30) is policy-
// routed out the matching physical uplink and MASQUERADE'D, so the encoder
// gets Internet egress through that uplink only. Idempotent: each add is
// gated on a cheap existence check so reconcile may run on every pass.
// The relay never installs a default route via the WG netdev (peer allowed-
// ips are only the /30), so the outer WG UDP always leaves over the direct
// relay↔encoder link — transport and egress paths stay separate (spec §10).
// ---------------------------------------------------------------------------

export const IPTABLES_BIN = "/usr/sbin/iptables";
export const SYSCTL_BIN = "/usr/sbin/sysctl";

/** True if `bin args` exits 0 (used as an existence probe; a throwing / non-
 * zero exit means "not present"). */
async function cmdSucceeds(bin: string, args: string[]): Promise<boolean> {
	try {
		await execCmd(bin, args);
		return true;
	} catch {
		return false;
	}
}

/** Enable IPv4 forwarding once (best-effort; harmless if already on). */
export async function ensureIpForward(): Promise<void> {
	try {
		await execCmd(SYSCTL_BIN, ["-w", "net.ipv4.ip_forward=1"]);
	} catch (e) {
		// Non-fatal: forwarding may already be on; relay egress will surface
		// any real failure through the ping/test path.
		void e;
	}
}

/**
 * Idempotently apply the relay-side policy routing + NAT for ONE tunnel:
 * `ip rule` (source = encoder /30 → per-tunnel table), `default dev <uplink>`
 * in that table, MASQUERADE on the uplink, and FORWARD rules in both
 * directions. Call once per uplink after its `wg-<if>` netdev is up.
 */
export async function ensureWireGuardRelayEgress(opts: {
	uplink: string;
	wgName: string;
	/** The encoder's /30 on this tunnel, e.g. `10.200.2.2/30`. */
	encoderSubnet: string;
	routeTable: number;
	rulePriority: number;
}): Promise<void> {
	const { uplink, wgName, encoderSubnet, routeTable, rulePriority } = opts;
	await ensureIpForward();

	// 1. ip rule: source from the encoder /30 → per-tunnel table.
	const ruleShown = await execCmd(IP_BIN, ["rule", "show"]).catch(() => "");
	if (!ruleShown.includes(`from ${encoderSubnet}`))
		await execCmd(IP_BIN, [
			"rule",
			"add",
			"from",
			encoderSubnet,
			"table",
			String(routeTable),
			"priority",
			String(rulePriority),
		]);

	// 2. route in the per-tunnel table: default out the physical uplink.
	const routeShown = await execCmd(IP_BIN, [
		"route",
		"show",
		"table",
		String(routeTable),
	]).catch(() => "");
	if (!routeShown.includes("default"))
		await execCmd(IP_BIN, [
			"route",
			"add",
			"default",
			"dev",
			uplink,
			"table",
			String(routeTable),
		]);

	// 3. NAT: MASQUERADE tunnel-sourced traffic leaving the physical uplink.
	const natOk = await cmdSucceeds(IPTABLES_BIN, [
		"-t",
		"nat",
		"-C",
		"POSTROUTING",
		"-s",
		encoderSubnet,
		"-o",
		uplink,
		"-j",
		"MASQUERADE",
	]);
	if (!natOk)
		await execCmd(IPTABLES_BIN, [
			"-t",
			"nat",
			"-A",
			"POSTROUTING",
			"-s",
			encoderSubnet,
			"-o",
			uplink,
			"-j",
			"MASQUERADE",
		]);

	// 4. FORWARD: tunnel → uplink (new), and uplink → tunnel (return only).
	const fwdOk = await cmdSucceeds(IPTABLES_BIN, [
		"-C",
		"FORWARD",
		"-i",
		wgName,
		"-o",
		uplink,
		"-j",
		"ACCEPT",
	]);
	if (!fwdOk)
		await execCmd(IPTABLES_BIN, [
			"-A",
			"FORWARD",
			"-i",
			wgName,
			"-o",
			uplink,
			"-j",
			"ACCEPT",
		]);

	const retOk = await cmdSucceeds(IPTABLES_BIN, [
		"-C",
		"FORWARD",
		"-i",
		uplink,
		"-o",
		wgName,
		"-m",
		"state",
		"--state",
		"RELATED,ESTABLISHED",
		"-j",
		"ACCEPT",
	]);
	if (!retOk)
		await execCmd(IPTABLES_BIN, [
			"-A",
			"FORWARD",
			"-i",
			uplink,
			"-o",
			wgName,
			"-m",
			"state",
			"--state",
			"RELATED,ESTABLISHED",
			"-j",
			"ACCEPT",
		]);
}

/**
 * Encoder-side per-vif routing (spec §8, §10). WireGuard peer programming is
 * done with `wg set` (NOT wg-quick), so WG installs NO routes — we own every
 * route. For vif `wg-<if>` (source = the encoder's /30 `.2`):
 *   1. `ip rule from <localIp> table <t>` — bind this vif's traffic to its table;
 *   2. `ip route add <endpointIp> dev <endpointDev> table <t>` — the explicit
 *      transport-isolation route: the outer WG UDP (source = the vif IP, so
 *      it matches the rule) leaves over the DEDICATED relay↔encoder link,
 *      never via the tunnel it transports (no WG-over-WG loop);
 *   3. `ip route add default dev wg-<if> table <t>` — Internet egress via the
 *      tunnel.
 * More-specific routes (1,2) win over the default (3). Idempotent.
 */
export async function ensureWireGuardEncoderRouting(opts: {
	wgName: string;
	/** The encoder's tunnel IP, e.g. `10.200.1.2` (the /30 `.2`). */
	localIp: string;
	routeTable: number;
	rulePriority: number;
	/** The relay's outer endpoint on the dedicated link, e.g. `192.168.10.100`. */
	endpointIp: string;
	/** The encoder iface that reaches the endpoint (the ded link, e.g. `eth0`). */
	endpointDev: string;
}): Promise<void> {
	const { wgName, localIp, routeTable, rulePriority, endpointIp, endpointDev } = opts;

	const ruleShown = await execCmd(IP_BIN, ["rule", "show"]).catch(() => "");
	if (!ruleShown.includes(`from ${localIp}`))
		await execCmd(IP_BIN, [
			"rule",
			"add",
			"from",
			localIp,
			"table",
			String(routeTable),
			"priority",
			String(rulePriority),
		]);

	const routeShown = await execCmd(IP_BIN, [
		"route",
		"show",
		"table",
		String(routeTable),
	]).catch(() => "");

	// Isolation: outer endpoint over the ded link (must precede the default).
	if (!routeShown.includes(endpointIp))
		await execCmd(IP_BIN, [
			"route",
			"add",
			`${endpointIp}/32`,
			"dev",
			endpointDev,
			"table",
			String(routeTable),
		]);
	// Internet through the tunnel.
	if (!routeShown.includes("default"))
		await execCmd(IP_BIN, [
			"route",
			"add",
			"default",
			"dev",
			wgName,
			"table",
			String(routeTable),
		]);
}

/** Best-effort removal of a vif's encoder-side routing table entries. */
export async function revokeWireGuardEncoderRouting(opts: {
	localIp: string;
	routeTable: number;
	wgName: string;
	endpointIp: string;
	endpointDev: string;
}): Promise<void> {
	const { localIp, routeTable, wgName, endpointIp, endpointDev } = opts;
	for (const args of [
		["rule", "del", "from", localIp, "table", String(routeTable)],
		["route", "del", `${endpointIp}/32`, "table", String(routeTable)],
		["route", "del", "default", "dev", wgName, "table", String(routeTable)],
	])
		try {
			await execCmd(IP_BIN, args);
		} catch {
			/* already absent */
		}
	void endpointDev;
}

/** Best-effort removal of a tunnel's relay egress (on uplink removal). */
export async function revokeWireGuardRelayEgress(opts: {
	uplink: string;
	wgName: string;
	encoderSubnet: string;
	routeTable: number;
}): Promise<void> {
	const { uplink, wgName, encoderSubnet, routeTable } = opts;
	const delRule = ["rule", "del", "from", encoderSubnet, "table", String(routeTable)];
	try {
		await execCmd(IP_BIN, delRule);
	} catch {
		/* already absent */
	}
	try {
		await execCmd(IP_BIN, [
			"route",
			"del",
			"default",
			"table",
			String(routeTable),
		]);
	} catch {
		/* already absent */
	}
	try {
		await execCmd(IPTABLES_BIN, [
			"-t",
			"nat",
			"-D",
			"POSTROUTING",
			"-s",
			encoderSubnet,
			"-o",
			uplink,
			"-j",
			"MASQUERADE",
		]);
	} catch {
		/* already absent */
	}
	for (const args of [
		["-D", "FORWARD", "-i", wgName, "-o", uplink, "-j", "ACCEPT"],
		[
			"-D",
			"FORWARD",
			"-i",
			uplink,
			"-o",
			wgName,
			"-m",
			"state",
			"--state",
			"RELATED,ESTABLISHED",
			"-j",
			"ACCEPT",
		],
	])
		try {
			await execCmd(IPTABLES_BIN, args);
		} catch {
			/* already absent */
		}
}

/** A WireGuard key pair (base64 private + derived public key). */
export interface WireGuardKeyPair {
	privateKey: string;
	publicKey: string;
}

type KeyGenFn = () => Promise<WireGuardKeyPair>;

/** Real key generation: `wg genkey` → private key, `wg pubkey` → public. */
async function realKeyGen(): Promise<WireGuardKeyPair> {
	// `wg genkey` → private key (32 raw bytes, base64). `wg pubkey` derives the
	// public key from the private one fed on stdin.
	const { spawn } = await import("node:child_process");
	const run = (
		args: string[],
		stdin?: string,
	): Promise<string> =>
		new Promise((resolve, reject) => {
			const child = spawn(WG_BIN, args);
			let out = "";
			child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
			child.on("error", reject);
			child.on("close", (code) =>
				code === 0
					? resolve(out)
					: reject(new Error(`wg ${args[0]} exited ${code}`)),
			);
			child.stdin.on("error", () => {});
			if (stdin != null) child.stdin.write(stdin);
			child.stdin.end();
		});
	const priv = (await run(["genkey"])).trim();
	const pub = (await run(["pubkey"], priv)).trim();
	return { privateKey: priv, publicKey: pub };
}

let keyGenFn: KeyGenFn = realKeyGen;

/**
 * Inject a key generator (unit tests return a fixed pair without shelling out
 * to `wg`, which may be absent). `undefined` restores the real `wg` runner.
 */
export function setKeyGen(fn: KeyGenFn | undefined): void {
	keyGenFn = fn ?? realKeyGen;
}

/** Generate a WireGuard key pair (through the injectable seam). */
export async function generateWireGuardKeyPair(): Promise<WireGuardKeyPair> {
	return keyGenFn();
}
