import { afterEach, expect, test } from "bun:test";
import {
	clearPumpRegistry,
	DEFAULT_TUN_MTU,
	ensureTunnelEncoderRouting,
	ensureTunnelRelayEgress,
	firePumpExitForTest,
	pumpArgs,
	removeTunnelVif,
	revokeTunnelEncoderRouting,
	revokeTunnelRelayEgress,
	setCmdRunner,
	setPumpKiller,
	setPumpSpawner,
	setupTunnelVif,
	tunSetupCommands,
	tunnelAddress,
	tunnelListenPort,
	tunnelRouteTable,
	tunTeardownCommands,
	uplinkDefaultGateway,
	type PumpOptions,
} from "../src/index";

/** A recorded command runner: captures `{bin, args}` in order. */
function recordCmdRunner(
	calls: Array<{ bin: string; args: string[] }>,
	failOnceOn?: (bin: string, args: string[]) => boolean,
): (bin: string, args: string[]) => Promise<string> {
	let failed = false;
	return async (bin, args) => {
		calls.push({ bin, args: [...args] });
		if (failOnceOn && !failed && failOnceOn(bin, args)) {
			failed = true;
			throw new Error("RTNETLINK answers: File exists");
		}
		return "";
	};
}

/** Stub the pump child seams: the spawner records the opts and returns a
 * DISTINCT pid per spawn (like a real process); the killer records the pids it
 * was asked to kill. No real process. Pass `pids` to capture each spawn's pid
 * in order (used by the exit-watcher supervision tests). */
function stubPumps(
	spawned: PumpOptions[],
	killed: number[],
	pids?: number[],
): void {
	let n = 0;
	setPumpSpawner(async (opts) => {
		spawned.push(opts);
		const pid = 1000 + ++n;
		if (pids) pids.push(pid);
		return { pid };
	});
	setPumpKiller(async (pid) => {
		killed.push(pid);
	});
}

afterEach(() => {
	setCmdRunner(undefined);
	setPumpSpawner(undefined);
	setPumpKiller(undefined);
	clearPumpRegistry();
});

const ip = (bin: string, args: string[]) =>
	bin === "/usr/sbin/ip" || bin.endsWith("/ip");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until the stub spawner has recorded at least `want` spawns (the
 * exit-watcher respawn is async + fire-and-forget). */
async function settleSpawns(
	spawned: PumpOptions[],
	want: number,
	timeoutMs = 1500,
): Promise<void> {
	const t0 = Date.now();
	while (spawned.length < want && Date.now() - t0 < timeoutMs) await sleep(5);
}

// --- Pure command builders ----------------------------------------------------

test("tunSetupCommands: addr + mtu + up (no link add — the pump owns the netdev)", () => {
	const cmds = tunSetupCommands("utn-wwan0", "10.200.2.2", 30, 1400);
	expect(cmds).toEqual([
		["addr", "add", "10.200.2.2/30", "dev", "utn-wwan0"],
		["link", "set", "utn-wwan0", "mtu", "1400"],
		["link", "set", "utn-wwan0", "up"],
	]);
});

test("tunTeardownCommands: link del only", () => {
	expect(tunTeardownCommands("utn-eth0")).toEqual([
		["link", "del", "utn-eth0"],
	]);
});

test("pumpArgs: server mode binds + pins allow", () => {
	expect(
		pumpArgs({ mode: "server", name: "utn-eth0", bind: "10.0.0.1:51820" }),
	).toEqual([
		"server", "--tun", "utn-eth0", "--bind", "10.0.0.1:51820", "--allow", "first",
	]);
	expect(
		pumpArgs({
			mode: "server",
			name: "utn-eth0",
			bind: "10.0.0.1:51820",
			allow: "1.2.3.4",
		}),
	).toEqual([
		"server", "--tun", "utn-eth0", "--bind", "10.0.0.1:51820", "--allow", "1.2.3.4",
	]);
});

test("pumpArgs: client mode dials remote", () => {
	expect(
		pumpArgs({ mode: "client", name: "utn-eth0", remote: "10.0.0.1:51820" }),
	).toEqual(["client", "--tun", "utn-eth0", "--remote", "10.0.0.1:51820"]);
});

