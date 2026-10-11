/** Small hand-written SVG charts (no chart library). Colours are CSS variables, so themes work. */

const NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
	const el = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	parent?.appendChild(el);
	return el;
}

/** One tooltip per dashboard, shown on hover (desktop) or tap (mobile). */
export class Tooltip {
	private el: HTMLElement;
	private hideTimer?: number;

	constructor(host: HTMLElement) {
		this.el = host.createDiv({ cls: "cr-dash-tip" });
	}

	show(e: MouseEvent | PointerEvent, text: string): void {
		window.clearTimeout(this.hideTimer);
		this.el.setText(text);
		this.el.addClass("is-visible");
		const host = this.el.parentElement as HTMLElement;
		const r = host.getBoundingClientRect();
		const x = Math.min(e.clientX - r.left + 12, r.width - 180);
		this.el.style.left = `${Math.max(4, x)}px`;
		this.el.style.top = `${e.clientY - r.top + host.scrollTop + 12}px`;
	}

	hide(): void {
		this.hideTimer = window.setTimeout(() => this.el.removeClass("is-visible"), 80);
	}

	/** Hover shows the tip; a tap shows it and, if given, runs the click action. */
	bind(target: Element, text: () => string, onClick?: () => void): void {
		target.addEventListener("pointerenter", (e) => this.show(e as PointerEvent, text()));
		target.addEventListener("pointermove", (e) => this.show(e as PointerEvent, text()));
		target.addEventListener("pointerleave", () => this.hide());
		target.addEventListener("click", (e) => {
			this.show(e as MouseEvent, text());
			onClick?.();
		});
		if (onClick) target.classList.add("is-clickable");
	}
}

export interface LinePoint<T> {
	x: number;
	y: number;
	data: T;
	tip: string;
}

export interface LineSeries<T> {
	name: string;
	color: string;
	points: Array<LinePoint<T>>;
	axis?: "left" | "right";
	thin?: boolean;
	dots?: boolean;
}

export interface LineOptions<T> {
	height?: number;
	yFormat?: (v: number) => string;
	y2Format?: (v: number) => string;
	xFormat?: (v: number) => string;
	zeroBased?: boolean;
	onClick?: (p: LinePoint<T>, s: LineSeries<T>) => void;
	tip: Tooltip;
}

function niceRange(values: number[], zeroBased = false): [number, number] {
	if (!values.length) return [0, 1];
	let lo = Math.min(...values);
	let hi = Math.max(...values);
	if (zeroBased) lo = Math.min(0, lo);
	if (lo === hi) {
		lo -= 1;
		hi += 1;
	}
	const pad = (hi - lo) * 0.08;
	return [zeroBased && lo >= 0 ? 0 : lo - pad, hi + pad];
}

