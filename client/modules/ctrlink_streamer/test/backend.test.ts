import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModuleCore } from "../../../../client/backend/module_core";
import {
	clearCapabilities,
	provideCapability,
} from "../../../../shared/capabilities";
import type {
	CtrlinkRegistry,
	UplinkEntry,
	Uplinks,
} from "../../../../shared/contracts/module_capabilities";
import type {
	CtrlinkDiscoveredRelay,
	CtrlinkRelayIface,
	CtrlinkTunnelSpec,
	CtrlinkSharedEndpoint,
} from "../../../../shared/ctrlink_discovery";
import {
	setCmdRunner,
	setPumpSpawner,
	setPumpKiller,
} from "@ctrlirl/udpip";
import * as mod from "../backend";
import {
	encoderTunnelStateForTest,
	resetEncoderTunnelTestState,
} from "../udpip";
import {
	knownRelays,
	noteMdnsRelay,
	noteRelay,
	sweepStaleRelays,
} from "../discovery";
import type { CtrlinkStreamerView } from "../types";

/** A fake uplinks capability that records add/remove and a live list. */
function fakeUplinks() {
	const added: UplinkEntry[] = [];
	const removed: string[] = [];
	let failAdd = false;
	return {
		added,
		removed,
		setFailAdd: (b: boolean) => {
			failAdd = b;
		},
		file: () => "/tmp/uplinks.txt",
		ensure: async () => {},
		onChanged: () => () => {},
		add: async (e: UplinkEntry) => {
			if (failAdd) throw new Error("uplink add rejected");
			const i = added.findIndex((x) => x.id === e.id);
			if (i >= 0) added[i] = e;
			else added.push(e);
		},
		remove: async (id: string) => {
			removed.push(id);
			const i = added.findIndex((x) => x.id === id);
			if (i >= 0) added.splice(i, 1);
		},
		list: () => [...added],
	};
}

/** A fake CtrLink relays registry (surfaced on the network card). */
function fakeCtrlinkRegistry() {
	const relays = new Map<string, CapRelay>();
	return {
		relays,
		upsertRelay: (r: CapRelay) => {
			relays.set(r.host, r);
		},
		dropRelay: (host: string) => {
			relays.delete(host);
		},
		listRelays: () => [...relays.values()],
	};
}
type CapRelay = Parameters<CtrlinkRegistry["upsertRelay"]>[0];

/** `section` is the content of `state.data.ctrlinkStreamer`. */
function fakeCore(section: Record<string, unknown> | null = null): ModuleCore {
	return {
		state: { data: section ? { ctrlinkStreamer: section } : {} },
		saveState: async () => {},
		config: { argv: [], DRY_RUN: true, LOG_FILE: "/tmp/x", ROLE: "encoder" },
		notifyStateChange: () => {},
		cancelAutostart: () => {},
		logEvent: () => {},
	} as unknown as ModuleCore;
}

const up = () => mod.default as NonNullable<typeof mod.default>;

/** Build a discovered relay (as a relay would announce it / control server). */
function relay(
	host: string,
	ifaces: Array<[name: string, address: string, port: number]>,
): CtrlinkDiscoveredRelay {
	const interfaces: CtrlinkSharedEndpoint[] = ifaces.map(
		([name, address, listenPort]) => ({
			name,
			address,
			listenPort,
		}),
	);
	return { host, hostname: host, interfaces, lastSeen: Date.now() };
}

/** Seed a relay as if its announce arrived, and let the async reconcile settle. */
async function announce(r: CtrlinkDiscoveredRelay): Promise<void> {
	noteRelay(r);
	await Bun.sleep(10);
}

/** Build a tunnel offer for uplink `index` of relay `host` (the /30 the relay
 * hands the encoder: `10.200.<i+1>.1` relay / `.2` encoder). The tunnel offer
 * arrives only over the WS control channel, so these attach to a
 * `CtrlinkRelayIface` (the announce payload carries no tunnel spec). */
