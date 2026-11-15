import { afterEach, expect, test } from "bun:test";
import {
	attachToBridge,
	createGretapTunnel,
	createUdpRelay,
	createVirtualInterface,
	egressIface,
	gretapSetupCommands,
	gretapTeardownCommands,
	listGretapInterfaces,
	listIfaceAddrs,
	makeMockIfaceRawSocket,
	maxPayload,
	moveAddrsToBridge,
	readIfaceStats,
	releaseIfaceFromBridge,
	setIpRunner,
	setUpGretap,
	outerEndpointFor,
	DEFAULT_GRETAP_MTU,
	GRETAP_OVERHEAD,
	encodeDataFrame,
	decodeFrame,
	isValid,
	buildUdpIpPacket,
	type RelayStats,
	type VifStats,
} from "../src/index";

function recordIpRunner(
	calls: string[][],
	failOnceOn?: (args: string[]) => boolean,
): (args: string[]) => Promise<string> {
	let failed = false;
	return async (args: string[]) => {
		calls.push([...args]);
		if (failOnceOn && !failed && failOnceOn(args)) {
			failed = true;
			throw new Error("RTNETLINK answers: File exists");
		}
		return "";
	};
}

afterEach(() => {
	setIpRunner(undefined);
});

// --- Wire sizing -------------------------------------------------------------

test("maxPayload = mtu - 38 (GRETAP overhead)", () => {
	expect(GRETAP_OVERHEAD).toBe(38);
	expect(maxPayload(1500)).toBe(1462);
	expect(maxPayload(1600)).toBe(1562);
	expect(DEFAULT_GRETAP_MTU).toBe(1500);
});

test("frame roundtrip: encodeDataFrame → decodeFrame", () => {
	const ipPacket = buildUdpIpPacket({
		srcIp: "10.90.1.1",
		dstIp: "192.168.1.2",
		srcPort: 1,
		dstPort: 2,
		payload: new TextEncoder().encode("hello"),
	});
	const frame = encodeDataFrame(ipPacket, "10.90.1.1");
	const decoded = decodeFrame(frame);
	expect(decoded.type).toBe("data");
	if (decoded.type === "data") {
		expect(decoded.vifIp).toBe("10.90.1.1");
		expect(new Uint8Array(decoded.payload)).toEqual(new Uint8Array(ipPacket));
	}
});

// --- ip helpers ---------------------------------------------------------------

test("isValid accepts real IPv4, rejects the rest", () => {
	expect(isValid("10.0.0.1")).toBe(true);
	expect(isValid("192.168.1.1")).toBe(true);
	expect(isValid("256.1.1.1")).toBe(false);
	expect(isValid("1.2.3")).toBe(false);
	expect(isValid("a.b.c.d")).toBe(false);
	expect(isValid("")).toBe(false);
});

// --- `ip` command builders (pure) ----------------------------------------------

test("gretapSetupCommands emits the exact topology argv", () => {
	expect(gretapSetupCommands("vif1", "192.168.10.1", 1500)).toEqual([
		["link", "add", "vif1", "type", "gretap", "remote", "192.168.10.1"],
		["link", "set", "vif1", "mtu", "1500"],
		["link", "add", "br-vif1", "type", "bridge"],
		["link", "set", "br-vif1", "up"],
		["link", "set", "vif1", "master", "br-vif1"],
		["link", "set", "vif1", "up"],
	]);
});

test("gretapTeardownCommands removes tunnel then bridge", () => {
	expect(gretapTeardownCommands("vif1")).toEqual([
		["link", "set", "vif1", "nomaster"],
		["link", "del", "vif1"],
		["link", "del", "br-vif1"],
	]);
});

// --- listGretapInterfaces (injected runner) -------------------------------------

test("listGretapInterfaces parses `ip -o link show type gretap`", async () => {
	setIpRunner(async () => [
		"3: vif1@NONE: <BROADCAST,MULTICAST> mtu 1500 state UP (LOWER_UP)",
		"4: vif2@NONE: <NO-CARRIER> mtu 1500 state DOWN (DORMANT)",
	].join("\n"));
	const list = await listGretapInterfaces();
	expect(list).toEqual([
		{ name: "vif1", state: "UP" },
		{ name: "vif2", state: "DOWN" },
	]);
});

