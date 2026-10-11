import { describe, expect, it } from "vitest";
import { THRESHOLDS } from "../src/engine/constants";
import { classifyGame, judgeMove, winningChances } from "../src/engine/classify";
import type { PlyAnalysis } from "../src/engine/types";

/** cp loss from equality that gives exactly Δ = target, from W(x) = target. */
const cpForDelta = (d: number) => Math.log((1 + d) / (1 - d)) / 0.00368208;

describe("winning chances", () => {
	it("is symmetric, bounded and clamped at ±1000 cp", () => {
		expect(winningChances(0)).toBe(0);
		expect(winningChances(300)).toBeCloseTo(-winningChances(-300));
		expect(winningChances(1000)).toBe(winningChances(5000));
		expect(winningChances(10_000)).toBeLessThan(1);
	});
});

describe("thresholds", () => {
	const at = (cp: number) => judgeMove({ cp: 0 }, { cp: -cp }, "white", "a2a3", "e2e4").mark;
	it("marks by drop in winning chances at 0.10 / 0.20 / 0.30", () => {
		expect(at(Math.floor(cpForDelta(THRESHOLDS.inaccuracy)))).toBeUndefined();
		expect(at(Math.ceil(cpForDelta(THRESHOLDS.inaccuracy)))).toBe("inaccuracy");
		expect(at(Math.floor(cpForDelta(THRESHOLDS.mistake)))).toBe("inaccuracy");
		expect(at(Math.ceil(cpForDelta(THRESHOLDS.mistake)))).toBe("mistake");
		expect(at(Math.floor(cpForDelta(THRESHOLDS.blunder)))).toBe("mistake");
		expect(at(Math.ceil(cpForDelta(THRESHOLDS.blunder)))).toBe("blunder");
	});
	it("does not mark losing 2 pawns when already far ahead", () => {
		expect(judgeMove({ cp: 800 }, { cp: 600 }, "white", "a2a3", "e2e4").mark).toBeUndefined();
		expect(judgeMove({ cp: 0 }, { cp: -200 }, "white", "a2a3", "e2e4").mark).toBe("blunder");
	});
	it("judges from the mover's point of view", () => {
		expect(judgeMove({ cp: 0 }, { cp: 200 }, "black", "a7a6", "e7e5").mark).toBe("blunder");
		expect(judgeMove({ cp: 0 }, { cp: -200 }, "black", "a7a6", "e7e5").mark).toBeUndefined();
	});
	it("never marks the engine's best move", () => {
		expect(judgeMove({ cp: 0 }, { cp: -500 }, "white", "e2e4", "e2e4").mark).toBeUndefined();
	});
});

describe("mate cases", () => {
	it("losing a forced mate is at least a mistake", () => {
		// Mate in 3 -> still +9 (no drop in W after clamping) is a mistake, not nothing.
		expect(judgeMove({ mate: 3 }, { cp: 900 }, "white", "a2a3", "d1h5").mark).toBe("mistake");
		expect(judgeMove({ mate: -3 }, { cp: -900 }, "black", "a7a6", "d8h4").mark).toBe("mistake");
	});
	it("keeping a mate is not marked; walking into mate is a blunder", () => {
		expect(judgeMove({ mate: 3 }, { mate: 4 }, "white", "a2a3", "d1h5").mark).toBeUndefined();
		expect(judgeMove({ cp: 0 }, { mate: -2 }, "white", "a2a3", "e2e4").mark).toBe("blunder");
	});
});

describe("classifyGame", () => {
	const ply = (i: number, cp: number, best = "x"): PlyAnalysis => ({ ply: i, fen: "", score: { cp }, best, pv: [], depth: 18, source: "local" });
	it("counts marks per side and computes ACPL", () => {
		const plies = [ply(0, 20), ply(1, 20), ply(2, 300), ply(3, 300), ply(4, -100)];
		const moves = ["e2e4", "a7a6", "e4e5", "b7b6"];
		const g = classifyGame(plies, moves, "white");
		expect(g.marks.get(2)).toBe("blunder"); // black: 20 -> 300
		expect(g.marks.get(4)).toBeUndefined(); // black: 300 -> -100 improves black's position
		expect(g.black.blunders).toBe(1);
		expect(g.white.acpl).toBe(0);
		expect(g.black.acpl).toBe(Math.round((0 + 280) / 2));
	});
});
