/*
 * Plain-UDP ↔ TUN IP-pump transport primitive (L3). One independent tunnel per
 * relay uplink, each with its own /30 addressing, so the encoder gets a
 * `utn-<if>` virtual interface that provides full Internet egress through that
 * relay uplink.
 *
 * There is NO crypto and NO kernel module: a tiny static Go binary (`udpip`)
 * owns the TUN data path (it performs `TUNSETIFF` and pumps IP packets both
 * ways over a plain UDP socket). This module only (a) spawns / supervises that
 * child (pid file + log file, respawn on peer/remote change) and (b) programs
 * the kernel around it with `ip` (address / MTU / up, and per-tunnel policy
 * routing + NAT) through the `command.ts` runner seam, so unit tests record
 * the exact argv with no live kernel and an injectable pump spawner.
 *
 * Trust model (per user decision): the link between relay and encoder is
 * trusted, so the tunnel is unauthenticated. The RELAY-side server binds only
 * to the specific uplink IP and pins a SINGLE peer (first datagram's source,
 * or an explicit `--allow <ip>`), which is the only hardening applied.
 *
 * Addressing / routing isolation (mirrors the former WireGuard spec §5,§8,§10):
 *  - each tunnel uses its own /30 (`10.200.<n>.1/30` relay, `.2/30` encoder);
 *  - the RELAY policy-routes tunnel-sourced traffic out the matching physical
 *    uplink + MASQUERADEs it (egress), and never installs a default route via
 *    the `utn-<if>` netdev (no loop, no egress hijack);
 *  - the ENCODER gets a per-source policy table so Internet traffic exits the
 *    tunnel, with an explicit transport-isolation route so the outer tunnel
 *    UDP leaves over the dedicated relay↔encoder link, never via the tunnel it
 *    transports (no tunnel-over-tunnel loop).
 */
