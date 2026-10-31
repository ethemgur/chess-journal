import { describe, expect, it } from "vitest";
import {
	GameRow,
	accuracyByResult,
	accuracyByTimeClass,
	accuracyFigures,
	accuracyRows,
	bandFigures,
	chooseAccuracySite,
	defaultFilters,
	matchesFilters,
	openingTable,
	performanceOf,
	ratingHistory,
	periodRanges,
	reviewQueue,
	rowFromFrontmatter,
	scoreFigures,
	select,
	siteTimeGroups,
	timeFigures,
	vsExpected, mistakeFigures, mistakeTrend, materialFigures
} from "../src/dashboard/compute";

let n = 0;
function game(p: Partial<GameRow>): GameRow {
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
		reviewed: false,
		analysed: false,
		...p,
	};
}

/**
 * 20 Lichess rapid games at 2000 v 2000: 10 wins, 4 draws, 6 losses → 12 points, 60%.
 * Accuracy: mine 80 in wins, 70 in draws, 60 in losses; opponents' 75 throughout.
 */
function fixture(): GameRow[] {
	n = 0;
	const rows: GameRow[] = [];
	for (let i = 0; i < 10; i++) rows.push(game({ myResult: "win", myAccuracy: 80, oppAccuracy: 75 }));
	for (let i = 0; i < 4; i++) rows.push(game({ myResult: "draw", result: "1/2-1/2", myAccuracy: 70, oppAccuracy: 75 }));
	for (let i = 0; i < 6; i++) rows.push(game({ myResult: "loss", result: "0-1", myAccuracy: 60, oppAccuracy: 75 }));
	return rows;
}

describe("summary cards on a 20-game fixture", () => {
	it("score", () => {
		expect(scoreFigures(fixture())).toEqual({ games: 20, wins: 10, draws: 4, losses: 6, points: 12, pct: 60 });
	});
	it("vs expected: equal ratings expect 10 of 20", () => {
		const v = vsExpected(fixture());
		expect(v.games).toBe(20);
		expect(v.diff).toBeCloseTo(2);
		expect(v.per100).toBeCloseTo(10);
	});
	it("performance: 60% against 2000 → 2072", () => {
		expect(performanceOf(fixture())).toEqual({ games: 20, rating: 2072 });
	});
	it("accuracy: mean, median and edge over opponents in the same games", () => {
		const a = accuracyFigures(accuracyRows(fixture(), "lichess"));
		// (10×80 + 4×70 + 6×60) / 20 = 72
		expect(a).toMatchObject({ games: 20, mine: 72, median: 75, opp: 75, edgeGames: 20 });
		expect(a.edge).toBeCloseTo(-3);
	});
	it("time trouble from clock data only", () => {
		const rows = fixture();
		rows[0].timeTrouble = true;
		rows[14].timeTrouble = true; // a loss
		rows[15].timeTrouble = false;
		rows[15].termination = "timeout";
		for (const r of rows.slice(1, 10)) r.timeTrouble = false;
		const t = timeFigures(rows);
		expect(t.withClocks).toHaveLength(12);
		expect(t.withoutClocks).toBe(8);
		expect(t.timeTroublePct).toBeCloseTo((2 / 12) * 100);
		expect(t.scoreInTrouble).toBe(50); // a win and a loss
		expect(t.lostOnTime).toHaveLength(1);
	});
});

describe("accuracy", () => {
	it("uses Lichess games that carry Lichess accuracy", () => {
		const rows = [...fixture(), game({ site: "otb" })];
		expect(chooseAccuracySite(rows)).toBe("lichess");
		expect(accuracyFigures(accuracyRows(rows, "lichess")).mine).toBe(72);
		expect(chooseAccuracySite([game({})])).toBeUndefined();
	});
	it("splits by result and time class", () => {
		const acc = accuracyRows(fixture(), "lichess");
		const byResult = accuracyByResult(acc);
		expect(byResult.map((s) => [s.key, s.games.length, s.mine, s.opp])).toEqual([["win", 10, 80, 75], ["draw", 4, 70, 75], ["loss", 6, 60, 75]]);
		expect(accuracyByTimeClass(acc).map((s) => s.key)).toEqual(["rapid"]);
	});
});

