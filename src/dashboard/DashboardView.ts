/**
 * Performance dashboard: filter bar, live rating cards, six stat cards with
 * period-over-period deltas, and nine panels. Reads the game index only; the one
 * write is "Mark reviewed".
 */
import { App, ItemView, Modal, WorkspaceLeaf, setIcon } from "obsidian";
import type { Site, TimeClass } from "../types";
import { TIME_CLASSES } from "../types";
import type { ChessJournalSettings } from "../settings";
import type { GameSummary } from "./summary";
import type { GameIndex } from "./gameIndex";
import type { RatingsCache, LiveRating } from "./ratings";
import {
	BandFigures,
	Filters,
	GameRow,
	OpeningRow,
	Period,
	bandFigures,
	biggestSwings,
	conversionFigures,
	defaultFilters,
	engineRows,
	errorFigures,
	openingTable,
	performanceOf,
	periodRanges,
	phaseFigures,
	ratingHistory,
	reviewQueue,
	scoreFigures,
	select,
	siteTimeGroups,
	timeFigures,
	trend,
	vsExpected,
	weakestPhase,
} from "./compute";
import { BANDS, BAND_LABEL, Band, Phase } from "./definitions";
import { Tooltip, barChart, lineChart } from "./charts";

export const VIEW_TYPE_DASHBOARD = "chess-journal-dashboard";

export interface DashboardHost {
	app: App;
	index: GameIndex;
	ratings: RatingsCache;
	settings(): ChessJournalSettings;
	engineLabel(): string;
	chesscomUserAgent(): string;
	filters(): Filters;
	saveFilters(f: Filters): void;
	openGame(row: GameRow, ply?: number): void;
	markReviewed(row: GameRow): Promise<void>;
	onSummariesChange(fn: () => void): () => void;
}

type ERow = GameRow & { summary: GameSummary };

