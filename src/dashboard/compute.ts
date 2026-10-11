/**
 * Dashboard figures from the game index: filters, periods, summary cards and the
 * nine panels. Pure functions over GameRow[]; no Obsidian or DOM access.
 */
import type { Site, TimeClass } from "../types";
import type { GameSummary, SummaryMark } from "./summary";
import {
	BANDS,
	Band,
	MyResult,
	PHASES,
	Phase,
	TREND_WINDOW,
	WEAKEST_PHASE_MIN_MOVES,
	errorRate,
	expectedScore,
	isError,
	median,
	openingFamily,
	performanceRating,
	points,
	ratingBand,
	reviewPriority,
} from "./definitions";

/* ------------------------------------------------------------------ */
/* Index rows                                                          */
/* ------------------------------------------------------------------ */

export interface GameRow {
	key: string;
	path: string;
	site: Site;
	url?: string;
	date: string; // YYYY-MM-DD
	playedAt: string;
	myColour: "white" | "black";
	myResult: MyResult;
	result: string;
	myRating?: number;
	oppRating?: number;
	timeClass?: TimeClass;
	rated?: boolean;
	opening?: string;
	eco?: string;
	family: string;
	opponent: string;
	engine?: string;
	analysisStatus?: string;
	reviewed: boolean;
	termination?: string;
	summary?: GameSummary;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

/** Build a row from game-note frontmatter; undefined when the note is not a usable game. */
export function rowFromFrontmatter(path: string, fm: Record<string, unknown>, summary?: GameSummary): GameRow | undefined {
	const key = str(fm["game-key"]);
	const site = str(fm.site) as Site | undefined;
	const myColour = fm["my-colour"] === "black" ? "black" : fm["my-colour"] === "white" ? "white" : undefined;
	const myResult = fm["my-result"];
	if (!key || !site || !myColour || (myResult !== "win" && myResult !== "loss" && myResult !== "draw")) return undefined;
	const playedAt = str(fm["played-at"]) ?? "";
	const date = str(fm.date) ?? playedAt.slice(0, 10);
	const opening = str(fm.opening);
	const eco = str(fm.eco);
	const white = str(fm.white) ?? "?";
	const black = str(fm.black) ?? "?";
	const tc = str(fm["time-class"]);
	return {
		key,
		path,
		site,
		url: str(fm.url),
		date,
		playedAt,
		myColour,
		myResult,
		result: str(fm.result) ?? "*",
		myRating: num(fm["my-rating"]),
		oppRating: num(fm["opp-rating"]),
		timeClass: tc as TimeClass | undefined,
		rated: typeof fm.rated === "boolean" ? fm.rated : undefined,
		opening,
		eco,
		family: openingFamily(opening, eco),
		opponent: myColour === "white" ? black : white,
		engine: str(fm.engine),
		analysisStatus: str(fm["analysis-status"]),
		reviewed: fm.reviewed === true,
		termination: str(fm.termination),
		summary,
	};
}

/* ------------------------------------------------------------------ */
/* Filters and periods                                                  */
/* ------------------------------------------------------------------ */

export type Period = "30d" | "3m" | "12m" | "all" | "custom";

export interface Filters {
	period: Period;
	from?: string; // custom, YYYY-MM-DD
	to?: string;
	sites: Site[]; // empty = all
	timeClasses: TimeClass[]; // empty = all
	colour: "both" | "white" | "black";
	ratedOnly: boolean;
	bands: Band[]; // empty = all
	families: string[]; // empty = all
}

export const defaultFilters = (period: Period = "3m"): Filters => ({
	period,
	sites: [],
	timeClasses: ["rapid", "classical"],
	colour: "both",
	ratedOnly: true,
	bands: [],
	families: [],
});

export interface DateRange {
	from?: string; // inclusive
	to?: string; // inclusive
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return isoDay(d);
};
const addMonths = (day: string, n: number) => {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() + n);
	return isoDay(d);
};