test("listGretapInterfaces on an empty host is []", async () => {
	setIpRunner(async () => "");
	expect(await listGretapInterfaces()).toEqual([]);
});

// --- setUpGretap (injected runner) -----------------------------------------------

test("setUpGretap runs the topology point-to-point (does NOT enslave the LAN NIC)", async () => {
	const calls: string[][] = [];
	setIpRunner(recordIpRunner(calls));
	const res = await setUpGretap({
		name: "vif1",
		peerIp: "192.168.10.1",
		localIp: "192.168.1.1",
		localIface: "eth0",
		mtu: 1500,
	});
	expect(res).toEqual({
		name: "vif1",
		bridge: "br-vif1",
		localIface: "eth0",
	});
	// The encoder bridge is point-to-point: gretap dev only. eth0 is the outer
	// egress, never a bridge member — enslaving it steals its IP and black-holes
	// the host (GRETAP-RESEARCH.md, e2e bring-up §7).
	expect(calls).toEqual(gretapSetupCommands("vif1", "192.168.10.1", 1500));
});

test("setUpGretap heals a leftover device (File exists → teardown → retry)", async () => {
	const calls: string[][] = [];
	setIpRunner(
		recordIpRunner(calls, (args) => args[0] === "link" && args[1] === "add" && args[2] === "vif1"),
	);
	const res = await setUpGretap({
		name: "vif1",
		peerIp: "192.168.10.1",
		localIp: "192.168.1.1",
		localIface: "eth0",
	});
	expect(res.name).toBe("vif1");
	// The failing add is retried once, with the heal-teardown in between.
	const addIndexes = calls
		.map((c, i) => (c[1] === "add" && c[2] === "vif1" ? i : -1))
		.filter((i) => i >= 0);
	expect(addIndexes).toHaveLength(2);
	expect(calls.slice(addIndexes[0] + 1, addIndexes[1])).toEqual(
		gretapTeardownCommands("vif1"),
	);
});

test("setUpGretap propagates non-healable errors", async () => {
	setIpRunner(async (args) => {
		if (args[1] === "add" && args[2] === "vif1")
			throw new Error("Operation not permitted");
		return "";
	});
	await expect(
		setUpGretap({
			name: "vif1",
			peerIp: "192.168.10.1",
			localIp: "192.168.1.1",
			localIface: "eth0",
		}),
	).rejects.toThrow(/Operation not permitted/);
});

// --- egressIface (LAN NIC resolution) --------------------------------------------

test("egressIface parses `ip route get` and is null on failure / loopback", async () => {
	setIpRunner(async (args) => {
		if (args[0] === "route" && args[1] === "get")
			return "192.168.10.1 dev eth1 src 192.168.1.7 uid 1000\n    cache\n";
		throw new Error(`unexpected ip args: ${args.join(" ")}`);
	});
	expect(await egressIface("192.168.10.1")).toBe("eth1");

	setIpRunner(async () => "10.0.0.1 dev lo src 10.0.0.1\n    cache\n");
	expect(await egressIface("10.0.0.1")).toBeNull();

	setIpRunner(async () => {
		throw new Error("ip route get failed: No such process");
	});
	expect(await egressIface("192.168.10.1")).toBeNull();
});

test("setUpGretap: virtual localIp (no iface holds it) → LAN NIC from the egress route", async () => {
	const calls: string[][] = [];
	setIpRunner(async (args) => {
		calls.push([...args]);
		if (args[0] === "route" && args[1] === "get")
			return "192.168.10.1 dev eth2 src 192.168.1.9\n    cache\n";
		return "";
	});
	// 10.90.77.1 is a synthetic tunnel IP — no host interface carries it, so
	// the LAN NIC must come from the routing table (the streamer's case).
	const res = await setUpGretap({
		name: "vif1",
		peerIp: "192.168.10.1",
		localIp: "10.90.77.1",
	});
	expect(res.localIface).toBe("eth2");
	expect(calls).toEqual([
		["route", "get", "192.168.10.1"],
		...gretapSetupCommands("vif1", "192.168.10.1", DEFAULT_GRETAP_MTU),
	]);
});