const SITE_LABEL: Record<Site, string> = { lichess: "Lichess", chesscom: "chess.com", otb: "OTB" };
const PHASE_LABEL: Record<Phase, string> = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };
const PERIODS: Array<[Period, string]> = [["30d", "30 days"], ["3m", "3 months"], ["12m", "12 months"], ["all", "All"], ["custom", "Custom"]];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (v?: number) => (v === undefined ? "–" : `${v.toFixed(1)}%`);
const signed = (v: number, digits = 1) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}`;
const groupLabel = (g: { site: Site; timeClass?: TimeClass }) => `${SITE_LABEL[g.site]} ${g.timeClass ?? ""}`.trim();
const today = () => new Date().toISOString().slice(0, 10);
const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class DashboardView extends ItemView {
	private filters: Filters;
	private tip!: Tooltip;
	private body!: HTMLElement;
	private perfGroup?: string;
	private renderTimer?: number;
	private unsub: Array<() => void> = [];
	private resizeObs?: ResizeObserver;
	private lastWidth = 0;
	private drawerOpen = false;
	private expanded = new Set<string>();

	constructor(leaf: WorkspaceLeaf, private host: DashboardHost) {
		super(leaf);
		this.filters = { ...defaultFilters(host.settings().dashboardPeriod), ...host.filters() };
	}

	getViewType(): string {
		return VIEW_TYPE_DASHBOARD;
	}

	getDisplayText(): string {
		return "Chess performance";
	}

	getIcon(): string {
		return "bar-chart-2";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("cr-dash");
		this.tip = new Tooltip(this.contentEl);
		this.body = this.contentEl.createDiv({ cls: "cr-dash-body" });
		this.unsub.push(this.host.index.onChange(() => this.render()));
		this.unsub.push(this.host.onSummariesChange(() => this.host.index.invalidate()));
		this.resizeObs = new ResizeObserver(() => {
			const w = this.contentEl.clientWidth;
			if (Math.abs(w - this.lastWidth) < 40) return;
			this.lastWidth = w;
			window.clearTimeout(this.renderTimer);
			this.renderTimer = window.setTimeout(() => this.render(), 150);
		});
		this.resizeObs.observe(this.contentEl);
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsub.forEach((f) => f());
		this.resizeObs?.disconnect();
		window.clearTimeout(this.renderTimer);
	}

	private setFilters(f: Filters): void {
		this.filters = f;
		this.host.saveFilters(f);
		this.render();
	}

	/* ------------------------------------------------------------ */
	/* Render                                                       */
	/* ------------------------------------------------------------ */

	render(): void {
		const s = this.host.settings();
		const width = this.contentEl.clientWidth || 1000;
		this.contentEl.toggleClass("is-narrow", width < 700);
		this.contentEl.toggleClass("is-two-col", width >= 900);
		this.contentEl.toggleClass("is-one-line-cards", width >= 1100);
		this.contentEl.removeClass("cr-pal-accent", "cr-pal-semantic", "cr-pal-soft");
		this.contentEl.addClass(`cr-pal-${s.dashboardPalette}`);

		const scroll = this.contentEl.scrollTop;
		this.body.empty();
		const all = this.host.index.all();
		const ranges = periodRanges(this.filters, today());
		const rows = select(all, this.filters, ranges.current);
		const prev = ranges.previous ? select(all, this.filters, ranges.previous) : undefined;
		const engine = this.host.engineLabel();
		const eng = engineRows(rows, engine);
		const engPrev = prev ? engineRows(prev, engine) : undefined;

		this.renderHeader(rows, eng);
		this.renderFilters(all);
		const summary = this.body.createDiv({ cls: "cr-dash-summary" });
		this.renderRatingCards(summary.createDiv({ cls: "cr-dash-ratings" }), rows);
		summary.createDiv({ cls: "cr-dash-divider" });
		this.renderStatCards(summary.createDiv({ cls: "cr-dash-stats" }), rows, prev, eng, engPrev);

		const panels = this.body.createDiv({ cls: "cr-dash-panels" });
		this.panelRatingHistory(panels, rows);
		this.panelBands(panels, rows);
		this.panelOpenings(panels, rows, eng);
		this.panelConversion(panels, eng);
		this.panelPhases(panels, eng);
		this.panelTime(panels, eng);
		this.panelTrend(panels, eng);
		this.panelSwings(panels, eng);
		this.panelQueue(panels, eng);
		this.contentEl.scrollTop = scroll;
	}

	private minGames(): number {
		return this.host.settings().dashboardMinGames;
	}

	private renderHeader(rows: GameRow[], eng: ERow[]): void {
		const head = this.body.createDiv({ cls: "cr-dash-head" });
		head.createEl("h2", { text: "Performance" });
		head.createSpan({ cls: "cr-dash-size", text: `${rows.length} games · ${eng.length} analysed` });
		const actions = head.createDiv({ cls: "cr-dash-actions" });
		const filtersBtn = actions.createEl("button", { cls: "cr-dash-filters-btn", text: "Filters" });
		filtersBtn.addEventListener("click", () => {
			this.drawerOpen = !this.drawerOpen;
			this.render();
		});
		const reset = actions.createEl("button", { text: "Reset" });
		reset.addEventListener("click", () => this.setFilters(defaultFilters(this.host.settings().dashboardPeriod)));
	}

	/* ------------------------------------------------------------ */
	/* Filters                                                      */
	/* ------------------------------------------------------------ */

	private renderFilters(all: GameRow[]): void {
		const f = this.filters;
		const bar = this.body.createDiv({ cls: "cr-dash-filters" + (this.drawerOpen ? " is-open" : "") });

		const period = bar.createDiv({ cls: "cr-filter" });
		period.createSpan({ cls: "cr-filter-label", text: "Period" });
		const sel = period.createEl("select", { cls: "dropdown" });
		for (const [v, label] of PERIODS) sel.createEl("option", { text: label, attr: { value: v } });
		sel.value = f.period;
		sel.addEventListener("change", () => this.setFilters({ ...f, period: sel.value as Period }));
		if (f.period === "custom") {
			for (const k of ["from", "to"] as const) {
				const inp = period.createEl("input", { attr: { type: "date", "aria-label": k } });
				inp.value = f[k] ?? "";
				inp.addEventListener("change", () => this.setFilters({ ...f, [k]: inp.value || undefined }));
			}
		}

		const toggles = <T extends string>(label: string, options: Array<[T, string]>, chosen: T[], set: (v: T[]) => void) => {
			const box = bar.createDiv({ cls: "cr-filter" });
			box.createSpan({ cls: "cr-filter-label", text: label });
			for (const [v, text] of options) {
				const on = chosen.includes(v);
				const b = box.createEl("button", { cls: "cr-toggle" + (on ? " is-on" : ""), text });
				b.addEventListener("click", () => set(on ? chosen.filter((x) => x !== v) : [...chosen, v]));
			}
		};
		toggles<Site>("Site", [["lichess", "Lichess"], ["chesscom", "chess.com"], ["otb", "OTB"]], f.sites, (v) => this.setFilters({ ...f, sites: v }));
		toggles<TimeClass>("Time class", TIME_CLASSES.map((t) => [t, cap(t)] as [TimeClass, string]), f.timeClasses, (v) => this.setFilters({ ...f, timeClasses: v }));

		const colour = bar.createDiv({ cls: "cr-filter" });
		colour.createSpan({ cls: "cr-filter-label", text: "My colour" });
		const cs = colour.createEl("select", { cls: "dropdown" });
		for (const [v, t] of [["both", "Both"], ["white", "White"], ["black", "Black"]]) cs.createEl("option", { text: t, attr: { value: v } });
		cs.value = f.colour;
		cs.addEventListener("change", () => this.setFilters({ ...f, colour: cs.value as Filters["colour"] }));

		const rated = bar.createDiv({ cls: "cr-filter" });
		const rb = rated.createEl("button", { cls: "cr-toggle" + (f.ratedOnly ? " is-on" : ""), text: "Rated only" });
		rb.addEventListener("click", () => this.setFilters({ ...f, ratedOnly: !f.ratedOnly }));

		toggles<Band>("Rating band", BANDS.map((b) => [b, BAND_LABEL[b]] as [Band, string]), f.bands, (v) => this.setFilters({ ...f, bands: v }));

		const fam = bar.createDiv({ cls: "cr-filter" });
		fam.createSpan({ cls: "cr-filter-label", text: "Opening" });
		const listId = `cr-fam-${Math.random().toString(36).slice(2)}`;
		const inp = fam.createEl("input", { attr: { type: "search", placeholder: "Search opening family…", list: listId } });
		const dl = fam.createEl("datalist", { attr: { id: listId } });
		for (const name of [...new Set(all.map((g) => g.family))].sort()) dl.createEl("option", { attr: { value: name } });
		inp.addEventListener("change", () => {
			const v = inp.value.trim();
			if (v && !f.families.includes(v)) this.setFilters({ ...f, families: [...f.families, v] });
		});

		// Removable chips for filters added by clicking in panels.
		const chips = this.body.createDiv({ cls: "cr-dash-chips" });
		const chip = (text: string, remove: () => void) => {
			const c = chips.createSpan({ cls: "cr-chip", text });
			const x = c.createSpan({ cls: "cr-chip-x", attr: { "aria-label": "Remove filter" } });
			setIcon(x, "x");
			c.addEventListener("click", remove);
		};
		for (const b of f.bands) chip(`Band ${BAND_LABEL[b]}`, () => this.setFilters({ ...f, bands: f.bands.filter((x) => x !== b) }));
		for (const fm of f.families) chip(fm, () => this.setFilters({ ...f, families: f.families.filter((x) => x !== fm) }));
		if (!chips.childElementCount) chips.remove();
	}

	/* ------------------------------------------------------------ */
	/* Summary row                                                  */
	/* ------------------------------------------------------------ */

	private renderRatingCards(el: HTMLElement, rows: GameRow[]): void {
		const groups = siteTimeGroups(rows.filter((g) => g.site !== "otb")).slice(0, 4);
		if (!groups.length) {
			el.createDiv({ cls: "cr-card is-empty", text: "No rated online games in this selection." });
			return;
		}
		const s = this.host.settings();
		for (const g of groups) {
			const card = el.createDiv({ cls: "cr-card cr-rating-card" });
			card.createDiv({ cls: "cr-card-title", text: groupLabel(g) });
			const value = card.createDiv({ cls: "cr-card-value", text: "…" });
			const sub = card.createDiv({ cls: "cr-card-sub" });
			const sorted = [...g.games].filter((x) => x.myRating !== undefined).sort((a, b) => (a.playedAt || a.date).localeCompare(b.playedAt || b.date));
			const first = sorted[0]?.myRating;
			const latest = sorted[sorted.length - 1]?.myRating;
			const fill = (live: LiveRating | undefined) => {
				value.empty();
				sub.empty();
				const current = live?.rating ?? latest;
				value.setText(current !== undefined ? String(current) : "–");
				if (live?.provisional) value.createSpan({ cls: "cr-prov", text: "?", attr: { title: "Provisional" } });
				if (current !== undefined && first !== undefined) {
					const d = current - first;
					sub.createSpan({ cls: `cr-delta ${d > 0 ? "is-good" : d < 0 ? "is-bad" : ""}`, text: `${d >= 0 ? "+" : "−"}${Math.abs(d)} this period` });
				}
				sub.createSpan({ text: ` · ${g.games.length} games` });
				const asOf = live?.asOf ? new Date(live.asOf).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
				const note = live ? (asOf ? `as of ${asOf}` : "live") : "from games";
				card.createDiv({ cls: "cr-card-foot", text: note });
			};
			const tc = g.timeClass;
			const load =
				g.site === "lichess"
					? this.host.ratings.lichess(s.lichessUsername)
					: this.host.ratings.chesscom(s.chesscomUsername, this.host.chesscomUserAgent());
			if (!navigator.onLine || !tc) {
				fill(undefined);
				continue;
			}
			void load.then((r) => fill(r?.[tc])).catch(() => fill(undefined));
		}
	}

	private statCard(
		el: HTMLElement,
		o: { title: string; value?: string; unit?: string; sub?: string; games: number; delta?: { value: number; text: string; goodWhen: "up" | "down" }; onClick?: () => void; extra?: (card: HTMLElement) => void },
	): void {
		const card = el.createDiv({ cls: "cr-card cr-stat-card" + (o.onClick ? " is-clickable" : "") });
		card.createDiv({ cls: "cr-card-title", text: o.title });
		const enough = o.games >= this.minGames();
		const v = card.createDiv({ cls: "cr-card-value" + (enough ? "" : " is-muted"), text: enough ? o.value ?? "–" : "–" });
		if (enough && o.value !== undefined && o.unit) v.createSpan({ cls: "cr-card-unit", text: ` ${o.unit}` });
		const sub = enough ? o.sub ?? "" : `${o.games} game${o.games === 1 ? "" : "s"} (need ${this.minGames()})`;
		if (sub) card.createDiv({ cls: "cr-card-sub", text: sub });
		if (enough && o.delta) {
			const better = o.delta.goodWhen === "up" ? o.delta.value > 0 : o.delta.value < 0;
			const flat = Math.abs(o.delta.value) < 1e-9;
			const d = card.createDiv({ cls: `cr-delta ${flat ? "" : better ? "is-good" : "is-bad"}` });
			d.createSpan({ cls: "cr-delta-arrow", text: flat ? "→" : o.delta.value > 0 ? "▲" : "▼" });
			d.createSpan({ text: ` ${o.delta.text} vs previous` });
		}
		o.extra?.(card);
		if (o.onClick) card.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("select")) return;
			o.onClick?.();
		});
	}

	private renderStatCards(el: HTMLElement, rows: GameRow[], prev: GameRow[] | undefined, eng: ERow[], engPrev: ERow[] | undefined): void {
		const minPrev = (n: number) => n >= this.minGames();
		// Score.
		const sc = scoreFigures(rows);
		const scPrev = prev ? scoreFigures(prev) : undefined;
		this.statCard(el, {
			title: "Score",
			value: pct(sc.pct),
			sub: `W ${sc.wins} · D ${sc.draws} · L ${sc.losses} · ${sc.games} games`,
			games: sc.games,
			delta: scPrev?.pct !== undefined && sc.pct !== undefined && minPrev(scPrev.games) ? { value: sc.pct - scPrev.pct, text: `${signed(sc.pct - scPrev.pct)} pts`, goodWhen: "up" } : undefined,
			onClick: () => this.openList("Score", rows),
		});
		// Vs expected.
		const ve = vsExpected(rows);
		const vePrev = prev ? vsExpected(prev) : undefined;
		this.statCard(el, {
			title: "Vs expected",
			value: ve.diff !== undefined ? `${signed(ve.diff)} pts` : undefined,
			sub: ve.per100 !== undefined ? `${signed(ve.per100)} per 100 games` : "",
			games: ve.games,
			delta: vePrev?.per100 !== undefined && ve.per100 !== undefined && minPrev(vePrev.games) ? { value: ve.per100 - vePrev.per100, text: `${signed(ve.per100 - vePrev.per100)} per 100`, goodWhen: "up" } : undefined,
			onClick: () => this.openList("Vs expected", rows.filter((g) => g.myRating !== undefined && g.oppRating !== undefined)),
		});
		// Performance (per site and time class).
		const groups = siteTimeGroups(rows);
		const chosen = groups.find((g) => g.id === this.perfGroup) ?? groups[0];
		const perf = chosen ? performanceOf(chosen.games) : { games: 0 };
		const prevGroup = chosen && prev ? prev.filter((g) => `${g.site}|${g.timeClass ?? "?"}` === chosen.id) : undefined;
		const perfPrev = prevGroup ? performanceOf(prevGroup) : undefined;
		this.statCard(el, {
			title: "Performance",
			value: perf.rating !== undefined ? String(perf.rating) : undefined,
			// With several site × time class groups the selector names the group; otherwise the sub-line does.
			sub: chosen && groups.length < 2 ? groupLabel(chosen) : "",
			games: perf.games,
			delta: perfPrev?.rating !== undefined && perf.rating !== undefined && minPrev(perfPrev.games) ? { value: perf.rating - perfPrev.rating, text: signed(perf.rating - perfPrev.rating, 0), goodWhen: "up" } : undefined,
			onClick: chosen ? () => this.openList(`Performance · ${groupLabel(chosen)}`, chosen.games) : undefined,
			extra: (card) => {
				if (groups.length < 2) return;
				const sel = card.createEl("select", { cls: "dropdown cr-card-select" });
				for (const g of groups) sel.createEl("option", { text: groupLabel(g), attr: { value: g.id } });
				sel.value = chosen?.id ?? "";
				sel.addEventListener("change", () => {
					this.perfGroup = sel.value;
					this.render();
				});
			},
		});
		// Error rate.
		const er = errorFigures(eng);
		const erPrev = engPrev ? errorFigures(engPrev) : undefined;
		this.statCard(el, {
			title: "Error rate",
			value: er.rate !== undefined ? er.rate.toFixed(2) : undefined,
			unit: "/ 10 moves",
			sub: er.medianAcpl !== undefined ? `Median ACPL ${Math.round(er.medianAcpl)}` : "",
			games: er.games,
			delta: erPrev?.rate !== undefined && er.rate !== undefined && minPrev(erPrev.games) ? { value: er.rate - erPrev.rate, text: signed(er.rate - erPrev.rate, 2), goodWhen: "down" } : undefined,
			onClick: () => this.openList("Error rate", eng),
		});
		// Weakest phase.
		const phases = phaseFigures(eng);
		const weak = weakestPhase(phases);
		this.statCard(el, {
			title: "Weakest phase",
			value: weak ? PHASE_LABEL[weak.phase] : "None",
			sub: weak ? `${weak.myRate?.toFixed(2)} vs opponents' ${weak.oppRate?.toFixed(2)} per 10 moves` : "Needs 20+ of your moves in a phase",
			games: eng.length,
			onClick: weak ? () => this.openList(`${PHASE_LABEL[weak.phase]} errors`, eng.filter((g) => g.summary.marks.some((m) => m.side === "me" && m.phase === weak.phase && m.kind !== "inaccuracy"))) : undefined,
		});
		// Conversion.
		const cv = conversionFigures(eng);
		const cvPrev = engPrev ? conversionFigures(engPrev) : undefined;
		this.statCard(el, {
			title: "Conversion",
			value: cv.conversionPct !== undefined ? `${Math.round(cv.conversionPct)}%` : undefined,
			sub: `${cv.thrownAway.toFixed(1)} points thrown away`,
			games: cv.winningGames.length,
			delta: cvPrev?.conversionPct !== undefined && cv.conversionPct !== undefined && minPrev(cvPrev.winningGames.length) ? { value: cv.conversionPct - cvPrev.conversionPct, text: `${signed(cv.conversionPct - cvPrev.conversionPct)} pts`, goodWhen: "up" } : undefined,
			onClick: () => this.openList("Reached a winning position", cv.winningGames),
		});
	}

	/* ------------------------------------------------------------ */
	/* Panels                                                       */
	/* ------------------------------------------------------------ */

	private panel(parent: HTMLElement, title: string, question: string, cls = ""): { body: HTMLElement; foot: (text: string) => void } {
		const det = parent.createEl("details", { cls: `cr-panel ${cls}` });
		det.open = true;
		const sum = det.createEl("summary");
		sum.createSpan({ cls: "cr-panel-title", text: title });
		sum.createSpan({ cls: "cr-panel-q", text: question });
		const body = det.createDiv({ cls: "cr-panel-body" });
		return { body, foot: (text: string) => det.createDiv({ cls: "cr-panel-foot", text }) };
	}

	private engineFoot(n: number): string {
		return `${n} game${n === 1 ? "" : "s"} analysed with ${this.host.engineLabel()}.`;
	}

	private panelRatingHistory(parent: HTMLElement, rows: GameRow[]): void {
		const { body } = this.panel(parent, "Rating history", "Where is my rating going?");
		const hist = ratingHistory(rows);
		if (!hist.length) {
			body.createDiv({ cls: "cr-empty", text: "No rated online games in this selection." });
			return;
		}
		const colours = ["var(--cr-c1)", "var(--cr-c2)", "var(--cr-c3)", "var(--cr-c4)", "var(--cr-c5)"];
		const legend = body.createDiv({ cls: "cr-legend" });
		const series = hist.slice(0, 5).map((h, i) => {
			const l = legend.createSpan({ cls: "cr-legend-item" });
			l.createSpan({ cls: "cr-swatch-dot", attr: { style: `background:${colours[i]}` } });
			l.appendText(groupLabel(h.group));
			return {
				name: groupLabel(h.group),
				color: colours[i],
				points: h.points.map((g) => ({ x: dayNum(g.date), y: g.myRating as number, data: g, tip: `${g.date} · ${g.myRating} · vs ${g.opponent} (${g.oppRating ?? "?"}) · ${g.myResult}` })),
			};
		});
		lineChart(body.createDiv({ cls: "cr-chart-box" }), series, {
			tip: this.tip,
			xFormat: fmtDay,
			onClick: (p) => this.host.openGame(p.data),
		});
	}

	private panelBands(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Against stronger and weaker", "Do I underperform against a kind of opponent?");
		const bands = bandFigures(rows);
		const min = this.minGames();
		barChart<BandFigures>(
			body.createDiv({ cls: "cr-chart-box" }),
			bands.map((b) => ({
				label: BAND_LABEL[b.band],
				sub: `${b.games.length} games`,
				muted: b.games.length < min,
				data: b,
				bars: [
					{ name: "Actual", value: b.games.length >= min ? b.actualPct : undefined, color: "var(--cr-c1)", tip: b.games.length >= min ? `Actual ${pct(b.actualPct)} · ${b.games.length} games` : `${b.games.length} games` },
					{ name: "Expected", value: b.games.length >= min ? b.expectedPct : undefined, color: "var(--cr-c2)", tip: b.games.length >= min ? `Expected ${pct(b.expectedPct)} · ${b.games.length} games` : `${b.games.length} games` },
				],
			})),
			{ tip: this.tip, max: 100, format: (v) => `${Math.round(v)}`, onClick: (g) => this.setFilters({ ...this.filters, bands: [g.data.band] }) },
		);
		const legend = body.createDiv({ cls: "cr-legend" });
		for (const [name, c] of [["Actual score %", "var(--cr-c1)"], ["Expected score %", "var(--cr-c2)"]]) {
			const l = legend.createSpan({ cls: "cr-legend-item" });
			l.createSpan({ cls: "cr-swatch-dot", attr: { style: `background:${c}` } });
			l.appendText(name);
		}
		foot("Opponent − my rating, pre-game, same site. Click a band to filter.");
	}

	private panelOpenings(parent: HTMLElement, rows: GameRow[], eng: ERow[]): void {
		const { body, foot } = this.panel(parent, "Openings", "Which openings cost me points, and is it the opening or the play after it?", "is-wide");
		const table = openingTable(rows, this.host.engineLabel());
		if (!table.length) {
			body.createDiv({ cls: "cr-empty", text: "No games in this selection." });
			return;
		}
		const wrap = body.createDiv({ cls: "cr-table-wrap" });
		const t = wrap.createEl("table", { cls: "cr-table" });
		const head = t.createEl("thead").createEl("tr");
		for (const h of ["Opening", "Games", "Score", "Vs expected", "Eval after move 15", "Opening errors / 10"]) head.createEl("th", { text: h });
		const tb = t.createEl("tbody");
		const min = this.minGames();
		let colour: string | undefined;
		const addRow = (r: OpeningRow, child: boolean) => {
			const enough = r.games.length >= min;
			const tr = tb.createEl("tr", { cls: (enough ? "" : "is-muted ") + (child ? "is-child" : "") });
			const name = tr.createEl("td", { cls: "cr-td-name" });
			const id = `${r.colour}|${r.family}`;
			if (!child && r.variations) {
				const caret = name.createSpan({ cls: "cr-caret" });
				setIcon(caret, this.expanded.has(id) ? "chevron-down" : "chevron-right");
				caret.addEventListener("click", (e) => {
					e.stopPropagation();
					if (this.expanded.has(id)) this.expanded.delete(id);
					else this.expanded.add(id);
					this.render();
				});
			}
			name.appendText(child ? r.name.replace(`${r.family}: `, "") : r.name);
			tr.createEl("td", { text: String(r.games.length) });
			tr.createEl("td", { text: enough ? pct(r.scorePct) : "–" });
			tr.createEl("td", { text: enough && r.vsExpected !== undefined ? signed(r.vsExpected) : "–" });
			tr.createEl("td", { text: enough && r.outcomePawns !== undefined ? signed(r.outcomePawns, 2) : "–" });
			tr.createEl("td", { text: enough && r.openingErrorRate !== undefined ? r.openingErrorRate.toFixed(2) : "–" });
			tr.addEventListener("click", () => this.setFilters({ ...this.filters, families: [r.family] }));
		};
		for (const r of table) {
			if (r.colour !== colour) {
				colour = r.colour;
				const tr = tb.createEl("tr", { cls: "cr-group-row" });
				tr.createEl("td", { text: `As ${r.colour}`, attr: { colspan: "6" } });
			}
			addRow(r, false);
			if (r.variations && this.expanded.has(`${r.colour}|${r.family}`)) for (const v of r.variations) addRow(v, true);
		}
		foot(`Good eval but poor score = the problem is after the opening. Evals and error rates from ${eng.length} analysed games.`);
	}

	private panelConversion(parent: HTMLElement, eng: ERow[]): void {
		const { body, foot } = this.panel(parent, "Conversion and saves", "Do I win won games and save lost ones?");
		const c = conversionFigures(eng);
		const min = this.minGames();
		const figs = body.createDiv({ cls: "cr-figs" });
		const fig = (label: string, v: number | undefined, n: number, games: GameRow[]) => {
			const f = figs.createDiv({ cls: "cr-fig is-clickable" + (n >= min ? "" : " is-muted") });
			f.createDiv({ cls: "cr-fig-value", text: n >= min && v !== undefined ? `${Math.round(v)}%` : `${n} games` });
			f.createDiv({ cls: "cr-fig-label", text: `${label} · ${n} games` });
			f.addEventListener("click", () => this.openList(label, games));
		};
		fig("Conversion", c.conversionPct, c.winningGames.length, c.winningGames);
		fig("Saves", c.savePct, c.losingGames.length, c.losingGames);
		const lf = figs.createDiv({ cls: "cr-fig" });
		lf.createDiv({ cls: "cr-fig-value", text: c.thrownAway.toFixed(1) });
		lf.createDiv({ cls: "cr-fig-label", text: "points thrown away" });
		if (c.notConverted.length) {
			const list = body.createDiv({ cls: "cr-list" });
			list.createDiv({ cls: "cr-list-title", text: "Winning, not won" });
			for (const g of c.notConverted.slice(0, 10)) {
				const row = list.createDiv({ cls: "cr-list-row is-clickable" });
				row.createSpan({ text: g.date });
				row.createSpan({ cls: "cr-grow", text: `vs ${g.opponent}` });
				row.createSpan({ text: `peak ${signed(g.summary.myPeakEvalCp / 100)}` });
				row.createSpan({ cls: `cr-result is-${g.myResult}`, text: g.myResult });
				row.addEventListener("click", () => this.host.openGame(g, g.summary.peakPly ?? undefined));
			}
		}
		foot(this.engineFoot(eng.length));
	}

	private panelPhases(parent: HTMLElement, eng: ERow[]): void {
		const { body, foot } = this.panel(parent, "Errors by phase", "In which phase do I go wrong?");
		const phases = phaseFigures(eng);
		const showInacc = this.host.settings().dashboardShowInaccuracies;
		barChart(
			body.createDiv({ cls: "cr-chart-box" }),
			phases.map((p) => ({
				label: PHASE_LABEL[p.phase],
				sub: `${p.myMoves} of my moves`,
				data: p,
				muted: p.myMoves < 10,
				bars: [
					{ name: "Mine", value: p.myRate, color: "var(--cr-c1)", tip: `My errors ${p.myRate?.toFixed(2) ?? "–"} / 10 moves (${p.myErrors} in ${p.myMoves})` },
					{ name: "Opponents", value: p.oppRate, color: "var(--cr-c2)", tip: `Opponents ${p.oppRate?.toFixed(2) ?? "–"} / 10 moves (${p.oppErrors} in ${p.oppMoves})` },
					...(showInacc ? [{ name: "My inaccuracies", value: p.myInaccuracyRate, color: "var(--cr-c3)", tip: `My inaccuracies ${p.myInaccuracyRate?.toFixed(2) ?? "–"} / 10 moves` }] : []),
				],
			})),
			{
				tip: this.tip,
				format: (v) => v.toFixed(2),
				onClick: (g) => this.openList(`${PHASE_LABEL[g.data.phase]}: games with my errors`, eng.filter((x) => x.summary.marks.some((m) => m.side === "me" && m.phase === g.data.phase && m.kind !== "inaccuracy"))),
			},
		);
		const legend = body.createDiv({ cls: "cr-legend" });
		for (const [name, c] of [["My errors / 10 moves", "var(--cr-c1)"], ["Opponents' (same games)", "var(--cr-c2)"], ...(showInacc ? [["My inaccuracies", "var(--cr-c3)"]] : [])]) {
			const l = legend.createSpan({ cls: "cr-legend-item" });
			l.createSpan({ cls: "cr-swatch-dot", attr: { style: `background:${c}` } });
			l.appendText(name);
		}
		foot(this.engineFoot(eng.length));
	}

	private panelTime(parent: HTMLElement, eng: ERow[]): void {
		const { body, foot } = this.panel(parent, "Time management", "Does the clock cost me points?");
		const t = timeFigures(eng);
		const min = this.minGames();
		const n = t.withClocks.length;
		const figs = body.createDiv({ cls: "cr-figs" });
		const fig = (value: string, label: string, games?: GameRow[]) => {
			const f = figs.createDiv({ cls: "cr-fig" + (games ? " is-clickable" : "") + (n >= min ? "" : " is-muted") });
			f.createDiv({ cls: "cr-fig-value", text: n >= min ? value : "–" });
			f.createDiv({ cls: "cr-fig-label", text: label });
			if (games) f.addEventListener("click", () => this.openList(label, games));
		};
		fig(pct(t.timeTroublePct), `games in time trouble (${t.timeTroubleGames.length})`, t.timeTroubleGames);
		fig(t.medianFirst10 !== undefined ? `${Math.round(t.medianFirst10)} s` : "–", "median on my first 10 moves", t.withClocks);
		fig(String(t.lostOnTime.length), "losses on time", t.lostOnTime);
		barChart(
			body.createDiv({ cls: "cr-chart-box" }),
			[
				{ label: "Under pressure", sub: `${t.pressureMoves} moves`, data: "pressure", bars: [{ name: "Error rate", value: t.pressureRate, color: "var(--cr-c1)", tip: `${t.pressureRate?.toFixed(2) ?? "–"} errors / 10 moves · ${t.pressureMoves} moves` }] },
				{ label: "Not under pressure", sub: `${t.calmMoves} moves`, data: "calm", bars: [{ name: "Error rate", value: t.calmRate, color: "var(--cr-c2)", tip: `${t.calmRate?.toFixed(2) ?? "–"} errors / 10 moves · ${t.calmMoves} moves` }] },
			],
			{ tip: this.tip, height: 140, format: (v) => v.toFixed(2), onClick: () => this.openList("Games with clocks", t.withClocks) },
		);
		foot(`${t.withoutClocks} game${t.withoutClocks === 1 ? "" : "s"} without clocks not included. ${this.engineFoot(n)}`);
	}

	private panelTrend(parent: HTMLElement, eng: ERow[]): void {
		const { body, foot } = this.panel(parent, "Trend", "Am I playing cleaner over time?");
		const points = trend(eng);
		if (!points.length) {
			body.createDiv({ cls: "cr-empty", text: `Needs 20 or more analysed games (${eng.length} so far).` });
			return;
		}
		lineChart(
			body.createDiv({ cls: "cr-chart-box" }),
			[
				{ name: "Error rate", color: "var(--cr-c1)", points: points.filter((p) => p.errorRate !== undefined).map((p) => ({ x: p.index, y: p.errorRate as number, data: p, tip: `Games ${p.index - 18}–${p.index + 1} · ${p.errorRate?.toFixed(2)} errors / 10 moves` })) },
				{ name: "Score %", color: "var(--cr-c2)", axis: "right", thin: true, dots: false, points: points.filter((p) => p.scorePct !== undefined).map((p) => ({ x: p.index, y: p.scorePct as number, data: p, tip: `Score ${pct(p.scorePct)}` })) },
			],
			{ tip: this.tip, yFormat: (v) => v.toFixed(1), y2Format: (v) => `${Math.round(v)}%`, onClick: (p) => this.openList(`20 games ending ${p.data.date}`, p.data.games) },
		);
		foot(`Rolling 20-game error rate (left) and score % (right, thin). ${this.engineFoot(eng.length)}`);
	}

	private panelSwings(parent: HTMLElement, eng: ERow[]): void {
		const { body, foot } = this.panel(parent, "Biggest swings", "What were my worst single moves?");
		const swings = biggestSwings(eng);
		if (!swings.length) {
			body.createDiv({ cls: "cr-empty", text: "No mistakes found in the analysed games." });
			return;
		}
		const wrap = body.createDiv({ cls: "cr-table-wrap" });
		const t = wrap.createEl("table", { cls: "cr-table" });
		const head = t.createEl("thead").createEl("tr");
		for (const h of ["Date", "Opponent", "Move", "Phase", "Eval", "Clock"]) head.createEl("th", { text: h });
		const tb = t.createEl("tbody");
		for (const s of swings) {
			const tr = tb.createEl("tr", { cls: "is-clickable" });
			tr.createEl("td", { text: s.game.date });
			tr.createEl("td", { text: s.game.opponent });
			tr.createEl("td", { text: `${s.moveNumber}${s.mark.ply % 2 === 1 ? "." : "…"}` });
			tr.createEl("td", { text: PHASE_LABEL[s.mark.phase] });
			tr.createEl("td", { text: `${signed(s.mark.evalBeforeCp / 100)} → ${signed(s.mark.evalAfterCp / 100)}` });
			tr.createEl("td", { text: s.mark.clockSec !== undefined ? fmtClock(s.mark.clockSec) : "–" });
			tr.addEventListener("click", () => this.host.openGame(s.game, s.mark.ply));
		}
		foot(this.engineFoot(eng.length));
	}

	private panelQueue(parent: HTMLElement, eng: ERow[]): void {
		const { body, foot } = this.panel(parent, "Review queue", "Which games should I review next?");
		const q = reviewQueue(eng);
		if (!q.length) {
			body.createDiv({ cls: "cr-empty", text: "Nothing to review: every analysed game here is marked reviewed." });
			return;
		}
		const wrap = body.createDiv({ cls: "cr-table-wrap" });
		const t = wrap.createEl("table", { cls: "cr-table" });
		const head = t.createEl("thead").createEl("tr");
		for (const h of ["Date", "Opponent", "Result", "Biggest swing", ""]) head.createEl("th", { text: h });
		const tb = t.createEl("tbody");
		for (const item of q) {
			const g = item.game;
			const tr = tb.createEl("tr", { cls: "is-clickable" });
			tr.createEl("td", { text: g.date });
			tr.createEl("td", { text: g.opponent });
			tr.createEl("td", { cls: `cr-result is-${g.myResult}`, text: g.myResult });
			tr.createEl("td", { text: g.summary.biggestSwing ? `${Math.round(g.summary.biggestSwing.deltaW * 50)}% (move ${Math.ceil(g.summary.biggestSwing.ply / 2)})` : "–" });
			const td = tr.createEl("td");
			const b = td.createEl("button", { cls: "cr-mark-btn", text: "Mark reviewed" });
			b.addEventListener("click", async (e) => {
				e.stopPropagation();
				b.disabled = true;
				await this.host.markReviewed(g);
				this.host.index.invalidate(true);
			});
			tr.addEventListener("click", () => this.host.openGame(g, g.summary.biggestSwing?.ply));
		}
		foot(`Ranked by biggest swing, +0.5 if lost, +0.25 if a winning position was not won. ${this.engineFoot(eng.length)}`);
	}

	private openList(title: string, games: GameRow[]): void {
		new GameListModal(this.app, title, games, (g) => this.host.openGame(g)).open();
	}
}

