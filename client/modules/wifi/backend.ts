/*
 * wifi module: the WiFi (802.11) uplink, driven through NetworkManager
 * (nmcli) — scan networks, connect / disconnect, and persist the network
 * parameters (SSID, password, band, channel) on the device.
 *
 * Self-contained: the only core edge is the `core` bag handed in at start.
 * Boxes without a wireless device report `available: false` (the module
 * stays harmless there); a missing `nmcli` fails the dependency preflight.
 */
import type { BackendModule } from "../../../shared/contracts/backend_module";
import { t } from "../../../shared/i18n";
import type { ModuleCore } from "../../backend/module_core";
import log from "./log";
import type {
	WifiClient,
	WifiModuleConfig,
	WifiNetwork,
	WifiStatus,
} from "./types";

/** Core bag, bound at discovery and re-filled at start (a module never imports the core). */
let core: ModuleCore;

/** The single NetworkManager profile this module manages on the box. */
const PROFILE = "ctrl-irl-wifi";
/** How long `nmcli connection up` may block before it gives up (s). */
const CONNECT_TIMEOUT_S = 30;
/** Scan results are reused between status pushes for this long (ms). */
const SCAN_TTL_MS = 15000;

let scanCache: { at: number; networks: WifiNetwork[] } | null = null;

/** This module's settings slice (created by the core from the role defaults). */
const slice = (): WifiModuleConfig | undefined =>
	core.state.settings.modules?.wifi as WifiModuleConfig | undefined;

/** nmcli that ignores errors — absence of a device/profile is a state, not a fault. */
const nmcli = (...args: string[]) => core.run("nmcli", args, true);
/** nmcli that throws on failure — profile setup and the connect itself. */
const nmcliStrict = (...args: string[]) => core.run("nmcli", args, false);

/** The wireless device as NetworkManager sees it (null when there is none).
 * `device status` (with the GENERAL.* fields) is supported by every nmcli
 * version, unlike `device wifi -f STATE`. */
async function wirelessDevice(): Promise<{
	device: string;
	state: string;
} | null> {
	const out = await nmcli(
		"-t",
		"-f",
		"GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE",
		"device",
		"status",
	);
	for (const line of out.split("\n")) {
		const [device, type, state = ""] = line.split(":");
		if (device && type?.includes("wireless")) return { device, state };
	}
	return null;
}

/**
 * The scanned networks, cached briefly (a full scan blocks for a second or
 * two and the status push happens often). `force` re-runs the scan — that is
 * what the Scan button asks for.
 */
async function scan(force = false): Promise<WifiNetwork[]> {
	if (!force && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS)
		return scanCache.networks;
	const out = await nmcli(
		"-t",
		"-f",
		"SSID,SIGNAL,SECURITY,IN-USE",
		"device",
		"wifi",
		"list",
	);
	const networks: WifiNetwork[] = [];
	for (const line of out.split("\n")) {
		if (!line) continue;
		// "MyNet:80:WPA2,CCMP:*" — SSID, signal (0-99), security, "*" = in use.
		// A missing SSID (ad-hoc noise) is skipped; colons inside an SSID are
		// not representable in terse mode and are not worth special-casing.
		const [ssid, signal, security = "", inUse = ""] = line.split(":");
		if (!ssid) continue;
		networks.push({
			ssid,
			strength: Number.parseInt(signal, 10) || 0,
			security,
			inUse: inUse === "*",
		});
	}
	scanCache = { at: Date.now(), networks };
	return networks;
}

/** The active attachment of the wireless device (null when not connected).
 * The attached SSID comes from the scan's in-use row — the attached profile
 * name (GENERAL.CONNECTION) is the module's own con-name, not the SSID. */
async function client(): Promise<WifiClient | null> {
	const dev = await wirelessDevice();
	if (!dev?.state.startsWith("connected")) return null;
	const active = (await scan()).find((n) => n.inUse);
	if (!active) return null;
	const ipLine = (
		await core.run("ip", ["-4", "-o", "addr", "show", dev.device], true)
	).split(/\s+/);
	const ip = ipLine[3]?.split("/")[0] || null;
	return { ssid: active.ssid, strength: active.strength, ip };
}

/** The live wifi state (also the status `wifi` fragment). */
async function wifiStatus(): Promise<WifiStatus> {
	const dev = await wirelessDevice();
	if (!dev) return { available: false, client: null, networks: [] };
	return {
		available: dev.state !== "unavailable",
		client: await client(),
		networks: await scan(),
	};
}

const strParam = (params: Record<string, unknown>, key: string) =>
	typeof params[key] === "string" && params[key].trim() !== ""
		? (params[key] as string).trim()
		: undefined;

