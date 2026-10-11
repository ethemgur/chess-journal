import { describe, expect, it } from "vitest";
import {
	GameRow,
	bandFigures,
	biggestSwings,
	conversionFigures,
	defaultFilters,
	engineRows,
	errorFigures,
	matchesFilters,
	openingTable,
	performanceOf,
	periodRanges,
	phaseFigures,
	reviewQueue,
	rowFromFrontmatter,
	scoreFigures,
	select,
	siteTimeGroups,
	timeFigures,
	trend,
	vsExpected,
	weakestPhase,
} from "../src/dashboard/compute";
import type { GameSummary, SummaryMark } from "../src/dashboard/summary";

const ENGINE = "stockfish-18-lite@1.5s";

function summary(p: Partial<GameSummary> & { marks?: SummaryMark[] }): GameSummary {
	return {
		derivedVersion: 1,
		engine: ENGINE,
		myMoves: 30,
		myMovesByPhase: { opening: 12, middlegame: 12, endgame: 6 },
		oppMovesByPhase: { opening: 12, middlegame: 12, endgame: 6 },
		marks: [],
		myAcpl: 30,
		myPeakEvalCp: 50,
		myLowEvalCp: -50,
		myEvalAfterMove15Cp: 20,
		reachedWinning: false,
		reachedLosing: false,
		peakPly: 10,
		hasClocks: true,
		timeTrouble: false,
		secondsOnFirst10Moves: 60,
		lostOnTime: false,
		biggestSwing: null,
		myMovesUnderPressure: 0,
		...p,
	};
}

const mark = (side: "me" | "opp", kind: SummaryMark["kind"], phase: SummaryMark["phase"], deltaW: number, ply = 20, underPressure = false): SummaryMark =>
	({ ply, side, kind, deltaW, phase, evalBeforeCp: 0, evalAfterCp: -100, underPressure });

let n = 0;
function game(p: Partial<GameRow> & { s?: Partial<GameSummary> }): GameRow {
	n++;
	return {
		key: `lichess:g${n}`,
		path: `g${n}.md`,
		site: "lichess",
		date: "2026-09-15",
		playedAt: `2026-09-15T10:${String(n).padStart(2, "0")}:00Z`,
		myColour: "white",
		myResult: "win",
		result: "1-0",
		myRating: 2000,
		oppRating: 2000,
		timeClass: "rapid",
		rated: true,
		opening: "Caro-Kann Defense: Advance Variation",
		eco: "B12",
		family: "Caro-Kann Defense",
		opponent: `opp${n}`,
		engine: ENGINE,
		analysisStatus: "done",
		reviewed: false,
		...p,
		summary: p.summary ?? summary(p.s ?? {}),
	};
}

/**
 * 20 games, all Lichess rapid at 2000 v 2000 unless stated:
 * 10 wins, 4 draws, 6 losses → 12 points, 60%.
 */
function fixture(): GameRow[] {
	n = 0;
	const rows: GameRow[] = [];
	for (let i = 0; i < 10; i++) rows.push(game({ myResult: "win" }));
	for (let i = 0; i < 4; i++) rows.push(game({ myResult: "draw", result: "1/2-1/2" }));
	for (let i = 0; i < 6; i++) rows.push(game({ myResult: "loss", result: "0-1" }));
	return rows;
}

