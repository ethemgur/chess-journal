import { describe, expect, it } from "vitest";
import { RATE_LIMIT_WAIT_MS, SyncEngine, SyncOptions, emptySummary, emptySyncState, formatSummary } from "../src/sync/syncEngine";
import { MemorySink, lichessGame, mockHttp } from "./helpers";
import type { Http } from "../src/sources/http";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const opts = (o: Partial<SyncOptions> = {}): SyncOptions => ({
	lichessUsername: "ethem",
	lichessToken: "",
	chesscomUsername: "",
	contactEmail: "me@example.com",
	timeClasses: ["rapid", "classical"],
	ratedOnly: true,
	importSince: "2026-08-15",
	version: "0.1.0",
	...o,
});

function setup(http: Http, o: Partial<SyncOptions> = {}) {
	const sink = new MemorySink();
	const state = emptySyncState();
	const sleeps: number[] = [];
	const progress: string[] = [];
	const engine = () =>
		new SyncEngine(opts(o), {
			http,
			sink,
			state,
			saveState: async () => undefined,
			sleep: async (ms) => void sleeps.push(ms),
			now: () => NOW,
			progress: (m) => progress.push(m),
			isCancelled: () => false,
		});
	return { sink, state, sleeps, progress, engine };
}

const ndjson = (games: object[]) => games.map((g) => JSON.stringify(g)).join("\n") + "\n";

describe("Lichess sync", () => {
	const games = [
		lichessGame("aaaaaaaa", Date.parse("2026-08-20T10:00:00Z")),
		lichessGame("bbbbbbbb", Date.parse("2026-09-03T10:00:00Z")),
		lichessGame("cccccccc", Date.parse("2026-09-04T10:00:00Z"), { variant: "chess960" }),
		lichessGame("dddddddd", Date.parse("2026-10-01T10:00:00Z"), { speed: "blitz" }),
	];
	const server = (list: object[]) =>
		mockHttp((req) => {
			const u = new URL(req.url);
			const since = Number(u.searchParams.get("since"));
			const until = Number(u.searchParams.get("until"));
			return { text: ndjson(list.filter((g) => (g as { createdAt: number }).createdAt >= since && (g as { createdAt: number }).createdAt <= until)) };
		});

	it("fetches month windows, creates notes and skips variants and filtered games", async () => {
		const http = server(games);
		const { sink, state, engine } = setup(http);
		const s = await engine().syncLichess();
		expect(http.calls.map((c) => new URL(c.url).searchParams.get("since"))).toHaveLength(3); // Aug, Sep, Oct
		expect(http.calls[0].headers?.Accept).toBe("application/x-ndjson");
		const q = new URL(http.calls[0].url).searchParams;
		expect(q.get("perfType")).toBe("rapid,classical");
		expect(q.get("finished")).toBe("true");
		expect(q.get("ongoing")).toBe("false");
		expect([...sink.notes.keys()]).toEqual(["lichess:aaaaaaaa", "lichess:bbbbbbbb"]);
		expect(s.created).toBe(2);
		expect(s.skippedVariant).toBe(1);
		expect(s.skippedFilter).toBe(1);
		expect(state.lichess.ethem.cursor).toBe(Date.parse("2026-10-01T10:00:00Z"));
		const r = sink.notes.get("lichess:aaaaaaaa")!;
		expect(r.myColour).toBe("white");
		expect(r.myResult).toBe("win");
		expect(r.timeControl).toBe("600+5");
		expect(r.termination).toBe("checkmate");
	});

	it("a second run changes nothing; a new game appears on the next sync", async () => {
		const list = [...games];
		const http = server(list);
		const { sink, engine, state } = setup(http);
		await engine().syncLichess();
		const writes = sink.writes;
		const again = await engine().syncLichess();
		expect(sink.writes).toBe(writes);
		expect(again.created).toBe(0);
		const since = Number(new URL(http.calls[http.calls.length - 1].url).searchParams.get("since"));
		expect(since).toBe(state.lichess.ethem.cursor! + 1);
		list.push(lichessGame("eeeeeeee", Date.parse("2026-10-10T10:00:00Z")));
		const third = await engine().syncLichess();
		expect(third.created).toBe(1);
		expect(sink.notes.has("lichess:eeeeeeee")).toBe(true);
	});

	it("does not re-create a deleted game", async () => {
		const { sink, engine } = setup(server(games));
		sink.deleted.add("lichess:aaaaaaaa");
		const s = await engine().syncLichess();
		expect(sink.notes.has("lichess:aaaaaaaa")).toBe(false);
		expect(s.skippedDeleted).toBe(1);
	});

	it("on 429 waits 60 s and retries the same window once", async () => {
		let n = 0;
		const inner = server(games);
		const http = mockHttp((req, i) => {
			n = i;
			return n === 1 ? { status: 429 } : { text: "" };
		});
		const { sleeps, engine } = setup(async (req) => {
			const r = await http(req);
			if (r.status === 429) return r;
			return inner(req);
		});
		const s = await engine().syncLichess();
		expect(sleeps).toEqual([RATE_LIMIT_WAIT_MS]);
		expect(http.calls[0].url).toBe(http.calls[1].url);
		expect(s.created).toBe(2);
		expect(s.aborted).toBeUndefined();
	});

	it("ends the run with a clear message after a second 429", async () => {
		const http = mockHttp(() => ({ status: 429 }));
		const { engine, state } = setup(http);
		const s = await engine().syncLichess();
		expect(http.calls).toHaveLength(2);
		expect(s.aborted).toMatch(/Lichess refused too many requests/);
		expect(state.lichess.ethem.cursor).toBeUndefined();
		expect(formatSummary(s)).toMatch(/try again in a minute/);
	});

	it("a network failure leaves the cursor unchanged so the window is retried", async () => {
		const ok = server(games);
		const http: Http = async (req) => {
			const since = Number(new URL(req.url).searchParams.get("since"));
			if (since === Date.parse("2026-09-01T00:00:00Z")) throw new Error("network down");
			return ok(req);
		};
		const { engine, state } = setup(http);
		const s = await engine().syncLichess();
		expect(s.failed).toBe(1);
		// August succeeded, September failed: the cursor must not move past September.
		expect(state.lichess.ethem.cursor).toBe(Date.parse("2026-08-20T10:00:00Z"));
	});

	it("sends the token as a bearer header when set", async () => {
		const http = server([]);
		const { engine } = setup(http, { lichessToken: "lip_secret" });
		await engine().syncLichess();
		expect(http.calls[0].headers?.Authorization).toBe("Bearer lip_secret");
	});
});

