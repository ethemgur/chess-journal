/** Frontmatter schema version 1. Keys are kebab-case and flat for Dataview and Bases. */
import type { AnalysisStatus, ClockStats, GameRecord, PositionStats } from "../types";

export const CR_SCHEMA = 1;
export const GAME_TAG = "chess-game";

/** Keys read from the game's moves (piece counting). Also filled in for older notes from their own PGN. */
export const POSITION_KEYS = ["moves", "material-low", "material-high", "material-end", "imbalances", "endgame"] as const;

/** Keys read from the game's clock times. */
export const CLOCK_KEYS = [
	"time-trouble",
	"first-10-seconds",
	"opp-time-trouble",
	"clock-curve",
	"opp-clock-curve",
	"longest-think",
	"longest-think-move",
] as const;

/** Keys the plugin may rewrite on sync. */
export const SYNC_KEYS = [
	"cr-schema",
	"game-key",
	"site",
	"url",
	"played-at",
	"date",
	"white",
	"black",
	"my-colour",
	"my-rating",
	"opp-rating",
	"result",
	"my-result",
	"termination",
	"time-control",
	"time-class",
	"rated",
	"eco",
	"opening",
	"event",
	"round",
	"site-accuracy",
	"opp-accuracy",
	...CLOCK_KEYS,
	...POSITION_KEYS,
] as const;

/** Keys the plugin may rewrite after analysis. */
export const ANALYSIS_KEYS = [
	"analysis-status",
	"engine",
	"my-acpl",
	"my-inaccuracies",
	"my-mistakes",
	"my-blunders",
	"opp-mistakes",
	"opp-blunders",
] as const;

const FRACTIONS: Record<number, string> = { 15: "¼", 30: "½", 45: "¾" };

/**
 * Time control as the sites show it: PGN "180+2" -> "3+2", "600" -> "10+0",
 * "30+0" -> "½+0", "1/259200" -> "3 days". Other forms (e.g. FIDE "40/5400:1800+30") are kept.
 */
