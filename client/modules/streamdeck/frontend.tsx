/*
 * Stream Deck card: shows the connected deck (model + key count) and flashes the
 * last key pressed. Connection state comes from the device status; live
 * press/release frames arrive on the `streamdeck.press` / `streamdeck.release`
 * events and update the "last key" readout without waiting for the next status
 * poll.
 */
import "./styles.css";
import { Card } from "@ui/components/";
import { card } from "@ui/device/store";
import { t } from "@ui/i18n";
import m from "mithril";
import type { FrontendModule } from "../../../shared/contracts/frontend_module";
import type { Status } from "../../../shared/contracts/wire";
import log from "./log";
import type { StreamDeckKeyEvent, StreamDeckStatus } from "./types";

const deckStatus = (status: Status): StreamDeckStatus =>
	(status.streamdeck as StreamDeckStatus | undefined) ?? {
		connected: false,
		model: null,
		keyCount: 0,
		lastPress: null,
		lastRelease: null,
	};

/** Live frames (the status poll is the fallback until the first event lands). */
let livePress: StreamDeckKeyEvent | null = null;
let liveRelease: StreamDeckKeyEvent | null = null;

function onEvent(event: string, data: unknown): void {
	if (event === "streamdeck.press") {
		livePress = data as StreamDeckKeyEvent;
		m.redraw();
	} else if (event === "streamdeck.release") {
		liveRelease = data as StreamDeckKeyEvent;
		m.redraw();
	}
}

function lastKey(
	status: StreamDeckStatus,
	live: StreamDeckKeyEvent | null,
): StreamDeckKeyEvent | null {
	if (live !== null) return live;
	return status.lastPress;
}

function streamdeckBody(status: Status): m.Vnode {
	const deck = deckStatus(status);
	const pressed = lastKey(deck, livePress);
	const released = lastKey(deck, liveRelease);

	if (!deck.connected)
		return (
			<Card class="streamdeck-card" title={t("streamdeck.title")}>
				<div class="streamdeck-empty">{t("streamdeck.not_connected")}</div>
			</Card>
		);

	return (
		<Card class="streamdeck-card" title={t("streamdeck.title")}>
			<div class="streamdeck-model">
				<span class="streamdeck-label">{t("streamdeck.model")}</span>
				<span class="streamdeck-value">{deck.model ?? "—"}</span>
			</div>
			<div class="streamdeck-keys">
				<span class="streamdeck-label">{t("streamdeck.key_count")}</span>
				<span class="streamdeck-value">{deck.keyCount}</span>
			</div>
			<div class="streamdeck-last">
				<span class="streamdeck-label">{t("streamdeck.last_pressed")}</span>
				<span class={pressed !== null ? "streamdeck-value streamdeck-pressed" : "streamdeck-value"}>
					{pressed !== null ? pressed.key : "—"}
				</span>
				<span class="streamdeck-label streamdeck-release">
					{t("streamdeck.last_released")}
				</span>
				<span class="streamdeck-value">{released !== null ? released.key : "—"}</span>
			</div>
		</Card>
	);
}

const streamdeckCardComp = {
	view(_v: m.Vnode): m.Vnode {
		return streamdeckBody(card.st.status ?? ({} as Status));
	},
};

const streamdeckModule: FrontendModule = {
	id: "streamdeck",
	kind: "device-card",
	title: "Stream Deck",
	icon: "⌨️",
	order: 60,
	log,
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	handleEvent: onEvent,
	component: (_status: Status) => m(streamdeckCardComp),
};

export default streamdeckModule;
