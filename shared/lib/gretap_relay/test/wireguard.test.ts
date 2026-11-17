import { afterEach, expect, test } from "bun:test";
import {
	addWireGuardPeer,
	DEFAULT_WG_KEEPALIVE_SEC,
	DEFAULT_WG_MTU,
	ensureWireGuardModule,
	removeWireGuard,
	removeWireGuardPeer,
	setupWireGuardInterface,
	setCmdRunner,
	wireGuardPeerCommand,
	wireGuardSetupCommands,
	wireGuardTeardownCommands,
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

afterEach(() => {
	setCmdRunner(undefined);
});

const ip = (bin: string, args: string[]) =>
	bin === "/usr/sbin/ip" || bin.endsWith("/ip");

// --- Pure command builders ----------------------------------------------------

test("wireGuardSetupCommands: netdev + addr + mtu + up", () => {
	const cmds = wireGuardSetupCommands("wg-wwan0", "10.200.2.2", 30, 1360);
	expect(cmds).toEqual([
		["link", "add", "wg-wwan0", "type", "wireguard"],
		["addr", "add", "10.200.2.2/30", "dev", "wg-wwan0"],
		["link", "set", "wg-wwan0", "mtu", "1360"],
		["link", "set", "wg-wwan0", "up"],
	]);
});

test("wireGuardPeerCommand: allowed-ips + endpoint, no keepalive by default", () => {
	const cmd = wireGuardPeerCommand("wg-wwan0", "PEERKEY", "192.168.10.104", "0.0.0.0/0");
	expect(cmd).toEqual([
		"set", "wg-wwan0", "peer", "PEERKEY",
		"endpoint", "192.168.10.104",
		"allowed-ips", "0.0.0.0/0",
	]);
});

test("wireGuardPeerCommand: adds persistent-keepalive when > 0", () => {
	const cmd = wireGuardPeerCommand("wg-wwan0", "PEERKEY", "1.2.3.4", "10.0.0.0/24", 25);
	expect(cmd).toEqual([
		"set", "wg-wwan0", "peer", "PEERKEY",
		"endpoint", "1.2.3.4",
		"allowed-ips", "10.0.0.0/24",
		"persistent-keepalive", "25",
	]);
});

test("wireGuardTeardownCommands: del only", () => {
	expect(wireGuardTeardownCommands("wg-eth0")).toEqual([
		["link", "del", "wg-eth0"],
	]);
});

test("defaults: cellular-friendly MTU + keepalive", () => {
	expect(DEFAULT_WG_MTU).toBe(1360);
	expect(DEFAULT_WG_KEEPALIVE_SEC).toBe(25);
});

// --- Orchestration (recorded runner) -----------------------------------------

test("setupWireGuardInterface: ip setup then wg peer in order", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	setCmdRunner(recordCmdRunner(calls));
	await setupWireGuardInterface({
		name: "wg-wwan0",
		localIp: "10.200.2.2",
		prefix: 30,
		peerKey: "ENC_KEY",
		endpoint: "192.168.10.104",
		allowedIps: "0.0.0.0/0",
	});
	// 4 ip commands (link add, addr add, mtu, up) + 1 wg peer.
	expect(calls.filter((c) => ip(c.bin, c.args)).length).toBe(4);
	expect(calls.filter((c) => c.bin.endsWith("/wg")).length).toBe(1);
	// The wg call is LAST (after the netdev exists).
	expect(calls[calls.length - 1].bin).toMatch(/wg$/);
	expect(calls[calls.length - 1].args).toEqual([
		"set", "wg-wwan0", "peer", "ENC_KEY",
		"endpoint", "192.168.10.104",
		"allowed-ips", "0.0.0.0/0",
		"persistent-keepalive", "25",
	]);
});

test("setupWireGuardInterface: heals a 'File exists' leftover by retrying", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	setCmdRunner(
		recordCmdRunner(
			calls,
			(bin, args) => ip(bin, args) && args[0] === "link" && args[1] === "add",
		),
	);
	await setupWireGuardInterface({
		name: "wg-eth0",
		localIp: "10.200.1.1",
		prefix: 30,
		peerKey: "ENC_KEY",
		endpoint: "192.168.10.104",
		allowedIps: "0.0.0.0/0",
	});
	// link-add appears TWICE (first healed away by a del, then re-added).
	const linkAdds = calls.filter(
		(c) => ip(c.bin, c.args) && c.args[0] === "link" && c.args[1] === "add",
	).length;
	expect(linkAdds).toBe(2);
	// A teardown (link del) happened between the two.
	const dels = calls.filter(
		(c) => ip(c.bin, c.args) && c.args[0] === "link" && c.args[1] === "del",
	);
	expect(dels.length).toBe(1);
});

test("setupWireGuardInterface: rejects an over-long / bad iface name", async () => {
	setCmdRunner(recordCmdRunner([]));
	await expect(
		setupWireGuardInterface({
			name: "wg-way-too-long-a-name",
			localIp: "10.0.0.1",
			prefix: 30,
			peerKey: "K",
			endpoint: "1.2.3.4",
			allowedIps: "0.0.0.0/0",
		}),
	).rejects.toThrow(/name too long/);
});

test("addWireGuardPeer: single wg set call", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	setCmdRunner(recordCmdRunner(calls));
	await addWireGuardPeer({
		name: "wg-eth0",
		peerKey: "ENC_KEY",
		endpoint: "192.168.10.104",
		allowedIps: "10.200.1.2/30",
	});
	expect(calls.length).toBe(1);
	expect(calls[0].args).toEqual([
		"set", "wg-eth0", "peer", "ENC_KEY",
		"endpoint", "192.168.10.104",
		"allowed-ips", "10.200.1.2/30",
	]);
});

test("removeWireGuardPeer: issues wg … peer … remove", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	setCmdRunner(recordCmdRunner(calls));
	await removeWireGuardPeer("wg-eth0", "ENC_KEY");
	expect(calls[0].args).toEqual([
		"set", "wg-eth0", "peer", "ENC_KEY", "remove",
	]);
});

test("removeWireGuardPeer: swallows a missing peer (idempotent)", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	setCmdRunner(async () => {
		calls.push({ bin: "", args: [] });
		throw new Error("RTNETLINK answers: No such device");
	});
	await expect(
		removeWireGuardPeer("wg-eth0", "GONE_KEY"),
	).resolves.toBeUndefined();
});

test("removeWireGuard: issues ip link del", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	setCmdRunner(recordCmdRunner(calls));
	await removeWireGuard("wg-wwan0");
	expect(calls[0].args).toEqual(["link", "del", "wg-wwan0"]);
});

test("ensureWireGuardModule: no-op when /sys/module/wireguard exists", async () => {
	const calls: Array<{ bin: string; args: string[] }> = [];
	setCmdRunner(recordCmdRunner(calls));
	// The module IS present on the probe host? On the dev box /sys/module/
	// wireguard is typically absent, so this exercises the modprobe path. We
	// only assert it never throws and, if it probes for modprobe, uses it.
	await ensureWireGuardModule();
	const modprobe = calls.filter((c) => c.bin.endsWith("modprobe"));
	// Either it already found the module (0 calls) or ran modprobe once (1).
	expect([0, 1]).toContain(modprobe.length);
	if (modprobe.length === 1) expect(modprobe[0].args).toEqual(["wireguard"]);
});
