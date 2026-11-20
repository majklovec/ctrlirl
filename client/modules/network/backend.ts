/*
 * Network module: the interface routing layer the `encoder` role uses —
 * interface detection, the SRT bond selection, the source-routing
 * tables (`ip rule`/`ip route`), the srtla_send uplinks file and the live
 * netlink monitor that keeps it in sync with the machine's interfaces.
 *
 * The SRTLA leg owner (the encoder) doesn't touch any of that directly:
 * it pulls the `network.uplinks` capability and points its `srtla_send` at
 * `uplinks.file()`, reloading (SIGHUP, restart fallback) on `uplinks.onChanged`.
 * The uplinks-changed handlers are registered by the consuming modules, so
 * one network module serves the role without knowing which one is running.
 */

import { requireCapability } from "../../../shared/capabilities";
import type {
	BackendModule,
	Params,
} from "../../../shared/contracts/backend_module";
import type {
	CtrlinkDiscoveredRelay,
	UplinkEntry,
} from "../../../shared/contracts/module_capabilities";
import { t } from "../../../shared/i18n";
import {
	ApiError,
	optionalStringList,
	requireString,
} from "../../../shared/params";
import type { ModuleCore } from "../../backend/module_core";
import log from "./log";
import {
	addProgrammaticUplink,
	bindRouting,
	defaultRouteDetails,
	detectInterfaces,
	ensureUplinksFile,
	isMonitorRunning,
	listNetworkInterfaces,
	listProgrammaticUplinks,
	migrateSelection,
	onInterfaceChange,
	onUplinksChanged,
	reconfigure,
	removeProgrammaticUplink,
	resolveSelection,
	selection,
	setSelection,
	startDefaultRouteFailover,
	startInterfaceMonitor,
	stopDefaultRouteFailover,
	stopInterfaceMonitor,
	UPLINKS_FILE,
} from "./routing";
import type { Iface, Modem, ModemConfig, ModemSource } from "./types";

/** Core bag, bound at discovery and re-filled at start (a module never imports the core). */
let core: ModuleCore;
let modemSource: ModemSource;

/**
 * The Ctrlink relays this device (encoder) has learned about, keyed by host.
 * Written by the `ctrlink_streamer` module as it discovers/configures relays;
 * surfaced on the network card grouped per-relay. In-memory (TTL'd upstream).
 */
const ctrlinkRelays = new Map<string, CtrlinkDiscoveredRelay>();

/** The interfaces chosen for the bond, enriched with the modem details from the modems module. */
async function modemStatus(): Promise<{
	interfaces: Iface[];
	selected: Iface[];
	modems: Modem[];
}> {
	const modems = await modemSource.detect();
	const interfaces = await detectInterfaces(modems);
	return { interfaces, selected: resolveSelection(interfaces), modems };
}

/**
 * Apply a bond selection: persist it, then rewrite the routing tables and the
 * uplinks file. `reconfigure` notifies the SRTLA leg owners (the encoder) so
 * they reload `srtla_send` when the file content changed.
 */
async function applySelection(next: ModemConfig) {
	await setSelection(next);
	const result = await reconfigure();
	if (!result.ok) throw new ApiError(result.error ?? "reconfigure failed", 500);
	return { selection: selection(), ...result };
}

async function selectModems(p: Params) {
	const names = optionalStringList(p, "modems");
	const ips = optionalStringList(p, "ips");
	const all = await detectInterfaces();
	const badIfaces =
		names?.filter((name) => !all.some((iface) => iface.iface === name)) ?? [];
	if (badIfaces.length)
		throw new ApiError(`Unknown interfaces: ${badIfaces.join(", ")}`);
	const badIps =
		ips?.filter((ip) => !all.some((iface) => iface.ip === ip)) ?? [];
	if (badIps.length) throw new ApiError(`Unknown IPs: ${badIps.join(", ")}`);
	// "Select these" in the exclusion model = exclude everything else, so a
	// later-appearing interface (absent from the picked set) is still bonded
	// by default.
	const included = new Set(
		names !== undefined
			? names
			: ips !== undefined
				? ips
						.map((ip) => all.find((iface) => iface.ip === ip)?.iface)
						.filter((n): n is string => !!n)
				: all.map((iface) => iface.iface),
	);
	return applySelection({
		excluded: all
			.map((iface) => iface.iface)
			.filter((name) => !included.has(name)),
	});
}