describe("chess.com sync", () => {
	const ARCH = "https://api.chess.com/pub/player/ethem/games/archives";
	const month = (m: string) => `https://api.chess.com/pub/player/ethem/games/2026/${m}`;
	const game = (uuid: string, rules = "chess", tc = "rapid") => ({
		uuid,
		url: `https://www.chess.com/game/live/${uuid}`,
		pgn: `[Event "Live Chess"]\n[White "ethem"]\n[Black "opp"]\n[Result "0-1"]\n[UTCDate "2026.09.02"]\n[UTCTime "10:00:00"]\n[ECOUrl "https://www.chess.com/openings/Caro-Kann-Defense-Advance-Variation"]\n\n1. e4 c6 0-1`,
		time_control: "600",
		time_class: tc,
		end_time: Date.parse("2026-09-02T10:20:00Z") / 1000,
		rated: true,
		rules,
		white: { username: "ethem", rating: 2000, result: "resigned" },
		black: { username: "opp", rating: 1990, result: "win" },
		accuracies: { white: 81.2, black: 90.1 },
	});
	const server = () => {
		const etags: Record<string, string> = { [month("08")]: '"e8"', [month("09")]: '"e9"' };
		return mockHttp((req) => {
			if (req.url === ARCH) return { text: JSON.stringify({ archives: [month("07"), month("08"), month("09")] }) };
			if (req.headers?.["If-None-Match"] === etags[req.url]) return { status: 304 };
			if (req.url === month("08")) return { text: JSON.stringify({ games: [game("u1")] }), headers: { etag: etags[req.url] } };
			if (req.url === month("09"))
				return { text: JSON.stringify({ games: [game("u2"), game("u3", "chess960"), game("u4", "chess", "bullet")] }), headers: { etag: etags[req.url] } };
			return { status: 404 };
		});
	};

	it("is serial, sends the User-Agent, skips variants and uses ETags", async () => {
		const http = server();
		const { sink, engine } = setup(http, { lichessUsername: "", chesscomUsername: "ethem" });
		const s = await engine().syncChesscom();
		expect(http.calls.map((c) => c.url)).toEqual([ARCH, month("08"), month("09")]);
		for (const c of http.calls) expect(c.headers?.["User-Agent"]).toBe("chess-journal/0.1.0 (username: ethem; contact: me@example.com)");
		expect(s.created).toBe(2);
		expect(s.skippedVariant).toBe(1);
		expect(s.skippedFilter).toBe(1);
		const r = sink.notes.get("chesscom:u2")!;
		expect(r.myColour).toBe("white");
		expect(r.myResult).toBe("loss");
		expect(r.termination).toBe("resignation");
		expect(r.opening).toBe("Caro-Kann Defense Advance Variation");
		expect(r.sourceAccuracy?.white).toBe(81.2);

		const writes = sink.writes;
		const again = await engine().syncChesscom();
		expect(again.created).toBe(0);
		expect(sink.writes).toBe(writes);
		const last = http.calls.slice(-2);
		expect(last.every((c) => c.headers?.["If-None-Match"])).toBe(true);
	});

	it("runs requests strictly one at a time", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const inner = server();
		const http: Http = async (req) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 2));
			const res = await inner(req);
			inFlight--;
			return res;
		};
		const { engine } = setup(http, { lichessUsername: "", chesscomUsername: "ethem" });
		await engine().syncChesscom(emptySummary());
		expect(maxInFlight).toBe(1);
	});
});
