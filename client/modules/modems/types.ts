/* Types for the modems module. The modem shape and the `modems.source`
 * capability contract live in shared/ (the network module codes against
 * the same contract); `ModemInfo` is the module-internal alias. */

import type { Modem } from "../../../shared/contracts/module_capabilities";

export type {
	ModemSource,
	ScannedNetwork,
} from "../../../shared/contracts/module_capabilities";

/** A ModemManager modem with the details the panels display. */
export type ModemInfo = Modem;

/**
 * A `modems.setup` request: every field is optional and `undefined` means
 * "leave as-is", so a call can touch just the band mode, just the APN, or
 * everything (belaUI parity — `handleModemConfig` applies all fields at once).
 */
export interface ModemNetworkSetup {
	/** PLMN id ("23003"); omit to keep the automatic home-network selection. */
	plmn?: string;
	/**
	 * Long name of the selected PLMN (from the scan row). Cached so the UI can
	 * show a name for a saved selection; not written to the profile.
	 */
	operatorName?: string;
	/** APN to dial (ignored, and cleared, when `autoConfig` is on). */
	apn?: string;
	/** APN username for network-credential-carrier profiles. */
	username?: string;
	/** APN password; empty string clears it. */
	password?: string;
	/** Allow roaming (`false` = home-only). */
	allowRoaming?: boolean;
	/** Let NetworkManager auto-configure the APN (`true` = no fixed APN). */
	autoConfig?: boolean;
	/** Allowed RATs, e.g. `["gsm", "lte"]`; omit to keep the current mode. */
	allowedModes?: string[];
	/** Preferred RAT among the allowed ones; omit to keep / use auto. */
	preferredMode?: string;
}

/** One modem's latest user-plane keepalive (`modems.keepalive` event). */
export interface ModemKeepalive {
	index: number;
	iface: string | null;
	/** True when the local UDP send succeeded, not a delivery confirmation. */
	ok: boolean;
	/** Epoch ms of the attempt. */
	at: number;
}

/** Payload of the `modems.keepalive` event. */
export interface ModemKeepaliveEvent {
	target: string;
	port: number;
	intervalMs: number;
	keepalives: ModemKeepalive[];
}

/** The modems module's status fragment (deep-merged into the device status). */
export interface ModemsStatus {
    modems: ModemInfo[];
}
