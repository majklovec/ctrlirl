/*
 * Encoder-side plain-UDP↔TUN multi-uplink vifs. For each relay-announced
 * uplink carrying a `tunnel` spec, the encoder builds ONE `rltun<R>_<if>` TUN
 * (`R` = the relay's stable 0-based index on this encoder, so two relays
 * exposing the same uplink name can't clash) backed by `createVirtualInterface`
 * (TUN + a UDP datagram socket that dials the relay and forwards IP packets),
 * plus per-vif policy routing so the vif egresses deterministically:
 *   - a source route (`from <localIp> lookup <t>` + `default dev <tun>`) via
 *     `applyVifSourceRoute`, and
 *   - an explicit transport-isolation route (`<endpoint>/32 dev <transportDev>
 *     table <t>`) so the OUTER tunnel UDP always leaves over the dedicated
 *     relay↔encoder link, never via the vif.
 *
 * On-link filter: an uplink whose name already exists as one of the encoder's
 * OWN interfaces is ignored — the encoder reaches that subnet directly and
 * doesn't tunnel it.
 *
 * No crypto, no key exchange — the relay pins this encoder as a single peer on
 * its side. Kernel `ip` work is a `CommandRunner` (tests inject a no-op); the
 * TUN/socket is a `vifFactory` seam (tests inject a mock).
 */
import { execFile } from "node:child_process";
import {
	applyVifSourceRoute,
	createVirtualInterface,
	removeVifSourceRoute,
	vifSourceTable,
} from "@ctrlirl/udp-relay";
import type {
	CommandRunner,
	VirtualInterface,
	VirtualInterfaceOptions,
} from "@ctrlirl/udp-relay";
import type { CtrlinkTunnelSpec } from "../../../shared/ctrlink_discovery";

export interface EncoderTunnelOffer {
	relayId: string;
	/** The relay's stable 0-based index on this encoder — names the vif
	 * `rltun<index>_<if>` so two relays exposing the same uplink name can't clash. */
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
	table: number;
	/** The relay endpoint this vif dials (the transport-isolation target). */
	endpoint: string;
	/** The relay's per-uplink UDP port this vif dials (`spec.udpPort`). */
	port: number;
	vif: VirtualInterface;
}

/** The `rltun<relayIndex>_<uplink>` netdev name for one (relay, uplink) pair. */
export function encoderVifName(relayIndex: number, uplink: string): string {
	return `rltun${relayIndex}_${uplink}`;
}

const vifs = new Map<string, EncoderVif>();
let configured = false;
/** The encoder's iface that reaches the relay on the dedicated link (e.g.
 * `eth0`) — the destination of the transport-isolation route. */
let transportDev = "eth0";
let inFlight = false;

/** The relay's per-uplink tunnel listen port (the vif's target display value;
 * the live socket binds an ephemeral port). Kept for continuity with the
 * `/30` slot addressing the relay uses. */
const TUNNEL_LISTEN_BASE = 51820;

/** Test seam: TUN/socket factory (default `createVirtualInterface`). */
let vifFactory: (opts: VirtualInterfaceOptions) => Promise<VirtualInterface> =
	createVirtualInterface;
/** Test seam: `ip`/`iptables` runner (default a real `execFile` adapter). */
let commandRunner: CommandRunner = defaultRunner;

/** Production `ip` runner: spawn via `execFile`, never throw (the lib checks
 * `exitCode`; a missing/failed binary just reports a non-zero code). */
function defaultRunner(
	cmd: string,
	...args: string[]
): Promise<{ stdout: string; exitCode: number }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { encoding: "utf8" }, (err, stdout, stderr) => {
			resolve({
				stdout: `${stdout ?? ""}${stderr ?? ""}`,
				exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
			});
		});
	});
}

export function setVifFactory(
	f: ((opts: VirtualInterfaceOptions) => Promise<VirtualInterface>) | null,
): void {
	vifFactory = f ?? createVirtualInterface;
}

export function setVifCommandRunner(r: CommandRunner | null): void {
	commandRunner = r ?? defaultRunner;
}

/** Arm the module (bind / start). Idempotent. */
export function configureEncoderTunnels(cfg: {
	enabled: boolean;
	transportDev?: string;
	/** The `ip`/`iptables` runner (defaults to a real `execFile` adapter). */
	commandRunner?: CommandRunner;
}): void {
	configured = cfg.enabled;
	if (cfg.transportDev) transportDev = cfg.transportDev;
	if (cfg.commandRunner) commandRunner = cfg.commandRunner;
}