import { openSync, writeFileSync, readFileSync, closeSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { execCmd } from "./command";

export const IFACE_NAME_RE = /^[a-zA-Z0-9_.-]{1,15}$/;

/**
 * Deterministic tunnel UDP listen port for uplink `i` (0-based). Shared by
 * relay and encoder so the two sides agree without a negotiation round-trip:
 * the relay binds its `utn-<if>` to this (on the uplink IP) and announces it
 * in `udpPort`; the encoder dials the same. Configure via the base for
 * deployments that avoid 51820+.
 */
export const TUN_LISTEN_PORT_BASE = 51820;
export function tunnelListenPort(uplinkIndex: number): number {
	return TUN_LISTEN_PORT_BASE + uplinkIndex;
}

/** Deterministic per-tunnel routing-table id (101,102,103 for `i`=0,1,2).
 * Relay and encoder derive the same number from the index. */
export function tunnelRouteTable(uplinkIndex: number): number {
	return 101 + uplinkIndex;
}
/** Tunnel MTU: wwan-friendly headroom (the relay carries cellular uplinks). */
export const DEFAULT_TUN_MTU = 1400;

/**
 * Deterministic per-uplink /30 tunnel subnet, shared by relay and encoder so
 * they agree on addresses without a negotiation round-trip. `uplinkIndex` is
 * 0-based, assigned by the relay in a stable order; the relay netdev takes
 * `.1`, the encoder netdev takes `.2`.
 */
export function tunnelAddress(uplinkIndex: number): {
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
export const IPTABLES_BIN = "/usr/sbin/iptables";
export const SYSCTL_BIN = "/usr/sbin/sysctl";
/** The small static Go pump. Deployed by hand (like `client-arm`), not in the
 * repo; `build.sh` next to the source makes it reproducible. */
export const UDPIP_BIN = "/usr/local/bin/udpip";
/** Per-vif pump supervision files. */
export const TUN_PID_FILE = (name: string): string =>
	`/run/ctrlink-${name}.pid`;
export const TUN_LOG_FILE = (name: string): string =>
	`/var/log/ctrlink-${name}.log`;

// ---------------------------------------------------------------------------
// Pure command builders
// ---------------------------------------------------------------------------

/**
 * The `ip` argv that addresses + raises an ALREADY-CREATED tunnel netdev
 * (pure). The netdev is created by the `udpip` pump (it owns the TUN fd), so
 * there is NO `link add` here — only the post-creation config.
 */
export function tunSetupCommands(
	name: string,
	localIp: string,
	prefix: number,
	mtu: number,
): string[][] {
	return [
		["addr", "add", `${localIp}/${prefix}`, "dev", name],
		["link", "set", name, "mtu", String(mtu)],
		["link", "set", name, "up"],
	];
}

/** The `ip` argv that tears a tunnel netdev down (best-effort; the netdev
 * normally vanishes when the pump closes its fd, this orphans-proof it). */
export function tunTeardownCommands(name: string): string[][] {
	return [["link", "del", name]];
}

/** The `udpip` argv for one pump (pure; tests assert the exact shape). */
export function pumpArgs(opts: {
	mode: "server" | "client";
	name: string;
	bind?: string;
	remote?: string;
	allow?: string;
}): string[] {
	const args = [opts.mode, "--tun", opts.name];
	if (opts.mode === "server") {
		args.push("--bind", opts.bind ?? "");
		args.push("--allow", opts.allow ?? "first");
	} else {
		args.push("--remote", opts.remote ?? "");
	}
	return args;
}

// ---------------------------------------------------------------------------
// Pump child supervision (spawn / kill seams)
// ---------------------------------------------------------------------------

export interface TunnelPumpHandle {
	pid: number;
}

export interface PumpOptions {
	name: string;
	mode: "server" | "client";
	bind?: string;
	remote?: string;
	allow?: string;
	logFile: string;
	pidFile: string;
}

export type PumpSpawner = (opts: PumpOptions) => Promise<TunnelPumpHandle>;
export type PumpKiller = (pid: number) => Promise<void>;

interface PumpState {
	pid: number;
	mode: "server" | "client";
	bind?: string;
	remote?: string;
	allow?: string;
}

const pumps = new Map<string, PumpState>();

/**
 * Real spawner: detach-launch `udpip` (it opens the TUN fd and starts
 * pumping), log its stderr to `logFile`, record its pid in `pidFile`, then
 * wait for the netdev to appear so the caller's `ip addr add` succeeds.
 */
async function realPumpSpawner(opts: PumpOptions): Promise<TunnelPumpHandle> {
	const logFd = openSync(opts.logFile, "a", 0o644);
	const child = spawn(UDPIP_BIN, pumpArgs(opts), {
		stdio: ["ignore", logFd, logFd],
		detached: true,
	});
	closeSync(logFd);
	child.unref();
	if (child.pid == null)
		throw new Error(`udpip: no pid for ${opts.name}`);
	try {
		writeFileSync(opts.pidFile, String(child.pid));
	} catch {
		// /run may not be writable before the caller's supervisor; non-fatal.
	}
	// The pump owns netdev creation; block until the netdev exists so the
	// subsequent `ip addr add` (run by the caller) sees it.
	await waitForNetdev(opts.name);
	return { pid: child.pid };
}

/** Poll `ip link show <name>` (real `ip`, not the seam) until the netdev is
 * up, up to ~5 s. Throws if it never appears (a stale peer still holds the
 * name, or the pump exited). */
async function waitForNetdev(name: string): Promise<void> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const pexecFile = promisify(execFile);
	const deadline = Date.now() + 5_000;
	for (;;) {
		try {
			await pexecFile(IP_BIN, ["link", "show", name], {
				encoding: "utf8",
				maxBuffer: 256 * 1024,
			});
			return;
		} catch {
			if (Date.now() > deadline)
				throw new Error(`tun netdev ${name} did not appear (pump exited?)`);
			await new Promise((r) => setTimeout(r, 100));
		}
	}
}

async function realPumpKiller(pid: number): Promise<void> {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Already gone.
	}
}

let pumpSpawner: PumpSpawner = realPumpSpawner;
let pumpKiller: PumpKiller = realPumpKiller;

/**
 * Inject the pump spawner (unit tests return a fixed pid without launching a
 * real `udpip` process). `undefined` restores the real spawner.
 */
export function setPumpSpawner(fn: PumpSpawner | undefined): void {
	pumpSpawner = fn ?? realPumpSpawner;
}

/** Inject the pump killer (unit tests record the pid, no real `kill`). */
export function setPumpKiller(fn: PumpKiller | undefined): void {
	pumpKiller = fn ?? realPumpKiller;
}

/** Currently tracked pump pids, by netdev name (for tests / debugging). */
export function pumpPidForTest(name: string): number | undefined {
	return pumps.get(name)?.pid;
}

// ---------------------------------------------------------------------------
// Tunnel vif lifecycle
// ---------------------------------------------------------------------------

