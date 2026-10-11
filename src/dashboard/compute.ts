/**
 * Dashboard figures from the game index: filters, periods, summary cards and panels.
 * Uses only what the sites provide (results, ratings, clocks, Lichess/chess.com
 * accuracy) and piece counts from the moves. Accuracy is never averaged across sites,
 * because Lichess and chess.com measure it on different scales.
 * Pure functions over GameRow[]; no Obsidian or DOM access.
 */
import type { Site, TimeClass } from "../types";
import { TIME_CLASSES } from "../types";
import {
	BANDS,
	Band,
	CLOCK_CHECKPOINTS,
	CLOCK_EDGE_MOVE,
	CLOCK_EDGE_PCT,
	IMBALANCE_KINDS,
	Imbalance,
	MATERIAL_SWING,
	MyResult,
	expectedScore,
	lostOnTime,
	mean,
	median,
	openingFamily,
	performanceRating,
	points,
	ratingBand,
	reviewPriority,
	wonOnTime,
} from "./definitions";

/* ------------------------------------------------------------------ */
/* Index rows                                                          */
/* ------------------------------------------------------------------ */

export type AccuracySite = "lichess" | "chesscom";

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
	reviewed: boolean;
	termination?: string;
	/** Site-provided accuracy (Lichess or chess.com scale, by `site`). */
	myAccuracy?: number;
	oppAccuracy?: number;
	/** From the PGN clocks. */
	timeTrouble?: boolean;
	first10Seconds?: number;
	oppTimeTrouble?: boolean;
	/** Clock left after moves 10, 20, 30, 40, % of base time. */
	clockCurve?: number[];
	oppClockCurve?: number[];
	longestThink?: number;
	longestThinkMove?: number;
	/** From the moves (piece counting); undefined until the note has them. */
	moves?: number;
	materialLow?: number;
	materialHigh?: number;
	materialEnd?: number;
	imbalances?: Imbalance[];
	endgame?: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : undefined;

/** Build a row from game-note frontmatter; undefined when the note is not a usable game. */
export function rowFromFrontmatter(path: string, fm: Record<string, unknown>): GameRow | undefined {
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
		timeClass: str(fm["time-class"]) as TimeClass | undefined,
		rated: typeof fm.rated === "boolean" ? fm.rated : undefined,
		opening,
		eco,
		family: openingFamily(opening, eco),
		opponent: myColour === "white" ? black : white,
		reviewed: fm.reviewed === true,
		termination: str(fm.termination),
		myAccuracy: num(fm["site-accuracy"]),
		oppAccuracy: num(fm["opp-accuracy"]),
		timeTrouble: typeof fm["time-trouble"] === "boolean" ? fm["time-trouble"] : undefined,
		first10Seconds: num(fm["first-10-seconds"]),
		oppTimeTrouble: typeof fm["opp-time-trouble"] === "boolean" ? fm["opp-time-trouble"] : undefined,
		clockCurve: numList(fm["clock-curve"]),
		oppClockCurve: numList(fm["opp-clock-curve"]),
		longestThink: num(fm["longest-think"]),
		longestThinkMove: num(fm["longest-think-move"]),
		moves: num(fm.moves),
		materialLow: num(fm["material-low"]),
		materialHigh: num(fm["material-high"]),
		materialEnd: num(fm["material-end"]),
		imbalances: num(fm.moves) === undefined ? undefined : imbalanceList(fm.imbalances),
		endgame: typeof fm.endgame === "boolean" ? fm.endgame : undefined,
	};
}

function numList(v: unknown): number[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.map(num);
	return out.every((x): x is number => x !== undefined) && out.length ? out : undefined;
}

function imbalanceList(v: unknown): Imbalance[] {
	const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[,\s]+/) : [];
	return IMBALANCE_KINDS.filter((k) => list.includes(k));
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
	/** Which site's accuracy the accuracy figures use; undefined = the one with most games. */
	accuracySite?: AccuracySite;
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
			return { current: { from, to: today }, previous: { from: addMonths(from, -months), to: addDays(from, -1) } };
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

/* ------------------------------------------------------------------ */
/* Results and ratings                                                  */
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

export interface RatingDay {
	date: string;
	/** Pre-game rating of the day's last game: one point per day, so several games a day do not stack. */
	rating: number;
	games: GameRow[];
}