/**
 * Reconcile the encoder's `rltun<R>_<if>` vifs toward the offered set.
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
		// derived from the relay's `rtltun-<if>` spec name; the ENCODER's own
		// netdev is renamed `rltun<relayIndex>_<if>` (below) so two relays
		// that both expose `eth0` never produce a clashing name.
		const desired = new Map<
			string,
			{
				spec: CtrlinkTunnelSpec;
				relayId: string;
				relayIndex: number;
			}
		>();
		for (const { spec, relayId, relayIndex } of offers) {
			const uplink = spec.virtualInterface.replace(/^rtltun-/, "");
			if (ownIfaces.has(uplink)) continue; // on-link: don't tunnel it
			if (!desired.has(uplink))
				desired.set(uplink, { spec, relayId, relayIndex });
		}

		// Remove vifs no longer offered.
		for (const uplink of [...vifs.keys()])
			if (!desired.has(uplink)) await teardownVif(uplink);

		// Build / refresh. Existing vifs are kept, EXCEPT when their relay
		// endpoint, dial port, or vif address drifted: the relay re-allocates
		// its per-uplink ports on restart, so a vif left "as-is" would keep
		// dialing the old (now-dead) port and never reach the relay.
		for (const [uplink, d] of desired) {
			const existing = vifs.get(uplink);
			if (
				existing &&
				existing.port === d.spec.udpPort &&
				existing.endpoint === d.spec.endpoint &&
				existing.localIp === d.spec.peerAddr
			)
				continue;
			await teardownVif(uplink);
			await ensureVif(uplink, d.spec, d.relayId, d.relayIndex);
		}
	} catch (e) {
		console.warn(`ctrlink_streamer udpip: reconcile failed: ${String(e)}`);
	} finally {
		inFlight = false;
	}
}

/**
 * The source IP the host uses to reach `endpoint` (`ip route get` → `src X`).
 * The vif's outer-UDP socket MUST bind to a routable transport address (this),
 * not the private `10.200.x.2` vif IP: if it bound to the vif IP, the relay
 * would have no route back to it and replies (keepalives + data) would vanish.
 */
async function transportSourceIp(endpoint: string): Promise<string | undefined> {
	try {
		const { stdout } = await commandRunner("ip", "route", "get", endpoint);
		const m = stdout.match(/\bsrc (\d+\.\d+\.\d+\.\d+)/);
		return m?.[1];
	} catch {
		return undefined;
	}
}

async function ensureVif(
	uplink: string,
	spec: CtrlinkTunnelSpec,
	relayId: string,
	relayIndex: number,
): Promise<void> {
	// The relay's spec name is `rtltun-<if>`; the encoder's netdev is named
	// `rltun<relayIndex>_<if>` so a second relay exposing the same uplink name
	// (e.g. `eth0`) can't collide with the first.
	const name = encoderVifName(relayIndex, uplink);
	const table = vifSourceTable(spec.uplinkIndex);
	const listenPort = TUNNEL_LISTEN_BASE + spec.uplinkIndex;

	// The vif TUN + datagram socket (dials the relay, keeps the peer alive).
	// `bindAddress` pins the outer socket to the transport source IP so the
	// relay can route replies back (see `transportSourceIp`).
	const vif = await vifFactory({
		name,
		localIp: spec.peerAddr,
		prefixLength: spec.prefix,
		relay: { host: spec.endpoint, port: spec.udpPort },
		bindAddress: await transportSourceIp(spec.endpoint),
		mtu: spec.mtu ?? 1400,
	});
	await vif.start();

	// Per-vif source route (+ the outer-UDP transport-isolation route).
	await applyVifSourceRoute(commandRunner, { name, vifIp: spec.peerAddr, table });
	await commandRunner(
		"ip",
		"route",
		"replace",
		`${spec.endpoint}/32`,
		"dev",
		transportDev,
		"table",
		String(table),
	);

	vifs.set(uplink, {
		relayId,
		name,
		uplink,
		index: spec.uplinkIndex,
		localIp: spec.peerAddr,
		listenPort,
		table,
		endpoint: spec.endpoint,
		port: spec.udpPort,
		vif,
	});
	console.log(
		`ctrlink_streamer udpip: ${name} up (${spec.peerAddr}) → relay ${spec.endpoint}:${spec.udpPort}`,
	);
}

async function teardownVif(uplink: string): Promise<void> {
	const v = vifs.get(uplink);
	if (!v) return;
	vifs.delete(uplink);
	try {
		await v.vif.stop();
	} catch {
		// best effort: the socket may already be closed.
	}
	// Routing is best effort (a half-provisioned vif is normal to tear down).
	try {
		await commandRunner(
			"ip",
			"route",
			"del",
			`${v.endpoint}/32`,
			"table",
			String(v.table),
		);
	} catch {
		/* ignore */
	}
	try {
		await removeVifSourceRoute(commandRunner, {
			name: v.name,
			vifIp: v.localIp,
			table: v.table,
		});
	} catch {
		/* ignore */
	}
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

/** Test reset: clear the reconcile state (vifs / config / in-flight guard).
 * The injectable seams (`vifFactory` / `commandRunner`) are left alone — the
 * test's `afterEach` owns clearing them, and a reset that clobbered them would
 * undo a factory the test injected in `setup`. */
export function resetEncoderTunnelTestState(): void {
	vifs.clear();
	configured = false;
	transportDev = "eth0";
	inFlight = false;
}