/**
 * Bring up (or refresh) ONE tunnel vif: netdev `name` (e.g. `utn-eth0`),
 * addressed `localIp/prefix`, MTU `mtu`, pumped by a `udpip` child in `mode`.
 *
 * Spawn semantics: idempotent when the desired `{mode, bind, remote, allow}`
 * is unchanged; a peer/remote change kills + respawns the pump. The netdev is
 * created by the pump (it owns the TUN fd); this only addresses + raises it.
 * Returns the netdev name.
 */
export async function setupTunnelVif(opts: {
	name: string;
	localIp: string;
	prefix: number;
	mode: "server" | "client";
	/** server: `<uplinkIP>:<port>`. */
	bind?: string;
	/** client: `<uplinkIP>:<port>`. */
	remote?: string;
	/** server: peer pin (`<clientIP>` or `first`; default `first`). */
	allow?: string;
	mtu?: number;
}): Promise<{ name: string }> {
	if (!IFACE_NAME_RE.test(opts.name))
		throw new Error(`tunnel iface name too long / bad: ${opts.name}`);
	const mtu = opts.mtu ?? DEFAULT_TUN_MTU;

	const existing = pumps.get(opts.name);
	const changed =
		existing &&
		(existing.mode !== opts.mode ||
			existing.bind !== opts.bind ||
			existing.remote !== opts.remote ||
			existing.allow !== opts.allow);
	if (existing && !changed) return { name: opts.name }; // no-op
	if (existing) await killPumpOpt(opts.name);

	const { pid } = await pumpSpawner({
		name: opts.name,
		mode: opts.mode,
		bind: opts.bind,
		remote: opts.remote,
		allow: opts.allow,
		logFile: TUN_LOG_FILE(opts.name),
		pidFile: TUN_PID_FILE(opts.name),
	});
	pumps.set(opts.name, {
		pid,
		mode: opts.mode,
		bind: opts.bind,
		remote: opts.remote,
		allow: opts.allow,
	});

	const runAll = async () => {
		for (const args of tunSetupCommands(opts.name, opts.localIp, opts.prefix, mtu))
			await execCmd(IP_BIN, args);
	};
	try {
		await runAll();
	} catch (first) {
		const msg = first instanceof Error ? first.message : String(first);
		// A lingering address from a previous run — heal it and retry once.
		if (!msg.includes("File exists") && !msg.includes("has been assigned"))
			throw first;
		await execCmd(IP_BIN, [
			"addr",
			"flush",
			`${opts.localIp}/${opts.prefix}`,
			"dev",
			opts.name,
		]).catch(() => {});
		await runAll();
	}
	return { name: opts.name };
}

/** Kill a tracked pump by netdev name (best-effort). */
async function killPumpOpt(name: string): Promise<void> {
	const st = pumps.get(name);
	if (!st) return;
	await pumpKiller(st.pid);
	pumps.delete(name);
}

/** Best-effort teardown of one tunnel: kill the pump, then delete any
 * orphan netdev (ENOENT / ENODEV from a gone netdev is fine). */
export async function removeTunnelVif(name: string): Promise<void> {
	await killPumpOpt(name);
	for (const args of tunTeardownCommands(name)) {
		try {
			await execCmd(IP_BIN, args);
		} catch {
			// Already gone — the netdev is what we wanted to remove.
		}
	}
	try {
		unlinkSync(TUN_PID_FILE(name));
	} catch {
		/* no pid file */
	}
}

/**
 * Recover tracked pump state from on-disk pid files (e.g. after an app restart
 * where a pump survived). `pidFiles` maps netdev name → pid file. Names whose
 * pid file is missing / unreadable are dropped (the caller re-creates the
 * vif). Best-effort; never throws.
 */
export function adoptPumpsFromPidFiles(
	pidFiles: Record<string, string>,
): void {
	for (const [name, file] of Object.entries(pidFiles)) {
		try {
			const pid = Number(readFileSync(file, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0)
				pumps.set(name, { pid, mode: "server", bind: undefined });
		} catch {
			pumps.delete(name);
		}
	}
}

/** Clear the in-memory pump registry (test seam + full teardown). */
export function clearPumpRegistry(): void {
	pumps.clear();
}

// ---------------------------------------------------------------------------
// Relay egress: per-tunnel policy routing + NAT.
//
// Traffic arriving on `utn-<uplink>` (source = the encoder's /30) is
// policy-routed out the matching physical uplink and MASQUERADE'd, so the
// encoder gets Internet egress through that uplink only. Idempotent: each add
// is gated on a cheap existence check so reconcile may run on every pass. The
// relay never installs a default route via the `utn-<if>` netdev (no crypto,
// no peer allowed-ips — it's a plain L3 device), so the outer pump UDP always
// leaves over the dedicated relay↔encoder link (spec §10).
// ---------------------------------------------------------------------------

/** True if `bin args` exits 0 (an existence probe; non-zero ⇒ not present). */
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
		// Non-fatal: forwarding may already be on.
		void e;
	}
}