/** Rating history: per site × time class, one point per day with games. */
export function ratingHistory(rows: GameRow[]): Array<{ group: Group; days: RatingDay[] }> {
	return siteTimeGroups(rows.filter((g) => g.myRating !== undefined && g.site !== "otb")).map((group) => {
		const sorted = [...group.games].sort((a, b) => (a.playedAt || a.date).localeCompare(b.playedAt || b.date));
		const days: RatingDay[] = [];
		for (const g of sorted) {
			const last = days[days.length - 1];
			if (last && last.date === g.date) {
				last.games.push(g);
				last.rating = g.myRating as number;
			} else days.push({ date: g.date, rating: g.myRating as number, games: [g] });
		}
		return { group, days };
	});
}

/* ------------------------------------------------------------------ */
/* Accuracy (site-provided, one site at a time)                         */
/* ------------------------------------------------------------------ */

export type AccuracyRow = GameRow & { myAccuracy: number };

const hasAccuracy = (g: GameRow): g is AccuracyRow => g.myAccuracy !== undefined;

/** The accuracy site to use: the preferred one if it has games, else the one with the most. */
export function chooseAccuracySite(rows: GameRow[], preferred?: AccuracySite): AccuracySite | undefined {
	const count = (s: AccuracySite) => rows.filter((g) => g.site === s && hasAccuracy(g)).length;
	if (preferred && count(preferred)) return preferred;
	const l = count("lichess");
	const c = count("chesscom");
	if (!l && !c) return preferred;
	return l >= c ? "lichess" : "chesscom";
}

/** Games of one site that carry that site's accuracy for me. */
export function accuracyRows(rows: GameRow[], site: AccuracySite | undefined): AccuracyRow[] {
	return site ? rows.filter((g): g is AccuracyRow => g.site === site && hasAccuracy(g)) : [];
}

export interface AccuracyFigures {
	games: number;
	mine?: number; // mean
	median?: number;
	opp?: number; // mean over games with the opponent's accuracy
	edge?: number; // mean of (mine − opponent's) in the same games
	edgeGames: number;
}

export function accuracyFigures(rows: AccuracyRow[]): AccuracyFigures {
	const both = rows.filter((g) => g.oppAccuracy !== undefined);
	return {
		games: rows.length,
		mine: mean(rows.map((g) => g.myAccuracy)),
		median: median(rows.map((g) => g.myAccuracy)),
		opp: mean(both.map((g) => g.oppAccuracy as number)),
		edge: mean(both.map((g) => g.myAccuracy - (g.oppAccuracy as number))),
		edgeGames: both.length,
	};
}

export interface AccuracySplit<K> {
	key: K;
	games: AccuracyRow[];
	mine?: number;
	opp?: number;
}

/** My and my opponents' accuracy in wins, draws and losses. */
export function accuracyByResult(rows: AccuracyRow[]): Array<AccuracySplit<MyResult>> {
	return (["win", "draw", "loss"] as MyResult[]).map((key) => {
		const games = rows.filter((g) => g.myResult === key);
		return { key, games, mine: mean(games.map((g) => g.myAccuracy)), opp: mean(games.filter((g) => g.oppAccuracy !== undefined).map((g) => g.oppAccuracy as number)) };
	});
}

/** My and my opponents' accuracy per time class (only classes with games). */
export function accuracyByTimeClass(rows: AccuracyRow[]): Array<AccuracySplit<TimeClass>> {
	return TIME_CLASSES.map((key) => {
		const games = rows.filter((g) => g.timeClass === key);
		return { key, games, mine: mean(games.map((g) => g.myAccuracy)), opp: mean(games.filter((g) => g.oppAccuracy !== undefined).map((g) => g.oppAccuracy as number)) };
	}).filter((s) => s.games.length > 0);
}

/* ------------------------------------------------------------------ */
/* Openings                                                             */
/* ------------------------------------------------------------------ */

export interface OpeningRow {
	colour: "white" | "black";
	family: string;
	name: string; // family, or the full opening name for a variation row
	games: GameRow[];
	scorePct?: number;
	vsExpected?: number;
	accuracy?: number; // mean, accuracy site only
	accuracyGames: number;
	variations?: OpeningRow[];
}

function openingRow(colour: "white" | "black", family: string, name: string, games: GameRow[], site?: AccuracySite): OpeningRow {
	const acc = accuracyRows(games, site);
	return {
		colour,
		family,
		name,
		games,
		scorePct: scoreFigures(games).pct,
		vsExpected: vsExpected(games).diff,
		accuracy: mean(acc.map((g) => g.myAccuracy)),
		accuracyGames: acc.length,
	};
}