export function formatTimeControl(tc?: string): string | undefined {
	if (!tc || tc === "-" || tc === "?") return undefined;
	const daily = /^1\/(\d+)$/.exec(tc);
	if (daily) {
		const days = Math.max(1, Math.round(Number(daily[1]) / 86400));
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	const m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
	if (!m) return tc;
	const base = Number(m[1]);
	const minutes = base >= 60 ? String(Math.round((base / 60) * 100) / 100) : FRACTIONS[base] ?? `${base}s`;
	return `${minutes}+${m[2] ?? "0"}`;
}

/**
 * For notes written before time controls were stored in the readable form: convert
 * values that are clearly PGN seconds ("1/N", or a base of 180 or more).
 */
export function displayTimeControl(v: unknown): string {
	if (typeof v !== "string" || !v) return "";
	const m = /^(\d+)(?:\+\d+)?$/.exec(v);
	if (/^1\/\d+$/.test(v) || (m && Number(m[1]) >= 180)) return formatTimeControl(v) ?? v;
	return v;
}

export type FmValue = string | number | boolean | string[] | number[] | null;
export type Frontmatter = Record<string, FmValue>;

/** Plugin-owned sync keys for a game. Missing values are left out (never written as empty). */
export function syncFrontmatter(r: GameRecord): Frontmatter {
	const me = r.myColour === "white" ? r.white : r.black;
	const opp = r.myColour === "white" ? r.black : r.white;
	const oppColour = r.myColour === "white" ? "black" : "white";
	const fm: Frontmatter = {
		"cr-schema": CR_SCHEMA,
		"game-key": r.key,
		site: r.site,
		url: r.url ?? null,
		"played-at": r.playedAt || null,
		date: r.playedAt ? r.playedAt.slice(0, 10) : null,
		white: r.white.name,
		black: r.black.name,
		"my-colour": r.myColour,
		"my-rating": me.rating ?? null,
		"opp-rating": opp.rating ?? null,
		result: r.result,
		"my-result": r.myResult,
		termination: r.termination ?? null,
		"time-control": formatTimeControl(r.timeControl) ?? null,
		"time-class": r.timeClass ?? null,
		rated: r.rated ?? null,
		eco: r.eco ?? null,
		opening: r.opening ?? null,
		event: r.event ?? null,
		round: r.round ?? null,
		"site-accuracy": r.sourceAccuracy?.[r.myColour] ?? null,
		"opp-accuracy": r.sourceAccuracy?.[oppColour] ?? null,
		...clockFrontmatter(r.clock),
		...positionFrontmatter(r.position),
	};
	for (const k of Object.keys(fm)) if (fm[k] === null) delete fm[k];
	return fm;
}

/** Clock keys; unknown values and empty curves are left out. */
export function clockFrontmatter(c?: ClockStats): Frontmatter {
	if (!c) return {};
	const fm: Frontmatter = {
		"time-trouble": c.timeTrouble,
		"first-10-seconds": c.first10Seconds,
		"opp-time-trouble": c.oppTimeTrouble,
		"clock-curve": c.clockCurve.length ? c.clockCurve : null,
		"opp-clock-curve": c.oppClockCurve.length ? c.oppClockCurve : null,
		"longest-think": c.longestThink,
		"longest-think-move": c.longestThinkMove,
	};
	for (const k of Object.keys(fm)) if (fm[k] === null) delete fm[k];
	return fm;
}

/** Position keys; imbalances is left out when there are none. */
export function positionFrontmatter(p?: PositionStats): Frontmatter {
	if (!p) return {};
	const fm: Frontmatter = { moves: p.moves, "material-low": p.materialLow, "material-high": p.materialHigh, "material-end": p.materialEnd, endgame: p.endgame };
	if (p.imbalances.length) fm.imbalances = p.imbalances;
	return fm;
}

/** Engine label for analyses made by Lichess itself. */
export const LICHESS_ENGINE = "lichess";

/**
 * Analysis keys from the site (Lichess games only): Lichess's counts once the game is
 * analysed on lichess.org, else just "awaiting". Undefined for games the site does not analyse.
 */
export function siteAnalysisFrontmatter(r: GameRecord): Frontmatter | undefined {
	const a = r.siteAnalysis;
	if (!a) return undefined;
	if (a === "awaiting") return { "analysis-status": "awaiting" };
	const me = a[r.myColour];
	const opp = a[r.myColour === "white" ? "black" : "white"];
	const fm: Frontmatter = {
		"analysis-status": "done",
		engine: LICHESS_ENGINE,
		"my-acpl": me.acpl ?? null,
		"my-inaccuracies": me.inaccuracies,
		"my-mistakes": me.mistakes,
		"my-blunders": me.blunders,
		"opp-mistakes": opp.mistakes,
		"opp-blunders": opp.blunders,
	};
	if (fm["my-acpl"] === null) delete fm["my-acpl"];
	return fm;
}

/**
 * Whether sync should write the site's analysis keys over the note's current ones.
 * A Lichess analysis always wins; "awaiting" never replaces an analysis made, queued
 * or running on this device.
 */
export function shouldWriteSiteAnalysis(current: Record<string, unknown> | undefined, site: Frontmatter): boolean {
	if (site["analysis-status"] !== "awaiting") return true;
	const status = current?.["analysis-status"];
	return status === undefined || status === null || status === "none" || status === "awaiting" || status === "failed";
}

/** Full frontmatter for a new note, in schema order. */
export function newNoteFrontmatter(r: GameRecord, status: AnalysisStatus): Frontmatter {
	return {
		...syncFrontmatter(r),
		...(siteAnalysisFrontmatter(r) ?? { "analysis-status": status }),
		tags: [GAME_TAG],
		reviewed: false,
	};
}

const sameValue = (a: unknown, b: unknown): boolean => {
	if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
	if (typeof a === "number" && typeof b === "string") return String(a) === b;
	if (typeof b === "number" && typeof a === "string") return String(b) === a;
	return a === b;
};

/** Which plugin keys differ between the wanted values and the note's current frontmatter. */
export function changedKeys(current: Record<string, unknown> | undefined, wanted: Frontmatter, owned: readonly string[]): string[] {
	const out: string[] = [];
	for (const k of owned) {
		const has = current && k in current && current[k] !== null && current[k] !== undefined;
		if (k in wanted) {
			if (!has || !sameValue(current?.[k], wanted[k])) out.push(k);
		} else if (has) out.push(k);
	}
	return out;
}

/** Apply plugin-owned keys onto a frontmatter object in place, keeping every user key. */
export function applyOwnedKeys(fm: Record<string, unknown>, wanted: Frontmatter, owned: readonly string[]): void {
	for (const k of owned) {
		if (k in wanted) fm[k] = wanted[k];
		else delete fm[k];
	}
	const tags = fm.tags;
	const list = Array.isArray(tags) ? (tags as unknown[]).map(String) : typeof tags === "string" ? tags.split(/[,\s]+/).filter(Boolean) : [];
	if (!list.includes(GAME_TAG)) fm.tags = [...list, GAME_TAG];
}

/* ------------------------------------------------------------------ */
/* YAML for new notes                                                   */
/* ------------------------------------------------------------------ */

function yamlScalar(v: FmValue): string {
	if (v === null) return "";
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) return "\n" + v.map((x) => `  - ${yamlScalar(x)}`).join("\n");
	// Quote strings that YAML could misread (dates, numbers, booleans, special chars).
	if (/^[A-Za-z][A-Za-z0-9 _.-]*$/.test(v) && !/^(true|false|yes|no|null|on|off|~)$/i.test(v)) return v;
	return JSON.stringify(v);
}

export function renderYaml(fm: Frontmatter): string {
	return Object.entries(fm)
		.map(([k, v]) => `${k}:${Array.isArray(v) ? "" : " "}${yamlScalar(v)}`)
		.join("\n");
}
