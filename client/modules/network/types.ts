/* Types for the network module's interface domain: the bond selection.
 * The cross-module capability contracts (modems.source, network.interfaces,
 * network.uplinks) live in shared/ — re-exported so module-internal
 * imports can stay on `./types`. */

import type {
    Iface,
    Modem,
    ModemSource,
    NetworkInterfaces,
    Uplinks,
} from "../../../shared/contracts/module_capabilities";
export type {
    Iface,
    Modem,
    ModemSource,
    NetworkInterfaces,
    Uplinks,
};

/** The persisted bond selection. Exclusion model: every interface is bonded
 * by default; `excluded` names the interfaces the user opted OUT of. A
 * newly-appearing interface is bonded automatically (it is not excluded), so
 * the bond tracks the live interface set with no per-event persistence.
 *
 * `modems` / `ips` are the legacy *include* format, kept only so a
 * pre-migration selection can still be read (see `resolveSelection`) and
 * converted once (see `migrateSelection`). A freshly-persisted selection is
 * always `{excluded: [...]}` (an empty/absent list = bond everything). */
export interface ModemConfig {
    /** Interface names removed from the bond. Absent/empty = bond all. */
    excluded?: string[];
    /** @deprecated Legacy include list (by name); migrated to `excluded`. */
    modems?: string[];
    /** @deprecated Legacy include list (by IP); migrated to `excluded`. */
    ips?: string[];
}

/**
 * One srtla_send link of the SRTLA stats push (`stream.stats`)
 * — the fields the interfaces card renders (structural: the SRTLA module
 * owns the full event type).
 */
export interface SrtlaLinkStats {
	ip: string;
	label?: string;
	connected: boolean;
	timed_out: boolean;
	bitrate_bytes_per_sec: number;
	rtt_ms: number;
	rtt_min_ms: number;
	window: number;
	in_flight: number;
	nak_count: number;
	cc_loss_permille: number;
	quality_multiplier?: number;
	base_score?: number;
	weak?: boolean;
	weak_reason?: string;
	stall_gated?: boolean;
	sole_carrier?: boolean;
}

/** The network module's status fragment (deep-merged into the device status). */
export interface NetworkStatus {
	interfaces: Iface[];
	selected: Iface[];
	selection?: ModemConfig;
	modems?: import("../../../shared/contracts/module_capabilities").Modem[];
	/** CtrLink relays this encoder has learned about (via UDP announce /
	 * manual config), each with the tunnel interfaces the relay offers. The
	 * interface list renders these as a grouped section per relay after the
	 * device's own interfaces (encoder role only). */
	registeredRelays?: import("../../../shared/contracts/module_capabilities").CtrlinkDiscoveredRelay[];
	defaultRouteInterface?: string | null;
	defaultRouteSourceIp?: string | null;
	monitor?: { running: boolean };
}

/**
 * Capability note: the `network.uplinks` contract is the `Uplinks` type
 * (shared/contracts/module_capabilities.ts, re-exported above) — the bonded
 * uplinks file plus a change hook; the consumer (encoder) reloads
 * its `srtla_send` (SIGHUP first, restart as fallback) when it fires.
 */
