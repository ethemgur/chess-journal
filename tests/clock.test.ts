import { describe, expect, it } from "vitest";
import { clockStats } from "../src/sources/clock";
import { GameRow, clockRace, timeFigures } from "../src/dashboard/compute";

const hms = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/** Knight shuffles; White spends 20 s a move (30 s on move 5), Black 5 s. */
function pgn(moves: number): string {
	const w = ["Nf3", "Ng1"];
	const b = ["Nf6", "Ng8"];
	let wc = 600;
	let bc = 600;
	const out: string[] = [];
	for (let m = 1; m <= moves; m++) {
		wc -= m === 5 ? 30 : 20;
		bc -= 5;
		out.push(`${m}. ${w[(m - 1) % 2]} { [%clk ${hms(wc)}] } ${b[(m - 1) % 2]} { [%clk ${hms(bc)}] }`);
	}
	return `[TimeControl "600"]\n[Result "0-1"]\n\n${out.join(" ")} 0-1`;
}

describe("clock statistics", () => {
	it("curves, time trouble on both sides, longest think", () => {
		const s = clockStats(pgn(28), "white", false);
		expect(s?.clockCurve).toEqual([65, 32]);
		expect(s?.oppClockCurve).toEqual([92, 83]);
		expect(s?.timeTrouble).toBe(true);
		expect(s?.oppTimeTrouble).toBe(false);
		expect(s?.longestThink).toBe(30);
		expect(s?.longestThinkMove).toBe(5);
		expect(s?.first10Seconds).toBe(210);
		const black = clockStats(pgn(28), "black", false);
		expect(black?.clockCurve).toEqual([92, 83]);
		expect(black?.oppTimeTrouble).toBe(true);
	});

	it("daily games have no curve or thinks", () => {
		const s = clockStats(pgn(12), "white", true);
		expect(s?.clockCurve).toEqual([]);
		expect(s?.longestThink).toBeNull();
	});
});

describe("time figures", () => {
	let n = 0;
	const g = (p: Partial<GameRow>): GameRow => ({
		key: `k${++n}`, path: `${n}.md`, site: "lichess", date: "2026-09-01", playedAt: "", myColour: "white", myResult: "win", result: "1-0",
		family: "x", opponent: "o", reviewed: false, analysed: false, timeTrouble: false, oppTimeTrouble: false, ...p,
	});

	it("who got into time trouble, wins and losses on time", () => {
		const rows = [
			g({ timeTrouble: true, myResult: "loss", termination: "timeout", materialEnd: 2 }),
			g({ timeTrouble: true, oppTimeTrouble: true, myResult: "loss", termination: "timeout", materialEnd: -4 }),
			g({ oppTimeTrouble: true, termination: "timeout" }),
			g({}),
		];
		const t = timeFigures(rows);
		expect(t.trouble.onlyMe.games).toHaveLength(1);
		expect(t.trouble.both.games).toHaveLength(1);
		expect(t.trouble.onlyOpp.games).toHaveLength(1);
		expect(t.trouble.neither.games).toHaveLength(1);
		expect(t.lostOnTime).toHaveLength(2);
		expect(t.lostOnTimeNotBehind).toHaveLength(1);
		expect(t.wonOnTime).toHaveLength(1);
		expect(t.oppTroublePct).toBe(50);
	});

	it("clock race at move 20", () => {
		const rows = [
			g({ clockCurve: [90, 60], oppClockCurve: [80, 40] }),
			g({ clockCurve: [90, 40], oppClockCurve: [80, 45], myResult: "draw" }),
			g({ clockCurve: [70, 20], oppClockCurve: [90, 50], myResult: "loss" }),
			g({ clockCurve: [70], oppClockCurve: [90] }),
		];
		const r = clockRace(rows);
		expect(r.checkpoints[0]).toMatchObject({ move: 10, mine: 80, opp: 85 });
		expect(r.checkpoints[1].games).toHaveLength(3);
		expect([r.ahead.games.length, r.even.games.length, r.behind.games.length]).toEqual([1, 1, 1]);
	});
});