describe("summary cards on a 20-game fixture", () => {
	it("score", () => {
		expect(scoreFigures(fixture())).toEqual({ games: 20, wins: 10, draws: 4, losses: 6, points: 12, pct: 60 });
	});
	it("vs expected: equal ratings expect 10 of 20", () => {
		const v = vsExpected(fixture());
		expect(v.games).toBe(20);
		expect(v.expected).toBeCloseTo(10);
		expect(v.diff).toBeCloseTo(2);
		expect(v.per100).toBeCloseTo(10);
	});
	it("performance: 60% against 2000 → 2000 + 72", () => {
		expect(performanceOf(fixture())).toEqual({ games: 20, rating: 2072 });
	});
	it("error rate and weakest phase", () => {
		const rows = fixture();
		// 3 of my errors in the endgame across 6×20 = 120 endgame moves; opponents 1.
		rows[0].summary = summary({ marks: [mark("me", "blunder", "endgame", 0.4), mark("me", "inaccuracy", "endgame", 0.12)] });
		rows[1].summary = summary({ marks: [mark("me", "mistake", "endgame", 0.25), mark("opp", "mistake", "endgame", 0.2)] });
		rows[2].summary = summary({ marks: [mark("me", "mistake", "endgame", 0.22), mark("me", "mistake", "opening", 0.21)] });
		const eng = engineRows(rows, ENGINE);
		const e = errorFigures(eng);
		expect(e).toMatchObject({ games: 20, errors: 4, moves: 600 });
		expect(e.rate).toBeCloseTo(4 / 60);
		expect(e.medianAcpl).toBe(30);
		const ph = phaseFigures(eng);
		const end = ph.find((p) => p.phase === "endgame")!;
		expect(end.myRate).toBeCloseTo(3 / 12); // 3 errors / 120 moves × 10
		expect(end.oppRate).toBeCloseTo(1 / 12);
		expect(end.myInaccuracies).toBe(1);
		expect(weakestPhase(ph)?.phase).toBe("endgame");
	});
	it("conversion, saves and points thrown away", () => {
		const rows = fixture();
		rows[0].summary = summary({ reachedWinning: true, myPeakEvalCp: 400 }); // win
		rows[10].summary = summary({ reachedWinning: true, myPeakEvalCp: 900 }); // draw
		rows[14].summary = summary({ reachedWinning: true, myPeakEvalCp: 600 }); // loss
		rows[15].summary = summary({ reachedLosing: true }); // loss
		rows[11].summary = summary({ reachedLosing: true }); // draw
		const c = conversionFigures(engineRows(rows, ENGINE));
		expect(c.winningGames).toHaveLength(3);
		expect(c.conversionPct).toBeCloseTo(50); // 1 + 0.5 + 0 of 3
		expect(c.thrownAway).toBeCloseTo(1.5);
		expect(c.savePct).toBeCloseTo(25); // 0 + 0.5 of 2
		expect(c.notConverted.map((g) => g.summary.myPeakEvalCp)).toEqual([900, 600]);
	});
});

describe("periods and filters", () => {
	it("3 months and the previous 3 months", () => {
		const r = periodRanges(defaultFilters("3m"), "2026-10-11");
		expect(r.current).toEqual({ from: "2026-07-12", to: "2026-10-11" });
		expect(r.previous).toEqual({ from: "2026-04-12", to: "2026-07-11" });
		expect(periodRanges(defaultFilters("30d"), "2026-10-11").current.from).toBe("2026-09-12");
		expect(periodRanges(defaultFilters("all"), "2026-10-11").previous).toBeUndefined();
	});
	it("filters by site, time class, colour, rated, band and opening family", () => {
		const f = defaultFilters();
		const g = game({});
		expect(matchesFilters(g, f)).toBe(true);
		expect(matchesFilters({ ...g, timeClass: "blitz" }, f)).toBe(false);
		expect(matchesFilters({ ...g, rated: false }, f)).toBe(false);
		expect(matchesFilters(g, { ...f, colour: "black" })).toBe(false);
		expect(matchesFilters(g, { ...f, bands: ["stronger"] })).toBe(false);
		expect(matchesFilters({ ...g, oppRating: 2100 }, { ...f, bands: ["stronger"] })).toBe(true);
		expect(matchesFilters(g, { ...f, families: ["Sicilian Defense"] })).toBe(false);
		expect(matchesFilters(g, { ...f, sites: ["chesscom"] })).toBe(false);
		const otb = { ...g, site: "otb" as const, timeClass: undefined };
		expect(matchesFilters(otb, f)).toBe(false);
		expect(matchesFilters(otb, { ...f, sites: ["otb"] })).toBe(true);
		const rows = [game({ date: "2026-06-01" }), game({ date: "2026-09-01" })];
		expect(select(rows, f, { from: "2026-07-12", to: "2026-10-11" })).toHaveLength(1);
	});
	it("rows from frontmatter", () => {
		const r = rowFromFrontmatter("a.md", {
			"game-key": "chesscom:1", site: "chesscom", "my-colour": "black", "my-result": "draw", result: "1/2-1/2",
			white: "x", black: "me", date: "2026-10-01", "my-rating": 1990, "opp-rating": "2010", "time-class": "blitz",
			rated: true, opening: "Sicilian Defense: Najdorf", reviewed: true,
		})!;
		expect(r).toMatchObject({ opponent: "x", myRating: 1990, oppRating: 2010, family: "Sicilian Defense", reviewed: true });
		expect(rowFromFrontmatter("b.md", { site: "lichess" })).toBeUndefined();
	});
});