/** Current period and the previous period of the same length (none for "all"). */
export function periodRanges(f: Filters, today: string): { current: DateRange; previous?: DateRange } {
	switch (f.period) {
		case "all":
			return { current: {} };
		case "custom": {
			const from = f.from;
			const to = f.to ?? today;
			if (!from) return { current: { to } };
			const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
			return { current: { from, to }, previous: { from: addDays(from, -days), to: addDays(from, -1) } };
		}
		case "30d": {
			const from = addDays(today, -29);
			return { current: { from, to: today }, previous: { from: addDays(from, -30), to: addDays(from, -1) } };
		}
		default: {
			const months = f.period === "3m" ? 3 : 12;
			const from = addDays(addMonths(today, -months), 1);
			return { current: { from, to: today }, previous: { from: addDays(addMonths(from, -months), 0), to: addDays(from, -1) } };
		}
	}
}

const inRange = (date: string, r: DateRange) => (!r.from || date >= r.from) && (!r.to || date <= r.to);

/** Every filter except the period. */
export function matchesFilters(g: GameRow, f: Filters): boolean {
	if (f.sites.length && !f.sites.includes(g.site)) return false;
	if (f.timeClasses.length && (!g.timeClass || !f.timeClasses.includes(g.timeClass))) {
		// OTB games often have no time class; keep them when OTB is explicitly selected.
		if (!(g.site === "otb" && !g.timeClass && f.sites.includes("otb"))) return false;
	}
	if (f.colour !== "both" && g.myColour !== f.colour) return false;
	if (f.ratedOnly && g.rated === false) return false;
	if (f.bands.length) {
		if (g.myRating === undefined || g.oppRating === undefined) return false;
		if (!f.bands.includes(ratingBand(g.myRating, g.oppRating))) return false;
	}
	if (f.families.length && !f.families.includes(g.family)) return false;
	return true;
}

export function select(rows: GameRow[], f: Filters, range: DateRange): GameRow[] {
	return rows.filter((g) => inRange(g.date, range) && matchesFilters(g, f));
}

/** Games analysed with the current engine setting (the only ones engine panels use). */
export function engineRows(rows: GameRow[], engineLabel: string): Array<GameRow & { summary: GameSummary }> {
	return rows.filter(
		(g): g is GameRow & { summary: GameSummary } =>
			g.analysisStatus === "done" && g.engine === engineLabel && !!g.summary && g.summary.engine === engineLabel,
	);
}

/* ------------------------------------------------------------------ */
/* Summary cards                                                        */
/* ------------------------------------------------------------------ */

export interface ScoreFigures {
	games: number;
	wins: number;
	draws: number;
	losses: number;
	points: number;
	pct?: number; // 0–100
}

export function scoreFigures(rows: GameRow[]): ScoreFigures {
	const wins = rows.filter((g) => g.myResult === "win").length;
	const draws = rows.filter((g) => g.myResult === "draw").length;
	const losses = rows.length - wins - draws;
	const pts = wins + draws / 2;
	return { games: rows.length, wins, draws, losses, points: pts, pct: rows.length ? (pts / rows.length) * 100 : undefined };
}

export interface ExpectedFigures {
	games: number; // games with both ratings
	actual: number;
	expected: number;
	diff?: number; // actual − expected points
	per100?: number;
}

export function vsExpected(rows: GameRow[]): ExpectedFigures {
	const rated = rows.filter((g) => g.myRating !== undefined && g.oppRating !== undefined);
	const actual = rated.reduce((a, g) => a + points(g.myResult), 0);
	const expected = rated.reduce((a, g) => a + expectedScore(g.myRating as number, g.oppRating as number), 0);
	const diff = rated.length ? actual - expected : undefined;
	return { games: rated.length, actual, expected, diff, per100: diff !== undefined ? (diff / rated.length) * 100 : undefined };
}

export interface Group {
	id: string; // "lichess|rapid"
	site: Site;
	timeClass?: TimeClass;
	games: GameRow[];
}