export function lineChart<T>(el: HTMLElement, series: Array<LineSeries<T>>, opts: LineOptions<T>): void {
	const width = Math.max(240, el.clientWidth || 480);
	const height = opts.height ?? 180;
	const m = { l: 40, r: series.some((s) => s.axis === "right") ? 40 : 10, t: 8, b: 20 };
	const all = series.flatMap((s) => s.points);
	if (!all.length) return;
	const xs = all.map((p) => p.x);
	const [x0, x1] = [Math.min(...xs), Math.max(...xs) === Math.min(...xs) ? Math.min(...xs) + 1 : Math.max(...xs)];
	const left = series.filter((s) => s.axis !== "right").flatMap((s) => s.points.map((p) => p.y));
	const right = series.filter((s) => s.axis === "right").flatMap((s) => s.points.map((p) => p.y));
	const [l0, l1] = niceRange(left, opts.zeroBased);
	const [r0, r1] = niceRange(right, true);
	const sx = (x: number) => m.l + ((x - x0) / (x1 - x0)) * (width - m.l - m.r);
	const sy = (y: number, axis?: "left" | "right") => {
		const [a, b] = axis === "right" ? [r0, r1] : [l0, l1];
		return m.t + (1 - (y - a) / (b - a)) * (height - m.t - m.b);
	};
	const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "cr-chart" }, el);
	// Grid and axis labels.
	for (let i = 0; i <= 3; i++) {
		const v = l0 + ((l1 - l0) * i) / 3;
		const y = sy(v);
		svg("line", { x1: m.l, x2: width - m.r, y1: y, y2: y, class: "cr-grid" }, root);
		const t = svg("text", { x: m.l - 4, y: y + 3, class: "cr-axis", "text-anchor": "end" }, root);
		t.textContent = opts.yFormat ? opts.yFormat(v) : String(Math.round(v));
		if (right.length) {
			const rv = r0 + ((r1 - r0) * i) / 3;
			const rt = svg("text", { x: width - m.r + 4, y: y + 3, class: "cr-axis" }, root);
			rt.textContent = opts.y2Format ? opts.y2Format(rv) : String(Math.round(rv));
		}
	}
	if (opts.xFormat) {
		for (const x of [x0, x1]) {
			const t = svg("text", { x: sx(x), y: height - 4, class: "cr-axis", "text-anchor": x === x0 ? "start" : "end" }, root);
			t.textContent = opts.xFormat(x);
		}
	}
	// Dots carry an index; one set of listeners on the chart serves them all (thousands of games stay fast).
	const lookup: Array<[LinePoint<T>, LineSeries<T>]> = [];
	for (const s of series) {
		if (!s.points.length) continue;
		const d = s.points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y, s.axis).toFixed(1)}`).join(" ");
		svg("path", { d, class: "cr-line" + (s.thin ? " is-thin" : ""), style: `stroke:${s.color}` }, root);
		if (s.dots === false) continue;
		const r = s.points.length > 300 ? 2.2 : 3.2;
		for (const p of s.points) {
			svg("circle", { cx: sx(p.x).toFixed(1), cy: sy(p.y, s.axis).toFixed(1), r, class: "cr-dot" + (opts.onClick ? " is-clickable" : ""), style: `fill:${s.color}`, "data-i": lookup.length }, root);
			lookup.push([p, s]);
		}
	}
	const hit = (e: Event) => {
		const i = (e.target as Element).getAttribute?.("data-i");
		return i === null || i === undefined ? undefined : lookup[Number(i)];
	};
	root.addEventListener("pointermove", (e) => {
		const h = hit(e);
		if (h) opts.tip.show(e, h[0].tip);
		else opts.tip.hide();
	});
	root.addEventListener("pointerleave", () => opts.tip.hide());
	root.addEventListener("click", (e) => {
		const h = hit(e);
		if (!h) return;
		opts.tip.show(e, h[0].tip);
		opts.onClick?.(h[0], h[1]);
	});
}

export interface Bar {
	name: string;
	value?: number;
	color: string;
	tip: string;
}

export interface BarGroup<T> {
	label: string;
	sub?: string;
	bars: Bar[];
	data: T;
	muted?: boolean;
}

export interface BarOptions<T> {
	height?: number;
	max?: number;
	format?: (v: number) => string;
	onClick?: (g: BarGroup<T>) => void;
	tip: Tooltip;
}

/** Groups of side-by-side bars, labelled underneath. */
export function barChart<T>(el: HTMLElement, groups: Array<BarGroup<T>>, opts: BarOptions<T>): void {
	const width = Math.max(240, el.clientWidth || 480);
	const height = opts.height ?? 170;
	const m = { l: 8, r: 8, t: 16, b: 34 };
	const values = groups.flatMap((g) => g.bars.map((b) => b.value ?? 0));
	const max = opts.max ?? Math.max(0.0001, ...values) * 1.15;
	const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, class: "cr-chart" }, el);
	const gw = (width - m.l - m.r) / Math.max(1, groups.length);
	const inner = height - m.t - m.b;
	svg("line", { x1: m.l, x2: width - m.r, y1: m.t + inner, y2: m.t + inner, class: "cr-grid" }, root);
	groups.forEach((g, gi) => {
		const bw = Math.min(28, (gw * 0.7) / Math.max(1, g.bars.length));
		const start = m.l + gi * gw + (gw - bw * g.bars.length) / 2;
		const hit = svg("rect", { x: m.l + gi * gw, y: 0, width: gw, height, class: "cr-hit" }, root);
		g.bars.forEach((b, bi) => {
			const v = b.value ?? 0;
			const h = (v / max) * inner;
			const x = start + bi * bw;
			const r = svg("rect", { x: x + 1, y: m.t + inner - h, width: bw - 2, height: Math.max(h, b.value === undefined ? 0 : 1), class: "cr-bar" + (g.muted ? " is-muted" : ""), style: `fill:${b.color}` }, root);
			opts.tip.bind(r, () => b.tip, opts.onClick ? () => opts.onClick?.(g) : undefined);
			if (b.value !== undefined && opts.format) {
				const t = svg("text", { x: x + bw / 2, y: m.t + inner - h - 3, class: "cr-bar-label", "text-anchor": "middle" }, root);
				t.textContent = opts.format(b.value);
			}
		});
		const lab = svg("text", { x: m.l + gi * gw + gw / 2, y: height - 18, class: "cr-axis cr-group-label", "text-anchor": "middle" }, root);
		lab.textContent = g.label;
		if (g.sub) {
			const sub = svg("text", { x: m.l + gi * gw + gw / 2, y: height - 5, class: "cr-axis", "text-anchor": "middle" }, root);
			sub.textContent = g.sub;
		}
		if (opts.onClick) {
			hit.classList.add("is-clickable");
			hit.addEventListener("click", () => opts.onClick?.(g));
		}
	});
}