function tunnelSpec(index: number, host: string): CtrlinkTunnelSpec {
	return {
		virtualInterface: `utn-eth${index}`,
		endpoint: host,
		udpPort: 5222 + index,
		localAddr: `10.200.${index + 1}.1`,
		peerAddr: `10.200.${index + 1}.2`,
		prefix: 30,
		uplinkIndex: index,
		mtu: 1400,
	};
}

// Build a relay `CtrlinkRelayIface`. `index` (when given) attaches the tunnel
// offer so the encoder builds a `utn-<if>` vif for this uplink (the tunnel
// offer arrives only over the WS control channel, never the UDP announce).
const iface = (
	name: string,
	ip: string,
	port: number,
	state: "up" | "down" = "up",
	index?: number,
): CtrlinkRelayIface => ({
	iface_name: name,
	ip,
	udp_port: port,
	state,
	uplink: true,
	...(index === undefined ? {} : { tunnel: tunnelSpec(index, ip) }),
});

beforeEach(() => {
	clearCapabilities();
});

// The tunnel reconcile shells out (`ip`/`iptables`) through the lib's runner
// seam and spawns a `udpip` child through the pump seams. All are injectable —
// a no-op runner + stub pump spawner/killer let the reconcile populate the vif
// map with no live kernel and no real process.
afterEach(() => {
	setCmdRunner(undefined);
	setPumpSpawner(undefined);
	setPumpKiller(undefined);
});

/** Bind a fresh core + fake uplinks + registry, flush leftover state and start
 * the module the way the device process does (it runs always on encoders). */
async function setup(data: Record<string, unknown> = {}) {
	const core = fakeCore(data);
	const uplinks = fakeUplinks();
	const ctrlink = fakeCtrlinkRegistry();
	provideCapability<Uplinks>("network.uplinks", uplinks);
	provideCapability<CtrlinkRegistry>("network.ctrlink", ctrlink);
	setCmdRunner(async () => "");
	setPumpSpawner(async () => ({ pid: 4242 }));
	setPumpKiller(async () => {});
	up().bind?.(core);
	await up().stop(); // idempotent: clears vifs/uplinks + the discovery registry
	await up().start({ config: {}, emit: () => {}, log: () => {}, core });
	// `start()` fires a fire-and-forget tunnel reconcile (0 offers) that
	// latches the module-level `inFlight` guard. Let it drain, then hard-reset
	// the module state so a hello sent by the test isn't dropped by the
	// in-flight guard and no vifs leak across tests.
	await Bun.sleep(10);
	resetEncoderTunnelTestState();
	return { core, uplinks, ctrlink };
}

const view = async (): Promise<CtrlinkStreamerView> =>
	(await up().dispatch("ctrlink_streamer.status", {})) as CtrlinkStreamerView;

/**
 * The WG vif reconcile is fire-and-forget (a best-effort background task the
 * WS hello triggers). Poll until the vif count settles to `n` (bounded), so a
 * test never races the async `ip` runner.
 */
async function awaitVifs(n: number): Promise<boolean> {
	for (let i = 0; i < 100; i++) {
		if (encoderTunnelStateForTest().vifs.length === n) return true;
		await Bun.sleep(5);
	}
	return encoderTunnelStateForTest().vifs.length === n;
}