test("defaults: 1400 MTU + 51820 base + 201 table base + per-index /30", () => {
	expect(DEFAULT_TUN_MTU).toBe(1400);
	expect(tunnelListenPort(0)).toBe(51820);
	expect(tunnelListenPort(1)).toBe(51821);
	// 201+, NOT 101 — the relay `network` module owns tables 100+ (101, 102…)
	// for its per-uplink source routing; a tunnel table there would collide.
	expect(tunnelRouteTable(0)).toBe(201);
	expect(tunnelRouteTable(1)).toBe(202);
	expect(tunnelAddress(0)).toEqual({
		relayIp: "10.200.1.1",
		encoderIp: "10.200.1.2",
		subnet: "10.200.1.1/30",
	});
	expect(tunnelAddress(1)).toEqual({
		relayIp: "10.200.2.1",
		encoderIp: "10.200.2.2",
		subnet: "10.200.2.1/30",
	});
});

// --- Orchestration (recorded runner + pump stubs) -----------------------------

test("setupTunnelVif: spawns the pump, then runs ip addr/mtu/up in order", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	const spawned: PumpOptions[] = [];
	const killed: number[] = [];
	stubPumps(spawned, killed);
	setCmdRunner(recordCmdRunner(calls));
	await setupTunnelVif({
		name: "utn-wwan0",
		localIp: "10.200.2.2",
		prefix: 30,
		mode: "client",
		remote: "192.168.10.104:51820",
	});
	// The pump was spawned in client mode with the remote.
	expect(spawned).toHaveLength(1);
	expect(spawned[0].mode).toBe("client");
	expect(spawned[0].remote).toBe("192.168.10.104:51820");
	// Exactly the 3 ip commands (addr, mtu, up) — no link add, no wg, no modprobe.
	expect(calls.filter((c) => ip(c.bin, c.args)).length).toBe(3);
	expect(calls[0].args).toEqual([
		"addr", "add", "10.200.2.2/30", "dev", "utn-wwan0",
	]);
	expect(calls[1].args).toEqual(["link", "set", "utn-wwan0", "mtu", "1400"]);
	expect(calls[2].args).toEqual(["link", "set", "utn-wwan0", "up"]);
});

test("setupTunnelVif: idempotent when the pump options are unchanged", async () => {
	const spawned: PumpOptions[] = [];
	const killed: number[] = [];
	stubPumps(spawned, killed);
	setCmdRunner(recordCmdRunner([]));
	await setupTunnelVif({
		name: "utn-eth0",
		localIp: "10.200.1.1",
		prefix: 30,
		mode: "server",
		bind: "10.0.0.1:51820",
	});
	await setupTunnelVif({
		name: "utn-eth0",
		localIp: "10.200.1.1",
		prefix: 30,
		mode: "server",
		bind: "10.0.0.1:51820",
	});
	// Only ONE spawn (the second is a no-op), no kill.
	expect(spawned).toHaveLength(1);
	expect(killed).toHaveLength(0);
});

test("setupTunnelVif: kills + respawns when the remote changes", async () => {
	const spawned: PumpOptions[] = [];
	const killed: number[] = [];
	stubPumps(spawned, killed);
	setCmdRunner(recordCmdRunner([]));
	await setupTunnelVif({
		name: "utn-eth0",
		localIp: "10.200.1.1",
		prefix: 30,
		mode: "client",
		remote: "10.0.0.1:51820",
	});
	await setupTunnelVif({
		name: "utn-eth0",
		localIp: "10.200.1.1",
		prefix: 30,
		mode: "client",
		remote: "10.0.0.2:51820",
	});
	expect(spawned).toHaveLength(2);
	expect(killed).toHaveLength(1);
});

