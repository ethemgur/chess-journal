import { describe, expect, it } from "vitest";
import { RATE_LIMIT_WAIT_MS, SyncEngine, SyncOptions, emptySyncState, formatSummary } from "../src/sync/syncEngine";
import { LICHESS_ANALYSIS, MemorySink, lichessGame, mockHttp } from "./helpers";
import type { Http } from "../src/sources/http";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const opts = (o: Partial<SyncOptions> = {}): SyncOptions => ({
	lichessUsername: "ethem",
	lichessToken: "",
	timeClasses: ["rapid", "classical"],
	ratedOnly: true,
	importSince: "2026-08-15",
	...o,
});

function setup(http: Http, o: Partial<SyncOptions> = {}, awaitingIds?: () => string[]) {
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
			awaitingIds,
		});
	return { sink, state, sleeps, progress, engine, http };
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

describe("Lichess analysis on sync", () => {
	const g1 = lichessGame("aaaaaaaa", Date.parse("2026-08-20T10:00:00Z"));
	const g2 = lichessGame("bbbbbbbb", Date.parse("2026-09-03T10:00:00Z"));
	/** Export windows by date, and POST /api/games/export/_ids by ID; `analysed` IDs come back with Lichess's analysis. */
	const server = (analysed: Set<string>) =>
		mockHttp((req) => {
			const withAnalysis = (g: { id: string }) => (analysed.has(g.id) ? { ...g, ...LICHESS_ANALYSIS } : g);
			if (req.method === "POST") {
				const ids = (req.body ?? "").split(",");
				return { text: ndjson([g1, g2].filter((g) => ids.includes(g.id)).map(withAnalysis)) };
			}
			const u = new URL(req.url);
			const since = Number(u.searchParams.get("since"));
			const until = Number(u.searchParams.get("until"));
			return { text: ndjson([g1, g2].filter((g) => g.createdAt >= since && g.createdAt <= until).map(withAnalysis)) };
		});
	const awaiting = (sink: MemorySink) => () =>
		[...sink.notes.values()].filter((r) => r.siteAnalysis === "awaiting").map((r) => r.key.slice("lichess:".length));

	it("imports unanalysed games as awaiting, and fills them in once Lichess has analysed them", async () => {
		const analysed = new Set<string>();
		const http = server(analysed);
		const st = setup(http);
		const sink = st.sink;
		const engine = () => new SyncEngine(opts(), { ...depsOf(st), awaitingIds: awaiting(sink) });
		const first = await engine().syncLichess();
		expect(first.created).toBe(2);
		expect(first.awaiting).toBe(2);
		expect(formatSummary(first)).toMatch(/2 awaiting Lichess analysis/);
		expect(sink.notes.get("lichess:aaaaaaaa")!.siteAnalysis).toBe("awaiting");

		// The user analyses game a on lichess.org; the next sync (past both games' dates) re-checks by ID.
		analysed.add("aaaaaaaa");
		const calls = http.calls.length;
		const second = await engine().syncLichess();
		const post = http.calls.slice(calls).find((c) => c.method === "POST")!;
		expect(post.url).toMatch(/^https:\/\/lichess\.org\/api\/games\/export\/_ids\?/);
		expect(new URL(post.url).searchParams.get("evals")).toBe("true");
		expect(post.body).toBe("aaaaaaaa,bbbbbbbb");
		expect(second.updated).toBe(1);
		expect(second.awaiting).toBe(1);
		const a = sink.notes.get("lichess:aaaaaaaa")!.siteAnalysis;
		expect(a !== "awaiting" && a?.white.accuracy).toBe(96);
	});

	it("changing the speeds starts again from the start date", async () => {
		const http = server(new Set());
		const st = setup(http);
		await st.engine().syncLichess();
		expect(st.state.lichess.ethem.cursor).toBe(g2.createdAt);
		const again = new SyncEngine(opts({ timeClasses: ["rapid", "classical", "blitz"] }), depsOf(st));
		const calls = http.calls.length;
		await again.syncLichess();
		const firstSince = Number(new URL(http.calls[calls].url).searchParams.get("since"));
		expect(firstSince).toBe(Date.parse("2026-08-15T00:00:00Z"));
	});
});

function depsOf(st: ReturnType<typeof setup>) {
	return {
		http: st.http,
		sink: st.sink,
		state: st.state,
		saveState: async () => undefined,
		sleep: async () => undefined,
		now: () => NOW,
		progress: () => undefined,
		isCancelled: () => false,
	};
}
