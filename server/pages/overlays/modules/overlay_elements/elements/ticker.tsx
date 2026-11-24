/** @jsx m */
/*
 * Ticker widget — a scrolling bar of messages (the codebase replacement for
 * the old `ticker.html` overlay template). Three directions: `left` (the
 * classic horizontal marquee with an accent corner label), `up` and `down`
 * (vertical, one message per row).
 *
 * The marquee is a CSS animation (smooth on the OBS CEF capture, zero
 * per-frame JS): the track lays the item sequence out TWICE and the
 * keyframe (`ovTickerScrollLeft/Up/Down`, declared in overlay.css — runtime
 * only) scrolls exactly half the track, so the loop is seamless. The
 * animation duration is derived from the `speed` prop (px/s) and the
 * CONTENT: for `left` the track's measured half-width, for the verticals
 * the row count × row height. The duration is written straight to the DOM
 * node (`node.style.animationDuration`) — a DOM write mithril never diffs,
 * because that key is deliberately absent from the style object. The editor
 * shows the static first copy (design state, like credits).
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type { MithrilJSXComponent } from "@ui/jsx";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { numProp, strProp } from "@ui/overlay/element";
import type { FormRow } from "@ui/overlay/fields";
import { bindableForm } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

export type TickerDirection = "left" | "up" | "down";

export interface TickerProps {
	/** The scrolling messages, in order. */
	items: string[];
	direction: TickerDirection;
	/** Scroll rate in px/s (higher = faster). */
	speed: number;
	/** Corner label (`left` direction only). */
	label: string;
	/** Separator between items (`left` direction only). */
	separator: string;
	color: string;
	accent: string;
	background: string;
	fontSize: number;
	fontFamily: string;
}

export const DEFAULT_TICKER_PROPS: Required<TickerProps> = {
	items: ["Welcome to the stream"],
	direction: "left",
	speed: 80,
	label: "LIVE",
	separator: "•",
	color: "#ffffff",
	accent: "#6c5ce7",
	background: "#0f0f19",
	fontSize: 22,
	fontFamily: "Inter, system-ui, sans-serif",
};

/** One vertical row is twice the font size tall (the template's 22 → 44). */
const ROW_RATIO = 2;

function tickerDirection(p: Record<string, unknown>): TickerDirection {
	const d = p.direction;
	return d === "up" || d === "down" ? d : "left";
}

function tickerItems(p: Record<string, unknown>): string[] {
	return (Array.isArray(p.items) ? p.items : []).filter(
		(s): s is string => typeof s === "string",
	);
}

// ── the scrolling track ──────────────────────────────────────────────────
// `animate` carries the full animation shorthand on the runtime page; the
// editor's design state carries none (a static first copy). The rAF
// measurement patches `animationDuration` onto the node — it runs after the
// node is in the layout, and re-runs whenever the content identity changes.

interface TickerTrackAttrs {
	direction: TickerDirection;
	speed: number;
	fontSize: number;
	rows: number;
	/** Identity of everything the measured duration depends on. */
	measureKey: string;
	animate?: string;
}

interface TickerTrackState {
	measureKey: string;
	raf: number | null;
}

type TrackVnode = m.Vnode<TickerTrackAttrs, TickerTrackState>;

function scheduleMeasure(vnode: TrackVnode): void {
	const s = vnode.state;
	if (s.raf !== null) cancelAnimationFrame(s.raf);
	if (vnode.attrs.animate === undefined) {
		// design state — nothing to time
		s.measureKey = vnode.attrs.measureKey;
		return;
	}
	s.raf = requestAnimationFrame(() => {
		s.raf = null;
		// attrs at fire time — a redraw between the schedule and the frame
		// re-armed the measurement, so measure what is on screen.
		const a = vnode.attrs;
		s.measureKey = a.measureKey;
		const node = (vnode as m.VnodeDOM<TickerTrackAttrs, TickerTrackState>)
			.dom as HTMLElement;
		if (!node.isConnected) return;
		// One copy of the sequence is exactly half the track.
		const half =
			a.direction === "left"
				? (node as HTMLElement).scrollWidth / 2
				: a.rows * Math.round(a.fontSize * ROW_RATIO);
		const duration = Math.max(1, half / a.speed);
		node.style.animationDuration = `${duration.toFixed(2)}s`;
	});
}

