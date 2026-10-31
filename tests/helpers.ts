import type { Http, HttpRequest, HttpResponse } from "../src/sources/http";
import type { GameRecord } from "../src/types";
import type { NoteSink, UpsertResult } from "../src/sync/syncEngine";

export const LICHESS_PGN = `[Event "Rated rapid game"]
[Site "https://lichess.org/{ID}"]
[White "ethem"]
[Black "opp"]
[Result "1-0"]

1. e4 { [%clk 0:10:00] } 1... e5 { [%clk 0:10:00] } 2. Qh5 { [%clk 0:10:00] } 2... Nc6 { [%clk 0:10:00] } 3. Bc4 { [%clk 0:10:00] } 3... Nf6 { [%clk 0:10:00] } 4. Qxf7# 1-0`;

export function lichessGame(id: string, createdAt: number, extra: Record<string, unknown> = {}) {
	return {
		id,
		rated: true,
		variant: "standard",
		speed: "rapid",
		createdAt,
		status: "mate",
		players: { white: { user: { name: "ethem", id: "ethem" }, rating: 2004 }, black: { user: { name: "opp", id: "opp" }, rating: 1987 } },
		winner: "white",
		opening: { eco: "C20", name: "King's Pawn Game: Wayward Queen Attack" },
		clock: { initial: 600, increment: 5 },
		pgn: LICHESS_PGN.replace("{ID}", id),
		...extra,
	};
}

/** Lichess's analysis for LICHESS_PGN: 3...Nf6?? is a blunder (3...g6 was best), 4.Qxf7# ends the game. */
export const LICHESS_ANALYSIS = {
	players: {
		white: { user: { name: "ethem", id: "ethem" }, rating: 2004, analysis: { inaccuracy: 0, mistake: 0, blunder: 0, acpl: 12, accuracy: 96 } },
		black: { user: { name: "opp", id: "opp" }, rating: 1987, analysis: { inaccuracy: 1, mistake: 0, blunder: 1, acpl: 410, accuracy: 41 } },
	},
	analysis: [
		{ eval: 25 },
		{ eval: 30 },
		{ eval: -20 },
		{ eval: -15, best: "g8f6", variation: "Nf6 Qxe5+", judgment: { name: "Inaccuracy", comment: "Inaccuracy. Nf6 was best." } },
		{ eval: -30 },
		{ mate: 1, best: "g7g6", variation: "g6 Qf3 Nf6", judgment: { name: "Blunder", comment: "Checkmate is now unavoidable. g6 was best." } },
	],
};

/** Scripted HTTP: each handler gets the request and returns a response (or throws). */
export function mockHttp(handler: (req: HttpRequest, n: number) => Partial<HttpResponse>): Http & { calls: HttpRequest[] } {
	const calls: HttpRequest[] = [];
	const fn = (async (req: HttpRequest) => {
		calls.push(req);
		const r = handler(req, calls.length);
		return { status: 200, text: "", headers: {}, ...r };
	}) as Http & { calls: HttpRequest[] };
	fn.calls = calls;
	return fn;
}

/** In-memory note store with the same update rules as NoteWriter. */
export class MemorySink implements NoteSink {
	notes = new Map<string, GameRecord>();
	writes = 0;
	deleted = new Set<string>();
	async upsert(r: GameRecord): Promise<UpsertResult> {
		if (this.deleted.has(r.key)) return "deleted";
		const cur = this.notes.get(r.key);
		if (!cur) {
			this.notes.set(r.key, r);
			this.writes++;
			return "created";
		}
		const { pgn: _a, ...a } = cur;
		const { pgn: _b, ...b } = r;
		if (JSON.stringify(a) === JSON.stringify(b)) return "unchanged";
		this.notes.set(r.key, { ...r, pgn: cur.pgn }); // never overwrite the PGN
		this.writes++;
		return "updated";
	}
}
