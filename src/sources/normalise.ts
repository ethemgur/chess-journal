/** Every source -> one GameRecord. Pure functions, no vault or network access. */
import type { Colour, GameRecord, MyResult, Result, TimeClass } from "../types";
import { mainline, parseGame } from "../pgn/tree";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

export function myResultOf(result: Result, me: Colour): MyResult {
	if (result === "1/2-1/2") return "draw";
	return (result === "1-0") === (me === "white") ? "win" : "loss";
}

/** Time class from a base/increment, using Lichess's estimate (base + 40 × increment). */
export function timeClassFromClock(base: number, inc: number): TimeClass {
	const est = base + 40 * inc;
	if (est < 180) return "bullet";
	if (est < 480) return "blitz";
	if (est < 1500) return "rapid";
	return "classical";
}

/** Read the tag section of a PGN without parsing moves. */
export function pgnTags(pgn: string): Map<string, string> {
	const tags = new Map<string, string>();
	const re = /^\s*\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(pgn))) tags.set(m[1], m[2].replace(/\\(.)/g, "$1"));
	return tags;
}

function dateTimeFromTags(tags: Map<string, string>): string | undefined {
	const date = tags.get("UTCDate") ?? tags.get("Date");
	if (!date || !/^\d{4}\.\d{2}\.\d{2}$/.test(date)) return undefined;
	const time = tags.get("UTCTime") ?? tags.get("StartTime");
	const t = time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : "00:00:00";
	return `${date.replace(/\./g, "-")}T${t}Z`;
}

const sameUser = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/* ------------------------------------------------------------------ */
/* Lichess                                                             */
/* ------------------------------------------------------------------ */

export interface LichessPlayer {
	user?: { name: string; id?: string };
	aiLevel?: number;
	rating?: number;
	analysis?: { accuracy?: number };
}

export interface LichessGame {
	id: string;
	rated?: boolean;
	variant?: string;
	speed?: string;
	perf?: string;
	createdAt: number;
	lastMoveAt?: number;
	status: string;
	players: { white: LichessPlayer; black: LichessPlayer };
	winner?: "white" | "black";
	opening?: { eco?: string; name?: string };
	clock?: { initial: number; increment: number };
	daysPerTurn?: number;
	pgn?: string;
	initialFen?: string;
}

const LICHESS_UNFINISHED = new Set(["created", "started", "aborted", "noStart", "unknownFinish"]);
const LICHESS_TERMINATION: Record<string, string> = {
	mate: "checkmate",
	resign: "resignation",
	outoftime: "timeout",
	timeout: "abandonment",
	draw: "agreement",
	stalemate: "stalemate",
	cheat: "fair play violation",
	variantEnd: "variant end",
	insufficientMaterialClaim: "insufficient material",
};

export type SkipReason = "variant" | "filter" | "unfinished" | "invalid";
export type Normalised = { ok: true; record: GameRecord } | { ok: false; reason: SkipReason };

export function lichessTimeClass(speed?: string): TimeClass | undefined {
	switch (speed) {
		case "ultraBullet":
		case "bullet":
			return "bullet";
		case "blitz":
			return "blitz";
		case "rapid":
			return "rapid";
		case "classical":
			return "classical";
		case "correspondence":
			return "daily";
		default:
			return undefined;
	}
}

const lichessName = (p: LichessPlayer) => p.user?.name ?? (p.aiLevel ? `Stockfish level ${p.aiLevel}` : "Anonymous");

