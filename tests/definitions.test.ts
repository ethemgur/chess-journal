import { describe, expect, it } from "vitest";
import {
	accuracyEdge,
	expectedScore,
	fideDp,
	inTimeTrouble,
	lostOnTime,
	mean,
	median,
	openingFamily,
	performanceRating,
	ratingBand,
	reviewPriority,
	timeTroubleThreshold,
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

describe("time trouble and accuracy", () => {
	it("time trouble below max(10% of base, 30 s); none without clocks or for daily", () => {
		expect(timeTroubleThreshold(600)).toBe(60);
		expect(timeTroubleThreshold(180)).toBe(30);
		expect(inTimeTrouble([500, 300, 61], 600, false)).toBe(false);
		expect(inTimeTrouble([500, 59], 600, false)).toBe(true);
		expect(inTimeTrouble([], 600, false)).toBeNull();
		expect(inTimeTrouble([10], 86400, true)).toBeNull();
	});
	it("losses on time, accuracy edge, mean and median", () => {
		expect(lostOnTime("loss", "timeout")).toBe(true);
		expect(lostOnTime("loss", "resignation")).toBe(false);
		expect(lostOnTime("draw", "timeout vs insufficient material")).toBe(false);
		expect(accuracyEdge(84.5, 80)).toBeCloseTo(4.5);
		expect(mean([80, 90])).toBe(85);
		expect(mean([])).toBeUndefined();
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
	it("review priority = accuracy gap ÷ 10 (0–2) + 0.5 if lost", () => {
		expect(reviewPriority(80, 90, "win")).toBeCloseTo(1);
		expect(reviewPriority(80, 90, "loss")).toBeCloseTo(1.5);
		expect(reviewPriority(90, 80, "loss")).toBeCloseTo(0.5); // I was more accurate: no gap
		expect(reviewPriority(40, 95, "draw")).toBe(2); // capped
	});
});