test("setupTunnelVif: heals a 'File exists' leftover by flushing + retrying", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	stubPumps([], []);
	setCmdRunner(
		recordCmdRunner(
			calls,
			(bin, args) => ip(bin, args) && args[0] === "addr" && args[1] === "add",
		),
	);
	await setupTunnelVif({
		name: "utn-eth0",
		localIp: "10.200.1.1",
		prefix: 30,
		mode: "server",
		bind: "10.0.0.1:51820",
	});
	// addr-add appears TWICE (first healed away by a flush, then re-added).
	const addrAdds = calls.filter(
		(c) => ip(c.bin, c.args) && c.args[0] === "addr" && c.args[1] === "add",
	).length;
	expect(addrAdds).toBe(2);
	// A flush happened between the two.
	const flushes = calls.filter(
		(c) => ip(c.bin, c.args) && c.args[0] === "addr" && c.args[1] === "flush",
	);
	expect(flushes).toHaveLength(1);
});

test("setupTunnelVif: rejects an over-long / bad iface name", async () => {
	setCmdRunner(recordCmdRunner([]));
	await expect(
		setupTunnelVif({
			name: "utn-way-too-long-a-name",
			localIp: "10.0.0.1",
			prefix: 30,
			mode: "client",
			remote: "1.2.3.4:51820",
		}),
	).rejects.toThrow(/name too long/);
});

test("removeTunnelVif: kills the pump then issues ip link del", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	const spawned: PumpOptions[] = [];
	const killed: number[] = [];
	stubPumps(spawned, killed);
	setCmdRunner(recordCmdRunner(calls));
	await setupTunnelVif({
		name: "utn-wwan0",
		localIp: "10.200.2.2",
		prefix: 30,
		mode: "client",
		remote: "1.2.3.4:51820",
	});
	await removeTunnelVif("utn-wwan0");
	expect(killed).toHaveLength(1);
	expect(calls[calls.length - 1].args).toEqual(["link", "del", "utn-wwan0"]);
});

// --- Relay egress: policy-route + NAT ----------------------------------------

test("ensureTunnelRelayEgress: rule + route + MASQUERADE + FORWARD", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	setCmdRunner(recordCmdRunner(calls));
	await ensureTunnelRelayEgress({
		uplink: "eth0",
		tunName: "utn-eth0",
		encoderSubnet: "10.200.1.2/30",
		routeTable: 201,
		rulePriority: 1000,
	});
	// An ip rule add…
	expect(
		calls.some(
			(c) => ip(c.bin, c.args) && c.args[0] === "rule" && c.args[1] === "add",
		),
	).toBe(true);
	// …a per-tunnel default route out the uplink…
	expect(
		calls.some(
			(c) =>
				ip(c.bin, c.args) &&
				c.args[0] === "route" &&
				c.args[1] === "add" &&
				c.args.includes("table") &&
				c.args.includes("201"),
		),
	).toBe(true);
	// …and iptables NAT + FORWARD rules.
	const ipt = calls.filter((c) => c.bin.endsWith("iptables"));
	expect(ipt.length).toBeGreaterThan(0);
	expect(
		ipt.some(
			(c) =>
				c.args.includes("-t") &&
				c.args.includes("nat") &&
				c.args.includes("MASQUERADE"),
		),
	).toBe(true);
});

test("ensureTunnelRelayEgress: replaces a stale default in the per-tunnel table", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	// `route show table 101` reports a stale POC default on a DIFFERENT
	// uplink — the case that would skip the correct egress install.
	const runner = async (bin: string, args: string[]) => {
		calls.push({ bin, args: [...args] });
		if (ip(bin, args) && args[0] === "route" && args[1] === "show")
			return "default via 192.168.10.100 dev eth1";
		return "";
	};
	setCmdRunner(runner);
	await ensureTunnelRelayEgress({
		uplink: "eth0",
		tunName: "utn-eth0",
		encoderSubnet: "10.200.1.2/30",
		routeTable: 201,
		rulePriority: 1000,
	});
	// The stale default on the wrong uplink is removed…
	expect(
		calls.some(
			(c) =>
				ip(c.bin, c.args) &&
				c.args[0] === "route" &&
				c.args[1] === "del" &&
				c.args.includes("default") &&
				c.args.includes("201"),
		),
	).toBe(true);
	// …and the correct `default dev eth0` is installed in table 201.
	expect(
		calls.some(
			(c) =>
				ip(c.bin, c.args) &&
				c.args[0] === "route" &&
				c.args[1] === "add" &&
				c.args.includes("default") &&
				c.args.includes("eth0") &&
				c.args.includes("201"),
		),
	).toBe(true);
});