describe("ctrlink_streamer", () => {
	test("a WS offer for an uplink builds a utn-<if> vif and registers its uplink", async () => {
		const { uplinks } = await setup();
		// Tunnel offers arrive over the relay WS control channel (protocol §3)
		// — a UDP announce alone carries no tunnel spec and builds nothing.
		mod.onRelayWsMessage("relay-1", {
			type: "hello",
			relay_id: "relay-1",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000, "up", 0)],
		});
		await awaitVifs(1);
		expect(encoderTunnelStateForTest().vifs).toEqual([
			{
				relayId: "relay-1",
				uplink: "eth0",
				name: "utn0-eth0",
				localIp: "10.200.1.2",
				listenPort: 51820,
			},
		]);
		const v = await view();
		expect(v.runtime.running).toBe(true);
		expect(v.runtime.tunnels[0]).toMatchObject({
			interfaceName: "utn0-eth0",
			interfaceAddress: "10.200.1.2",
			relayHost: "relay-1",
			uplinkRegistered: true,
		});
		expect(uplinks.added).toEqual([
			{
				id: "ctrlink:tun:utn0-eth0",
				source: "10.200.1.2",
				label: "Ctrlink (utn0-eth0)",
			},
		]);
		// The learned relay is mirrored to the network card registry.
		await up().stop();
		expect(uplinks.removed).toContain("ctrlink:tun:utn0-eth0");
		expect(uplinks.list()).toEqual([]);
	});

	test("two relays get distinct vif names; a clashing uplink name is deduped", async () => {
		const { uplinks } = await setup();
		// Relay 0 offers eth0 → `utn0-eth0`.
		mod.onRelayWsMessage("relay-1", {
			type: "hello",
			relay_id: "relay-1",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000, "up", 0)],
		});
		await awaitVifs(1);
		expect(encoderTunnelStateForTest().vifs).toHaveLength(1);
		expect(
			encoderTunnelStateForTest().vifs[0].name,
		).toBe("utn0-eth0");

		// Relay 1 (index 1) offers eth1 → `utn1-eth1`.
		mod.onRelayWsMessage("relay-2", {
			type: "hello",
			relay_id: "relay-2",
			proto: 1,
			interfaces: [iface("eth1", "198.51.100.33", 4001, "up", 1)],
		});
		await awaitVifs(2);
		const names = encoderTunnelStateForTest().vifs
			.map((v) => v.name)
			.sort();
		expect(names).toEqual(["utn0-eth0", "utn1-eth1"]);
		// The relay-1 vif is unchanged (its index is pinned at 0).
		expect(
			encoderTunnelStateForTest().vifs.find((v) => v.relayId === "relay-2")
				?.name,
		).toBe("utn1-eth1");

		// Relay 1 ALSO offers an `eth0` uplink. That uplink name is already
		// taken by relay 0's vif, so it is deduped away (no second device, no
		// /30 clash) — the encoder keeps exactly the two vifs above.
		mod.onRelayWsMessage("relay-2", {
			type: "hello",
			relay_id: "relay-2",
			proto: 1,
			interfaces: [
				iface("eth1", "198.51.100.33", 4001, "up", 1),
				iface("eth0", "198.51.100.34", 4002, "up", 0),
			],
		});
		await Bun.sleep(20);
		expect(encoderTunnelStateForTest().vifs).toHaveLength(2);
		expect(
			encoderTunnelStateForTest().vifs.map((v) => v.name).sort(),
		).toEqual(["utn0-eth0", "utn1-eth1"]);
		await up().stop();
	});

	test("an interface whose subnet is already on-link on this host is not tunneled", async () => {
		const { core, uplinks } = await setup();
		// Simulate the kernel: every announced address is directly on-link on
		// eth0 (a plain `dev`, no `via` gateway) — the encoder physically sits
		// on that segment, so the tunnels are redundant and must be skipped.
		type CoreWithRun = {
			run: (bin: string, args: string[], ignore?: boolean) => Promise<string>;
		};
		(core as unknown as CoreWithRun).run = async (_bin, args) =>
			args[0] === "route" && args[1] === "get"
				? `${args[2]} dev eth0 src 203.0.113.5 uid 0\n`
				: "";
		await announce(
			relay("203.0.113.10", [
				["eth0", "203.0.113.10", 4000],
				["eth1", "203.0.113.11", 4001],
			]),
		);
		expect(uplinks.added).toEqual([]);
		const v = await view();
		expect(v.runtime.tunnels).toEqual([]);
		await up().stop();
	});

	test("a gateway-routed (not on-link) uplink is still tunneled", async () => {
		const { core, uplinks } = await setup();
		// The WG /30 endpoint is reached via a gateway (not on any local
		// iface) → NOT on-link → the vif is built (the fail-open path).
		type CoreWithRun = {
			run: (bin: string, args: string[], ignore?: boolean) => Promise<string>;
		};
		(core as unknown as CoreWithRun).run = async (_bin, args) =>
			args[0] === "route" && args[1] === "get"
				? `${args[2]} via 192.168.1.1 dev eth0 src 192.168.1.5 uid 0\n`
				: "";
		mod.onRelayWsMessage("relay-1", {
			type: "hello",
			relay_id: "relay-1",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000, "up", 0)],
		});
		await awaitVifs(1);
		expect(uplinks.list().map((e) => e.id)).toEqual(["ctrlink:tun:utn0-eth0"]);
		expect(encoderTunnelStateForTest().vifs).toHaveLength(1);
		await up().stop();
	});

	test("multiple WG uplinks → one vif each, derived from the spec", async () => {
		const { uplinks } = await setup();
		// WG uplinks are keyed by iface name. Two distinct uplinks (eth0/eth1)
		// with their own specs → one vif each.
		mod.onRelayWsMessage("relay-1", {
			type: "hello",
			relay_id: "relay-1",
			proto: 1,
			interfaces: [
				iface("eth0", "198.51.100.9", 4000, "up", 0),
				iface("eth1", "198.51.100.9", 4001, "up", 1),
			],
		});
		await awaitVifs(2);
		const { vifs } = encoderTunnelStateForTest();
		expect(vifs.map((v) => v.name).sort()).toEqual(["utn0-eth0", "utn0-eth1"]);
		expect(vifs.map((v) => v.localIp).sort()).toEqual([
			"10.200.1.2",
			"10.200.2.2",
		]);
		const v = await view();
		expect(v.runtime.running).toBe(true);
		expect(
			uplinks
				.list()
				.map((e) => e.id)
				.sort(),
		).toEqual(["ctrlink:tun:utn0-eth0", "ctrlink:tun:utn0-eth1"]);
		await up().stop();
	});

	test("no discovered relays → nothing running and no uplinks", async () => {
		const { uplinks } = await setup();
		expect(uplinks.added).toEqual([]);
		const v = await view();
		expect(v.runtime.running).toBe(false);
		expect(v.runtime.tunnels).toEqual([]);
	});

	test("an updated hello offering a new uplink re-reconciles and adds a vif", async () => {
		const { uplinks } = await setup();
		mod.onRelayWsMessage("relay-1", {
			type: "hello",
			relay_id: "relay-1",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000, "up", 0)],
		});
		await awaitVifs(1);
		expect(uplinks.list().map((e) => e.id)).toEqual(["ctrlink:tun:utn0-eth0"]);

		// The relay sends a newer hello that now also offers eth1 → the
		// encoder re-reconciles and builds a second vif (utn0-eth1) alongside.
		mod.onRelayWsMessage("relay-1", {
			type: "hello",
			relay_id: "relay-1",
			proto: 1,
			interfaces: [
				iface("eth0", "198.51.100.9", 4000, "up", 0),
				iface("eth1", "198.51.100.9", 4001, "up", 1),
			],
		});
		await awaitVifs(2);
		const v = await view();
		expect(
			uplinks
				.list()
				.map((e) => e.id)
				.sort(),
		).toEqual(["ctrlink:tun:utn0-eth0", "ctrlink:tun:utn0-eth1"]);
		expect(
			v.runtime.tunnels.some((t) => t.interfaceName === "utn0-eth1"),
		).toBe(true);
		await up().stop();
	});

	test("a failed uplink add leaves nothing running for that tunnel", async () => {
		const { uplinks } = await setup();
		uplinks.setFailAdd(true);
		await announce(relay("203.0.113.10", [["eth0", "203.0.113.10", 4000]]));
		const v = await view();
		expect(v.runtime.running).toBe(false);
		expect(v.runtime.tunnels).toEqual([]);
		expect(uplinks.list()).toEqual([]);
		await up().stop();
		expect(uplinks.list()).toEqual([]);
	});

	test("teardown stops the vifs and unregisters their uplinks", async () => {
		const { uplinks } = await setup();
		mod.onRelayWsMessage("relay-1", {
			type: "hello",
			relay_id: "relay-1",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000, "up", 0)],
		});
		await awaitVifs(1);
		expect(uplinks.list().map((e) => e.id)).toEqual(["ctrlink:tun:utn0-eth0"]);
		expect(encoderTunnelStateForTest().vifs).toHaveLength(1);
		await up().stop();
		expect(uplinks.list()).toEqual([]);
		expect(uplinks.removed).toContain("ctrlink:tun:utn0-eth0");
		expect(encoderTunnelStateForTest().vifs).toHaveLength(0);
	});

	test("the learned relays are reported in the view's discoveredRelays", async () => {
		const { ctrlink } = await setup();
		await announce(relay("203.0.113.10", [["eth0", "203.0.113.10", 4000]]));
		const v = await view();
		expect(v.discoveredRelays.map((r) => r.host)).toEqual(["203.0.113.10"]);
		expect(ctrlink.relays.get("203.0.113.10")?.interfaces).toHaveLength(1);
		await up().stop();
	});

	test("an interface_down in the ANNOUNCE is not tunnelled (protocol.md §5)", async () => {
		const { uplinks } = await setup();
		await announce({
			host: "203.0.113.20",
			hostname: "203.0.113.20",
			interfaces: [
				{
					name: "eth0",
					address: "203.0.113.20",
					listenPort: 4000,
					state: "down",
				},
			],
			lastSeen: Date.now(),
		});
		expect(uplinks.list()).toEqual([]);
		const v = await view();
		expect(v.runtime.tunnels).toEqual([]);
		// The endpoint is still tracked (the port mapping must survive).
		expect(v.discoveredRelays[0]?.interfaces[0]?.state).toBe("down");
		await up().stop();
	});
});

