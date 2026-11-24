import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import type { TickerDirection } from "../server/pages/overlays/modules/overlay_elements/elements/ticker";
import type {
	ElementContext,
	OverlayElement,
} from "../shared/ui/overlay/element";

let m: typeof import("mithril");
let tickerElement: typeof import("../server/pages/overlays/modules/overlay_elements/elements/ticker").tickerElement;
let root: HTMLElement | undefined;
const savedGlobals: [string, unknown][] = [];
const bundleFile = new URL(
	`../.tmp-ticker-${crypto.randomUUID()}.js`,
	import.meta.url,
);

beforeAll(async () => {
	const { Window } = await import("happy-dom");
	const win = new Window();
	const globals = globalThis as Record<string, unknown>;
	for (const key of [
		"window",
		"document",
		"requestAnimationFrame",
		"cancelAnimationFrame",
	]) {
		savedGlobals.push([key, globals[key]]);
	}
	globals.window = win;
	globals.document = win.document;
	globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
	globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
	m = (await import("mithril")).default;
	// Keep browser i18n's cached DOM detection out of other tests' stub windows.
	const bundle = await Bun.build({
		entrypoints: [
			new URL(
				"../server/pages/overlays/modules/overlay_elements/elements/ticker.tsx",
				import.meta.url,
			).pathname,
		],
		target: "browser",
		format: "esm",
		plugins: [
			{
				name: "ticker-test-i18n",
				setup(build) {
					build.onLoad({ filter: /shared\/ui\/i18n\.tsx$/ }, () => ({
						contents: "export const t = (key) => key;",
						loader: "js",
					}));
				},
			},
		],
	});
	if (!bundle.success) {
		throw new AggregateError(bundle.logs, "Ticker test bundle failed");
	}
	await Bun.write(bundleFile, await bundle.outputs[0].text());
	({ tickerElement } = await import(bundleFile.href));
});

afterEach(() => {
	if (root) {
		m.render(root, null);
		root.remove();
		root = undefined;
	}
});

afterAll(async () => {
	if (await Bun.file(bundleFile).exists()) {
		await Bun.file(bundleFile).delete();
	}
	const globals = globalThis as Record<string, unknown>;
	for (const [key, original] of savedGlobals) {
		if (original === undefined) delete globals[key];
		else globals[key] = original;
	}
});

function element(direction: TickerDirection): OverlayElement {
	return {
		id: "ticker-1",
		name: "Ticker",
		type: "ticker",
		transform: { x: 0, y: 0, width: 720, height: 44, rotation: 0, opacity: 1 },
		visible: true,
		locked: false,
		parentId: null,
		bindings: {},
		props: {
			...tickerElement.defaultProps,
			direction,
			items: ["First", "Second"],
		},
	};
}

function context(live: boolean): ElementContext {
	return {
		assetUrls: new Map(),
		variables: new Map(),
		variableNames: new Map(),
		...(live ? { activeTriggers: new Map() } : {}),
	};
}

describe("ticker message rendering", () => {
	for (const direction of ["left", "up", "down"] as const) {
		for (const live of [false, true]) {
			test(`${direction} shows messages in ${live ? "runtime" : "editor"}`, () => {
				root = document.createElement("div");
				document.body.appendChild(root);
				m.render(root, tickerElement.draw(element(direction), context(live)));

				const track = root.querySelector<HTMLElement>(".ov-ticker-track");
				expect(track).not.toBeNull();
				const messages = [...track!.querySelectorAll("span")]
					.map((span) => span.textContent)
					.filter((text) => text !== "•");
				expect(messages).toEqual(["First", "Second", "First", "Second"]);
				const padded = [...track!.querySelectorAll("span")].filter(
					(span) => direction !== "left" || span.textContent === "•",
				);
				const defaultPadding = direction === "left" ? "40px" : "20px";
				expect(padded.map((span) => span.style.paddingLeft)).toEqual(
					Array(4).fill(defaultPadding),
				);
				if (live) {
					expect(track!.style.animation).toContain(
						`ovTickerScroll${direction === "left" ? "Left" : direction === "up" ? "Up" : "Down"}`,
					);
				} else {
					expect(track!.style.animation).toBe("");
					if (direction === "left") {
						expect(track!.style.transform).toBe("translateY(-50%)");
					}
				}
			});
		}
	}

	test("editing messages updates the static editor track", () => {
		root = document.createElement("div");
		document.body.appendChild(root);
		const el = element("left");
		m.render(root, tickerElement.draw(el, context(false)));
		el.props.items = ["Updated"];
		m.render(root, tickerElement.draw(el, context(false)));
		expect(root.querySelector(".ov-ticker-track")!.textContent).toBe(
			"Updated•Updated•",
		);
	});
});

describe("ticker padding", () => {
	test("the inspector writes padding in pixels and 0 removes it", () => {
		root = document.createElement("div");
		document.body.appendChild(root);
		const el = element("left");
		m.render(
			root,
			tickerElement.editForm({
				element: el,
				variables: [],
				mutate: (update) => update(el),
			}),
		);
		const input = root.querySelector<HTMLInputElement>(
			'input[name="tickerPadding"]',
		)!;
		expect(input.value).toBe("40");
		input.value = "0";
		input.dispatchEvent(
			new document.defaultView!.Event("input", { bubbles: true }),
		);
		expect(el.props.tickerPadding).toBe(0);

		m.render(root, tickerElement.draw(el, context(false)));
		const separator = root.querySelector<HTMLElement>(
			".ov-ticker-track span:nth-child(2)",
		)!;
		expect(separator.style.paddingLeft).toBe("0px");
		expect(separator.style.paddingRight).toBe("0px");
	});

	test("custom padding applies to all vertical rows", () => {
		root = document.createElement("div");
		const el = element("down");
		el.props.tickerPadding = 12;
		m.render(root, tickerElement.draw(el, context(false)));
		const rows = root.querySelectorAll<HTMLElement>(".ov-ticker-track span");
		expect(rows).toHaveLength(4);
		for (const row of rows) {
			expect(row.style.paddingLeft).toBe("12px");
			expect(row.style.paddingRight).toBe("12px");
		}
	});

	test("changing padding recalculates the horizontal runtime duration", async () => {
		root = document.createElement("div");
		document.body.appendChild(root);
		const el = element("left");
		const live = context(true);
		const frame = () =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		m.render(root, tickerElement.draw(el, live));

		const track = root.querySelector<HTMLElement>(".ov-ticker-track")!;
		const separator = track.querySelector<HTMLElement>("span:nth-child(2)")!;
		Object.defineProperty(track, "scrollWidth", {
			get: () => 400 + 8 * parseFloat(separator.style.paddingLeft),
		});
		await frame();
		expect(track.style.animationDuration).toBe("4.50s");

		el.props.tickerPadding = 10;
		m.render(root, tickerElement.draw(el, live));
		await frame();
		expect(separator.style.paddingLeft).toBe("10px");
		expect(track.style.animationDuration).toBe("3.00s");
	});
});
