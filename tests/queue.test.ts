import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { AnalysisQueue, QueueHost, QueueState } from "../src/engine/queue";
import { AnalysisCache } from "../src/engine/cache";
import { SearchStopped } from "../src/engine/stockfish";
import type { Frontmatter } from "../src/notes/frontmatter";
import { mockHttp } from "./helpers";
import { mainline, parseGame } from "../src/pgn/tree";

const lichess = readFileSync(new URL("./fixtures/lichess.pgn", import.meta.url), "utf8");
/** Positions after White's 6. O-O?? and later: scripted as -2.1 for White. */
const AFTER_BLUNDER = new Set(mainline(parseGame(lichess)).slice(11).map((p) => p.fen));

function memCache() {
	const files = new Map<string, string>();
	return new AnalysisCache(
		{
			exists: async (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/")),
			read: async (p) => files.get(p) ?? "",
			write: async (p, d) => void files.set(p, d),
			remove: async (p) => void files.delete(p),
			mkdir: async () => undefined,
		},
		"plugin",
	);
}

function setup(opts: { cloudHits?: number; pgn?: string; blockFirst?: boolean } = {}) {
	const state: QueueState = { queue: [], paused: false };
	const statuses: Array<[string, string]> = [];
	const results: Record<string, Frontmatter> = {};
	const searched: string[] = [];
	let release: (() => void) | undefined;
	const cloudHits = opts.cloudHits ?? 4;
	const http = mockHttp((_req, n) => (n <= cloudHits ? { text: JSON.stringify({ depth: 40, pvs: [{ moves: "e2e4 e7e5", cp: 20 }] }) } : { status: 404 }));
	const cache = memCache();
	const host: QueueHost = {
		state,
		save: async () => undefined,
		engine: {
			installed: async () => true,
			newGame: async () => undefined,
			stopBatch: () => release?.(),
			batchSearch: async (fen: string, _l: unknown, isCancelled: () => boolean) => {
				if (opts.blockFirst && !searched.length) {
					await new Promise<void>((r) => (release = r));
					if (isCancelled()) throw new SearchStopped("stopped");
				}
				searched.push(fen);
				// Black's 6th move position etc: a simple scripted eval, White's 6. O-O?? drops 2 pawns.
				const after00 = AFTER_BLUNDER.has(fen);
				return { bestmove: "a2a3", lines: [{ multipv: 1, depth: 18, score: { cp: after00 ? -210 : 15 }, pv: ["a2a3"] }] };
			},
		} as never,
		cache,
		http,
		engineLabel: () => "stockfish-18-lite@1.5s",
		limits: () => ({ movetimeMs: 1500 }),
		useCloudEval: () => true,
		canRun: () => true,
		readGame: async () => ({ pgn: opts.pgn ?? lichess, myColour: "white" }),
		writeResult: async (k, v) => void (results[k] = v),
		setStatus: async (k, s) => void statuses.push([k, s]),
		status: () => undefined,
		notify: () => undefined,
	};
	return { queue: new AnalysisQueue(host), state, statuses, results, searched, http, cache };
}

const idle = async (q: AnalysisQueue) => {
	for (let i = 0; i < 200 && (q as unknown as { running: boolean }).running; i++) await new Promise((r) => setTimeout(r, 1));
};

describe("analysis queue", () => {
	it("uses cloud eval until the first 404, then the engine, and writes results", async () => {
		const { queue, results, searched, http, cache, statuses } = setup({ cloudHits: 4 });
		await queue.enqueue(["lichess:abcd1234"]);
		await idle(queue);
		expect(http.calls).toHaveLength(5); // 4 hits + the 404
		const a = (await cache.get("lichess:abcd1234"))!;
		expect(a.plies).toHaveLength(14); // start + 13 moves
		expect(a.plies.slice(0, 4).every((p) => p.source === "cloud")).toBe(true);
		expect(a.plies[4].source).toBe("local");
		expect(searched).toHaveLength(10);
		expect(results["lichess:abcd1234"]).toMatchObject({ "analysis-status": "done", engine: "stockfish-18-lite@1.5s", "my-blunders": 1 });
		expect(statuses.map((s) => s[1])).toEqual(["queued", "running"]);
	});

	it("stops cloud eval after 20 plies", async () => {
		const moves = "1. Nf3 Nf6 2. Ng1 Ng8 ".repeat(6) + "1-0";
		const pgn = `[Result "1-0"]\n\n${moves.replace(/\d+\. /g, "")}`;
		const { queue, http } = setup({ cloudHits: 999, pgn });
		await queue.enqueue(["otb:x"]);
		await idle(queue);
		expect(http.calls).toHaveLength(20);
	});

	it("refuses a game without a final result", async () => {
		const { queue, statuses, results } = setup({ pgn: '[Result "*"]\n\n1. e4 e5 *' });
		await queue.enqueue(["k"]);
		await idle(queue);
		expect(results.k).toBeUndefined();
		expect(statuses.pop()).toEqual(["k", "failed"]);
	});

	it("pause keeps the game queued; cancel marks it failed and empties the queue", async () => {
		const s = setup({ cloudHits: 0, blockFirst: true });
		await s.queue.enqueue(["a", "b"]);
		await new Promise((r) => setTimeout(r, 5));
		await s.queue.pause();
		await idle(s.queue);
		expect(s.state.queue).toEqual(["a", "b"]);
		expect(s.statuses.filter((x) => x[0] === "a").pop()).toEqual(["a", "queued"]);

		const c = setup({ cloudHits: 0, blockFirst: true });
		await c.queue.enqueue(["a", "b"]);
		await new Promise((r) => setTimeout(r, 5));
		await c.queue.cancel();
		await idle(c.queue);
		expect(c.state.queue).toEqual([]);
		expect(c.statuses.filter((x) => x[0] === "a").pop()).toEqual(["a", "failed"]);
		expect(c.statuses.filter((x) => x[0] === "b").pop()).toEqual(["b", "none"]);
	});
});
