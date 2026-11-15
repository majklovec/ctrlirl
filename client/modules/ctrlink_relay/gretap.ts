/**
 * Relay-side GRETAP: expose a pass-through interface to a discovered encoder
 * through a kernel GRETAP L2 tunnel, per `GRETAP-RESEARCH.md`.
 *
 * The relay already speaks UDP-discovery + a per-encoder WebSocket to the
 * encoder. This module adds the L2 leg: for every advertised pass-through
 * interface `E` (that is not the one the encoder is already on) and every known
 * encoder, it builds a keyed GRETAP tunnel `gretap<E>_<enc>` that encodes
 * toward the relay's **on-path** IP (`outerEndpointFor(enc.ip)`), and bridges
 * `E` into it so the encoder reaches `E`'s whole subnet over the tunnel.
 *
 * Safety (this touches the relay's OWN LAN interfaces):
 *  - **opt-in** behind `ctrlink_relay.gretap` (default false) and never in DRY_RUN;
 *  - **idempotent** — a re-running reconcile reuses / heals existing devices;
 *  - **restorable** — teardown (or disabling) puts every borrowed interface's
 *    address back and un-enslaves it, so the relay keeps its connectivity.
 *
 * The `ip` calls go through `@ctrlirl/gretap-relay` (`setIpRunner` test seam),
 * so unit tests record the argv without a live kernel.
 */
import {
	attachToBridge,
	createGretapTunnel,
	greKeyForEndpoints,
	ifaceWithAddress,
	moveAddrsToBridge,
	outerEndpointFor,
	releaseIfaceFromBridge,
	removeGretap,
	setIpRunner,
} from "@ctrlirl/gretap-relay";

/** One live relay-side GRETAP tunnel (one advertised endpoint × one encoder). */
interface TunnelState {
	/** gretap device suffix (device = `gretap<name>`, bridge = `br-<name>`). */
	name: string;
	/** The pass-through interface bridged in (the one whose subnet is exposed). */
	exposedIface: string;
	/** The exposed iface's addresses moved to the bridge (restored on teardown). */
	exposedAddrs: string[];
}

/** A gretap runner seam (production: the real `ip` via the lib; tests: a spy). */
type GrepRunner = () => Promise<void>;

let reconcileImpl: GrepRunner = () => runIfaceReconcile();

/** Inject the reconcile runner (tests). `undefined` restores the real one. */
export function setGretapReconcileRunner(
	impl: GrepRunner | undefined,
): void {
	reconcileImpl = impl ?? (async () => runIfaceReconcile());
}
/** Expose the `ip` runner to tests (delegates to the lib's `setIpRunner`). */
export function setGretapIpRunner(
	impl: ((args: string[]) => Promise<string>) | undefined,
): void {
	setIpRunner(impl);
}

/** Current tunnel state, keyed `endpointIface \0 encoderId`. */
const tunnels = new Map<string, TunnelState>();

/** The in-flight reconcile, so awaiters join the SAME pass (not a no-op). */
let inFlight: Promise<void> | null = null;

/**
 * Last known per-(exposed iface, encoder-IP) outer IP, filled by the
 * reconcile so the backend can annotate the WS iface list without a route
 * lookup for every hello/event. Key: `iface \0 encoderIp`. A missing entry
 * means "no tunnel planned/known for this pair yet".
 */
const outerCache = new Map<string, string>();

/**
 * Outer IP the encoder on `encoderIp` should address GRETAP outer headers at
 * for a frame on `iface`, as cached by the most recent reconcile. Returns
 * `undefined` when unknown (encoder not announced, or gretap not applied).
 */
export function gretapOuterIpFor(iface: string, encoderIp: string): string {
	return outerCache.get(`${iface}\0${encoderIp}`) ?? "";
}

/**
 * Build a ≤15-char, unique gretap DEVICE name for (exposed iface, encoder id).
 * The name is derived from the RELAY's interface so both ends match:
 * `eno2` → `gretap_eno2` (bridge `br-gretap_eno2`). A second encoder on the
 * same iface disambiguates with its id (e.g. `gretap_eno2_rpi`).
 */
export function tunnelName(
	exposedIface: string,
	encoderId: string,
	taken: Iterable<string>,
): string {
	const slug = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "");
	const base = `gretap_${slug(exposedIface)}`.slice(0, 15);
	if (![...taken].includes(base)) return base;
	return `gretap_${slug(exposedIface)}_${slug(encoderId)}`.slice(0, 15);
}

interface Relayer {
	enabled: boolean;
	dryRun: boolean;
	/** Advertised pass-through endpoints: interface name → its IPv4. */
	endpoints: Array<{ iface: string; ip: string }>;
	/** Encoders to serve (id + the IP we reach them by). */
	encoders: Array<{ id: string; ip: string }>;
}

/**
 * The reconcile body: bring the tunnel set to the desired (endpoints ×
 * encoders) state. Idempotent. All `ip` work is through the lib.
 */
