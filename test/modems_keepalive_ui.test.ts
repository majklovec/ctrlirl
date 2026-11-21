import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { keepaliveDot } from "../client/modules/modems/frontend";
import type { ModemKeepaliveEvent } from "../client/modules/modems/types";
import type { CardState } from "../shared/ui/device/store";

function indicator(state: CardState): {
	className: string;
	key: string | number | undefined;
	style: string | undefined;
} {
	const node = keepaliveDot({ st: state }, 1);
	if (!node || typeof node !== "object" || !Array.isArray(node.children))
		throw new Error("Keepalive indicator was not rendered");
	const dot = node.children[0];
	if (
		!dot ||
		typeof dot !== "object" ||
		!("attrs" in dot) ||
		!dot.attrs ||
		!("className" in dot.attrs) ||
		typeof dot.attrs.className !== "string"
	)
		throw new Error("Keepalive dot was not rendered");
	return {
		className: dot.attrs.className,
		key: dot.key,
		style:
			"style" in dot.attrs && typeof dot.attrs.style === "string"
				? dot.attrs.style
				: undefined,
	};
}

test("the modem dot flashes on each successful UDP send and shows failures", () => {
	const payload: ModemKeepaliveEvent = {
		target: "1.1.1.1",
		port: 53,
		intervalMs: 50_000,
		keepalives: [{ index: 1, iface: "wwan0", ok: true, at: 100 }],
	};
	const state: CardState = {
		status: null,
		events: new Map([["modems.keepalive", { data: payload, at: 100 }]]),
	};
	const first = indicator(state);
	expect(first.className).toContain("ok");
	expect(first.key).toBe("100:true");
	expect(first.style).toBe("--keepalive-interval: 50000ms");

	payload.keepalives[0].at = 200;
	payload.intervalMs = 5_000;
	const second = indicator(state);
	expect(second.className).toContain("ok");
	expect(second.key).toBe("200:true");
	expect(second.style).toBe("--keepalive-interval: 5000ms");

	payload.keepalives[0].ok = false;
	const failed = indicator(state);
	expect(failed.className).toContain("bad");
	expect(failed.key).toBe("200:false");
	payload.intervalMs = Number.NaN;
	expect(indicator(state).style).toBeUndefined();
	payload.intervalMs = 0;
	expect(indicator(state).style).toBeUndefined();
	state.events.clear();
	expect(keepaliveDot({ st: state }, 1)).toBeNull();
});

test("the keepalive dot does not inherit global status margins", () => {
	const window = new Window();
	const document = window.document;
	const styles = document.createElement("style");
	styles.textContent = [
		readFileSync(new URL("../shared/css/layout.css", import.meta.url), "utf8"),
		readFileSync(
			new URL("../client/modules/modems/styles.css", import.meta.url),
			"utf8",
		),
	].join("\n");
	document.head.append(styles);
	document.body.innerHTML =
		'<section class="mod-modems-card"><article class="modem"><span class="modem-state"><span class="keepalive"><i></i></span></span></article></section>';
	const dot = document.querySelector("i");
	if (!dot) throw new Error("Missing keepalive dot");
	const state: CardState = {
		status: null,
		events: new Map([
			[
				"modems.keepalive",
				{
					at: 100,
					data: {
						target: "1.1.1.1",
						port: 53,
						intervalMs: 50_000,
						keepalives: [{ index: 1, iface: "wwan0", ok: true, at: 100 }],
					} satisfies ModemKeepaliveEvent,
				},
			],
		]),
	};
	dot.className = indicator(state).className;
	const computed = window.getComputedStyle(dot);
	expect(computed.marginTop).toBe("0px");
	expect(computed.marginBottom).toBe("0px");
});