test("uplinkDefaultGateway: resolves the via-gateway for the given uplink", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	const runner = async (bin: string, args: string[]) => {
		calls.push({ bin, args: [...args] });
		if (ip(bin, args) && args.includes("route") && args.includes("show"))
			return [
				"default via 192.168.1.1 dev eth0",
				"default via 10.128.219.98 dev wwan0 proto static metric 700",
			].join("\n");
		return "";
	};
	setCmdRunner(runner);
	expect(await uplinkDefaultGateway("eth0")).toBe("192.168.1.1");
	expect(await uplinkDefaultGateway("wwan0")).toBe("10.128.219.98");
	expect(await uplinkDefaultGateway("usb0")).toBe("");
	expect(
		calls.some(
			(c) =>
				ip(c.bin, c.args) &&
				c.args.includes("route") &&
				c.args.includes("show") &&
				c.args.includes("-o") &&
				c.args.includes("-4"),
		),
	).toBe(true);
});

test("ensureTunnelRelayEgress: installs `via <gw>` default when the uplink has one", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	const runner = async (bin: string, args: string[]) => {
		calls.push({ bin, args: [...args] });
		if (ip(bin, args) && args.includes("route") && args.includes("show")) {
			// main-table lookup (has -o) returns the uplink gateway; the
			// per-tunnel table is empty (fresh install).
			return args.includes("-o")
				? "default via 192.168.1.1 dev eth0"
				: "";
		}
		return "";
	};
	setCmdRunner(runner);
	await ensureTunnelRelayEgress({
		uplink: "eth0",
		tunName: "utn-eth0",
		encoderSubnet: "10.200.1.2/30",
		routeTable: 201,
		rulePriority: 1000,
	});
	// The egress default must carry the via-gateway (a bare `dev eth0`
	// scope-link default breaks forwarded traffic — verified live).
	expect(
		calls.some(
			(c) =>
				ip(c.bin, c.args) &&
				c.args[0] === "route" &&
				c.args[1] === "add" &&
				c.args.includes("via") &&
				c.args.includes("192.168.1.1") &&
				c.args.includes("eth0") &&
				c.args.includes("201"),
		),
	).toBe(true);
});

test("ensureTunnelEncoderRouting: rule + isolation route + default via vif", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	setCmdRunner(recordCmdRunner(calls));
	await ensureTunnelEncoderRouting({
		tunName: "utn-eth0",
		localIp: "10.200.1.2",
		routeTable: 101,
		rulePriority: 1000,
		endpointIp: "192.168.10.100",
		endpointDev: "eth0",
	});
	// rule from <localIp> table <t>
	expect(
		calls.some(
			(c) =>
				ip(c.bin, c.args) &&
				c.args[0] === "rule" &&
				c.args[1] === "add" &&
				c.args.includes("10.200.1.2"),
		),
	).toBe(true);
	// isolation route to the endpoint over the ded link
	expect(
		calls.some(
			(c) =>
				ip(c.bin, c.args) &&
				c.args[0] === "route" &&
				c.args[1] === "add" &&
				c.args.includes("192.168.10.100/32"),
		),
	).toBe(true);
	// default via the vif
	expect(
		calls.some(
			(c) =>
				ip(c.bin, c.args) &&
				c.args[0] === "route" &&
				c.args[1] === "add" &&
				c.args.includes("default") &&
				c.args.includes("utn-eth0"),
		),
	).toBe(true);
});

test("revoke fns are best-effort (no runner set → swallow the failures)", async () => {
	await expect(
		revokeTunnelRelayEgress({
			uplink: "eth0",
			tunName: "utn-eth0",
			encoderSubnet: "10.200.1.2/30",
			routeTable: 101,
		}),
	).resolves.toBeUndefined();
	await expect(
		revokeTunnelEncoderRouting({
			localIp: "10.200.1.2",
			routeTable: 101,
			tunName: "utn-eth0",
			endpointIp: "",
			endpointDev: "eth0",
		}),
	).resolves.toBeUndefined();
});

// --- Pump exit supervision (respawn) ------------------------------------------