export function normaliseLichess(g: LichessGame, username: string): Normalised {
	if (g.variant && g.variant !== "standard" && g.variant !== "fromPosition") return { ok: false, reason: "variant" };
	if (LICHESS_UNFINISHED.has(g.status)) return { ok: false, reason: "unfinished" };
	if (!g.pgn) return { ok: false, reason: "invalid" };
	const white = { name: lichessName(g.players.white), rating: g.players.white.rating };
	const black = { name: lichessName(g.players.black), rating: g.players.black.rating };
	const myColour: Colour = sameUser(g.players.black.user?.id, username) || sameUser(black.name, username) ? "black" : "white";
	const result: Result = g.winner === "white" ? "1-0" : g.winner === "black" ? "0-1" : "1/2-1/2";
	const tags = pgnTags(g.pgn);
	let timeControl: string | undefined;
	if (g.clock) timeControl = `${g.clock.initial}+${g.clock.increment}`;
	else if (g.daysPerTurn) timeControl = `1/${g.daysPerTurn * 86400}`;
	const acc = { white: g.players.white.analysis?.accuracy, black: g.players.black.analysis?.accuracy };
	return {
		ok: true,
		record: {
			key: `lichess:${g.id}`,
			site: "lichess",
			url: `https://lichess.org/${g.id}${myColour === "black" ? "/black" : ""}`,
			playedAt: new Date(g.createdAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
			white,
			black,
			myColour,
			result,
			myResult: myResultOf(result, myColour),
			termination: LICHESS_TERMINATION[g.status] ?? g.status,
			timeControl,
			timeClass: lichessTimeClass(g.speed),
			rated: g.rated ?? false,
			eco: g.opening?.eco ?? tags.get("ECO"),
			opening: g.opening?.name ?? tags.get("Opening"),
			event: tags.get("Event"),
			sourceAccuracy: acc.white !== undefined || acc.black !== undefined ? acc : undefined,
			pgn: g.pgn.trim(),
		},
	};
}

/* ------------------------------------------------------------------ */
/* chess.com                                                           */
/* ------------------------------------------------------------------ */

export interface ChesscomPlayer {
	username: string;
	rating?: number;
	result: string;
}

export interface ChesscomGame {
	url: string;
	pgn?: string;
	time_control?: string;
	time_class?: string;
	end_time?: number;
	start_time?: number;
	rated?: boolean;
	rules?: string;
	uuid?: string;
	eco?: string;
	white: ChesscomPlayer;
	black: ChesscomPlayer;
	accuracies?: { white?: number; black?: number };
}

const CHESSCOM_TERMINATION: Record<string, string> = {
	checkmated: "checkmate",
	resigned: "resignation",
	timeout: "timeout",
	abandoned: "abandonment",
	agreed: "agreement",
	repetition: "repetition",
	stalemate: "stalemate",
	insufficient: "insufficient material",
	"50move": "50-move rule",
	timevsinsufficient: "timeout vs insufficient material",
};

/** "https://www.chess.com/openings/Caro-Kann-Defense-Advance-Variation" -> "Caro-Kann Defense Advance Variation". */
export function openingFromEcoUrl(url?: string): string | undefined {
	if (!url) return undefined;
	const slug = url.split("/openings/")[1];
	if (!slug) return undefined;
	return decodeURIComponent(slug)
		.replace(/-(?=[A-Z0-9])/g, " ")
		.replace(/\s+/g, " ")
		.replace(HYPHENATED, (m) => m.replace(" ", "-"))
		.trim();
}

/** Opening names that keep their hyphen (slugs use hyphens for spaces too). */
const HYPHENATED = /\b(Caro Kann|Nimzo Indian|Bogo Indian|Nimzo Larsen|Smith Morra|Max Lange|Schliemann Jaenisch)\b/g;

export function normaliseChesscom(g: ChesscomGame, username: string): Normalised {
	if (g.rules && g.rules !== "chess") return { ok: false, reason: "variant" };
	if (!g.pgn) return { ok: false, reason: "invalid" };
	const tags = pgnTags(g.pgn);
	const myColour: Colour = sameUser(g.black.username, username) ? "black" : "white";
	let result: Result;
	if (g.white.result === "win") result = "1-0";
	else if (g.black.result === "win") result = "0-1";
	else result = "1/2-1/2";
	const tagResult = tags.get("Result");
	if (tagResult === "*") return { ok: false, reason: "unfinished" };
	const loser = result === "1-0" ? g.black : result === "0-1" ? g.white : g.white;
	const tc = g.time_class === "daily" || g.time_class === "bullet" || g.time_class === "blitz" || g.time_class === "rapid"
		? (g.time_class as TimeClass)
		: undefined;
	const playedAt =
		(g.start_time && new Date(g.start_time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")) ||
		dateTimeFromTags(tags) ||
		(g.end_time ? new Date(g.end_time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : "");
	const uuid = g.uuid ?? g.url.split("/").pop() ?? g.url;
	const ecoUrl = g.eco ?? tags.get("ECOUrl");
	const acc = g.accuracies;
	return {
		ok: true,
		record: {
			key: `chesscom:${uuid}`,
			site: "chesscom",
			url: g.url,
			playedAt,
			white: { name: g.white.username, rating: g.white.rating },
			black: { name: g.black.username, rating: g.black.rating },
			myColour,
			result,
			myResult: myResultOf(result, myColour),
			termination: CHESSCOM_TERMINATION[loser.result] ?? loser.result,
			timeControl: g.time_control,
			timeClass: tc,
			rated: g.rated ?? false,
			eco: tags.get("ECO"),
			opening: openingFromEcoUrl(ecoUrl),
			sourceAccuracy: acc && (acc.white !== undefined || acc.black !== undefined) ? acc : undefined,
			pgn: g.pgn.trim(),
		},
	};
}

/* ------------------------------------------------------------------ */
/* OTB / PGN files                                                     */
/* ------------------------------------------------------------------ */

/** Name tokens, order-insensitive: "Gur, Ethem" and "Ethem Gur" match. */
const nameTokens = (n: string) =>
	n.toLowerCase().split(/[\s,.]+/).filter(Boolean).sort().join(" ");

export function matchMyColour(white: string, black: string, myNames: string[]): Colour | undefined {
	const mine = new Set(myNames.map((n) => nameTokens(n)).filter(Boolean));
	const w = mine.has(nameTokens(white));
	const b = mine.has(nameTokens(black));
	if (w && !b) return "white";
	if (b && !w) return "black";
	return undefined;
}

export async function sha1Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const buf = await crypto.subtle.digest("SHA-1", data);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** otb: + SHA-1 of the normalised main-line moves plus White, Black and Date tags. */
export async function otbKey(pgn: string): Promise<string> {
	const game = parseGame(pgn);
	const moves = mainline(game).slice(1).map((p) => p.uci).join(" ");
	const h = game.headers;
	const basis = [moves, h.get("White") ?? "?", h.get("Black") ?? "?", h.get("Date") ?? "????.??.??"].join("|");
	return `otb:${await sha1Hex(basis)}`;
}

export interface OtbDraft {
	pgn: string;
	tags: Map<string, string>;
	myColour?: Colour;
}

/** First pass on an OTB game: parse tags and guess my colour. Throws PgnParseError on bad PGN. */
export function draftOtb(pgn: string, myNames: string[]): OtbDraft {
	parseGame(pgn);
	const tags = pgnTags(pgn);
	return { pgn, tags, myColour: matchMyColour(tags.get("White") ?? "", tags.get("Black") ?? "", myNames) };
}

/** Replace or add tags in a PGN's tag section. */
export function setPgnTags(pgn: string, changes: Record<string, string>): string {
	let out = pgn;
	for (const [k, v] of Object.entries(changes)) {
		const line = `[${k} "${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
		const re = new RegExp(`^\\s*\\[${k}\\s+"(?:[^"\\\\]|\\\\.)*"\\s*\\]\\s*$`, "m");
		if (re.test(out)) out = out.replace(re, line);
		else {
			const lastTag = [...out.matchAll(/^\s*\[[A-Za-z0-9_]+\s+".*"\s*\]\s*$/gm)].pop();
			if (lastTag && lastTag.index !== undefined) {
				const end = lastTag.index + lastTag[0].length;
				out = out.slice(0, end) + "\n" + line + out.slice(end);
			} else out = line + "\n\n" + out;
		}
	}
	return out;
}

export async function normaliseOtb(pgn: string, myColour: Colour): Promise<Normalised> {
	const tags = pgnTags(pgn);
	const r = tags.get("Result");
	if (r !== "1-0" && r !== "0-1" && r !== "1/2-1/2") return { ok: false, reason: "unfinished" };
	const variant = tags.get("Variant");
	if (variant && !/^(standard|chess|from position)$/i.test(variant)) return { ok: false, reason: "variant" };
	const num = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : undefined);
	const tcTag = tags.get("TimeControl");
	const tcm = tcTag ? /^(\d+)(?:\+(\d+))?$/.exec(tcTag) : null;
	const known = (s?: string) => (s && s !== "?" && s !== "-" ? s : undefined);
	return {
		ok: true,
		record: {
			key: await otbKey(pgn),
			site: "otb",
			playedAt: dateTimeFromTags(tags) ?? "",
			white: { name: tags.get("White") ?? "?", rating: num(tags.get("WhiteElo")) },
			black: { name: tags.get("Black") ?? "?", rating: num(tags.get("BlackElo")) },
			myColour,
			result: r,
			myResult: myResultOf(r, myColour),
			termination: known(tags.get("Termination")),
			timeControl: known(tcTag),
			timeClass: tcm ? timeClassFromClock(Number(tcm[1]), Number(tcm[2] ?? 0)) : undefined,
			eco: known(tags.get("ECO")),
			opening: known(tags.get("Opening")),
			event: known(tags.get("Event")),
			round: known(tags.get("Round")),
			pgn: pgn.trim(),
		},
	};
}