test("setUpGretap: no localIface, no holding iface, no egress route → clear error", async () => {
	setIpRunner(async () => {
		throw new Error("ip route get failed");
	});
	await expect(
		setUpGretap({ name: "vif1", peerIp: "192.168.10.1", localIp: "10.90.77.2" }),
	).rejects.toThrow(/pass localIface/);
});

// --- readIfaceStats -------------------------------------------------------------

test("readIfaceStats reads 0 for a missing interface", () => {
	const s = readIfaceStats("gretap-never-created");
	expect(s).toEqual({
		rxBytes: 0,
		rxPackets: 0,
		txBytes: 0,
		txPackets: 0,
		drops: 0,
	});
});

// --- No-op relay ------------------------------------------------------------------

test("no-op relay: no destination allowed (relay-box slots)", async () => {
	const rel = await createUdpRelay({
		interfaceName: "lo",
		listenPort: 4000,
		interfaceAddress: "127.0.0.1",
	});
	expect(rel.interfaceName).toBe("lo");
	expect(rel.interfaceAddress).toBe("127.0.0.1");
	expect(rel.natAddress).toBe("127.0.0.1");
	expect(rel.destination).toBe("");
	expect(rel.isRunning()).toBe(false);

	let statEvents = 0;
	// Re-construct with onStats to observe emissions.
	const rel2 = await createUdpRelay({
		interfaceName: "lo",
		listenPort: 4001,
		interfaceAddress: "127.0.0.1",
		onStats: () => statEvents++,
	});
	await rel2.start();
	await rel2.start(); // idempotent
	expect(rel2.isRunning()).toBe(true);
	await rel2.stop();
	await rel2.stop(); // idempotent
	expect(rel2.isRunning()).toBe(false);
	expect(statEvents).toBe(2); // start + stop

	// Legacy counters — all zero (the kernel owns the counters now).
	const s = rel2.stats() as RelayStats;
	expect(s.encRxPackets).toBe(0);
	expect(s.encTxPackets).toBe(0);
	expect(s.encRxBytes).toBe(0);
	expect(s.encTxBytes).toBe(0);
});

test("no-op relay: closes the injected iface socket on stop, never reads it", async () => {
	const mock = makeMockIfaceRawSocket();
	const rel = await createUdpRelay({
		interfaceName: "lo",
		listenPort: 4002,
		interfaceAddress: "127.0.0.1",
		ifaceSocket: mock,
	});
	expect(mock.closed).toBe(false);
	await rel.start();
	expect(mock.closed).toBe(false); // untouched while running
	await rel.stop();
	expect(mock.closed).toBe(true);
});

test("no-op relay: with a destination, it validates but ignores the port", async () => {
	const rel = await createUdpRelay({
		interfaceName: "eth0",
		listenPort: 4003,
		interfaceAddress: "192.168.1.5",
		destination: { host: "192.168.10.9", port: 4003 },
	});
	expect(rel.destination).toBe("192.168.10.9");
});

test("no-op relay: rejects a missing/invalid destination host", async () => {
	await expect(
		createUdpRelay({
			interfaceName: "lo",
			listenPort: 4004,
			interfaceAddress: "127.0.0.1",
			destination: { host: "not-an-ip", port: 1 },
		}),
	).rejects.toThrow(/destination/);
	await expect(
		createUdpRelay({
			interfaceName: "bad name!",
			listenPort: 4005,
			interfaceAddress: "127.0.0.1",
		}),
	).rejects.toThrow(/interfaceName/);
});

// --- createVirtualInterface --------------------------------------------------------

const baseVifOpts = {
	name: "vif1",
	localIp: "192.168.10.1",
	prefixLength: 24,
	relay: { host: "192.168.10.9", port: 4000 } as const,
};