/** Groups by site × time class, most-played first. */
export function siteTimeGroups(rows: GameRow[]): Group[] {
	const m = new Map<string, Group>();
	for (const g of rows) {
		const id = `${g.site}|${g.timeClass ?? "?"}`;
		if (!m.has(id)) m.set(id, { id, site: g.site, timeClass: g.timeClass, games: [] });
		m.get(id)?.games.push(g);
	}
	return [...m.values()].sort((a, b) => b.games.length - a.games.length);
}

export function performanceOf(rows: GameRow[]): { games: number; rating?: number } {
	const rated = rows.filter((g) => g.oppRating !== undefined);
	return {
		games: rated.length,
		rating: performanceRating(rated.map((g) => g.oppRating as number), rated.reduce((a, g) => a + points(g.myResult), 0)),
	};
}

export interface ErrorFigures {
	games: number;
	errors: number;
	moves: number;
	rate?: number;
	medianAcpl?: number;
}

export function errorFigures(rows: Array<GameRow & { summary: GameSummary }>): ErrorFigures {
	let errors = 0;
	let moves = 0;
	for (const g of rows) {
		moves += g.summary.myMoves;
		errors += g.summary.marks.filter((m) => m.side === "me" && isError(m.kind)).length;
	}
	return { games: rows.length, errors, moves, rate: errorRate(errors, moves), medianAcpl: median(rows.map((g) => g.summary.myAcpl)) };
}

export interface PhaseFigures {
	phase: Phase;
	myMoves: number;
	oppMoves: number;
	myErrors: number;
	oppErrors: number;
	myInaccuracies: number;
	myRate?: number;
	oppRate?: number;
	myInaccuracyRate?: number;
	games: number; // games with at least one of my errors in this phase
}

export function phaseFigures(rows: Array<GameRow & { summary: GameSummary }>): PhaseFigures[] {
	return PHASES.map((phase) => {
		let myMoves = 0;
		let oppMoves = 0;
		let myErrors = 0;
		let oppErrors = 0;
		let myInacc = 0;
		let games = 0;
		for (const g of rows) {
			myMoves += g.summary.myMovesByPhase[phase];
			oppMoves += g.summary.oppMovesByPhase[phase];
			const inPhase = g.summary.marks.filter((m) => m.phase === phase);
			const mine = inPhase.filter((m) => m.side === "me" && isError(m.kind)).length;
			myErrors += mine;
			if (mine) games++;
			oppErrors += inPhase.filter((m) => m.side === "opp" && isError(m.kind)).length;
			myInacc += inPhase.filter((m) => m.side === "me" && m.kind === "inaccuracy").length;
		}
		return {
			phase,
			myMoves,
			oppMoves,
			myErrors,
			oppErrors,
			myInaccuracies: myInacc,
			myRate: errorRate(myErrors, myMoves),
			oppRate: errorRate(oppErrors, oppMoves),
			myInaccuracyRate: errorRate(myInacc, myMoves),
			games,
		};
	});
}

/** The phase where my error rate exceeds my opponents' by the most (20+ of my moves). */
export function weakestPhase(phases: PhaseFigures[]): PhaseFigures | undefined {
	let best: PhaseFigures | undefined;
	for (const p of phases) {
		if (p.myMoves < WEAKEST_PHASE_MIN_MOVES || p.myRate === undefined || p.oppRate === undefined) continue;
		if (!best || p.myRate - p.oppRate > (best.myRate as number) - (best.oppRate as number)) best = p;
	}
	return best;
}

export interface ConversionFigures {
	winningGames: GameRow[];
	conversionPct?: number;
	thrownAway: number;
	losingGames: GameRow[];
	savePct?: number;
	notConverted: Array<GameRow & { summary: GameSummary }>;
}