const TickerTrack = {
	oncreate(vnode: TrackVnode) {
		vnode.state.measureKey = "";
		vnode.state.raf = null;
		scheduleMeasure(vnode);
	},
	onupdate(vnode: TrackVnode) {
		if (vnode.attrs.measureKey !== vnode.state.measureKey)
			scheduleMeasure(vnode);
	},
	onremove(vnode: TrackVnode) {
		if (vnode.state.raf !== null) cancelAnimationFrame(vnode.state.raf);
	},
	view(vnode: TrackVnode): Vnode {
		const a = vnode.attrs;
		const horizontal = a.direction === "left";
		return (
			<div
				class="ov-ticker-track"
				style={{
					position: "absolute",
					...(horizontal
						? { left: "0", top: "50%" }
						: { top: "0", left: "0", right: "0" }),
					display: "flex",
					flexDirection: horizontal ? "row" : "column",
					alignItems: "center",
					whiteSpace: "nowrap",
					// The horizontal track's vertical centering lives in the
					// keyframes (they overwrite `transform`); the design state
					// carries it statically. `animationDuration` is set via the
					// rAF DOM write and must stay out of this object.
					...(horizontal && a.animate === undefined
						? { transform: "translateY(-50%)" }
						: {}),
					...(a.animate
						? { animation: a.animate, willChange: "transform" }
						: {}),
				}}
			>
				{vnode.children}
			</div>
		);
	},
} as unknown as MithrilJSXComponent<TickerTrackAttrs, TickerTrackState>;

// ── the item list (the inspector) ────────────────────────────────────────
/** One text input per message + add/remove; reuses the editor's
 * `.ov-channel-*` row classes so the list looks like every other widget's. */
export const TickerItemsField = {
	view: (vnode: m.Vnode): Vnode => {
		const { element, mutate } = vnode.attrs as ElementProps;
		const items = tickerItems(element.props);
		const set = (next: string[]): void =>
			mutate((el) => {
				el.props.items = next;
			});
		return (
			<div class="ov-field">
				<span class="ov-lbl">{t("overlay.ticker_items")}</span>
				<div class="ov-channels">
					{items.length === 0 ? (
						<div class="ov-channels-empty">{t("overlay.no_rows")}</div>
					) : (
						items.map((item, i) => (
							<div class="ov-channel-row" key={i}>
								<input
									value={item}
									placeholder={t("overlay.ticker_item_ph")}
									aria-label={t("overlay.ticker_item")}
									oninput={(ev: Event) =>
										set(
											items.map((row, j) =>
												j === i ? (ev.target as HTMLInputElement).value : row,
											),
										)
									}
								/>
								<button
									class="ov-channel-remove"
									type="button"
									aria-label={t("overlay.remove_row")}
									onclick={() => set(items.filter((_, j) => j !== i))}
								>
									<Icon name="close" class="role-icon" />
								</button>
							</div>
						))
					)}
					<button
						class="ov-channel-add"
						type="button"
						onclick={() => set([...items, ""])}
					>
						+ {t("overlay.ticker_add_item")}
					</button>
				</div>
			</div>
		);
	},
} as unknown as MithrilJSXComponent<ElementProps>;

// ── the element ──────────────────────────────────────────────────────────

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	const p = element.props;
	const direction = tickerDirection(p);
	const items = tickerItems(p);
	const speed = numProp(p, "speed", 80);
	const label = strProp(p, "label", "LIVE");
	const separator = strProp(p, "separator", "•");
	const color = strProp(p, "color", "#ffffff");
	const accent = strProp(p, "accent", "#6c5ce7");
	const background = strProp(p, "background", "#0f0f19");
	const fontSize = numProp(p, "fontSize", 22);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
	const horizontal = direction === "left";
	const rowHeight = Math.round(fontSize * ROW_RATIO);
	// Runtime only: the editor stays on the static (design) state.
	const live = ctx.activeTriggers !== undefined;
	const animate = live
		? `ovTickerScroll${
				direction === "left" ? "Left" : direction === "up" ? "Up" : "Down"
			} 20s linear infinite`
		: undefined;

	// The item sequence, TWICE — the track scrolls exactly half its length,
	// so the loop is seamless.
	const trackChildren: Vnode[] = [];
	for (const copy of [0, 1])
		for (let i = 0; i < items.length; i++) {
			trackChildren.push(
				m(
					"span",
					{
						key: `${copy}:${i}`,
						style: horizontal
							? {
									color,
									fontFamily,
									fontSize: `${fontSize}px`,
									fontWeight: "600",
								}
							: {
									color,
									fontFamily,
									fontSize: `${fontSize}px`,
									fontWeight: "600",
									height: `${rowHeight}px`,
									lineHeight: `${rowHeight}px`,
									padding: `0 20px`,
									overflow: "hidden",
									textOverflow: "ellipsis",
								},
					},
					items[i],
				),
			);
			if (horizontal)
				trackChildren.push(
					m(
						"span",
						{
							key: `${copy}:sep:${i}`,
							style: {
								color: accent,
								fontSize: `${Math.round(fontSize * 1.3)}px`,
								padding: "0 40px",
							},
						},
						separator,
					),
				);
		}
	const measureKey = [direction, speed, fontSize, items.join("\u0000")].join(
		"|",
	);

	return (
		<div
			class="ov-ticker"
			style={{
				width: "100%",
				height: "100%",
				boxSizing: "border-box",
				display: "flex",
				alignItems: "stretch",
				background,
				fontFamily,
				overflow: "hidden",
			}}
		>
			{horizontal && label
				? m(
						"span",
						{
							style: {
								flex: "none",
								display: "flex",
								alignItems: "center",
								padding: "0 12px",
								background: `linear-gradient(180deg, rgba(255,255,255,0.14), rgba(0,0,0,0.16)), ${accent}`,
								color,
								fontSize: `${fontSize}px`,
								fontWeight: "800",
								letterSpacing: "0.16em",
							},
						},
						label,
					)
				: null}
			<div
				style={{
					position: "relative",
					flex: "1",
					minWidth: "0",
					overflow: "hidden",
				}}
			>
				<TickerTrack
					direction={direction}
					speed={speed}
					fontSize={fontSize}
					rows={items.length}
					measureKey={measureKey}
					animate={animate}
				>
					{trackChildren}
				</TickerTrack>
				{/* the viewport's edge fade (the template's `.viewport::after`, inlined) */}
				{m("div", {
					style: {
						position: "absolute",
						inset: 0,
						pointerEvents: "none",
						background: horizontal
							? `linear-gradient(90deg, ${background}, transparent) left / 60px 100% no-repeat, linear-gradient(270deg, ${background}, transparent) right / 60px 100% no-repeat`
							: `linear-gradient(180deg, ${background}, transparent) top / 100% 40px no-repeat, linear-gradient(0deg, ${background}, transparent) bottom / 100% 40px no-repeat`,
					},
				})}
			</div>
		</div>
	);
}

