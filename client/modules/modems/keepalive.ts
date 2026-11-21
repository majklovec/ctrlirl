/*
 * Cellular user-plane keepalive: periodically send one UDP packet out of every
 * connected modem's interface. Carriers release an idle bearer (and its NAT
 * mappings) after their inactivity timer. A small packet every 45–60 s is
 * intended to keep the bearer active. Results are pushed as the retained
 * `modems.keepalive` event.
 */
import { argEnv, intArgEnv } from "../../../shared/args";
import type { Emit } from "../../../shared/contracts/backend_module";
import { errorMessage } from "../../../shared/util";
import { sendKeepalive } from "./keepalive_udp";
import type { ModemInfo, ModemKeepalive, ModemKeepaliveEvent } from "./types";

export const KEEPALIVE_EVENT = "modems.keepalive";
const KEEPALIVE_INTERVAL_MS = intArgEnv(
	"--modem-keepalive-ms",
	"MODEM_KEEPALIVE_MS",
	50_000,
	5_000,
);
const KEEPALIVE_TARGET = argEnv(
	"--modem-keepalive-target",
	"MODEM_KEEPALIVE_TARGET",
	"1.1.1.1",
);
const KEEPALIVE_PORT = intArgEnv(
	"--modem-keepalive-port",
	"MODEM_KEEPALIVE_PORT",
	53,
	1,
	65535,
);

interface KeepaliveDeps {
	detect: () => Promise<ModemInfo[]>;
	modemIface: (modem: ModemInfo) => Promise<string | null>;
	emit: Emit;
	send?: typeof sendKeepalive;
	target?: string;
	port?: number;
	intervalMs?: number;
	now?: () => number;
}

/** One pass: send out of every connected modem and emit the results. */
export async function keepaliveTick(deps: KeepaliveDeps): Promise<void> {
	const target = deps.target ?? KEEPALIVE_TARGET;
	const port = deps.port ?? KEEPALIVE_PORT;
	const now = deps.now ?? Date.now;
	const connected = (await deps.detect()).filter(
		(m) => m.state === "connected",
	);
	const keepalives = await Promise.all(
		connected.map(async (modem): Promise<ModemKeepalive> => {
			let iface: string | null = null;
			try {
				iface = await deps.modemIface(modem);
				if (!iface) throw new Error("no connected bearer interface");
				await (deps.send ?? sendKeepalive)(iface, target, port);
				return { index: modem.index, iface, ok: true, at: now() };
			} catch (err: unknown) {
				console.warn(
					`[modems] keepalive for modem #${modem.index} failed:`,
					errorMessage(err),
				);
				return { index: modem.index, iface, ok: false, at: now() };
			}
		}),
	);
	const payload: ModemKeepaliveEvent = {
		target,
		port,
		intervalMs: deps.intervalMs ?? KEEPALIVE_INTERVAL_MS,
		keepalives,
	};
	deps.emit(KEEPALIVE_EVENT, payload, { retain: true });
}

let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;

/** Start the periodic keepalive loop (idempotent); first send fires now. */
export function startModemKeepalive(deps: KeepaliveDeps): void {
	if (timer) return;
	const current = ++generation;
	let busy = false;
	const intervalMs = deps.intervalMs ?? KEEPALIVE_INTERVAL_MS;
	const tick = () => {
		if (busy) return;
		busy = true;
		void keepaliveTick({
			...deps,
			intervalMs,
			emit: (...args) => {
				if (generation === current) deps.emit(...args);
			},
		})
			.catch((err: unknown) =>
				console.warn("[modems] keepalive error:", errorMessage(err)),
			)
			.finally(() => {
				busy = false;
			});
	};
	console.log(
		`[modems] UDP keepalive to ${deps.target ?? KEEPALIVE_TARGET}:${deps.port ?? KEEPALIVE_PORT} every ${intervalMs}ms`,
	);
	tick();
	timer = setInterval(tick, intervalMs);
}

/** Stop the keepalive loop and drop the retained event. */
export function stopModemKeepalive(emit?: Emit): void {
	if (timer) clearInterval(timer);
	timer = null;
	generation++;
	emit?.(KEEPALIVE_EVENT, null, { retain: false });
}
