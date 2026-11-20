/*
 * SRTLA module: the source-routing half of the SRTLA leg — one
 * per-source routing table per bonded interface (`ip rule`/`ip route`), the
 * srtla_send uplinks file the encoder points its `srtla_send` at, and the
 * main-table default-route failover over the bond.
 *
 * Runs only on roles that carry an SRTLA leg (the encoder): the relay-side
 * box needs none of this — its network module stays at interface detection,
 * the bond selection and the live monitor.
 *
 * Pulls the `network.interfaces` capability for detection, the bond selection
 * and the monitor's debounced reconciles (its source tables self-filter their
 * own route events through `onSelfGeneratedEvent`); provides
 * `network.uplinks` (file, ensure, onChanged, programmatic entries).
 */

import { requireCapability } from "../../../shared/capabilities";
import type {
	BackendModule,
	Params,
} from "../../../shared/contracts/backend_module";
import { t } from "../../../shared/i18n";
import type { ModuleCore } from "../../backend/module_core";
import {
	UPLINKS_FILE,
	addProgrammaticUplink,
	bindSrtlaCore,
	ensureUplinksFile,
	isFailoverRunning,
	isSelfGeneratedEvent,
	listProgrammaticUplinks,
	onUplinksChanged,
	reconfigure,
	removeProgrammaticUplink,
	seedManagedTableCount,
	startDefaultRouteFailover,
	stopDefaultRouteFailover,
} from "./routing";
import type { NetworkInterfaces, UplinkEntry } from "./types";

/** Core bag, bound at discovery and re-filled at start. */
let core: ModuleCore;
/** The `network.interfaces` capability (detection, selection, monitor events). */
let netIfaces: NetworkInterfaces;

/** Unsubscribe the monitor reconcile hook on stop. */
let reconcileUnsub: (() => void) | undefined;
/** Unsubscribe the self-generated-event classifier on stop. */
let selfGenUnsub: (() => void) | undefined;

const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: "srtla",
	title: "SRTLA",
	dependencies: ["network"],
	methods: [],
	events: [],
	bind(c) {
		core = c;
		netIfaces = requireCapability<NetworkInterfaces>("network.interfaces");
		bindSrtlaCore(c, netIfaces);
	},
	async start(ctx) {
		core = ctx.core;
		netIfaces = requireCapability<NetworkInterfaces>("network.interfaces");
		// Tables a previous run left behind are ours: seed the managed count
		// so the monitor's self-event filter recognises them right away.
		void seedManagedTableCount();
		// The monitor (network module) fires these on every debounced netlink
		// reconcile — the srtla tables + uplinks file follow the live bond.
		reconcileUnsub = netIfaces.onReconcile(reconfigure);
		selfGenUnsub = netIfaces.onSelfGeneratedEvent(isSelfGeneratedEvent);
		const result = await reconfigure();
		if (!result.ok) {
			// Non-fatal: a device that boots while no uplink is up (cable
			// unplugged, modem not dialed yet, ...) must keep running — the
			// monitor re-runs the reconcile on the first interface event and
			// `ensureUplinksFile` re-syncs the file on first use.
			console.warn(
				"Initial SRTLA reconfigure failed (will retry when an interface comes up):",
				result.error,
			);
			core.logEvent(
				"warn",
				"SRTLA",
				t("log.srtla_reconfigure_failed", { error: result.error }),
			);
		} else {
			console.log(`SRTLA uplinks: ${result.ips.join(", ")}`);
		}
		startDefaultRouteFailover();
	},
	async stop() {
		reconcileUnsub?.();
		reconcileUnsub = undefined;
		selfGenUnsub?.();
		selfGenUnsub = undefined;
		stopDefaultRouteFailover();
	},
	async dispatch(method: string) {
		throw new Error(`unknown method ${method}`);
	},
	async status() {
		return {
			uplinksFile: UPLINKS_FILE,
			failover: { running: isFailoverRunning() },
		};
	},
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
		},
		consumes: ["network.interfaces"],
	},
};

export default registration;
