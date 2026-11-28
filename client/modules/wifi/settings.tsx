/**
 * WiFi controls for the Settings page.
 *
 * Visible for every role that serves the (optional) wifi module. The network
 * parameters live under `modules.wifi` and are saved when Connect is pressed
 * (the device persists them with the NetworkManager profile).
 *
 * The card shows the live state (connected network + IP, last scan) and lets
 * the operator pick a scanned network by tapping it, fill in its password,
 * choose the band/channel and connect or disconnect.
 *
 * Default-exports its ModuleDef; the settings framework registers it from the
 * generated manifest (generated/modules.settings.ts) — no per-module imports.
 */

import {
	Actions,
	Button,
	Field,
	Input,
	Options,
	Select,
} from "@ui/components/";
import { t } from "@ui/i18n";
import m from "mithril";
import { roleServes } from "../../../shared/ui/role_view";
import type { ModuleContext, ModuleDef } from "../../frontend/modules";
import log from "./log";
import "./styles.css";
import type { WifiSliceView } from "./types";

/** Editable copy of the module's WiFi parameters (channel is a form string:
 * "" = automatic). */
const draft = {
	ssid: "",
	password: "",
	band: "auto",
	channel: "",
};

/** A scanned wireless network. */
interface WifiNetwork {
	ssid: string;
	strength: number;
	security: string;
	inUse: boolean;
}

/** Live wifi state as last reported by the device (the status `wifi` fragment). */
interface WifiStatus {
	available: boolean;
	client: { ssid: string; strength: number; ip: string | null } | null;
	networks: WifiNetwork[];
}

let wifi: WifiStatus | null = null;
/** The card's own subscription to status pushes (the live attached network +
 * scan only arrive in the top-level `wifi` fragment). */
let sub: (() => void) | undefined;

function adopt(status: WifiStatus | null): void {
	wifi = status;
	m.redraw();
}

async function connect(ctx: ModuleContext): Promise<void> {
	const channel = Number.parseInt(draft.channel, 10);
	const result = await ctx.run(() =>
		ctx.rpc.call<WifiStatus>("wifi.connect", {
			ssid: draft.ssid,
			// A blank password keeps the stored one (the device falls back
			// to its slice).
			password: draft.password,
			band: draft.band,
			channel: Number.isFinite(channel) ? channel : 0,
		}),
	);
	adopt(result);
	draft.password = ""; // the stored secret is write-only
	ctx.note(
		t("mlog.done.wifi_connected", { ssid: result.client?.ssid ?? draft.ssid }),
	);
}

async function disconnect(ctx: ModuleContext): Promise<void> {
	const result = await ctx.run(() =>
		ctx.rpc.call<WifiStatus>("wifi.disconnect"),
	);
	adopt(result);
	ctx.note(t("mlog.done.wifi_disconnected"));
}

async function scan(ctx: ModuleContext): Promise<void> {
	const result = await ctx.run(() =>
		ctx.rpc.call<{ networks: WifiNetwork[] }>("wifi.scan"),
	);
	if (wifi) {
		wifi.networks = result.networks;
	} else {
		wifi = {
			available: true,
			client: null,
			networks: result.networks,
		};
	}
	ctx.note(t("mlog.done.wifi_scan"));
}

/** A scanned row's label (signal + security flags). */
const netLabel = (net: WifiNetwork): string =>
	`${net.strength}%${net.security ? ` · ${net.security}` : ""}`;

export const def: ModuleDef = {
	id: "wifi",
	titleKey: "set.wifi",
	log,
	visible: (ctx) => roleServes(ctx.role, "wifi"),
	refresh: (ctx) => {
		const s = ctx.modules.wifi as WifiSliceView | undefined;
		draft.ssid = s?.ssid ?? "";
		draft.password = ""; // masked on the device — write-only
		draft.band = s?.band ?? "auto";
		draft.channel =
			typeof s?.channel === "number" && s.channel > 0 ? String(s.channel) : "";
		// The connect-time push can arrive before this card subscribes, so
		// fetch the live state.
		void ctx.rpc
			.call<WifiStatus | null>("wifi.status")
			.then(adopt)
			.catch(() => {});
		m.redraw();
	},
	render: (ctx) => {
		// The live attached network only comes in the status pushes'
		// top-level `wifi` fragment, so this card keeps its own subscription.
		if (!sub) {
			sub = ctx.rpc.on("status", (data) => {
				adopt(
					(data as { wifi?: WifiStatus | null } | null | undefined)?.wifi ??
						null,
				);
			});
		}
		const busy = ctx.busy;
		const client = wifi?.client ?? null;
		const networks = wifi?.networks ?? [];
		return [
			<p class="muted" key="hint">
				{t("set.wifi_desc")}
			</p>,
			<div key="card" class="mod-wifi">
				<p class="muted" key="state">
					{client
						? t("set.wifi_connected", {
								ssid: client.ssid,
								ip: client.ip ?? "—",
							})
						: wifi?.available
							? t("set.wifi_not_connected")
							: t("set.wifi_no_device")}
				</p>
				,
				{networks.length > 0 ? (
					<ul class="wifi-networks" key="nets">
						{networks.map((net) => (
							<li key={net.ssid} class={net.inUse ? "in-use" : undefined}>
								<button
									type="button"
									onclick={() => {
										draft.ssid = net.ssid;
										m.redraw();
									}}
								>
									<span>{net.ssid}</span>
									<span class="muted">{netLabel(net)}</span>
								</button>
							</li>
						))}
					</ul>
				) : (
					<p class="muted" key="nets">
						{t("set.wifi_no_networks")}
					</p>
				)}
				<Field
					label={t("set.wifi_ssid")}
					control={<Input target={draft} prop="ssid" autocomplete="off" />}
				/>
				<Field
					label={t("set.wifi_password")}
					control={
						<Input
							target={draft}
							prop="password"
							type="password"
							autocomplete="new-password"
							placeholder={t("set.wifi_password_ph")}
						/>
					}
				/>
				<Select target={draft} prop="band">
					<Options
						pairs={[
							["auto", t("set.wifi_band_auto")],
							["2.4", t("set.wifi_band_2_4")],
							["5", t("set.wifi_band_5")],
						]}
					/>
				</Select>
				<Field
					label={t("set.wifi_channel")}
					control={
						<input
							type="number"
							min={1}
							max={233}
							step={1}
							placeholder={t("set.wifi_channel_ph")}
							value={draft.channel}
							oninput={(e: Event) => {
								draft.channel = (e.target as HTMLInputElement).value;
								m.redraw();
							}}
						/>
					}
				/>
				<Actions>
					<Button
						label={t("set.wifi_scan")}
						disabled={busy}
						onclick={() => void scan(ctx)}
					/>
					<Button
						label={t("set.wifi_connect")}
						disabled={busy || !wifi?.available || !draft.ssid}
						onclick={() => void connect(ctx)}
					/>
					<Button
						label={t("set.wifi_disconnect")}
						class="danger"
						disabled={busy || !client}
						onclick={() => void disconnect(ctx)}
					/>
				</Actions>
			</div>,
		];
	},
};

export default def;