test("createVirtualInterface rejects malformed options", async () => {
	await expect(
		createVirtualInterface({ ...baseVifOpts, name: "way-to-long-name-for-iface" }),
	).rejects.toThrow(/name/);
	await expect(
		createVirtualInterface({ ...baseVifOpts, localIp: "10.0.0" }),
	).rejects.toThrow(/localIp/);
	await expect(
		createVirtualInterface({
			...baseVifOpts,
			relay: { host: "hostname", port: 4000 },
		}),
	).rejects.toThrow(/relay\.host/);
	await expect(
		createVirtualInterface({ ...baseVifOpts, prefixLength: 7 }),
	).rejects.toThrow(/prefixLength/);
	await expect(
		createVirtualInterface({ ...baseVifOpts, mtu: 60 }),
	).rejects.toThrow(/mtu/);
});

test("createVirtualInterface: start brings up the tunnel, stop tears it down", async () => {
	const calls: string[][] = [];
	setIpRunner(recordIpRunner(calls));
	const vif = await createVirtualInterface({
		...baseVifOpts,
		localIface: "eth0",
		mtu: 1500,
	});
	expect(vif.name).toBe("vif1");
	expect(vif.socketAddress).toBeNull();
	expect(vif.isRunning()).toBe(false);

	await vif.start();
	expect(vif.isRunning()).toBe(true);
	expect(calls).toEqual([
		...gretapSetupCommands("vif1", "192.168.10.9", 1500),
		["addr", "replace", "192.168.10.1/24", "dev", "br-vif1"],
		["route", "replace", "192.168.10.0/24", "dev", "br-vif1"],
	]);

	const before = calls.length;
	await vif.start(); // idempotent
	expect(calls.length).toBe(before);

	await vif.stop();
	expect(vif.isRunning()).toBe(false);
	expect(calls.slice(before)).toEqual(gretapTeardownCommands("vif1"));

	// Stats surface: zeros for the (absent) kernel device, no lastError.
	const s = vif.stats() as VifStats;
	expect(s.lastError).toBeUndefined();
});

test("createVirtualInterface: start failures record lastError and throw", async () => {
	setIpRunner(async (args) => {
		if (args[1] === "add") throw new Error("Permission denied");
		return "";
	});
	const vif = await createVirtualInterface({
		...baseVifOpts,
		localIface: "eth0",
	});
	await expect(vif.start()).rejects.toThrow(/Permission denied/);
	expect(vif.isRunning()).toBe(false);
	expect(vif.stats().lastError?.message).toMatch(/Permission denied/);
});

test("createVirtualInterface emits onStats on start and stop", async () => {
	const calls: string[][] = [];
	setIpRunner(recordIpRunner(calls));
	let events = 0;
	const vif = await createVirtualInterface({
		...baseVifOpts,
		localIface: "eth0",
		onStats: () => events++,
	});
	await vif.start();
	expect(events).toBe(1);
	await vif.stop();
	expect(events).toBe(2);
});

// --- Relay-side GRETAP (on-path endpoint + L2 bridge) ---------------------------

/** A runner that answers the read-only `ip` queries + records writes. */
function routeRunner(
	calls: string[][],
	routeGet: Record<string, string>,
	addrs: Record<string, string[]>,
): (args: string[]) => Promise<string> {
	return async (args: string[]) => {
		calls.push([...args]);
		if (args[0] === "route" && args[1] === "get") {
			const r = routeGet[args[2]];
			// explicit entry (may be "" → no route) wins; unknown → default route
			return r !== undefined ? r : "default via 0.0.0.0 dev eno1 src 1.2.3.4";
		}
		if (args.slice(0, 4).join(" ") === "-o -4 addr show")
			return addrs[args[args.length - 1]]?.join("\n") ?? "";
		return "";
	};
}

