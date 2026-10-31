/**
 * Performance dashboard: filter bar, live rating cards, six stat cards with
 * period-over-period deltas, and panels. Uses what Lichess provides (results,
 * ratings, clocks, accuracy and its computer analysis) and Stockfish analyses
 * of OTB games; nothing is evaluated here. The one write is "Mark reviewed".
 */
import { App, ItemView, Modal, WorkspaceLeaf, setIcon } from "obsidian";
import type { Site, TimeClass } from "../types";
import { TIME_CLASSES } from "../types";
import type { ChessJournalSettings } from "../settings";
import type { GameIndex } from "./gameIndex";
import type { RatingsCache, LiveRating } from "./ratings";
import {
	AccuracyRow,
	AccuracySite,
	BandFigures,
	Filters,
	GameRow,
	OpeningRow,
	Period,
	ResultSplit,
	accuracyByResult,
	accuracyByTimeClass,
	accuracyFigures,
	accuracyRows,
	analysedRows,
	bandFigures,
	chooseAccuracySite,
	clockRace,
	defaultFilters,
	endgameFigures,
	imbalanceTable,
	materialFigures,
	mistakeFigures,
	mistakeTrend,
	openingTable,
	performanceOf,
	periodRanges,
	ratingHistory,
	reviewQueue,
	scoreFigures,
	select,
	siteTimeGroups,
	timeFigures,
	vsExpected,
} from "./compute";
import { BANDS, BAND_LABEL, Band, CLOCK_EDGE_MOVE, CLOCK_EDGE_PCT, IMBALANCE_LABEL, MATERIAL_SWING, MISSED_GIVE_BACK, MyResult, WINNING_EVAL } from "./definitions";
import { Tooltip, barChart, lineChart } from "./charts";

export const VIEW_TYPE_DASHBOARD = "chess-journal-dashboard";

export interface DashboardHost {
	app: App;
	index: GameIndex;
	ratings: RatingsCache;
	settings(): ChessJournalSettings;
	filters(): Filters;
	saveFilters(f: Filters): void;
	openGame(row: GameRow, ply?: number): void;
	markReviewed(row: GameRow): Promise<void>;
}