export function conversionFigures(rows: Array<GameRow & { summary: GameSummary }>): ConversionFigures {
	const winning = rows.filter((g) => g.summary.reachedWinning);
	const losing = rows.filter((g) => g.summary.reachedLosing);
	const pct = (gs: GameRow[]) => (gs.length ? (gs.reduce((a, g) => a + points(g.myResult), 0) / gs.length) * 100 : undefined);
	return {
		winningGames: winning,
		conversionPct: pct(winning),
		thrownAway: winning.reduce((a, g) => a + (1 - points(g.myResult)), 0),
		losingGames: losing,
		savePct: pct(losing),
		notConverted: winning.filter((g) => g.myResult !== "win").sort((a, b) => b.summary.myPeakEvalCp - a.summary.myPeakEvalCp),
	};
}

/* ------------------------------------------------------------------ */
/* Panels                                                               */
/* ------------------------------------------------------------------ */

export interface BandFigures {
	band: Band;
	games: GameRow[];
	actualPct?: number;
	expectedPct?: number;
}

export function bandFigures(rows: GameRow[]): BandFigures[] {
	return BANDS.map((band) => {
		const games = rows.filter((g) => g.myRating !== undefined && g.oppRating !== undefined && ratingBand(g.myRating, g.oppRating) === band);
		const n = games.length;
		return {
			band,
			games,
			actualPct: n ? (games.reduce((a, g) => a + points(g.myResult), 0) / n) * 100 : undefined,
			expectedPct: n ? (games.reduce((a, g) => a + expectedScore(g.myRating as number, g.oppRating as number), 0) / n) * 100 : undefined,
		};
	});
}

export interface OpeningRow {
	colour: "white" | "black";
	family: string;
	name: string; // family, or the full opening name for a variation row
	games: GameRow[];
	scorePct?: number;
	vsExpected?: number;
	outcomePawns?: number; // median eval after move 15, my side
	openingErrorRate?: number;
	variations?: OpeningRow[];
}

function openingRow(colour: "white" | "black", family: string, name: string, games: GameRow[], engineLabel: string): OpeningRow {
	const eng = engineRows(games, engineLabel);
	const evals = eng.map((g) => g.summary.myEvalAfterMove15Cp).filter((v): v is number => v !== null);
	let errs = 0;
	let moves = 0;
	for (const g of eng) {
		moves += g.summary.myMovesByPhase.opening;
		errs += g.summary.marks.filter((m) => m.side === "me" && m.phase === "opening" && isError(m.kind)).length;
	}
	const ve = vsExpected(games);
	const outcome = median(evals);
	return {
		colour,
		family,
		name,
		games,
		scorePct: scoreFigures(games).pct,
		vsExpected: ve.diff,
		outcomePawns: outcome !== undefined ? outcome / 100 : undefined,
		openingErrorRate: errorRate(errs, moves),
	};
}

/** Grouped by my colour, then opening family (sorted by games); variations by full name. */
export function openingTable(rows: GameRow[], engineLabel: string): OpeningRow[] {
	const out: OpeningRow[] = [];
	for (const colour of ["white", "black"] as const) {
		const byFamily = new Map<string, GameRow[]>();
		for (const g of rows.filter((r) => r.myColour === colour)) {
			if (!byFamily.has(g.family)) byFamily.set(g.family, []);
			byFamily.get(g.family)?.push(g);
		}
		const fams = [...byFamily.entries()].sort((a, b) => b[1].length - a[1].length);
		for (const [family, games] of fams) {
			const row = openingRow(colour, family, family, games, engineLabel);
			const byName = new Map<string, GameRow[]>();
			for (const g of games) {
				const n = g.opening ?? g.eco ?? family;
				if (!byName.has(n)) byName.set(n, []);
				byName.get(n)?.push(g);
			}
			if (byName.size > 1 || (byName.size === 1 && !byName.has(family))) {
				row.variations = [...byName.entries()]
					.sort((a, b) => b[1].length - a[1].length)
					.map(([name, gs]) => openingRow(colour, family, name, gs, engineLabel));
			}
			out.push(row);
		}
	}
	return out;
}

export interface TimeFigures {
	withClocks: Array<GameRow & { summary: GameSummary }>;
	withoutClocks: number;
	timeTroubleGames: GameRow[];
	timeTroublePct?: number;
	pressureRate?: number;
	calmRate?: number;
	pressureMoves: number;
	calmMoves: number;
	medianFirst10?: number;
	lostOnTime: GameRow[];
}