test("exit-watcher: a dead pump is respawned with the same config", async () => {
	const spawned: PumpOptions[] = [];
	const killed: number[] = [];
	const calls: Array<{ bin: string; args: string[] }> = [];
	stubPumps(spawned, killed);
	setCmdRunner(recordCmdRunner(calls));
	await setupTunnelVif({
		name: "utn-eth0",
		localIp: "10.200.1.1",
		prefix: 30,
		mode: "server",
		bind: "10.0.0.1:51820",
	});
	expect(spawned).toHaveLength(1);
	// Simulate the pump dying unattended → the supervisor respawns it.
	firePumpExitForTest(spawned[0]);
	await settleSpawns(spawned, 2);
	// Exactly one respawn (2 spawns total), and it re-runs the ip setup.
	expect(spawned.length).toBe(2);
	// The respawn used the SAME config (server / same bind).
	expect(spawned[1].mode).toBe("server");
	expect(spawned[1].bind).toBe("10.0.0.1:51820");
	expect(spawned[1].remote).toBeUndefined();
	// Netdev was deleted then re-addressed (addr add appears again).
	expect(
		calls.some(
			(c) => ip(c.bin, c.args) && c.args["0"] === "addr" &&
				c.args.includes("10.200.1.1/30"),
		),
	).toBe(true);
});

test("exit-watcher: an intentional teardown is NOT respawned", async () => {
	const spawned: PumpOptions[] = [];
	const killed: number[] = [];
	const pids: number[] = [];
	stubPumps(spawned, killed, pids);
	setCmdRunner(recordCmdRunner([]));
	await setupTunnelVif({
		name: "utn-eth0",
		localIp: "10.200.1.1",
		prefix: 30,
		mode: "server",
		bind: "10.0.0.1:51820",
	});
	// A config change kills the pump (marks it stopping) and spawns a new one.
	await setupTunnelVif({
		name: "utn-eth0",
		localIp: "10.200.1.1",
		prefix: 30,
		mode: "server",
		bind: "10.0.0.2:51820",
	});
	expect(spawned.length).toBe(2);
	// The OLD pump (pid 1) died AFTER being superseded by the reconfigure
	// (now pid 2) — its stale exit must be ignored, not respawn a 3rd.
	firePumpExitForTest(spawned[0], pids[0]);
	await sleep(80);
	expect(spawned.length).toBe(2); // no respawn of the stale pump
});

test("exit-watcher: a persistent failure trips the restart cap", async () => {
	const spawned: PumpOptions[] = [];
	const killed: number[] = [];
	stubPumps(spawned, killed);
	setCmdRunner(recordCmdRunner([]));
	await setupTunnelVif({
		name: "utn-wwan0",
		localIp: "10.200.2.2",
		prefix: 30,
		mode: "client",
		remote: "10.0.0.1:51821",
	});
	// Each respawn re-registers the pump (new pid) so the exit watcher
	// re-arms; firing an exit 5 more times spends the budget, then further
	// exits are ignored (no crash-loop).
	let lastOpts = spawned[0];
	for (let i = 0; i < 6; i++) {
		firePumpExitForTest(spawned[spawned.length - 1]);
		await settleSpawns(spawned, spawned.length + 1, 300);
		if (spawned.length <= i + 1) {
			// The cap tripped early — no respawn happened.
			break;
		}
		lastOpts = spawned[spawned.length - 1];
	}
	// Original + at most 5 respawns (the cap) — never more than 6 total.
	expect(spawned.length).toBeLessThanOrEqual(6);
	// Once the budget is spent, an exit is a no-op.
	const atCap = spawned.length;
	firePumpExitForTest(lastOpts);
	await sleep(120);
	expect(spawned.length).toBe(atCap);
	// The restart budget is per-vif: a config change resets it, so the pump
	// can be brought back with a fresh set of respawns.
	await setupTunnelVif({
		name: "utn-wwan0",
		localIp: "10.200.2.2",
		prefix: 30,
		mode: "client",
		remote: "10.0.0.1:51899", // changed → fresh budget
	});
	firePumpExitForTest(spawned[spawned.length - 1]);
	await settleSpawns(spawned, spawned.length + 1, 300);
	expect(spawned.length).toBe(atCap + 2); // reconfigure + one fresh respawn
});