/** Report (never throw) a per-tunnel failure so one bad pair can't abort the pass. */
let reportLog: (msg: string) => void = () => {};
export function setGretapLogger(fn: (msg: string) => void): void {
	reportLog = fn;
}
async function runIfaceReconcile(): Promise<void> {
	const relay = currentRelayer();
	try {
		await reconcilePass(relay);
	} catch (e) {
		// The outer-IP table must never be left mid-rebuild: on an unexpected
		// error treat every (iface, encoder) as "no outer IP" (tunnels down,
		// the UDP path is unaffected) and report instead of throwing.
		outerCache.clear();
		for (const ep of relay.endpoints)
			for (const enc of relay.encoders)
				outerCache.set(`${ep.iface}\0${enc.ip}`, "");
		reportLog(
			`gretap: reconcile pass failed: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
}

async function reconcilePass(relay: Relayer): Promise<void> {
	if (!relay.enabled || relay.dryRun) {
		outerCache.clear();
		await teardownAll();
		return;
	}
	const keys = new Set<string>();
	// Rebuild the per-(iface, encoder) outer-IP table this pass.
	outerCache.clear();
	for (const enc of relay.encoders) {
		const onPath = await outerEndpointFor(enc.ip);
		if (!onPath) {
			// Cannot resolve the on-path IP → the encoder can't be reached → no
			// tunnel (the UDP path is unaffected); advertise no outer IP.
			for (const ep of relay.endpoints)
				outerCache.set(`${ep.iface}\0${enc.ip}`, "");
			continue;
		}
		for (const ep of relay.endpoints) {
			// The interface the encoder ALREADY reaches us on is the direct
			// segment — do not tunnel it (mirrors `directIfaces` on the relay).
			if (ep.iface === onPath.iface) {
				outerCache.set(`${ep.iface}\0${enc.ip}`, "");
				continue;
			}
			outerCache.set(`${ep.iface}\0${enc.ip}`, onPath.ip);
			const key = `${ep.iface}\0${enc.id}`;
			keys.add(key);
			// Collision set excludes THIS tunnel's own current name: once its
			// `gretap_<iface>` device exists it is always in the set and would
			// otherwise force a `_<encId>` suffix every reconcile pass (flap).
			const ownName = tunnels.get(key)?.name;
			const taken = [...tunnels.values()]
				.map((s) => s.name)
				.filter((n) => n !== ownName);
			const name = tunnelName(ep.iface, enc.id, taken);
			const st = tunnels.get(key);
			// Already up AND named as desired — skip. A name change (e.g. the
			// `gretap_<iface>` scheme) falls through and rebuilds.
			if (st && st.exposedIface === ep.iface && st.name === name) continue;
			// (Re)build this tunnel. `createGretapTunnel` heals leftovers. A
			// single pair's failure must not abort the whole pass (the other
			// endpoints + the outer-IP table for them keep working).
			try {
				if (st) await destroyTunnel(st);
				const greKey = greKeyForEndpoints(ep.ip, enc.ip);
				const { bridge } = await createGretapTunnel({
					name,
					encIp: enc.ip,
					relayIp: onPath.ip,
					greKey,
				});
				await attachToBridge(bridge, ep.iface);
				const exposed = await moveAddrsToBridge(ep.iface, bridge);
				tunnels.set(key, { name, exposedIface: ep.iface, exposedAddrs: exposed });
			} catch (e) {
				if (st) tunnels.delete(`${ep.iface}\0${enc.id}`);
				reportLog(
					`gretap: ${ep.iface}↔${enc.id} failed: ${
						e instanceof Error ? e.message : String(e)
					}`,
				);
			}
		}
	}
	// Tear down tunnels whose endpoint/encoder disappeared.
	for (const [key, st] of [...tunnels]) {
		if (!keys.has(key)) await destroyTunnel(st, key);
	}
}

/** Destroy one tunnel + release the borrowed interface. */
async function destroyTunnel(
	st: TunnelState,
	key?: string,
): Promise<void> {
	if (key) tunnels.delete(key);
	try {
		await releaseIfaceFromBridge(
			st.exposedIface,
			`br-${st.name}`,
			st.exposedAddrs,
		);
	} catch {
		/* best-effort — the tunnel delete below still runs */
	}
	try {
		await removeGretap(st.name);
	} catch {
		/* already gone */
	}
}

/** Tear down every tunnel (module stop / gretap disabled). */
async function teardownAll(): Promise<void> {
	for (const [key, st] of [...tunnels]) await destroyTunnel(st, key);
}

/**
 * The desired GRETAP state, as the backend exposes it: the enabled flag, DRY-
 * RUN, the advertised endpoints (non-direct ifaces + addresses) and the known
 * encoders. The backend keeps this callback current.
 */
let relayerSnapshot: () => Relayer = (): Relayer => ({
	enabled: false,
	dryRun: true,
	endpoints: [],
	encoders: [],
});

/** The backend installs how to read the relay's current desired state. */
export function setGretapRelayer(snap: () => Relayer): void {
	relayerSnapshot = snap;
}
function currentRelayer(): Relayer {
	return relayerSnapshot();
}

/**
 * Coalesced reconcile entry point (safe to call from network changes,
 * encoder (dis)appearance, config toggles, and startup). Returns the pass's
 * promise so a caller can `await` it (e.g. the relay before a first hello),
 * joining an in-flight pass instead of running a second one.
 */
export function reconcileGretaps(): Promise<void> {
	if (inFlight) return inFlight;
	inFlight = (async () => {
		try {
			await reconcileImpl();
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/** Stop all tunnels and reset bookkeeping (module stop / disable). */
export async function stopGretaps(): Promise<void> {
	await teardownAll();
}

/** For tests + diagnostics: the live tunnel set. */
export function gretapTunnelsForTest(): Array<TunnelState & { key: string }> {
	return [...tunnels.entries()].map(([key, st]) => ({ ...st, key }));
}

/** For tests: reset module state. */
export function resetGretapTestState(): void {
	tunnels.clear();
	outerCache.clear();
	inFlight = null;
}

export type { Relayer as GretapRelayer };