describe("rating history", () => {
	it("one point per day: the pre-game rating of that day's last game", () => {
		const rows = [
			game({ date: "2026-09-01", playedAt: "2026-09-01T09:00:00Z", myRating: 2000 }),
			game({ date: "2026-09-01", playedAt: "2026-09-01T10:00:00Z", myRating: 2008 }),
			game({ date: "2026-09-01", playedAt: "2026-09-01T11:00:00Z", myRating: 2001 }),
			game({ date: "2026-09-03", playedAt: "2026-09-03T11:00:00Z", myRating: 2010 }),
			game({ site: "otb", date: "2026-09-01", myRating: 1800 }),
		];
		const h = ratingHistory(rows);
		expect(h.map((x) => x.group.id)).toEqual(["lichess|rapid"]); // OTB is not plotted
		expect(h[0].days.map((d) => [d.date, d.rating, d.games.length])).toEqual([["2026-09-01", 2001, 3], ["2026-09-03", 2010, 1]]);
	});
});

describe("review queue", () => {
	it("ranks by mistakes, accuracy gap, thrown wins and losses; skips reviewed and clean wins", () => {
		const rows = [
			game({ myAccuracy: 70, oppAccuracy: 85, myResult: "win" }), // gap 1 (capped)
			game({ myAccuracy: 75, oppAccuracy: 80, myResult: "loss" }), // 0.5 + 0.5 = 1.0
			game({ myAccuracy: 50, oppAccuracy: 95, myResult: "loss", reviewed: true }),
			game({ myAccuracy: 60, myResult: "loss" }), // not analysed, no opponent accuracy: not in the queue
			game({ myAccuracy: 90, oppAccuracy: 70, myResult: "draw" }), // 0: left out
			game({ analysed: true, myMistakes: 1, myBlunders: 1, evalHigh: 4, myResult: "draw" }), // 1.5 + 0.5 thrown
		];
		const q = reviewQueue(rows);
		expect(q.map((x) => x.priority)).toEqual([2, 1, 1]);
		expect(q[0].thrownWin).toBe(true);
		expect(q[1].gap).toBe(15);
	});
});

describe("mistakes", () => {
	const an = (p: Partial<GameRow>) => game({ analysed: true, myMistakes: 0, myBlunders: 0, myInaccuracies: 0, ...p });
	it("per game, by phase, in time trouble, missed chances, first mistake", () => {
		const rows = [
			an({ myMistakes: 1, myBlunders: 1, myAcpl: 40, oppMistakes: 2, errOpening: 0, errMiddlegame: 2, errEndgame: 0, errLowClock: 1, missedChances: 1, firstErrorMove: 18 }),
			an({ myMistakes: 0, myBlunders: 0, myAcpl: 20, oppBlunders: 1, errOpening: 0, errMiddlegame: 0, errEndgame: 0, errLowClock: 0, missedChances: 0 }),
			an({ myMistakes: 2, myBlunders: 0, myAcpl: 30, errLowClock: 2, missedChances: 0, firstErrorMove: 30 }), // no phase division (OTB)
			game({}), // not analysed
		];
		const m = mistakeFigures(rows);
		expect(m.analysed).toHaveLength(3);
		expect(m.errorsPerGame).toBeCloseTo(4 / 3);
		expect(m.blundersPerGame).toBeCloseTo(1 / 3);
		expect(m.acpl).toBe(30);
		expect(m.clean).toHaveLength(1);
		expect(m.phaseGames).toHaveLength(2);
		expect(m.byPhase).toEqual({ opening: 0, middlegame: 1, endgame: 0 });
		expect([m.lowClockErrors, m.clockErrors]).toEqual([3, 4]);
		expect(m.lowClockPct).toBe(75);
		expect([m.missed, m.oppErrors]).toEqual([1, 3]);
		expect(m.firstErrorMedian).toBe(24);
	});
	it("month by month", () => {
		const t = mistakeTrend([an({ date: "2026-08-02", myBlunders: 2 }), an({ date: "2026-09-01" }), an({ date: "2026-09-20", myMistakes: 1 })]);
		expect(t.map((m) => [m.month, m.errorsPerGame, m.blundersPerGame])).toEqual([["2026-08", 2, 2], ["2026-09", 0.5, 0]]);
	});
	it("winning and losing positions use the evaluation, else material", () => {
		const m = materialFigures([
			game({ evalHigh: 4, evalLow: 0, moves: 30, materialHigh: 0, myResult: "draw" }), // winning by eval, let slip
			game({ evalHigh: 1, evalLow: -5, moves: 30, materialLow: 0, myResult: "win" }), // losing by eval, saved
			game({ evalHigh: 1, evalLow: 0, moves: 30, materialHigh: 5, myResult: "loss" }), // eval says not winning: material ignored
			game({ moves: 30, materialHigh: 3, materialLow: 0, myResult: "win" }), // no analysis: up material, won
		]);
		expect(m.byEval).toBe(3);
		expect(m.up.games).toHaveLength(2);
		expect(m.letSlip).toHaveLength(1);
		expect(m.turnedAround).toHaveLength(1);
	});
});