function fmtClock(s: number): string {
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** The games behind a figure: sortable, each row opens the note. */
export class GameListModal extends Modal {
	private sortKey = "date";
	private desc = true;

	constructor(app: App, private title: string, private games: GameRow[], private openGame: (g: GameRow) => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("cr-dash-modal");
		this.titleEl.setText(`${this.title} · ${this.games.length} game${this.games.length === 1 ? "" : "s"}`);
		this.draw();
	}

	private draw(): void {
		const { contentEl } = this;
		contentEl.empty();
		const cols: Array<[string, string, (g: GameRow) => string | number]> = [
			["date", "Date", (g) => g.date],
			["opponent", "Opponent", (g) => g.opponent],
			["ratings", "Ratings", (g) => `${g.myRating ?? "?"} – ${g.oppRating ?? "?"}`],
			["result", "Result", (g) => g.myResult],
			["opening", "Opening", (g) => g.opening ?? g.eco ?? ""],
			["errors", "Errors", (g) => (g.summary ? g.summary.marks.filter((m) => m.side === "me" && m.kind !== "inaccuracy").length : "–")],
			["reviewed", "Reviewed", (g) => (g.reviewed ? "yes" : "")],
		];
		const wrap = contentEl.createDiv({ cls: "cr-table-wrap" });
		const t = wrap.createEl("table", { cls: "cr-table" });
		const head = t.createEl("thead").createEl("tr");
		for (const [key, label] of cols) {
			const th = head.createEl("th", { text: label + (this.sortKey === key ? (this.desc ? " ▼" : " ▲") : ""), cls: "is-clickable" });
			th.addEventListener("click", () => {
				this.desc = this.sortKey === key ? !this.desc : key === "date";
				this.sortKey = key;
				this.draw();
			});
		}
		const get = cols.find((c) => c[0] === this.sortKey)?.[2] ?? cols[0][2];
		const sorted = [...this.games].sort((a, b) => {
			const x = get(a);
			const y = get(b);
			const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
			return this.desc ? -c : c;
		});
		const tb = t.createEl("tbody");
		for (const g of sorted) {
			const tr = tb.createEl("tr", { cls: "is-clickable" });
			for (const [, , fn] of cols) tr.createEl("td", { text: String(fn(g)) });
			tr.addEventListener("click", () => {
				this.close();
				this.openGame(g);
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