export function timeFigures(rows: Array<GameRow & { summary: GameSummary }>): TimeFigures {
	const withClocks = rows.filter((g) => g.summary.hasClocks && g.summary.timeTrouble !== null);
	let pErr = 0;
	let cErr = 0;
	let pMoves = 0;
	let cMoves = 0;
	for (const g of withClocks) {
		const under = g.summary.myMovesUnderPressure ?? 0;
		pMoves += under;
		cMoves += g.summary.myMoves - under;
		for (const m of g.summary.marks) {
			if (m.side !== "me" || !isError(m.kind)) continue;
			if (m.underPressure) pErr++;
			else cErr++;
		}
	}
	const trouble = withClocks.filter((g) => g.summary.timeTrouble);
	return {
		withClocks,
		withoutClocks: rows.length - withClocks.length,
		timeTroubleGames: trouble,
		timeTroublePct: withClocks.length ? (trouble.length / withClocks.length) * 100 : undefined,
		pressureRate: errorRate(pErr, pMoves),
		calmRate: errorRate(cErr, cMoves),
		pressureMoves: pMoves,
		calmMoves: cMoves,
		medianFirst10: median(withClocks.map((g) => g.summary.secondsOnFirst10Moves).filter((v): v is number => v !== null)),
		lostOnTime: withClocks.filter((g) => g.summary.lostOnTime),
	};
}

export interface TrendPoint {
	index: number; // position of the window's last game
	date: string;
	errorRate?: number;
	scorePct?: number;
	games: GameRow[];
}

/** Rolling 20-game error rate and score %, oldest first. Empty below 20 analysed games. */
export function trend(rows: Array<GameRow & { summary: GameSummary }>, window = TREND_WINDOW): TrendPoint[] {
	const sorted = [...rows].sort((a, b) => (a.playedAt || a.date).localeCompare(b.playedAt || b.date));
	const out: TrendPoint[] = [];
	for (let i = window - 1; i < sorted.length; i++) {
		const w = sorted.slice(i - window + 1, i + 1);
		out.push({ index: i, date: sorted[i].date, errorRate: errorFigures(w).rate, scorePct: scoreFigures(w).pct, games: w });
	}
	return out;
}

export interface Swing {
	game: GameRow & { summary: GameSummary };
	mark: SummaryMark;
	moveNumber: number;
}

/** The largest drops in my winning chances in the selection. */
export function biggestSwings(rows: Array<GameRow & { summary: GameSummary }>, n = 10): Swing[] {
	const all: Swing[] = [];
	for (const g of rows) {
		for (const m of g.summary.marks) {
			if (m.side === "me") all.push({ game: g, mark: m, moveNumber: Math.ceil(m.ply / 2) });
		}
	}
	return all.sort((a, b) => b.mark.deltaW - a.mark.deltaW).slice(0, n);
}

export interface QueueItem {
	game: GameRow & { summary: GameSummary };
	priority: number;
}

/** Analysed, unreviewed games ranked by review priority. */
export function reviewQueue(rows: Array<GameRow & { summary: GameSummary }>, n = 10): QueueItem[] {
	return rows
		.filter((g) => !g.reviewed)
		.map((g) => ({ game: g, priority: reviewPriority(g.summary.biggestSwing?.deltaW ?? 0, g.myResult, g.summary.reachedWinning) }))
		.sort((a, b) => b.priority - a.priority || b.game.date.localeCompare(a.game.date))
		.slice(0, n);
}

/** Rating history: per site × time class, games in date order with a pre-game rating. */
export function ratingHistory(rows: GameRow[]): Array<{ group: Group; points: GameRow[] }> {
	return siteTimeGroups(rows.filter((g) => g.myRating !== undefined && g.site !== "otb")).map((group) => ({
		group,
		points: [...group.games].sort((a, b) => (a.playedAt || a.date).localeCompare(b.playedAt || b.date)),
	}));
}
