import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
	PgnParseError,
	addMove,
	commentOf,
	deleteFrom,
	infoAt,
	mainlinePath,
	makeMainline,
	nodeAt,
	normalisePgnForCompare,
	parseGame,
	promoteVariation,
	serialise,
	setNag,
	splitPgnGames,
	timeSpent,
	updateComment,
} from "../src/pgn/tree";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const FIXTURES = ["lichess.pgn", "other-site.pgn", "chessbase.pgn"];

describe("round trip", () => {
	for (const f of FIXTURES) {
		it(`${f} is unchanged apart from whitespace`, () => {
			const text = fixture(f);
			const out = serialise(parseGame(text));
			expect(normalisePgnForCompare(out)).toBe(normalisePgnForCompare(text));
			// And serialising twice is stable.
			expect(serialise(parseGame(out))).toBe(out);
		});
	}
	it("every game of the OTB file round-trips", () => {
		const games = splitPgnGames(fixture("otb.pgn"));
		expect(games).toHaveLength(2);
		for (const g of games) expect(normalisePgnForCompare(serialise(parseGame(g)))).toBe(normalisePgnForCompare(g));
	});
});

describe("parsing", () => {
	it("keeps variations, NAGs and shapes", () => {
		const g = parseGame(fixture("chessbase.pgn"));
		expect(g.comments?.[0]).toContain("quiet Berlin");
		const n = nodeAt(g, [0, 0, 0, 0, 0, 0])!;
		const c = commentOf(n, g);
		expect(c.shapes).toHaveLength(3);
		expect(c.text).toBe("The Berlin.");
		const d3 = nodeAt(g, [0, 0, 0, 0, 0, 0, 1])!;
		expect(d3.children[0].children).toHaveLength(2);
	});
	it("gives a readable error for malformed PGN", () => {
		expect(() => parseGame("")).toThrow(PgnParseError);
		expect(() => parseGame("1. e4 e5 2. Ke3 Nf6")).toThrow('Illegal or unreadable move "Ke3" at move 2 (White).');
		expect(() => parseGame('[Variant "Chess960"]\n\n1. e4 *')).toThrow(/not supported/);
	});
	it("computes time spent from clocks plus increment", () => {
		const g = parseGame(fixture("lichess.pgn"));
		const t = timeSpent(g);
		expect(t.get(1)).toBe(5); // 600 - 600 + 5
		expect(t.get(3)).toBe(2); // 600 - 603 + 5
		expect(t.get(7)).toBe(30); // 605 - 580 + 5
		expect(t.get(11)).toBe(94); // 571 - 482 + 5
	});
});

describe("editing", () => {
	it("adds moves, goes to existing ones and adds variations", () => {
		const g = parseGame("1. e4 e5 *");
		expect(addMove(g, [], "e2e4")).toEqual([0]);
		expect(addMove(g, [], "d2d4")).toEqual([1]);
		expect(addMove(g, [0, 0], "g1f3")).toEqual([0, 0, 0]);
		expect(addMove(g, [0, 0], "e1e3")).toBeUndefined();
		expect(serialise(g)).toBe("1. e4 (1. d4) 1... e5 2. Nf3 *");
	});
	it("promotes, makes main line and deletes", () => {
		const g = parseGame("1. e4 ( 1. d4 ) ( 1. c4 c5 ) *");
		let p = promoteVariation(g, [2, 0]);
		expect(p).toEqual([1, 0]);
		expect(serialise(g)).toBe("1. e4 (1. c4 c5) (1. d4) *");
		p = makeMainline(g, p);
		expect(p).toEqual([0, 0]);
		expect(serialise(g)).toBe("1. c4 (1. e4) (1. d4) 1... c5 *");
		expect(deleteFrom(g, [0, 0])).toEqual([0]);
		expect(serialise(g)).toBe("1. c4 (1. e4) (1. d4) *");
	});
	it("sets comments, symbols and shapes, keeping clocks", () => {
		const g = parseGame(fixture("lichess.pgn"));
		updateComment(g, [0], { text: "Main move", shapes: [{ color: "red", from: 12, to: 28 }] });
		setNag(g, [0], "move", 1);
		setNag(g, [0], "move", 3);
		setNag(g, [0], "position", 14);
		const c = commentOf(nodeAt(g, [0])!, g);
		expect(c.text).toBe("Main move");
		expect(c.clock).toBe(600);
		expect(c.evaluation).toEqual({ pawns: 0.18 });
		expect(c.shapes).toEqual([{ color: "red", from: 12, to: 28 }]);
		const again = parseGame(serialise(g));
		expect(nodeAt(again, [0])!.children.length).toBe(1);
		expect((nodeAt(again, [0]) as unknown as { data: { nags?: number[] } }).data.nags).toEqual([3, 14]);
	});
	it("walks paths to positions", () => {
		const g = parseGame(fixture("other-site.pgn"));
		const end = infoAt(g, mainlinePath(g));
		expect(end.pos.isCheckmate()).toBe(true);
		expect(end.lastUci).toBe("h5f7");
	});
});

describe("castling", () => {
	it("uses king-two-squares UCI and accepts both notations", () => {
		const g = parseGame("1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O *");
		expect(infoAt(g, mainlinePath(g)).lastUci).toBe("e1g1");
		const h = parseGame("1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *");
		const end = mainlinePath(h);
		expect(addMove(h, end, "e1g1")).toEqual([0, 0, 0, 0, 0, 0, 0]);
		expect(addMove(h, end, "e1h1")).toEqual([0, 0, 0, 0, 0, 0, 0]);
		expect(serialise(h)).toBe("1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O *");
	});
});