const SITE_LABEL: Record<Site, string> = { lichess: "Lichess", otb: "OTB" };
const RESULT_LABEL: Record<MyResult, string> = { win: "Wins", draw: "Draws", loss: "Losses" };
const PERIODS: Array<[Period, string]> = [["30d", "30 days"], ["3m", "3 months"], ["12m", "12 months"], ["all", "All"], ["custom", "Custom"]];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (v?: number) => (v === undefined ? "–" : `${v.toFixed(1)}%`);
const acc = (v?: number) => (v === undefined ? "–" : v.toFixed(1));
const fmtSeconds = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s)} s`);
const per = (v?: number) => (v === undefined ? "–" : v.toFixed(2));
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

	private minGames(): number {
		return this.host.settings().dashboardMinGames;
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
		const site = chooseAccuracySite(rows, this.filters.accuracySite);
		const accRows = accuracyRows(rows, site);
		const accPrev = prev ? accuracyRows(prev, site) : undefined;

		this.renderHeader(rows, analysedRows(rows).length);
		this.renderFilters(all, rows, site);
		const summary = this.body.createDiv({ cls: "cr-dash-summary" });
		this.renderRatingCards(summary.createDiv({ cls: "cr-dash-ratings" }), rows);
		summary.createDiv({ cls: "cr-dash-divider" });
		this.renderStatCards(summary.createDiv({ cls: "cr-dash-stats" }), rows, prev, accRows, accPrev, site);

		const panels = this.body.createDiv({ cls: "cr-dash-panels" });
		this.panelRatingHistory(panels, rows);
		this.panelMistakeTrend(panels, rows);
		this.panelMistakes(panels, rows);
		this.panelBands(panels, rows);
		this.panelOpenings(panels, rows, site);
		this.panelComebacks(panels, rows);
		this.panelImbalances(panels, rows);
		this.panelEndgames(panels, rows);
		this.panelAccuracyByResult(panels, accRows, site);
		this.panelAccuracyByTimeClass(panels, accRows, site);
		this.panelTime(panels, rows);
		this.panelClockRace(panels, rows);
		this.panelQueue(panels, rows);
		this.contentEl.scrollTop = scroll;
	}

	private renderHeader(rows: GameRow[], analysed: number): void {
		const head = this.body.createDiv({ cls: "cr-dash-head" });
		head.createEl("h2", { text: "Performance" });
		head.createSpan({ cls: "cr-dash-size", text: `${rows.length} games · ${analysed} analysed` });
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

	private renderFilters(all: GameRow[], rows: GameRow[], site: AccuracySite | undefined): void {
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
		toggles<Site>("Site", [["lichess", "Lichess"], ["otb", "OTB"]], f.sites, (v) => this.setFilters({ ...f, sites: v }));
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
			const foot = card.createDiv({ cls: "cr-card-foot" });
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
				foot.setText(live ? (asOf ? `as of ${asOf}` : "live") : "from games");
			};
			const tc = g.timeClass;
			if (!navigator.onLine || !tc) {
				fill(undefined);
				continue;
			}
			const load = this.host.ratings.lichess(s.lichessUsername);
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
		if (o.onClick) {
			card.addEventListener("click", (e) => {
				if ((e.target as HTMLElement).closest("select")) return;
				o.onClick?.();
			});
		}
	}

	private renderStatCards(el: HTMLElement, rows: GameRow[], prev: GameRow[] | undefined, accRows: AccuracyRow[], accPrev: AccuracyRow[] | undefined, site: AccuracySite | undefined): void {
		const enoughPrev = (n: number) => n >= this.minGames();
		const siteName = site ? SITE_LABEL[site] : "site";

		const sc = scoreFigures(rows);
		const scPrev = prev ? scoreFigures(prev) : undefined;
		this.statCard(el, {
			title: "Score",
			value: pct(sc.pct),
			sub: `W ${sc.wins} · D ${sc.draws} · L ${sc.losses} · ${sc.games} games`,
			games: sc.games,
			delta: scPrev?.pct !== undefined && sc.pct !== undefined && enoughPrev(scPrev.games) ? { value: sc.pct - scPrev.pct, text: `${signed(sc.pct - scPrev.pct)} pts`, goodWhen: "up" } : undefined,
			onClick: () => this.openList("Score", rows),
		});

		const ve = vsExpected(rows);
		const vePrev = prev ? vsExpected(prev) : undefined;
		this.statCard(el, {
			title: "Vs expected",
			value: ve.diff !== undefined ? `${signed(ve.diff)} pts` : undefined,
			sub: ve.per100 !== undefined ? `${signed(ve.per100)} per 100 games` : "",
			games: ve.games,
			delta: vePrev?.per100 !== undefined && ve.per100 !== undefined && enoughPrev(vePrev.games) ? { value: ve.per100 - vePrev.per100, text: `${signed(ve.per100 - vePrev.per100)} per 100`, goodWhen: "up" } : undefined,
			onClick: () => this.openList("Vs expected", rows.filter((g) => g.myRating !== undefined && g.oppRating !== undefined)),
		});

		const groups = siteTimeGroups(rows);
		const chosen = groups.find((g) => g.id === this.perfGroup) ?? groups[0];
		const perf = chosen ? performanceOf(chosen.games) : { games: 0 };
		const perfPrev = chosen && prev ? performanceOf(prev.filter((g) => `${g.site}|${g.timeClass ?? "?"}` === chosen.id)) : undefined;
		this.statCard(el, {
			title: "Performance",
			value: perf.rating !== undefined ? String(perf.rating) : undefined,
			sub: chosen && groups.length < 2 ? groupLabel(chosen) : "",
			games: perf.games,
			delta: perfPrev?.rating !== undefined && perf.rating !== undefined && enoughPrev(perfPrev.games) ? { value: perf.rating - perfPrev.rating, text: signed(perf.rating - perfPrev.rating, 0), goodWhen: "up" } : undefined,
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

		const a = accuracyFigures(accRows);
		const aPrev = accPrev ? accuracyFigures(accPrev) : undefined;
		this.statCard(el, {
			title: `Accuracy · ${siteName}`,
			value: a.mine !== undefined ? acc(a.mine) : undefined,
			sub: a.opp !== undefined && a.edge !== undefined ? `Opponents ${acc(a.opp)} (${signed(a.edge)}) · ${a.games} games` : a.median !== undefined ? `Median ${acc(a.median)} · ${a.games} games` : "",
			games: a.games,
			delta: aPrev?.mine !== undefined && a.mine !== undefined && enoughPrev(aPrev.games) ? { value: a.mine - aPrev.mine, text: signed(a.mine - aPrev.mine), goodWhen: "up" } : undefined,
			onClick: () => this.openList(`Games with ${siteName} accuracy`, accRows),
		});

		const m = mistakeFigures(rows);
		const mPrev = prev ? mistakeFigures(prev) : undefined;
		this.statCard(el, {
			title: "Mistakes per game",
			value: m.errorsPerGame !== undefined ? per(m.errorsPerGame) : undefined,
			sub: m.analysed.length ? `Blunders ${per(m.blundersPerGame)}${m.acpl !== undefined ? ` · ACPL ${Math.round(m.acpl)}` : ""} · ${m.analysed.length} games` : "",
			games: m.analysed.length,
			delta:
				mPrev?.errorsPerGame !== undefined && m.errorsPerGame !== undefined && enoughPrev(mPrev.analysed.length)
					? { value: m.errorsPerGame - mPrev.errorsPerGame, text: signed(m.errorsPerGame - mPrev.errorsPerGame, 2), goodWhen: "down" }
					: undefined,
			onClick: () => this.openList("Analysed games", m.analysed),
		});

		const t = timeFigures(rows);
		const tPrev = prev ? timeFigures(prev) : undefined;
		this.statCard(el, {
			title: "Time trouble",
			value: t.timeTroublePct !== undefined ? `${Math.round(t.timeTroublePct)}%` : undefined,
			sub: `${t.lostOnTime.length} lost on time · ${t.withClocks.length} games with clocks`,
			games: t.withClocks.length,
			delta: tPrev?.timeTroublePct !== undefined && t.timeTroublePct !== undefined && enoughPrev(tPrev.withClocks.length) ? { value: t.timeTroublePct - tPrev.timeTroublePct, text: `${signed(t.timeTroublePct - tPrev.timeTroublePct)} pts`, goodWhen: "down" } : undefined,
			onClick: () => this.openList("Games in time trouble", t.timeTroubleGames),
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

	private accuracyFoot(n: number, site: AccuracySite | undefined): string {
		if (!site || !n) return "No games with Lichess accuracy here. Lichess gives accuracy for games analysed on lichess.org (“Request a computer analysis”).";
		return `${n} game${n === 1 ? "" : "s"} with ${SITE_LABEL[site]} accuracy.`;
	}

	private legend(body: HTMLElement, items: Array<[string, string]>): void {
		const legend = body.createDiv({ cls: "cr-legend" });
		for (const [name, c] of items) {
			const l = legend.createSpan({ cls: "cr-legend-item" });
			l.createSpan({ cls: "cr-swatch-dot", attr: { style: `background:${c}` } });
			l.appendText(name);
		}
	}

	private panelRatingHistory(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Rating history", "Where is my rating going?");
		const hist = ratingHistory(rows);
		if (!hist.length) {
			body.createDiv({ cls: "cr-empty", text: "No rated online games in this selection." });
			return;
		}
		const colours = ["var(--cr-c1)", "var(--cr-c2)", "var(--cr-c3)", "var(--cr-c4)", "var(--cr-c5)"];
		const shown = hist.slice(0, 5);
		this.legend(body, shown.map((h, i) => [groupLabel(h.group), colours[i]] as [string, string]));
		lineChart(
			body.createDiv({ cls: "cr-chart-box" }),
			shown.map((h, i) => ({
				name: groupLabel(h.group),
				color: colours[i],
				points: h.days.map((d) => {
					const sc = scoreFigures(d.games);
					const tip =
						d.games.length === 1
							? `${d.date} · ${d.rating} · vs ${d.games[0].opponent} (${d.games[0].oppRating ?? "?"}) · ${d.games[0].myResult}`
							: `${d.date} · ${d.rating} · ${d.games.length} games (W ${sc.wins} · D ${sc.draws} · L ${sc.losses})`;
					return { x: dayNum(d.date), y: d.rating, data: d, tip };
				}),
			})),
			{
				tip: this.tip,
				xFormat: fmtDay,
				onClick: (p) => (p.data.games.length === 1 ? this.host.openGame(p.data.games[0]) : this.openList(`${groupLabel({ site: p.data.games[0].site, timeClass: p.data.games[0].timeClass })} · ${p.data.date}`, p.data.games)),
			},
		);
		foot("One point per day: the rating before that day's last game. Click a day to see its games.");
	}

	private analysedFoot(analysed: number, total: number): string {
		const awaiting = total - analysed;
		return `${analysed} of ${total} games analysed.` + (awaiting ? " Games are analysed when you request a computer analysis on lichess.org (OTB games: “Analyse this game”), so these figures may lean towards the games you chose to look at." : "");
	}

	private panelMistakeTrend(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Mistake trend", "Am I making fewer mistakes?");
		const months = mistakeTrend(rows);
		if (!months.length) {
			body.createDiv({ cls: "cr-empty", text: "No analysed games in this selection." });
			foot(this.analysedFoot(0, rows.length));
			return;
		}
		const x = (m: string) => Date.parse(`${m}-15T00:00:00Z`);
		const tip = (m: (typeof months)[number]) =>
			`${m.month} · ${per(m.errorsPerGame)} mistakes, ${per(m.blundersPerGame)} blunders per game${m.acpl !== undefined ? ` · ACPL ${Math.round(m.acpl)}` : ""} · ${m.games.length} games`;
		this.legend(body, [["Mistakes + blunders per game", "var(--cr-c1)"], ["Blunders per game", "var(--cr-c2)"]]);
		lineChart(
			body.createDiv({ cls: "cr-chart-box" }),
			[
				{ name: "Mistakes", color: "var(--cr-c1)", dots: true, points: months.map((m) => ({ x: x(m.month), y: m.errorsPerGame, data: m, tip: tip(m) })) },
				{ name: "Blunders", color: "var(--cr-c2)", dots: true, points: months.map((m) => ({ x: x(m.month), y: m.blundersPerGame, data: m, tip: tip(m) })) },
			],
			{
				tip: this.tip,
				zeroBased: true,
				yFormat: (v) => v.toFixed(1),
				xFormat: (ms) => new Date(ms).toISOString().slice(0, 7),
				onClick: (p) => this.openList(`Analysed games · ${p.data.month}`, p.data.games),
			},
		);
		foot(`One point per month. ${this.analysedFoot(analysedRows(rows).length, rows.length)}`);
	}

	private panelMistakes(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Where I make mistakes", "When and how do my mistakes happen?");
		const m = mistakeFigures(rows);
		const min = this.minGames();
		if (!m.analysed.length) {
			body.createDiv({ cls: "cr-empty", text: "No analysed games in this selection." });
			foot(this.analysedFoot(0, rows.length));
			return;
		}
		const figs = body.createDiv({ cls: "cr-figs cr-figs-3" });
		const fig = (value: string, label: string, sub: string, n: number, games?: GameRow[]) => {
			const f = figs.createDiv({ cls: "cr-fig" + (games?.length ? " is-clickable" : "") + (n >= min ? "" : " is-muted") });
			f.createDiv({ cls: "cr-fig-value", text: n >= min ? value : "–" });
			f.createDiv({ cls: "cr-fig-label", text: label });
			if (sub) f.createDiv({ cls: "cr-fig-label cr-fig-sub", text: sub });
			if (games?.length) f.addEventListener("click", () => this.openList(cap(label), games));
		};
		const whole = (v?: number) => (v === undefined ? "–" : `${Math.round(v)}%`);
		fig(per(m.errorsPerGame), "mistakes per game", `Opponents ${per(m.oppErrorsPerGame)}`, m.analysed.length, m.analysed);
		fig(whole(m.lowClockPct), "made in time trouble", `${m.lowClockErrors} of ${m.clockErrors} mistakes`, m.clockGames.length, m.clockGames.filter((g) => (g.errLowClock ?? 0) > 0));
		fig(whole(m.missedPct), "of their mistakes not punished", `${m.missed} of ${m.oppErrors}`, m.analysed.length, m.missedGames);
		fig(m.firstErrorMedian !== undefined ? `move ${Math.round(m.firstErrorMedian)}` : "–", "first mistake", "median", m.analysed.length);
		fig(whole(m.analysed.length ? (m.clean.length / m.analysed.length) * 100 : undefined), "games without a mistake", `${m.clean.length} games`, m.analysed.length, m.clean);
		fig(per(m.inaccuraciesPerGame), "inaccuracies per game", m.acpl !== undefined ? `ACPL ${Math.round(m.acpl)}` : "", m.analysed.length);
		if (m.phaseGames.length) {
			const n = m.phaseGames.length;
			const phase = (key: "opening" | "middlegame" | "endgame", label: string, has: (g: GameRow) => boolean) => ({
				label,
				sub: `${n} games`,
				muted: n < min,
				data: m.phaseGames.filter(has),
				bars: [{ name: "Me", value: n >= min ? m.byPhase[key] : undefined, color: "var(--cr-c1)", tip: `${label}: ${per(m.byPhase[key])} mistakes per game` }],
			});
			body.createDiv({ cls: "cr-panel-lead", text: "Mistakes per game, by phase" });
			barChart(
				body.createDiv({ cls: "cr-chart-box" }),
				[
					phase("opening", "Opening", (g) => (g.errOpening ?? 0) > 0),
					phase("middlegame", "Middlegame", (g) => (g.errMiddlegame ?? 0) > 0),
					phase("endgame", "Endgame", (g) => (g.errEndgame ?? 0) > 0),
				],
				{ tip: this.tip, format: (v) => v.toFixed(2), onClick: (g) => this.openList(`Mistakes in the ${g.label.toLowerCase()}`, g.data) },
			);
		}
		foot(
			`Mistakes = Lichess's “Mistake” and “Blunder” (for OTB games, the same thresholds on Stockfish's analysis). Time trouble: clock below 10% of base time or 30 s before the move. Not punished: my reply gave back at least ${Math.round(MISSED_GIVE_BACK * 100)}% of what their mistake gave me. Phases follow Lichess's division (Lichess games only). ${this.analysedFoot(m.analysed.length, rows.length)}`,
		);
	}

	private panelBands(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Against stronger and weaker", "Do I underperform against a kind of opponent?");
		const min = this.minGames();
		barChart<BandFigures>(
			body.createDiv({ cls: "cr-chart-box" }),
			bandFigures(rows).map((b) => ({
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
		this.legend(body, [["Actual score %", "var(--cr-c1)"], ["Expected score %", "var(--cr-c2)"]]);
		foot("Opponent − my rating, pre-game, same site. Click a band to filter.");
	}

	private panelOpenings(parent: HTMLElement, rows: GameRow[], site: AccuracySite | undefined): void {
		const { body, foot } = this.panel(parent, "Openings", "Which openings cost me points?", "is-wide");
		const table = openingTable(rows, site);
		if (!table.length) {
			body.createDiv({ cls: "cr-empty", text: "No games in this selection." });
			return;
		}
		const wrap = body.createDiv({ cls: "cr-table-wrap" });
		const t = wrap.createEl("table", { cls: "cr-table" });
		const head = t.createEl("thead").createEl("tr");
		for (const h of ["Opening", "Games", "Score", "Vs expected", site ? `Accuracy (${SITE_LABEL[site]})` : "Accuracy", "Mistakes / game"]) head.createEl("th", { text: h });
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
			tr.createEl("td", { text: r.accuracyGames >= min ? `${acc(r.accuracy)} (${r.accuracyGames})` : r.accuracyGames ? `${r.accuracyGames} games` : "–" });
			tr.createEl("td", { text: r.analysedGames >= min ? `${per(r.errorsPerGame)} (${r.analysedGames})` : r.analysedGames ? `${r.analysedGames} games` : "–" });
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
		foot("A poor score with few mistakes points to the opposition you meet in that opening; many mistakes point to your play. Mistakes = mistakes + blunders in analysed games. Click a row to filter.");
	}

	/** Table of games split by result; each count opens its games. */
	private resultTable(body: HTMLElement, first: string, rows: Array<{ label: string; split: ResultSplit; extra?: string }>, extraHead?: string): void {
		const min = this.minGames();
		const wrap = body.createDiv({ cls: "cr-table-wrap" });
		const t = wrap.createEl("table", { cls: "cr-table cr-result-table" });
		const head = t.createEl("thead").createEl("tr");
		for (const h of [first, "Games", "W", "D", "L", "Score"]) head.createEl("th", { text: h });
		if (extraHead) head.createEl("th", { text: extraHead, cls: "cr-col-extra" });
		const tb = t.createEl("tbody");
		for (const r of rows) {
			const s = r.split;
			const enough = s.games.length >= min;
			const tr = tb.createEl("tr", { cls: enough ? "" : "is-muted" });
			tr.createEl("td", { cls: "cr-td-name", text: r.label });
			const cell = (games: GameRow[], what: string) => {
				const td = tr.createEl("td", { text: String(games.length), cls: games.length ? "is-clickable" : "" });
				if (games.length)
					td.addEventListener("click", (e) => {
						e.stopPropagation();
						this.openList(`${r.label} · ${what}`, games);
					});
			};
			cell(s.games, "all");
			cell(s.wins, "won");
			cell(s.draws, "drawn");
			cell(s.losses, "lost");
			tr.createEl("td", { text: enough && s.scorePct !== undefined ? `${Math.round(s.scorePct)}%` : "–" });
			if (extraHead) tr.createEl("td", { text: enough ? r.extra ?? "–" : "–", cls: "cr-col-extra" });
		}
	}

	private movesFoot(withoutMoves: number): string {
		return withoutMoves ? ` ${withoutMoves} game${withoutMoves === 1 ? "" : "s"} not read yet.` : "";
	}

	private panelComebacks(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Converting and saving", "Do I win winning positions and save lost ones?");
		const m = materialFigures(rows);
		if (!m.withMoves.length) {
			body.createDiv({ cls: "cr-empty", text: "No analysed games or move statistics yet." });
			foot(this.movesFoot(m.withoutMoves).trim());
			return;
		}
		const figs = body.createDiv({ cls: "cr-figs cr-figs-3" });
		const fig = (value: string, label: string, sub: string, games: GameRow[]) => {
			const f = figs.createDiv({ cls: "cr-fig" + (games.length ? " is-clickable" : "") });
			f.createDiv({ cls: "cr-fig-value", text: value });
			f.createDiv({ cls: "cr-fig-label", text: label });
			f.createDiv({ cls: "cr-fig-label cr-fig-sub", text: sub });
			if (games.length) f.addEventListener("click", () => this.openList(cap(label), games));
		};
		fig(m.up.games.length ? `${Math.round((m.up.wins.length / m.up.games.length) * 100)}%` : "–", "winning positions won", `${m.up.wins.length} of ${m.up.games.length}`, m.up.wins);
		fig(String(m.letSlip.length), "let slip", `${m.up.draws.length} D · ${m.up.losses.length} L`, m.letSlip);
		fig(String(m.turnedAround.length), "saved", `${m.down.wins.length} W · ${m.down.draws.length} D of ${m.down.games.length} lost positions`, m.turnedAround);
		this.resultTable(body, "Position", [
			{ label: "Was winning", split: m.up },
			{ label: "Was losing", split: m.down },
		]);
		const byMaterial = m.withMoves.length - m.byEval;
		foot(
			`Winning / losing: the evaluation was at least ${WINNING_EVAL} pawns for me / against me for two moves or more (${m.byEval} analysed games).` +
				(byMaterial
					? ` ${byMaterial} game${byMaterial === 1 ? "" : "s"} without an analysis are judged by material instead: up or down ${MATERIAL_SWING} points for three moves or more.`
					: "") +
				this.movesFoot(m.withoutMoves),
		);
	}

	private panelImbalances(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Material imbalances", "How do I score with unbalanced material?");
		const table = imbalanceTable(rows);
		const withMoves = rows.filter((g) => g.imbalances !== undefined);
		const any = new Set(table.flatMap((r) => r.games.map((g) => g.key))).size;
		if (!table.length) body.createDiv({ cls: "cr-empty", text: withMoves.length ? "No lasting imbalances in this selection." : "No games with move statistics yet." });
		else {
			body.createDiv({ cls: "cr-panel-lead", text: `${any} of ${withMoves.length} games (${pct((any / withMoves.length) * 100)}) had at least one.` });
			this.resultTable(
				body,
				"Imbalance",
				table.map((r) => ({ label: IMBALANCE_LABEL[r.kind], split: r, extra: r.vsExpected !== undefined ? signed(r.vsExpected) : undefined })),
				"Vs expected",
			);
		}
		foot(`Named from my side ("queen vs pieces": I had the queen). An imbalance counts when it lasts three moves or more.${this.movesFoot(rows.length - withMoves.length)}`);
	}

	private panelEndgames(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Endgames", "Do I score better in long games or short ones?");
		const e = endgameFigures(rows);
		const known = e.reached.games.length + e.notReached.games.length;
		if (!known) {
			body.createDiv({ cls: "cr-empty", text: "No games with move statistics yet." });
			return;
		}
		body.createDiv({ cls: "cr-panel-lead", text: `${pct(e.reachedPct)} of games reached an endgame.` });
		this.resultTable(body, "Game", [
			{ label: "Reached an endgame", split: e.reached },
			{ label: "Decided before", split: e.notReached },
		]);
		foot(`Endgame: six or fewer pieces left (not counting kings and pawns), both sides together.${this.movesFoot(rows.length - known)}`);
	}

	private panelAccuracyByResult(parent: HTMLElement, accRows: AccuracyRow[], site: AccuracySite | undefined): void {
		const { body, foot } = this.panel(parent, "Accuracy by result", "How well do I play when I win, draw and lose?");
		const min = this.minGames();
		barChart(
			body.createDiv({ cls: "cr-chart-box" }),
			accuracyByResult(accRows).map((s) => ({
				label: RESULT_LABEL[s.key],
				sub: `${s.games.length} games`,
				muted: s.games.length < min,
				data: s,
				bars: [
					{ name: "Me", value: s.games.length >= min ? s.mine : undefined, color: "var(--cr-c1)", tip: `My accuracy ${acc(s.mine)} · ${s.games.length} games` },
					{ name: "Opponents", value: s.games.length >= min ? s.opp : undefined, color: "var(--cr-c2)", tip: `Opponents ${acc(s.opp)}` },
				],
			})),
			{ tip: this.tip, max: 100, format: (v) => v.toFixed(0), onClick: (g) => this.openList(`${RESULT_LABEL[g.data.key]} with accuracy`, g.data.games) },
		);
		this.legend(body, [["My accuracy", "var(--cr-c1)"], ["Opponents' (same games)", "var(--cr-c2)"]]);
		foot(this.accuracyFoot(accRows.length, site));
	}

	private panelAccuracyByTimeClass(parent: HTMLElement, accRows: AccuracyRow[], site: AccuracySite | undefined): void {
		const { body, foot } = this.panel(parent, "Accuracy by time control", "Where do I play my best chess?");
		const min = this.minGames();
		const split = accuracyByTimeClass(accRows);
		if (!split.length) {
			body.createDiv({ cls: "cr-empty", text: "No games with site accuracy in this selection." });
		} else {
			barChart(
				body.createDiv({ cls: "cr-chart-box" }),
				split.map((s) => ({
					label: cap(s.key),
					sub: `${s.games.length} games`,
					muted: s.games.length < min,
					data: s,
					bars: [
						{ name: "Me", value: s.games.length >= min ? s.mine : undefined, color: "var(--cr-c1)", tip: `My accuracy ${acc(s.mine)} · ${s.games.length} games` },
						{ name: "Opponents", value: s.games.length >= min ? s.opp : undefined, color: "var(--cr-c2)", tip: `Opponents ${acc(s.opp)}` },
					],
				})),
				{ tip: this.tip, max: 100, format: (v) => v.toFixed(0), onClick: (g) => this.openList(`${cap(g.data.key)} games with accuracy`, g.data.games) },
			);
			this.legend(body, [["My accuracy", "var(--cr-c1)"], ["Opponents'", "var(--cr-c2)"]]);
		}
		foot(this.accuracyFoot(accRows.length, site));
	}

	private panelTime(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Time management", "Does the clock cost me points?");
		const t = timeFigures(rows);
		const min = this.minGames();
		const n = t.withClocks.length;
		const figs = body.createDiv({ cls: "cr-figs cr-figs-3" });
		const fig = (value: string, label: string, sub: string, games?: GameRow[]) => {
			const f = figs.createDiv({ cls: "cr-fig" + (games?.length ? " is-clickable" : "") + (n >= min ? "" : " is-muted") });
			f.createDiv({ cls: "cr-fig-value", text: n >= min ? value : "–" });
			f.createDiv({ cls: "cr-fig-label", text: label });
			if (sub) f.createDiv({ cls: "cr-fig-label cr-fig-sub", text: sub });
			if (games?.length) f.addEventListener("click", () => this.openList(cap(label), games));
		};
		const whole = (v?: number) => (v === undefined ? "–" : `${Math.round(v)}%`);
		fig(whole(t.timeTroublePct), "me in time trouble", `${t.timeTroubleGames.length} games`, t.timeTroubleGames);
		fig(whole(t.oppTroublePct), "opponent in time trouble", `${t.oppTroubleGames.length} games`, t.oppTroubleGames);
		fig(t.medianFirst10 !== undefined ? `${Math.round(t.medianFirst10)} s` : "–", "first 10 moves", "median", t.withClocks);
		fig(String(t.lostOnTime.length), "lost on time", `${t.lostOnTimeNotBehind.length} not behind on material`, t.lostOnTime);
		fig(String(t.wonOnTime.length), "won on time", "", t.wonOnTime);
		fig(t.medianLongestThink !== undefined ? fmtSeconds(t.medianLongestThink) : "–", "longest think", "median per game");
		this.resultTable(body, "Time trouble", [
			{ label: "Only me", split: t.trouble.onlyMe },
			{ label: "Only opponent", split: t.trouble.onlyOpp },
			{ label: "Both", split: t.trouble.both },
			{ label: "Neither", split: t.trouble.neither },
		]);
		foot(
			`Time trouble: clock below 10% of base time or 30 s after any move. "Not behind on material": level or ahead in the final position. ${t.withoutClocks} game${t.withoutClocks === 1 ? "" : "s"} without clocks not included.`,
		);
	}

	private panelClockRace(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Clock race", "Do I spend my time faster than my opponents?");
		const r = clockRace(rows);
		const min = this.minGames();
		if (!r.checkpoints[0].games.length) {
			body.createDiv({ cls: "cr-empty", text: "No games with both players' clocks in this selection." });
			return;
		}
		barChart(
			body.createDiv({ cls: "cr-chart-box" }),
			r.checkpoints.map((c) => ({
				label: `Move ${c.move}`,
				sub: `${c.games.length} games`,
				muted: c.games.length < min,
				data: c,
				bars: [
					{ name: "Me", value: c.games.length >= min ? c.mine : undefined, color: "var(--cr-c1)", tip: `Me: ${c.mine ?? "–"}% of base time left · ${c.games.length} games` },
					{ name: "Opponents", value: c.games.length >= min ? c.opp : undefined, color: "var(--cr-c2)", tip: `Opponents: ${c.opp ?? "–"}% left` },
				],
			})),
			{ tip: this.tip, max: 100, format: (v) => `${Math.round(v)}%`, onClick: (g) => this.openList(`Games reaching move ${g.data.move}`, g.data.games) },
		);
		this.legend(body, [["My clock left (median)", "var(--cr-c1)"], ["Opponents'", "var(--cr-c2)"]]);
		this.resultTable(body, `At move ${CLOCK_EDGE_MOVE}`, [
			{ label: "More time", split: r.ahead },
			{ label: "About even", split: r.even },
			{ label: "Less time", split: r.behind },
		]);
		foot(`Clock left as % of base time (it can pass 100% with increment). "More time": at least ${CLOCK_EDGE_PCT} points more than the opponent after my ${CLOCK_EDGE_MOVE}th move. Daily and OTB games without clocks are not included.`);
	}

	private panelQueue(parent: HTMLElement, rows: GameRow[]): void {
		const { body, foot } = this.panel(parent, "Review queue", "Which games should I review next?");
		const q = reviewQueue(rows);
		if (!q.length) {
			body.createDiv({ cls: "cr-empty", text: "Nothing to review: no unreviewed analysed games here." });
			return;
		}
		const wrap = body.createDiv({ cls: "cr-table-wrap" });
		const t = wrap.createEl("table", { cls: "cr-table" });
		const head = t.createEl("thead").createEl("tr");
		for (const h of ["Date", "Opponent", "Result", "Mistakes", "Accuracy", ""]) head.createEl("th", { text: h });
		const tb = t.createEl("tbody");
		for (const item of q) {
			const g = item.game;
			const tr = tb.createEl("tr", { cls: "is-clickable" });
			tr.createEl("td", { text: g.date });
			const opp = tr.createEl("td");
			opp.createDiv({ text: g.opponent });
			opp.createDiv({ cls: "cr-td-sub", text: SITE_LABEL[g.site] });
			const res = tr.createEl("td", { cls: `cr-result is-${g.myResult}`, text: g.myResult });
			if (item.thrownWin) res.createDiv({ cls: "cr-td-sub", text: "was winning" });
			tr.createEl("td", {
				text: g.analysed ? `${g.myBlunders ?? 0} B · ${g.myMistakes ?? 0} M` : "–",
				attr: { title: "My blunders and mistakes" },
			});
			tr.createEl("td", {
				text: g.myAccuracy !== undefined && g.oppAccuracy !== undefined ? `${Math.round(g.myAccuracy)} – ${Math.round(g.oppAccuracy)}` : "–",
				attr: { title: "My accuracy – my opponent's" },
			});
			const td = tr.createEl("td");
			const b = td.createEl("button", { cls: "cr-mark-btn clickable-icon", attr: { "aria-label": "Mark reviewed", title: "Mark reviewed" } });
			setIcon(b, "check");
			b.addEventListener("click", async (e) => {
				e.stopPropagation();
				b.disabled = true;
				await this.host.markReviewed(g);
				this.host.index.invalidate(true);
			});
			tr.addEventListener("click", () => this.host.openGame(g));
		}
		foot("Ranked by my blunders (1 each) and mistakes (½ each, up to 2 together), how much less accurate I was than my opponent (points ÷ 10, up to 1), +0.5 if I let a winning position go and +0.5 if I lost. ✓ marks a game reviewed.");
	}

	private openList(title: string, games: GameRow[]): void {
		new GameListModal(this.app, title, games, (g) => this.host.openGame(g)).open();
	}
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
			["accuracy", "Accuracy", (g) => (g.myAccuracy !== undefined ? g.myAccuracy : "–")],
			["mistakes", "Mistakes", (g) => (g.analysed ? (g.myMistakes ?? 0) + (g.myBlunders ?? 0) : "–")],
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
