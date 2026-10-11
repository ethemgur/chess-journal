import { describe, expect, it } from "vitest";
import {
	endgameStartPly,
	expectedScore,
	fideDp,
	inTimeTrouble,
	openingFamily,
	performanceRating,
	phaseOfPly,
	ratingBand,
	reachedWinningLosing,
	reviewPriority,
	timeTroubleThreshold,
	errorRate,
	pointsThrownAway,
	median,
} from "../src/dashboard/definitions";

describe("score and ratings", () => {
	it("expected score", () => {
		expect(expectedScore(2000, 2000)).toBe(0.5);
		expect(expectedScore(2000, 2400)).toBeCloseTo(1 / 11, 6);
		expect(expectedScore(2400, 2000)).toBeCloseTo(10 / 11, 6);
	});
	it("FIDE dp table, symmetric", () => {
		expect(fideDp(0.5)).toBe(0);
		expect(fideDp(0.75)).toBe(193);
		expect(fideDp(0.25)).toBe(-193);
		expect(fideDp(1)).toBe(800);
		expect(fideDp(0)).toBe(-800);
		expect(fideDp(0.546)).toBe(36); // rounds to 0.55
	});
	it("performance rating = average opponent + dp, capped", () => {
		expect(performanceRating([1900, 2100], 1)).toBe(2000);
		expect(performanceRating([2000, 2000, 2000, 2000], 3)).toBe(2193);
		expect(performanceRating([2000], 1)).toBe(2800);
		expect(performanceRating([], 0)).toBeUndefined();
	});
	it("rating bands by opponent − me", () => {
		expect(ratingBand(2000, 1800)).toBe("much-weaker");
		expect(ratingBand(2000, 1801)).toBe("weaker");
		expect(ratingBand(2000, 1950)).toBe("weaker");
		expect(ratingBand(2000, 1951)).toBe("equal");
		expect(ratingBand(2000, 2049)).toBe("equal");
		expect(ratingBand(2000, 2050)).toBe("stronger");
		expect(ratingBand(2000, 2199)).toBe("stronger");
		expect(ratingBand(2000, 2200)).toBe("much-stronger");
	});
});

describe("phases", () => {
	it("endgame starts when both sides' non-pawn material totals 26 or less", () => {
		const start = { white: 31, black: 31 };
		expect(endgameStartPly([start, start, { white: 22, black: 17 }, { white: 13, black: 13 }])).toBe(3);
		expect(endgameStartPly([start, start])).toBeUndefined();
	});
	it("opening is plies 1–24 unless the endgame starts earlier", () => {
		expect(phaseOfPly(1, undefined)).toBe("opening");
		expect(phaseOfPly(24, undefined)).toBe("opening");
		expect(phaseOfPly(25, undefined)).toBe("middlegame");
		expect(phaseOfPly(20, 18)).toBe("endgame");
		expect(phaseOfPly(17, 18)).toBe("opening");
		expect(phaseOfPly(60, 50)).toBe("endgame");
	});
});

describe("winning, time trouble, errors", () => {
	it("winning/losing need two consecutive moves of mine", () => {
		expect(reachedWinningLosing([50, 250, 100, 300])).toEqual({ winning: false, losing: false });
		expect(reachedWinningLosing([50, 250, 210])).toEqual({ winning: true, losing: false });
		expect(reachedWinningLosing([-300, -200, 0])).toEqual({ winning: false, losing: true });
		expect(reachedWinningLosing([150, 160], 150)).toEqual({ winning: true, losing: false });
	});
	it("time trouble below max(10% of base, 30 s); none without clocks or for daily", () => {
		expect(timeTroubleThreshold(600)).toBe(60);
		expect(timeTroubleThreshold(180)).toBe(30);
		expect(inTimeTrouble([500, 300, 61], 600, false)).toBe(false);
		expect(inTimeTrouble([500, 59], 600, false)).toBe(true);
		expect(inTimeTrouble([], 600, false)).toBeNull();
		expect(inTimeTrouble([10], 86400, true)).toBeNull();
	});
	it("error rate per 10 moves", () => {
		expect(errorRate(3, 40)).toBe(0.75);
		expect(errorRate(1, 0)).toBeUndefined();
	});
	it("points thrown away and median", () => {
		expect(pointsThrownAway([{ reachedWinning: true, result: "draw" }, { reachedWinning: true, result: "loss" }, { reachedWinning: false, result: "loss" }])).toBe(1.5);
		expect(median([3, 1, 2])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
	});
});

describe("openings and review priority", () => {
	it("opening family is the name up to the first colon, else the ECO code", () => {
		expect(openingFamily("Caro-Kann Defense: Advance Variation", "B12")).toBe("Caro-Kann Defense");
		expect(openingFamily(undefined, "B12")).toBe("B12");
		expect(openingFamily("", "")).toBe("Unknown");
	});
	it("review priority = swing + 0.5 if lost + 0.25 if a win was not converted", () => {
		expect(reviewPriority(0.4, "win", true)).toBeCloseTo(0.4);
		expect(reviewPriority(0.4, "loss", false)).toBeCloseTo(0.9);
		expect(reviewPriority(0.4, "loss", true)).toBeCloseTo(1.15);
		expect(reviewPriority(0.4, "draw", true)).toBeCloseTo(0.65);
		expect(reviewPriority(5, "win", false)).toBe(2);
	});
});
