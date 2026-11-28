/*
 * Local types for the wifi module (never imported by the core or other modules).
 */
import type { ModuleSliceView } from "../../../shared/contracts/wire";

/** The persisted configuration slice of the wifi module (the `modules.wifi` state). */
export interface WifiModuleConfig {
	enabled: boolean;
	/** The SSID to connect to. */
	ssid: string;
	/** The network password (WPA pre-shared key). */
	password: string;
	/** Frequency band: "auto" | "2.4" | "5". */
	band: string;
	/** Preferred channel (0 = automatic). */
	channel: number;
}

/** A scanned wireless network (the `wifi.scan` / `wifi.status` networks). */
export interface WifiNetwork {
	ssid: string;
	/** Signal strength 0-99. */
	strength: number;
	/** Security flags reported by NetworkManager (e.g. "WPA2,CCMP"). */
	security: string;
	/** True when the device is attached to this network. */
	inUse: boolean;
}

/** The active WiFi attachment (null when not connected). */
export interface WifiClient {
	ssid: string;
	/** Signal strength 0-99. */
	strength: number;
	/** The IPv4 address on the wireless interface (null when none). */
	ip: string | null;
}

/** Live wifi state (the `wifi.status` result, the status `wifi` fragment). */
export interface WifiStatus {
	/** A wireless device is present and NetworkManager can drive it. */
	available: boolean;
	/** The active attachment (null when not connected). */
	client: WifiClient | null;
	/** The last scan results (empty when there is no device). */
	networks: WifiNetwork[];
}

/** The module's slice of the modules view — safeModules() masks the password as `{configured}`. */
export interface WifiSliceView extends ModuleSliceView {
	ssid?: string;
	password?: { configured: boolean };
	band?: string;
	channel?: number;
}