function editForm({
	element: e,
	mutate,
	variables,
	variableUrl,
}: ElementProps): Vnode {
	const p = e.props;
	const direction = tickerDirection(p);
	const rows: FormRow[] = [
		<TickerItemsField
			element={e}
			mutate={mutate}
			variables={variables}
			variableUrl={variableUrl}
		/>,
		[
			{
				path: "props.direction",
				labelKey: "overlay.ticker_direction",
				type: "select",
				value: direction,
				options: [
					{ value: "left", label: t("overlay.ticker_direction.left") },
					{ value: "up", label: t("overlay.ticker_direction.up") },
					{ value: "down", label: t("overlay.ticker_direction.down") },
				],
			},
			{
				path: "props.speed",
				labelKey: "overlay.ticker_speed",
				type: "number",
				value: numProp(p, "speed", 80),
				min: 1,
				max: 2000,
			},
		],
	];
	// The corner label + separator only exist in the horizontal marquee.
	if (direction === "left")
		rows.push([
			{
				path: "props.label",
				labelKey: "overlay.ticker_label",
				type: "text",
				value: strProp(p, "label", "LIVE"),
			},
			{
				path: "props.separator",
				labelKey: "overlay.ticker_separator",
				type: "text",
				value: strProp(p, "separator", "•"),
			},
		]);
	rows.push(
		[
			{
				path: "props.color",
				labelKey: "overlay.color",
				type: "color",
				value: strProp(p, "color", "#ffffff"),
			},
			{
				path: "props.accent",
				labelKey: "overlay.accent",
				type: "color",
				value: strProp(p, "accent", "#6c5ce7"),
			},
			{
				path: "props.background",
				labelKey: "overlay.cd_background",
				type: "color",
				value: strProp(p, "background", "#0f0f19"),
			},
		],
		[
			{
				path: "props.fontSize",
				labelKey: "overlay.font_size",
				type: "number",
				value: numProp(p, "fontSize", 22),
				min: 6,
				max: 200,
			},
		],
	);
	return bindableForm({ element: e, mutate, variables, variableUrl, rows });
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const items = tickerItems(e.props);
	if (!Array.isArray(e.props.items) || items.every((s) => s.trim() === ""))
		problems.push("ticker needs at least one item");
	const speed = numProp(e.props, "speed", 80);
	if (!(speed >= 1 && speed <= 2000))
		problems.push("speed out of range (1–2000)");
	const size = numProp(e.props, "fontSize", 22);
	if (!(size >= 6 && size <= 200))
		problems.push("font size out of range (6–200)");
	return problems;
}

export const tickerElement: OverlayElementDef & OverlayElementSchema = {
	type: "ticker",
	category: "widgets",

	labelKey: "overlay.add_ticker",
	icon: () => <Icon name="subtitles" class="role-icon" />,
	order: 104,
	defaultProps: { ...DEFAULT_TICKER_PROPS },
	propKeys: [
		"items",
		"direction",
		"speed",
		"label",
		"separator",
		"color",
		"accent",
		"background",
		"fontSize",
		"fontFamily",
	],
	defaultSize: { width: 720, height: 44 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(props, read) {
		const d = DEFAULT_TICKER_PROPS;
		return {
			items: Array.isArray(props.items)
				? props.items
						.map((s) => (typeof s === "string" ? s.slice(0, 200) : ""))
						.slice(0, 50)
				: [d.items[0]],
			direction: read.oneOf(
				"direction",
				["left", "up", "down"] as const,
				d.direction,
			),
			speed: read.num("speed", d.speed, 1, 2000),
			label: read.str("label", d.label, 32),
			separator: read.str("separator", d.separator, 8),
			color: read.hex("color", d.color),
			accent: read.hex("accent", d.accent),
			background: read.hex("background", d.background),
			fontSize: read.num("fontSize", d.fontSize, 6, 200),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
		};
	},
};