test("outerEndpointFor parses the on-path iface+src from `ip route get`", async () => {
	const calls: string[][] = [];
	setIpRunner(
		routeRunner(calls, { "192.168.10.103": "192.168.10.103 dev eno1 src 192.168.10.1" }, {}),
	);
	expect(await outerEndpointFor("192.168.10.103")).toEqual({
		iface: "eno1",
		ip: "192.168.10.1",
	});
	setIpRunner(routeRunner([], { "10.0.0.9": "" }, {}));
	expect(await outerEndpointFor("10.0.0.9")).toBeNull();
});

test("listIfaceAddrs returns the CIDR list of an interface", async () => {
	setIpRunner(
		routeRunner([], {}, {
			eno2: ["3: eno2    inet 192.168.1.136/24 brd 192.168.1.255"],
		}),
	);
	expect(await listIfaceAddrs("eno2")).toEqual(["192.168.1.136/24"]);
	expect(await listIfaceAddrs("eth0")).toEqual([]);
});

test("createGretapTunnel builds the topology + points `local` at the on-path IP", async () => {
	const calls: string[][] = [];
	setIpRunner(recordIpRunner(calls));
	const res = await createGretapTunnel({
		name: "enc103",
		encIp: "192.168.10.103",
		relayIp: "192.168.10.1",
		mtu: 1458,
		greKey: 4143611081,
	});
	expect(res).toEqual({ gretap: "enc103", bridge: "br-enc103" });
	expect(calls).toEqual([
		...gretapSetupCommands("enc103", "192.168.10.103", 1458, 4143611081),
		["link", "set", "enc103", "type", "gretap", "local", "192.168.10.1", "remote", "192.168.10.103"],
	]);
});

test("createGretapTunnel heals a leftover device and retries once", async () => {
	const calls: string[][] = [];
	setIpRunner(
		recordIpRunner(calls, (args) => args[1] === "add" && args[2] === "enc103"),
	);
	await createGretapTunnel({
		name: "enc103",
		encIp: "192.168.10.103",
		relayIp: "192.168.10.1",
		greKey: 4143611081,
	});
	const addIndexes = calls
		.map((c, i) => (c[1] === "add" && c[2] === "enc103" ? i : -1))
		.filter((i) => i >= 0);
	expect(addIndexes).toHaveLength(2);
	// The tunnel encodes toward the on-path IP (relayIp), never the adv IP.
	expect(calls.some((c) => c.includes("192.168.10.1") && c.includes("192.168.10.103"))).toBe(true);
});

test("moveAddrsToBridge relocates the port's IPv4 onto the bridge, then flushes", async () => {
	const calls: string[][] = [];
	setIpRunner(
		routeRunner(calls, {}, {
			eno2: ["3: eno2    inet 192.168.1.136/24 brd 192.168.1.255"],
		}),
	);
	const moved = await moveAddrsToBridge("eno2", "br-enc103");
	expect(moved).toEqual(["192.168.1.136/24"]);
	expect(calls).toEqual([
		["-o", "-4", "addr", "show", "dev", "eno2"],
		["addr", "replace", "192.168.1.136/24", "dev", "br-enc103"],
		["addr", "flush", "dev", "eno2"],
		["route", "flush", "dev", "eno2"],
	]);
});

test("releaseIfaceFromBridge restores the addrs to the port, un-enslaves, clears the bridge", async () => {
	const calls: string[][] = [];
	setIpRunner(recordIpRunner(calls));
	await releaseIfaceFromBridge("eno2", "br-enc103", ["192.168.1.136/24"]);
	expect(calls).toEqual([
		["addr", "replace", "192.168.1.136/24", "dev", "eno2"],
		["link", "set", "eno2", "nomaster"],
		["addr", "flush", "dev", "br-enc103"],
	]);
});

test("attachToBridge enslaves the interface into the bridge and brings it up", async () => {
	const calls: string[][] = [];
	setIpRunner(recordIpRunner(calls));
	await attachToBridge("br-enc103", "eno2");
	expect(calls).toEqual([
		["link", "set", "eno2", "master", "br-enc103"],
		["link", "set", "eno2", "up"],
	]);
});