describe("periods, filters and rows", () => {
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
		expect(matchesFilters({ ...g, oppRating: 2100 }, { ...f, bands: ["stronger"] })).toBe(true);
		expect(matchesFilters(g, { ...f, families: ["Sicilian Defense"] })).toBe(false);
		const otb = { ...g, site: "otb" as const, timeClass: undefined };
		expect(matchesFilters(otb, f)).toBe(false);
		expect(matchesFilters(otb, { ...f, sites: ["otb"] })).toBe(true);
		expect(select([game({ date: "2026-06-01" }), game({ date: "2026-09-01" })], f, { from: "2026-07-12", to: "2026-10-11" })).toHaveLength(1);
	});
	it("rows from frontmatter, including site accuracy and clocks", () => {
		const r = rowFromFrontmatter("a.md", {
			"game-key": "lichess:abcd1234", site: "lichess", "my-colour": "black", "my-result": "draw", result: "1/2-1/2",
			white: "x", black: "me", date: "2026-10-01", "my-rating": 1990, "opp-rating": "2010", "time-class": "blitz",
			rated: true, opening: "Sicilian Defense: Najdorf", reviewed: true, "site-accuracy": 84.3, "opp-accuracy": 79.1,
			"time-trouble": false, "first-10-seconds": 45,
		})!;
		expect(r).toMatchObject({ opponent: "x", myRating: 1990, oppRating: 2010, family: "Sicilian Defense", reviewed: true, myAccuracy: 84.3, oppAccuracy: 79.1, timeTrouble: false, first10Seconds: 45 });
		expect(rowFromFrontmatter("b.md", { site: "lichess" })).toBeUndefined();
		expect(rowFromFrontmatter("c.md", { "game-key": "chesscom:1", site: "chesscom", "my-colour": "white", "my-result": "win" })).toBeUndefined();
	});
	it("bands, openings and groups", () => {
		const rows = [game({ oppRating: 2300, myResult: "draw" }), game({ oppRating: 2250, myResult: "loss" }), game({ oppRating: 2000 })];
		const strong = bandFigures(rows).find((x) => x.band === "much-stronger")!;
		expect(strong.games).toHaveLength(2);
		expect(strong.actualPct).toBeCloseTo(25);
		const t = openingTable([game({ myAccuracy: 80 }), game({ myAccuracy: 70, opening: "Caro-Kann Defense: Classical" }), game({ site: "otb", myAccuracy: 99 })], "lichess");
		expect(t[0].games).toHaveLength(3);
		expect(t[0].accuracy).toBe(75); // only Lichess accuracy counts
		expect(t[0].accuracyGames).toBe(2);
		expect(siteTimeGroups(fixture())[0].id).toBe("lichess|rapid");
	});
});