async function toggleModem(p: Params) {
	const name = requireString(p, "iface");
	const all = await detectInterfaces();
	if (!all.some((iface) => iface.iface === name))
		throw new ApiError(`Unknown interface: ${name}`, 404);
	// Resolve in the exclusion form (migrating a legacy selection first): the
	// bond is everything not excluded, so a toggle flips `name` between bonded
	// and excluded — persisted as such.
	await migrateSelection(all);
	const excluded = new Set(selection().excluded ?? []);
	if (excluded.has(name)) excluded.delete(name); // was out of the bond -> in
	else excluded.add(name); // was in the bond -> out
	// An excluded CtrLink TUN needs no special care: the uplinks file leaves
	// out a programmatic uplink (ctrlink_streamer registers one per TUN)
	// whose source sits on an excluded interface.
	return applySelection({ excluded: [...excluded] });
}

/** The module's bond selection used to live in the relay section: adopt it once. */
function adoptSelection(c: ModuleCore): void {
	const data = c.state.data;
	const legacy = (data.relay as Record<string, unknown> | undefined)?.selection;
	const net = (data.network ?? {}) as Record<string, unknown>;
	if (legacy !== undefined && net.selection === undefined) {
		data.network = { ...net, selection: legacy };
	}
}

const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: "network",
	title: "Network",
	dependencies: ["modems"],
	methods: ["interfaces.list", "reconfigure", "modems.select", "modems.toggle"],
	events: [],
	dashboardActions: [
		{
			id: "reconfigure",
			label: "act.network.reconfigure",
			icon: "↻",
			method: "reconfigure",
		},
	],
	log,
	bind(c) {
		core = c;
		adoptSelection(c);
		modemSource = requireCapability<ModemSource>("modems.source");
		bindRouting(c, modemSource);
	},
	async start(ctx) {
		core = ctx.core;
		// Watch before the initial reconfigure: an interface that comes up
		// while it runs (boot: DHCP, modems dialing) would otherwise be
		// missed and the uplinks file would stay behind the selection.
		startInterfaceMonitor();
		const result = await reconfigure();
		if (!result.ok) {
			// Non-fatal: a device that boots while no uplink is up (cable
			// unplugged, modem not dialed yet, ...) must keep running — the
			// interface monitor re-runs reconfigure() on the first interface
			// event and heals the bond, and `ensureUplinksFile` re-syncs the
			// uplinks file with the selection on first use.
			console.warn(
				"Initial reconfigure failed (will retry when an interface comes up):",
				result.error,
			);
			core.logEvent(
				"warn",
				"Interfaces",
				t("log.reconfigure_failed", { error: result.error }),
			);
		} else {
			console.log(`Initial uplinks: ${result.ips.join(", ")}`);
		}
		startDefaultRouteFailover();
	},
	async stop() {
		stopDefaultRouteFailover();
		await stopInterfaceMonitor();
	},
	async dispatch(method, p) {
		switch (method) {
			case "interfaces.list":
				return { interfaces: await detectInterfaces() };
			case "reconfigure":
				return reconfigure();
			case "modems.select":
				return selectModems(p);
			case "modems.toggle":
				return toggleModem(p);
		}
		throw new Error(`unknown method ${method}`);
	},
	async status() {
		const [modem, defaultRoute] = await Promise.all([
			modemStatus(),
			defaultRouteDetails(),
		]);
		return {
			...modem,
			selection: selection(),
			registeredRelays: [...ctrlinkRelays.values()],
			defaultRouteInterface: defaultRoute?.iface ?? null,
			defaultRouteSourceIp: defaultRoute?.ip ?? null,
			uplinksFile: UPLINKS_FILE,
			monitor: { running: isMonitorRunning() },
		};
	},
	dashboardWidgets: [{ type: "network", defaultSize: { w: 4, h: 5 } }],
	services: {
		capabilities: {
			"network.uplinks": {
				file: () => UPLINKS_FILE,
				ensure: ensureUplinksFile,
				onChanged: onUplinksChanged,
				add: (entry: UplinkEntry) =>
					addProgrammaticUplink(entry.id, entry.source, entry.label),
				remove: (id: string) => removeProgrammaticUplink(id),
				list: listProgrammaticUplinks,
			},
			"network.interfaces": {
				list: listNetworkInterfaces,
				onChanged: onInterfaceChange,
				ensureMonitoring: async () => {
					startInterfaceMonitor();
				},
			},
			"network.ctrlink": {
				upsertRelay: (r: CtrlinkDiscoveredRelay) => {
					ctrlinkRelays.set(r.host, r);
				},
				dropRelay: (host: string) => {
					ctrlinkRelays.delete(host);
				},
				listRelays: () => [...ctrlinkRelays.values()],
			},
		},
		consumes: ["modems.source"],
	},
};

export default registration;