/**
 * Idempotently apply the relay-side policy routing + NAT for ONE tunnel:
 * `ip rule` (source = encoder /30 → per-tunnel table), `default dev <uplink>`
 * in that table, MASQUERADE on the uplink, and FORWARD rules both ways. Call
 * once per uplink after its `utn-<if>` netdev is up.
 */
export async function ensureTunnelRelayEgress(opts: {
	uplink: string;
	tunName: string;
	/** The encoder's /30 on this tunnel, e.g. `10.200.2.2/30`. */
	encoderSubnet: string;
	routeTable: number;
	rulePriority: number;
}): Promise<void> {
	const { uplink, tunName, encoderSubnet, routeTable, rulePriority } = opts;
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
		tunName,
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
			tunName,
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
		tunName,
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
			tunName,
			"-m",
			"state",
			"--state",
			"RELATED,ESTABLISHED",
			"-j",
			"ACCEPT",
		]);
}

/**
 * Encoder-side per-vif routing (spec §8, §10). The `udpip` pump owns the
 * data path and installs NO routes — we own every route. For vif `utn-<if>`
 * (source = the encoder's /30 `.2`):
 *   1. `ip rule from <localIp> table <t>` — bind this vif's traffic to its table;
 *   2. `ip route add <endpointIp> dev <endpointDev> table <t>` — the explicit
 *      transport-isolation route: the outer pump UDP (source = the vif IP)
 *      leaves over the DEDICATED relay↔encoder link, never via the tunnel it
 *      transports (no tunnel-over-tunnel loop);
 *   3. `ip route add default dev utn-<if> table <t>` — Internet egress via the
 *      tunnel.
 * More-specific routes (1,2) win over the default (3). Idempotent.
 */
export async function ensureTunnelEncoderRouting(opts: {
	tunName: string;
	/** The encoder's tunnel IP, e.g. `10.200.1.2` (the /30 `.2`). */
	localIp: string;
	routeTable: number;
	rulePriority: number;
	/** The relay's outer endpoint on the dedicated link, e.g. `192.168.10.100`. */
	endpointIp: string;
	/** The encoder iface that reaches the endpoint (the ded link, e.g. `eth0`). */
	endpointDev: string;
}): Promise<void> {
	const { tunName, localIp, routeTable, rulePriority, endpointIp, endpointDev } =
		opts;

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
			tunName,
			"table",
			String(routeTable),
		]);
}

/** Best-effort removal of a vif's encoder-side routing table entries. */
export async function revokeTunnelEncoderRouting(opts: {
	localIp: string;
	routeTable: number;
	tunName: string;
	endpointIp: string;
	endpointDev: string;
}): Promise<void> {
	const { localIp, routeTable, tunName, endpointIp, endpointDev } = opts;
	for (const args of [
		["rule", "del", "from", localIp, "table", String(routeTable)],
		["route", "del", `${endpointIp}/32`, "table", String(routeTable)],
		["route", "del", "default", "dev", tunName, "table", String(routeTable)],
	])
		try {
			await execCmd(IP_BIN, args);
		} catch {
			/* already absent */
		}
	void endpointDev;
}

/** Best-effort removal of a tunnel's relay egress (on uplink removal). */
export async function revokeTunnelRelayEgress(opts: {
	uplink: string;
	tunName: string;
	encoderSubnet: string;
	routeTable: number;
}): Promise<void> {
	const { uplink, tunName, encoderSubnet, routeTable } = opts;
	try {
		await execCmd(IP_BIN, [
			"rule",
			"del",
			"from",
			encoderSubnet,
			"table",
			String(routeTable),
		]);
	} catch {
		/* already absent */
	}
	try {
		await execCmd(IP_BIN, ["route", "del", "default", "table", String(routeTable)]);
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
		["-D", "FORWARD", "-i", tunName, "-o", uplink, "-j", "ACCEPT"],
		[
			"-D",
			"FORWARD",
			"-i",
			uplink,
			"-o",
			tunName,
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