describe("relay WS control channel (protocol.md §3–§5)", () => {
	test("a hello snapshot registers the relay and builds its WG vifs", async () => {
		const { uplinks } = await setup();
		// The hello carries a tunnel offer per uplink → the encoder builds a
		// `utn-<if>` vif per uplink that isn't already on-link (protocol §3).
		mod.onRelayWsMessage("wan-relay", {
			type: "hello",
			relay_id: "wan-relay",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000, "up", 0)],
		});
		await awaitVifs(1);
		const v = await view();
		expect(v.discoveredRelays.map((r) => r.host)).toContain("wan-relay");
		expect(uplinks.list().map((e) => e.id)).toEqual(["ctrlink:tun:utn0-eth0"]);
		expect(encoderTunnelStateForTest().vifs).toEqual([
			{
				relayId: "wan-relay",
				uplink: "eth0",
				name: "utn0-eth0",
				localIp: "10.200.1.2",
				listenPort: 51820,
			},
		]);
		// The vif's status dials the offering relay (its WS host id).
		expect(v.runtime.tunnels[0]).toMatchObject({
			interfaceName: "utn0-eth0",
			interfaceAddress: "10.200.1.2",
			relayHost: "wan-relay",
		});
		await up().stop();
	});

	test("a hello with a peer IP keys the registry by IP (no UDP announce yet)", async () => {
		await setup();
		mod.onRelayWsMessage(
			"bigcml",
			{
				type: "hello",
				relay_id: "bigcml",
				proto: 1,
				interfaces: [iface("eno2", "192.0.2.10", 4000)],
			},
			"192.0.2.10",
		);
		await Bun.sleep(10);
		const v = await view();
		// The registry key is the routable peer IP, not the hostname (dgram
		// performs no hostname resolution — an ENOTFOUND dial target).
		expect(v.discoveredRelays.map((r) => r.host)).toEqual(["192.0.2.10"]);
		expect(v.discoveredRelays[0].hostname).toBe("bigcml");
		await up().stop();
	});

	test("a live WS marks the relay wsConnected on the network-card registry", async () => {
		const { ctrlink } = await setup();
		mod.onRelayWsMessage(
			"bigcml",
			{
				type: "hello",
				relay_id: "bigcml",
				proto: 1,
				interfaces: [iface("eno2", "192.0.2.10", 4000)],
			},
			"192.0.2.10",
		);
		await Bun.sleep(10);
		// The relay lands in the network-card registry flagged as WS-connected
		// (protocol.md §3) — the card renders the green dot from this flag.
		const entry = ctrlink.relays.get("192.0.2.10");
		expect(entry).toBeDefined();
		expect(entry?.wsConnected).toBe(true);
		await up().stop();
	});

	test("a later hello with a peer IP migrates the hostname-keyed registry entry", async () => {
		await setup();
		const hello = {
			type: "hello" as const,
			relay_id: "bigcml",
			proto: 1,
			interfaces: [iface("eno2", "192.0.2.10", 4000)],
		};
		mod.onRelayWsMessage("bigcml", hello);
		await Bun.sleep(10);
		expect((await view()).discoveredRelays.map((r) => r.host)).toEqual([
			"bigcml",
		]);
		mod.onRelayWsMessage("bigcml", hello, "192.0.2.10");
		await Bun.sleep(10);
		const v = await view();
		// One entry, re-keyed from the hostname to the peer IP.
		expect(v.discoveredRelays.map((r) => r.host)).toEqual(["192.0.2.10"]);
		expect(v.discoveredRelays[0].hostname).toBe("bigcml");
		await up().stop();
	});

	test("interface_down tears the vif; a re-hello rebuilds the same slot (protocol.md §1)", async () => {
		const { uplinks } = await setup();
		mod.onRelayWsMessage("wan-relay", {
			type: "hello",
			relay_id: "wan-relay",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000, "up", 0)],
		});
		await awaitVifs(1);
		expect(uplinks.list().map((e) => e.id)).toEqual(["ctrlink:tun:utn0-eth0"]);
		expect(encoderTunnelStateForTest().vifs).toHaveLength(1);

		// The uplink goes down → its vif is torn down (the offer is dropped).
		mod.onRelayWsMessage("wan-relay", {
			type: "interface_down",
			iface: iface("eth0", "198.51.100.9", 4000, "down"),
		});
		await awaitVifs(0);
		expect((await view()).runtime.tunnels).toEqual([]);
		expect(uplinks.list()).toEqual([]);
		expect(encoderTunnelStateForTest().vifs).toHaveLength(0);
		// The (down) endpoint stays in the registry → the port mapping keeps.
		expect(
			(await view()).discoveredRelays.find((r) => r.host === "wan-relay")
				?.interfaces,
		).toEqual([
			expect.objectContaining({
				name: "eth0",
				listenPort: 4000,
				state: "down",
			}),
		]);

		// A fresh hello re-offering eth0 rebuilds the SAME vif slot (utn0-eth0).
		mod.onRelayWsMessage("wan-relay", {
			type: "hello",
			relay_id: "wan-relay",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000, "up", 0)],
		});
		await awaitVifs(1);
		expect(uplinks.list().map((e) => e.id)).toEqual(["ctrlink:tun:utn0-eth0"]);
		expect(encoderTunnelStateForTest().vifs).toEqual([
			{
				relayId: "wan-relay",
				uplink: "eth0",
				name: "utn0-eth0",
				localIp: "10.200.1.2",
				listenPort: 51820,
			},
		]);
		await up().stop();
	});

	test("interface_added opens a new vif; interface_removed tears it (protocol.md §4.2)", async () => {
		const { uplinks } = await setup();
		mod.onRelayWsMessage("wan-relay", {
			type: "hello",
			relay_id: "wan-relay",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000, "up", 0)],
		});
		await awaitVifs(1);
		expect(uplinks.list().map((e) => e.id)).toEqual(["ctrlink:tun:utn0-eth0"]);

		// The relay adds a NEW uplink (eth1) carrying its own tunnel spec → a
		// second vif is built alongside.
		mod.onRelayWsMessage("wan-relay", {
			type: "interface_added",
			iface: iface("eth1", "198.51.100.9", 4001, "up", 1),
		});
		await awaitVifs(2);
		expect(uplinks.list().map((e) => e.id).sort()).toEqual([
			"ctrlink:tun:utn0-eth0",
			"ctrlink:tun:utn0-eth1",
		]);
		expect(
			(await view()).runtime.tunnels.map((t) => t.interfaceAddress),
		).toEqual(["10.200.1.2", "10.200.2.2"]);

		// The relay drops eth1 (the event carries no spec — the vif name is
		// derived from the iface) → its vif is torn down.
		mod.onRelayWsMessage("wan-relay", {
			type: "interface_removed",
			iface: iface("eth1", "198.51.100.9", 4001, "down"),
		});
		await awaitVifs(1);
		expect(uplinks.list().map((e) => e.id)).toEqual(["ctrlink:tun:utn0-eth0"]);
		expect(
			(await view()).discoveredRelays
				.find((r) => r.host === "wan-relay")
				?.interfaces.map((e) => e.name),
		).toEqual(["eth0"]);
		await up().stop();
	});

	test("a hello for an UNKNOWN relay is ignored until its identity is known", async () => {
		const { uplinks } = await setup();
		// No hello → no wsRelayHosts entry → single-interface events drop.
		mod.onRelayWsMessage("ghost-relay", {
			type: "interface_up",
			iface: iface("eth0", "198.51.100.9", 4000),
		});
		await Bun.sleep(10);
		expect(uplinks.list()).toEqual([]);
		await up().stop();
	});
});