/** Grouped by my colour, then opening family (sorted by games); variations by full name. */
export function openingTable(rows: GameRow[], site?: AccuracySite): OpeningRow[] {
	const out: OpeningRow[] = [];
	for (const colour of ["white", "black"] as const) {
		const byFamily = new Map<string, GameRow[]>();
		for (const g of rows.filter((r) => r.myColour === colour)) {
			if (!byFamily.has(g.family)) byFamily.set(g.family, []);
			byFamily.get(g.family)?.push(g);
		}
		for (const [family, games] of [...byFamily.entries()].sort((a, b) => b[1].length - a[1].length)) {
			const row = openingRow(colour, family, family, games, site);
			const byName = new Map<string, GameRow[]>();
			for (const g of games) {
				const n = g.opening ?? g.eco ?? family;
				if (!byName.has(n)) byName.set(n, []);
				byName.get(n)?.push(g);
			}
			if (byName.size > 1 || (byName.size === 1 && !byName.has(family))) {
				row.variations = [...byName.entries()]
					.sort((a, b) => b[1].length - a[1].length)
					.map(([name, gs]) => openingRow(colour, family, name, gs, site));
			}
			out.push(row);
		}
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Time management (from clocks)                                        */
/* ------------------------------------------------------------------ */

export interface TimeFigures {
	withClocks: GameRow[];
	withoutClocks: number;
	timeTroubleGames: GameRow[];
	timeTroublePct?: number;
	scoreInTrouble?: number;
	scoreWithout?: number;
	medianFirst10?: number;
	lostOnTime: GameRow[];
	/** Lost on time while not behind on material in the final position. */
	lostOnTimeNotBehind: GameRow[];
	wonOnTime: GameRow[];
	oppTroubleGames: GameRow[];
	oppTroublePct?: number;
	/** Who got into time trouble: score in each case (games with both sides' clocks). */
	trouble: { onlyMe: ResultSplit; onlyOpp: ResultSplit; both: ResultSplit; neither: ResultSplit };
	medianLongestThink?: number;
}

export function timeFigures(rows: GameRow[]): TimeFigures {
	const withClocks = rows.filter((g) => g.timeTrouble !== undefined);
	const trouble = withClocks.filter((g) => g.timeTrouble);
	const calm = withClocks.filter((g) => !g.timeTrouble);
	const both = withClocks.filter((g) => g.oppTimeTrouble !== undefined);
	return {
		withClocks,
		withoutClocks: rows.length - withClocks.length,
		timeTroubleGames: trouble,
		timeTroublePct: withClocks.length ? (trouble.length / withClocks.length) * 100 : undefined,
		scoreInTrouble: scoreFigures(trouble).pct,
		scoreWithout: scoreFigures(calm).pct,
		medianFirst10: median(withClocks.map((g) => g.first10Seconds).filter((v): v is number => v !== undefined)),
		lostOnTime: rows.filter((g) => lostOnTime(g.myResult, g.termination)),
		lostOnTimeNotBehind: rows.filter((g) => lostOnTime(g.myResult, g.termination) && g.materialEnd !== undefined && g.materialEnd >= 0),
		wonOnTime: rows.filter((g) => wonOnTime(g.myResult, g.termination)),
		oppTroubleGames: both.filter((g) => g.oppTimeTrouble),
		oppTroublePct: both.length ? (both.filter((g) => g.oppTimeTrouble).length / both.length) * 100 : undefined,
		trouble: {
			onlyMe: split(both.filter((g) => g.timeTrouble && !g.oppTimeTrouble)),
			onlyOpp: split(both.filter((g) => !g.timeTrouble && g.oppTimeTrouble)),
			both: split(both.filter((g) => g.timeTrouble && g.oppTimeTrouble)),
			neither: split(both.filter((g) => !g.timeTrouble && !g.oppTimeTrouble)),
		},
		medianLongestThink: median(withClocks.map((g) => g.longestThink).filter((v): v is number => v !== undefined)),
	};
}

export interface ClockRace {
	/** Median clock left (% of base) after each checkpoint move, in games that got that far. */
	checkpoints: Array<{ move: number; games: GameRow[]; mine?: number; opp?: number }>;
	/** At CLOCK_EDGE_MOVE: more time than the opponent, about even, less. */
	ahead: ResultSplit;
	even: ResultSplit;
	behind: ResultSplit;
}

export function clockRace(rows: GameRow[]): ClockRace {
	const curves = rows.filter((g) => g.clockCurve && g.oppClockCurve);
	const at = (g: GameRow, i: number) => [g.clockCurve?.[i], g.oppClockCurve?.[i]];
	const checkpoints = CLOCK_CHECKPOINTS.map((move, i) => {
		const games = curves.filter((g) => at(g, i).every((v) => v !== undefined));
		return { move, games, mine: median(games.map((g) => at(g, i)[0] as number)), opp: median(games.map((g) => at(g, i)[1] as number)) };
	});
	const ci = CLOCK_CHECKPOINTS.indexOf(CLOCK_EDGE_MOVE);
	const edge = (g: GameRow) => (at(g, ci)[0] as number) - (at(g, ci)[1] as number);
	const reached = checkpoints[ci].games;
	return {
		checkpoints,
		ahead: split(reached.filter((g) => edge(g) >= CLOCK_EDGE_PCT)),
		even: split(reached.filter((g) => Math.abs(edge(g)) < CLOCK_EDGE_PCT)),
		behind: split(reached.filter((g) => edge(g) <= -CLOCK_EDGE_PCT)),
	};
}

/* ------------------------------------------------------------------ */
/* Material: comebacks, imbalances, endgames (piece counting)           */
/* ------------------------------------------------------------------ */

export interface ResultSplit {
	games: GameRow[];
	wins: GameRow[];
	draws: GameRow[];
	losses: GameRow[];
	scorePct?: number;
}

function split(games: GameRow[]): ResultSplit {
	return {
		games,
		wins: games.filter((g) => g.myResult === "win"),
		draws: games.filter((g) => g.myResult === "draw"),
		losses: games.filter((g) => g.myResult === "loss"),
		scorePct: scoreFigures(games).pct,
	};
}

export interface MaterialFigures {
	withMoves: GameRow[];
	withoutMoves: number;
	/** Down at least MATERIAL_SWING for three moves or more. */
	down: ResultSplit;
	/** Up at least MATERIAL_SWING for three moves or more. */
	up: ResultSplit;
	/** Down, then won or drew. */
	turnedAround: GameRow[];
	/** Up, then drew or lost. */
	letSlip: GameRow[];
}

export function materialFigures(rows: GameRow[]): MaterialFigures {
	const withMoves = rows.filter((g) => g.moves !== undefined);
	const down = split(withMoves.filter((g) => (g.materialLow ?? 0) <= -MATERIAL_SWING));
	const up = split(withMoves.filter((g) => (g.materialHigh ?? 0) >= MATERIAL_SWING));
	return {
		withMoves,
		withoutMoves: rows.length - withMoves.length,
		down,
		up,
		turnedAround: [...down.wins, ...down.draws],
		letSlip: [...up.draws, ...up.losses],
	};
}

export interface ImbalanceRow extends ResultSplit {
	kind: Imbalance;
	vsExpected?: number; // actual − expected points
}

/** Score in games with each lasting imbalance; kinds with no games are left out. */
export function imbalanceTable(rows: GameRow[]): ImbalanceRow[] {
	const withMoves = rows.filter((g) => g.imbalances !== undefined);
	return IMBALANCE_KINDS.map((kind) => {
		const games = withMoves.filter((g) => g.imbalances?.includes(kind));
		return { kind, ...split(games), vsExpected: vsExpected(games).diff };
	}).filter((r) => r.games.length);
}

export interface EndgameFigures {
	reached: ResultSplit;
	notReached: ResultSplit;
	reachedPct?: number;
}

export function endgameFigures(rows: GameRow[]): EndgameFigures {
	const known = rows.filter((g) => g.endgame !== undefined);
	const reached = known.filter((g) => g.endgame);
	return {
		reached: split(reached),
		notReached: split(known.filter((g) => !g.endgame)),
		reachedPct: known.length ? (reached.length / known.length) * 100 : undefined,
	};
}

/* ------------------------------------------------------------------ */
/* Review queue                                                         */
/* ------------------------------------------------------------------ */

export interface QueueItem {
	game: AccuracyRow & { oppAccuracy: number };
	priority: number;
	gap: number; // opponent − me, accuracy points
}

/**
 * Unreviewed games where both accuracies are known, ranked by how much worse I
 * played than my opponent (+0.5 if lost). Comparing within one game is fair on
 * either site's scale, so both sites share the queue.
 */
export function reviewQueue(rows: GameRow[], n = 10): QueueItem[] {
	return rows
		.filter((g): g is AccuracyRow & { oppAccuracy: number } => !g.reviewed && g.myAccuracy !== undefined && g.oppAccuracy !== undefined)
		.map((g) => ({ game: g, gap: g.oppAccuracy - g.myAccuracy, priority: reviewPriority(g.myAccuracy, g.oppAccuracy, g.myResult) }))
		.sort((a, b) => b.priority - a.priority || b.game.date.localeCompare(a.game.date))
		.slice(0, n);
}
