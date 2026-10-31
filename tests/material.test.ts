import { describe, expect, it } from "vitest";
import { positionStats } from "../src/sources/material";
import { GameRow, endgameFigures, imbalanceTable, materialFigures, rowFromFrontmatter } from "../src/dashboard/compute";
import { positionFrontmatter } from "../src/notes/frontmatter";

const fen = (f: string, moves: string, result = "*") => `[FEN "${f}"]\n[SetUp "1"]\n[Result "${result}"]\n\n${moves} ${result}`;

describe("move statistics (piece counting)", () => {
	it("an exchange in progress is not a material swing; the bishop pair lasts", () => {
		const s = positionStats("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O f6 6. d4 exd4 7. Nxd4 c5 8. Nb3 Qxd1 9. Rxd1 *", "white");
		expect(s?.moves).toBe(9);
		expect(s?.materialLow).toBe(0);
		expect(s?.materialHigh).toBe(0);
		expect(s?.imbalances).toEqual(["opp-bishop-pair"]);
		expect(s?.endgame).toBe(false);
	});

	it("a lasting piece deficit and an endgame", () => {
		const s = positionStats(fen("rn2k3/8/8/8/8/8/8/R3K3 w - - 0 1", "1. Ra2 Nc6 2. Ra3 Nb4 3. Ra4 Nc6 4. Ra5"), "white");
		expect(s?.materialLow).toBe(-3);
		expect(s?.endgame).toBe(true);
		expect(s?.imbalances).toEqual([]);
	});

	it("rook vs minor piece, from each side", () => {
		const pgn = fen("4k3/8/2b5/8/8/8/8/R3K3 w - - 0 1", "1. Ra2 Bd7 2. Ra3 Bc6 3. Ra4 Bd7");
		expect(positionStats(pgn, "white")?.imbalances).toEqual(["rook-vs-minor"]);
		expect(positionStats(pgn, "black")?.imbalances).toEqual(["minor-vs-rook"]);
		expect(positionStats(pgn, "white")?.materialHigh).toBe(2);
	});

	it("a sacrifice right before the end is not a deficit", () => {
		const s = positionStats("1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0", "black");
		expect(s?.materialLow).toBe(0);
	});

	it("bad PGN gives no statistics", () => {
		expect(() => positionStats("1. e4 e5 2. Ke3 Ke6 3. Kxe5 *", "white")).not.toThrow();
		expect(positionStats("", "white")).toBeUndefined();
	});

	it("frontmatter round trip", () => {
		const fm = positionFrontmatter({ moves: 40, materialLow: -5, materialHigh: 2, materialEnd: -1, imbalances: ["minor-vs-rook"], endgame: true });
		const row = rowFromFrontmatter("a.md", { "game-key": "lichess:abcd1234", site: "lichess", "my-colour": "white", "my-result": "draw", ...fm });
		expect(row).toMatchObject({ moves: 40, materialLow: -5, materialHigh: 2, materialEnd: -1, imbalances: ["minor-vs-rook"], endgame: true });
		expect(positionFrontmatter({ moves: 10, materialLow: 0, materialHigh: 0, materialEnd: 0, imbalances: [], endgame: false })).not.toHaveProperty("imbalances");
	});
});

describe("material figures", () => {
	let n = 0;
	const g = (p: Partial<GameRow>): GameRow => ({
		key: `k${++n}`, path: `${n}.md`, site: "lichess", date: "2026-09-01", playedAt: "", myColour: "white", myResult: "win", result: "1-0",
		myRating: 1500, oppRating: 1500, family: "x", opponent: "o", reviewed: false, analysed: false, moves: 30, materialLow: 0, materialHigh: 0, imbalances: [], endgame: false, ...p,
	});

	it("comebacks and collapses", () => {
		const rows = [
			g({ materialLow: -3, myResult: "win" }),
			g({ materialLow: -5, myResult: "draw" }),
			g({ materialLow: -3, myResult: "loss" }),
			g({ materialHigh: 4, myResult: "win" }),
			g({ materialHigh: 3, myResult: "loss" }),
			g({ materialLow: -2, myResult: "win" }),
			g({ moves: undefined, materialLow: undefined }),
		];
		const m = materialFigures(rows);
		expect(m.withoutMoves).toBe(1);
		expect(m.down.games).toHaveLength(3);
		expect(m.turnedAround).toHaveLength(2);
		expect(m.up.games).toHaveLength(2);
		expect(m.letSlip).toHaveLength(1);
	});

	it("imbalances and endgames", () => {
		const rows = [g({ imbalances: ["bishop-pair"], endgame: true }), g({ imbalances: ["bishop-pair", "rook-vs-minor"], myResult: "loss" }), g({})];
		const t = imbalanceTable(rows);
		expect(t.map((r) => [r.kind, r.games.length, r.scorePct])).toEqual([["rook-vs-minor", 1, 0], ["bishop-pair", 2, 50]]);
		const e = endgameFigures(rows);
		expect(e.reached.games).toHaveLength(1);
		expect(e.notReached.games).toHaveLength(2);
	});
});