describe("panels", () => {
	it("bands: actual vs expected", () => {
		const rows = [game({ oppRating: 2300, myResult: "draw" }), game({ oppRating: 2250, myResult: "loss" }), game({ oppRating: 2000 })];
		const b = bandFigures(rows);
		const strong = b.find((x) => x.band === "much-stronger")!;
		expect(strong.games).toHaveLength(2);
		expect(strong.actualPct).toBeCloseTo(25);
		expect(b.find((x) => x.band === "equal")!.actualPct).toBe(100);
	});
	it("openings grouped by colour then family, with variations", () => {
		const rows = [
			game({ opening: "Sicilian Defense: Najdorf", family: "Sicilian Defense", myColour: "black" }),
			game({ opening: "Sicilian Defense: Dragon", family: "Sicilian Defense", myColour: "black", s: { myEvalAfterMove15Cp: -60 } }),
			game({}),
		];
		const t = openingTable(rows, ENGINE);
		expect(t.map((r) => `${r.colour}:${r.name}:${r.games.length}`)).toEqual(["white:Caro-Kann Defense:1", "black:Sicilian Defense:2"]);
		expect(t[1].variations?.map((v) => v.name)).toEqual(["Sicilian Defense: Najdorf", "Sicilian Defense: Dragon"]);
		expect(t[1].outcomePawns).toBeCloseTo(-0.2); // median of 20 and −60 cp
	});
	it("time management excludes games without clocks", () => {
		const rows = fixture();
		rows[0].summary = summary({ hasClocks: false, timeTrouble: null });
		rows[1].summary = summary({ timeTrouble: true, myMovesUnderPressure: 10, marks: [mark("me", "blunder", "endgame", 0.5, 50, true)] });
		rows[2].summary = summary({ lostOnTime: true, timeTrouble: true, myMovesUnderPressure: 10 });
		const t = timeFigures(engineRows(rows, ENGINE));
		expect(t.withoutClocks).toBe(1);
		expect(t.withClocks).toHaveLength(19);
		expect(t.timeTroublePct).toBeCloseTo((2 / 19) * 100);
		expect(t.pressureRate).toBeCloseTo(0.5); // 1 error in 20 moves
		expect(t.calmRate).toBe(0);
		expect(t.lostOnTime).toHaveLength(1);
		expect(t.medianFirst10).toBe(60);
	});
	it("trend needs 20 games; swings and review queue order", () => {
		const rows = fixture();
		expect(trend(engineRows(rows, ENGINE))).toHaveLength(1);
		expect(trend(engineRows(rows.slice(0, 19), ENGINE))).toHaveLength(0);
		rows[3].summary = summary({ marks: [mark("me", "blunder", "middlegame", 0.9, 41)], biggestSwing: { ply: 41, deltaW: 0.9 } });
		rows[16].summary = summary({ marks: [mark("me", "mistake", "endgame", 0.3, 61)], biggestSwing: { ply: 61, deltaW: 0.3 }, reachedWinning: true });
		rows[17].reviewed = true;
		rows[17].summary = summary({ biggestSwing: { ply: 9, deltaW: 1.5 } });
		const sw = biggestSwings(engineRows(rows, ENGINE));
		expect(sw.map((s) => s.mark.deltaW)).toEqual([0.9, 0.3]);
		expect(sw[0].moveNumber).toBe(21);
		const q = reviewQueue(engineRows(rows, ENGINE));
		// game 17 (loss, swing 0.3, winning not won): 0.3 + 0.5 + 0.25 = 1.05; game 4 (win, 0.9): 0.9
		expect(q[0].game.key).toBe(rows[16].key);
		expect(q[0].priority).toBeCloseTo(1.05);
		expect(q[1].game.key).toBe(rows[3].key);
		expect(q.find((x) => x.game.key === rows[17].key)).toBeUndefined();
	});
	it("only games analysed with the current engine count", () => {
		const rows = fixture();
		rows[0].engine = "stockfish-18-lite@d18";
		rows[1].analysisStatus = "queued";
		expect(engineRows(rows, ENGINE)).toHaveLength(18);
		expect(siteTimeGroups(rows)[0].id).toBe("lichess|rapid");
	});
});
