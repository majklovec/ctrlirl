import { describe, expect, spyOn, test } from "bun:test";
import { createSocket } from "node:dgram";
import type { ModuleCore } from "../client/backend/module_core";
import {
	KEEPALIVE_EVENT,
	keepaliveTick,
	startModemKeepalive,
	stopModemKeepalive,
} from "../client/modules/modems/keepalive";
import { sendKeepalive } from "../client/modules/modems/keepalive_udp";
import {
	bindModemManager,
	modemActiveNetworkIface,
} from "../client/modules/modems/modems";
import type { ModemInfo } from "../client/modules/modems/types";

const modem = (index: number, state: string): ModemInfo => ({
	index,
	path: "",
	state,
	powerState: "on",
});

describe("UDP modem keepalive", () => {
	test("sends a DNS datagram over a real loopback socket", async () => {
		const server = createSocket("udp4");
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.bind(0, "127.0.0.1", resolve);
			});
			const received = new Promise<Buffer>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("UDP packet not received")),
					2000,
				);
				server.once("message", (packet) => {
					clearTimeout(timeout);
					resolve(packet);
				});
			});
			await sendKeepalive("lo", "127.0.0.1", server.address().port);
			expect([...(await received)]).toEqual([
				0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1,
			]);
		} finally {
			server.close();
		}
	});

	test("does not fall back to another interface when the requested device is absent", async () => {
		await expect(sendKeepalive("missing0", "127.0.0.1", 53)).rejects.toThrow(
			"SO_BINDTODEVICE",
		);
	});

	test("only sends on connected modems and reports failures independently", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const sent: string[] = [];
			const emitted: unknown[][] = [];
			await keepaliveTick({
				send: async (iface, target, port) => {
					sent.push(`${iface}:${target}:${port}`);
					if (iface === "wwan2") throw new Error("no route");
				},
				detect: async () => [
					modem(0, "connected"),
					modem(1, "registered"),
					modem(2, "connected"),
					modem(3, "connected"),
				],
				modemIface: async (m) => (m.index === 3 ? null : `wwan${m.index}`),
				emit: (...args) => emitted.push(args),
				target: "1.1.1.1",
				port: 53,
				intervalMs: 50_000,
				now: () => 1000,
			});
			expect(sent.sort()).toEqual(["wwan0:1.1.1.1:53", "wwan2:1.1.1.1:53"]);
			expect(emitted).toEqual([
				[
					KEEPALIVE_EVENT,
					{
						target: "1.1.1.1",
						port: 53,
						intervalMs: 50_000,
						keepalives: [
							{ index: 0, iface: "wwan0", ok: true, at: 1000 },
							{ index: 2, iface: "wwan2", ok: false, at: 1000 },
							{ index: 3, iface: null, ok: false, at: 1000 },
						],
					},
					{ retain: true },
				],
			]);
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	test("does not publish an in-flight result after stop", async () => {
		let finish!: () => void;
		const inFlight = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const emitted: unknown[][] = [];
		startModemKeepalive({
			detect: async () => [modem(0, "connected")],
			modemIface: async () => "wwan0",
			send: async () => inFlight,
			emit: (...args) => emitted.push(args),
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		stopModemKeepalive((...args) => emitted.push(args));
		finish();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(emitted).toEqual([[KEEPALIVE_EVENT, null, { retain: false }]]);
	});
});

test("resolves only the current modem's connected bearer", async () => {
	const commands: string[] = [];
	const run: ModuleCore["run"] = async (command, args) => {
		commands.push(`${command} ${args.join(" ")}`);
		if (args.join(" ") === "-m 1 --output-keyvalue")
			return [
				"modem.generic.bearers.value[1]: /org/freedesktop/ModemManager1/Bearer/5",
				"modem.generic.bearers.value[2]: /org/freedesktop/ModemManager1/Bearer/6",
			].join("\n");
		if (args.join(" ") === "-b 5") return "connected: no\ninterface: wwan0";
		if (args.join(" ") === "-b 6") return "connected: yes\ninterface: wwan1";
		return "";
	};
	bindModemManager({ run } as ModuleCore);
	expect(await modemActiveNetworkIface(modem(1, "connected"))).toBe("wwan1");
	expect(await modemActiveNetworkIface(modem(2, "connected"))).toBeNull();
	expect(commands.some((command) => command.startsWith("ip "))).toBe(false);
});