describe("TTL sweep + WS keepalive (protocol.md §3 self-sustaining channel)", () => {
	test("sweepStaleRelays drops silent relays but spares live-WS peers", async () => {
		await setup();
		const backdated = {
			host: "192.0.2.10",
			hostname: "bigcml",
			interfaces: [{ name: "eno2", address: "192.0.2.10", listenPort: 4000 }],
			lastSeen: Date.now() - 20_000, // beyond the 15 s TTL
		};
		noteRelay(backdated as CtrlinkDiscoveredRelay);
		// The registry is keyed by the relay's identity (hostname), so the
		// swept key is "bigcml", not the IP.
		expect(sweepStaleRelays()).toEqual(["bigcml"]);
		// Re-seed the SAME relay, now with a live WS → protected from the sweep.
		noteRelay(backdated as CtrlinkDiscoveredRelay);
		expect(sweepStaleRelays(() => new Set(["192.0.2.10"]))).toEqual([]);
		expect(knownRelays().some((r) => r.host === "192.0.2.10")).toBe(true);
		await up().stop();
	});

	test("a ping frame refreshes the registry TTL (no log spam, quiet path)", async () => {
		await setup();
		mod.onRelayWsMessage(
			"bigcml",
			{
				type: "hello",
				relay_id: "bigcml",
				proto: 1,
				interfaces: [
					{
						iface_name: "eno2",
						ip: "192.0.2.10",
						udp_port: 4000,
						state: "up",
						uplink: true,
					},
				],
			},
			"192.0.2.10",
		);
		await Bun.sleep(10);
		// Age the entry past the TTL, then let a keepalive frame refresh it.
		noteRelay({
			host: "192.0.2.10",
			hostname: "bigcml",
			interfaces: [{ name: "eno2", address: "192.0.2.10", listenPort: 4000 }],
			lastSeen: Date.now() - 20_000,
		} as CtrlinkDiscoveredRelay);
		mod.onRelayWsMessage("bigcml", { type: "ping" }, "192.0.2.10");
		// Unprotected sweep: the ping refreshed lastSeen → relay survives.
		expect(sweepStaleRelays()).toEqual([]);
		expect(knownRelays().some((r) => r.host === "192.0.2.10")).toBe(true);
		await up().stop();
	});
});