/**
 * (Re)create the module's connection profile with the requested parameters
 * and bring it up. `connect` params win over the stored slice — the settings
 * card passes its draft, so connecting also saves the new parameters.
 */
async function connect(params: Record<string, unknown>): Promise<WifiStatus> {
	const s = slice() ?? {
		enabled: false,
		ssid: "",
		password: "",
		band: "auto",
		channel: 0,
	};
	const ssid = strParam(params, "ssid") ?? s.ssid;
	if (!ssid) throw new Error("ssid is required");
	const password = strParam(params, "password") ?? s.password;
	const band = strParam(params, "band") ?? s.band ?? "auto";
	const channelRaw = params.channel;
	const channel =
		typeof channelRaw === "number" && Number.isFinite(channelRaw)
			? Math.round(channelRaw)
			: (s.channel ?? 0);

	const dev = await wirelessDevice();
	if (!dev) throw new Error(t("wifi.no_device"));

	// Rebuild the profile from scratch — one profile per box, owned by this
	// module; every parameter the operator set lands on it.
	await nmcli("connection", "delete", PROFILE);
	await nmcliStrict(
		"--mode",
		"silent",
		"connection",
		"add",
		"type",
		"wifi",
		"con-name",
		PROFILE,
		"ssid",
		ssid,
	);
	if (password)
		await nmcliStrict(
			"--mode",
			"silent",
			"connection",
			"modify",
			PROFILE,
			"802-11-wireless-security.psk",
			password,
		);
	if (band === "2.4" || band === "5")
		await nmcliStrict(
			"--mode",
			"silent",
			"connection",
			"modify",
			PROFILE,
			"802-11-wireless.band",
			band === "2.4" ? "bg" : "a",
		);
	if (channel > 0)
		await nmcliStrict(
			"--mode",
			"silent",
			"connection",
			"modify",
			PROFILE,
			"802-11-wireless.channel",
			String(channel),
		);

	// Persist the parameters next to the profile (the box restores them).
	const stored = slice();
	if (stored) {
		stored.ssid = ssid;
		if (password) stored.password = password;
		stored.band = band;
		stored.channel = channel;
		await core.saveState();
	}

	scanCache = null;
	await nmcliStrict(
		"-w",
		String(CONNECT_TIMEOUT_S),
		"--mode",
		"silent",
		"connection",
		"up",
		PROFILE,
	);
	core.logEvent("info", "wifi", t("mlog.done.wifi_connected", { ssid }));
	return wifiStatus();
}

async function disconnect(): Promise<WifiStatus> {
	const dev = await wirelessDevice();
	if (dev?.state.startsWith("connected"))
		await nmcli("device", "disconnect", dev.device);
	scanCache = null;
	core.logEvent("info", "wifi", t("mlog.done.wifi_disconnected"));
	return wifiStatus();
}

const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: "wifi",
	title: "WiFi",
	titleKey: "set.wifi",
	configDefaults: { ssid: "", password: "", band: "auto", channel: 0 },
	configFields: [
		{
			name: "ssid",
			labelKey: "set.wifi_ssid",
			type: "text",
			placeholderKey: "set.wifi_ssid_ph",
		},
		{
			name: "password",
			labelKey: "set.wifi_password",
			type: "password",
			placeholderKey: "set.wifi_password_ph",
		},
		{
			name: "band",
			labelKey: "set.wifi_band",
			type: "select",
			options: [
				["auto", "set.wifi_band_auto"],
				["2.4", "set.wifi_band_2_4"],
				["5", "set.wifi_band_5"],
			],
		},
		{
			name: "channel",
			labelKey: "set.wifi_channel",
			type: "number",
			placeholderKey: "set.wifi_channel_ph",
			min: 0,
			max: 233,
			step: 1,
		},
	],
	secretFields: ["password"],
	methods: ["wifi.status", "wifi.scan", "wifi.connect", "wifi.disconnect"],
	events: [],
	log,
	bind(c) {
		core = c;
	},
	async start(ctx) {
		core = ctx.core;
	},
	async stop() {},
	/** `nmcli` (NetworkManager) is the only hard dependency. */
	async checkDependencies() {
		const out = await core.run("which", ["nmcli"], true);
		if (!out.trim()) return { ok: false, messageKey: "wifi.no_nmcli" };
		return { ok: true };
	},
	async dispatch(method, params) {
		switch (method) {
			case "wifi.status":
				return wifiStatus();
			case "wifi.scan":
				return { networks: await scan(true) };
			case "wifi.connect":
				return connect(params);
			case "wifi.disconnect":
				return disconnect();
		}
		throw new Error(`unknown method ${method}`);
	},
	async status() {
		return { wifi: await wifiStatus() };
	},
};

export default registration;
