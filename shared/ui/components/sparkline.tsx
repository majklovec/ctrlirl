/** @jsx m */
/**
 * Compact single-series sparkline (inline SVG, no axes, grid, or labels): a
 * small trend line for table cells and narrow widgets. The polyline is
 * stretched to fill its box (`preserveAspectRatio="none"`) with a constant
 * 1px stroke (`vector-effect: non-scaling-stroke`), so a viewBox of 100x28
 * scales to whatever size the surrounding box gives it.
 */
import m from "mithril";
import type { MithrilJSXComponent } from "../jsx";
import type { ChartSample } from "./linechart";

const W = 100;
const H = 28;
const PAD = 2;

/** Compact single-series trend line; needs at least two samples to draw. */
export const Sparkline = {
	view: (vnode) => {
		const { points, title } = vnode.attrs;
		const n = points.length;
		if (n < 2)
			return (
				<svg
					class="spark"
					viewBox={`0 0 ${W} ${H}`}
					preserveAspectRatio="none"
					role="img"
					aria-hidden="true"
				/>
			);
		const values = points.map((p) => p.v);
		const min = Math.min(...values);
		const max = Math.max(...values);
		const span = max - min;
		const xs = (i: number) => PAD + (i * (W - 2 * PAD)) / (n - 1);
		// A flat series (span 0) plots at mid-height instead of pinned to the
		// bottom, so a steady rate reads as a level line.
		const ys = (v: number) =>
			H - PAD - (span === 0 ? 0.5 : (v - min) / span) * (H - 2 * PAD);
		return (
			<svg
				class="spark"
				viewBox={`0 0 ${W} ${H}`}
				preserveAspectRatio="none"
				role="img"
				aria-label={title}
			>
				<polyline
					class="spark-line"
					points={points
						.map((p, i) => `${xs(i).toFixed(1)},${ys(p.v).toFixed(1)}`)
						.join(" ")}
				/>
			</svg>
		);
	},
} as MithrilJSXComponent<{ points: ChartSample[]; title?: string }>;