describe("registry dedupe (one entry per relay)", () => {
	test("the same relay learned via UDP, mDNS and WS stays a single entry", async () => {
		await setup();
		// 1) UDP broadcast announce (identity = hostname "bigcml").
		noteRelay({
			host: "192.0.2.10",
			hostname: "bigcml",
			interfaces: [{ name: "eno2", address: "192.0.2.10", listenPort: 4000 }],
			lastSeen: Date.now(),
		} as CtrlinkDiscoveredRelay);
		expect(knownRelays()).toHaveLength(1);
		// 2) mDNS for the SAME relay → merged into the existing entry, and
		// the longer endpoint set wins (mDNS may carry more endpoints).
		noteMdnsRelay("192.0.2.10", "bigcml", [
			{ name: "eno2", address: "192.0.2.10", listenPort: 4000 },
			{ name: "wg0", address: "192.0.2.11", listenPort: 4002 },
		]);
		expect(knownRelays()).toHaveLength(1);
		expect(knownRelays()[0].interfaces).toHaveLength(2);
		// 3) WS hello from the same relay → no new entry; the hello snapshot
		// replaces the interface set wholesale (protocol.md §4).
		mod.onRelayWsMessage(
			"bigcml",
			{
				type: "hello",
				relay_id: "bigcml",
				proto: 1,
				interfaces: [
					{
						iface_name: "eno2",
						ip: "192.0.2.10",
						udp_port: 4000,
						state: "up",
						uplink: true,
					},
				],
			},
			"192.0.2.10",
		);
		expect(knownRelays()).toHaveLength(1);
		expect(knownRelays()[0].host).toBe("192.0.2.10");
		expect(knownRelays()[0].hostname).toBe("bigcml");
		expect(knownRelays()[0].interfaces).toHaveLength(1);
		await up().stop();
	});

	test("an mDNS refresh of a WS-registered relay stays a single entry", async () => {
		await setup();
		// 1) WS hello registers the relay with one endpoint.
		mod.onRelayWsMessage(
			"bigcml",
			{
				type: "hello",
				relay_id: "bigcml",
				proto: 1,
				interfaces: [
					{
						iface_name: "eno2",
						ip: "192.0.2.10",
						udp_port: 4000,
						state: "up",
						uplink: true,
					},
				],
			},
			"192.0.2.10",
		);
		expect(knownRelays()).toHaveLength(1);
		// 2) mDNS for the SAME relay (same host + hostname) must merge into the
		// single entry — not accumulate a duplicate — and keep the endpoint.
		noteMdnsRelay("192.0.2.10", "bigcml", [
			{ name: "eno2", address: "192.0.2.10", listenPort: 4000 },
		]);
		expect(knownRelays()).toHaveLength(1);
		expect(knownRelays()[0].interfaces).toHaveLength(1);
		expect(knownRelays()[0].interfaces[0].name).toBe("eno2");
		expect(knownRelays()[0].interfaces[0].address).toBe("192.0.2.10");
		await up().stop();
	});

	test("a hostname-less relay stays one entry when its announce IP is stable", async () => {
		await setup();
		noteRelay({
			host: "192.0.2.20",
			interfaces: [{ name: "eno2", address: "192.0.2.20", listenPort: 4000 }],
			lastSeen: Date.now(),
		} as CtrlinkDiscoveredRelay);
		noteMdnsRelay("192.0.2.20", undefined, [
			{ name: "eno2", address: "192.0.2.20", listenPort: 4000 },
		]);
		noteRelay({
			host: "192.0.2.20",
			interfaces: [{ name: "eno2", address: "192.0.2.20", listenPort: 4000 }],
			lastSeen: Date.now(),
		} as CtrlinkDiscoveredRelay);
		expect(knownRelays()).toHaveLength(1);
		expect(knownRelays()[0].host).toBe("192.0.2.20");
		await up().stop();
	});
});

describe("encoderInfo (protocol.md §2 relay lookup)", () => {
	test("reports id / IP / WS port / protocol version", async () => {
		await setup();
		const info = (await up().dispatch("ctrlink_streamer.encoderInfo", {})) as {
			encoderId: string;
			ip: string;
			wsPort: number;
			proto: number;
		} | null;
		// `defaultSourceIp` shells out to `ip route get`; on test hosts it may
		// resolve a real LAN IP — assert the shape, not the address.
		expect(info).not.toBeNull();
		expect(info?.encoderId.length).toBeGreaterThan(0);
		expect(info?.wsPort).toBe(8190);
		expect(info?.proto).toBe(1);
		await up().stop();
	});
});
