import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
	SUMMARY_END,
	SUMMARY_START,
	fileNameFor,
	findGameBlock,
	firstGameBlock,
	renderNote,
	renderSummary,
	replaceBlockBody,
	replaceRegion,
} from "../src/notes/noteWriter";
import { applyOwnedKeys, changedKeys, displayTimeControl, formatTimeControl, newNoteFrontmatter, SYNC_KEYS, syncFrontmatter } from "../src/notes/frontmatter";
import { normaliseChesscom, normaliseLichess } from "../src/sources/normalise";
import { lichessGame } from "./helpers";
import type { GameRecord } from "../src/types";

const record = (): GameRecord => {
	const n = normaliseLichess(lichessGame("abcd1234", Date.parse("2026-10-04T18:22:10Z")) as never, "ethem");
	if (!n.ok) throw new Error("bad fixture");
	return n.record;
};

describe("note format", () => {
	it("renders frontmatter, summary, the chess-game block and My review", () => {
		const r = record();
		const note = renderNote(r, newNoteFrontmatter(r, "none"));
		expect(note).toMatch(/^---\ncr-schema: 1\ngame-key: "lichess:abcd1234"\nsite: lichess\n/);
		expect(note).toContain('played-at: "2026-10-04T18:22:10Z"');
		expect(note).toContain('date: "2026-10-04"');
		expect(note).toContain("my-rating: 2004\nopp-rating: 1987");
		expect(note).toContain("tags:\n  - chess-game\nreviewed: false\n---");
		expect(note).toContain("# ethem vs opp, 2026-10-04");
		expect(note).toContain(`${SUMMARY_START}\nRapid 10+5 · Lichess · 1-0 by checkmate · [open game](https://lichess.org/abcd1234)\nNot analysed yet.\n${SUMMARY_END}`);
		expect(firstGameBlock(note)?.trim()).toBe(r.pgn);
		expect(note.trimEnd().endsWith("## My review")).toBe(true);
	});

	it("summary after analysis", () => {
		const s = renderSummary({
			site: "chesscom",
			"time-class": "rapid",
			"time-control": "10+5",
			result: "0-1",
			termination: "resignation",
			url: "https://www.chess.com/game/live/1",
			"analysis-status": "done",
			"my-inaccuracies": 3,
			"my-mistakes": 1,
			"my-blunders": 0,
			"my-acpl": 31,
		});
		expect(s).toBe("Rapid 10+5 · chess.com · 0-1 by resignation · [open game](https://www.chess.com/game/live/1)\nMy mistakes: 3 inaccuracies, 1 mistake, 0 blunders · ACPL 31");
		expect(displayTimeControl("600+5")).toBe("10+5"); // written by an older version
		expect(displayTimeControl("3+2")).toBe("3+2");
	});

	it("replaces only the summary region and only a block's body", () => {
		const r = record();
		const note = renderNote(r, newNoteFrontmatter(r, "none")) + "\nMy notes here.\n";
		const next = replaceRegion(note, "NEW");
		expect(next).toContain(`${SUMMARY_START}\nNEW\n${SUMMARY_END}`);
		expect(next.replace(/<!-- chess-journal:summary:start -->[\s\S]*<!-- chess-journal:summary:end -->/, "")).toBe(
			note.replace(/<!-- chess-journal:summary:start -->[\s\S]*<!-- chess-journal:summary:end -->/, ""),
		);
		const lines = note.split("\n");
		const start = lines.findIndex((l) => l === "```chess-game");
		const end = lines.findIndex((l, i) => i > start && l === "```");
		const edited = replaceBlockBody(note, start, end, "1. d4 *");
		expect(firstGameBlock(edited)).toBe("1. d4 *\n");
		// Text outside the block is byte-for-byte unchanged.
		const outside = (s: string) => s.replace(/```chess-game\n[\s\S]*?\n```/, "");
		expect(outside(edited)).toBe(outside(note));
	});

	it("keeps CRLF line endings when replacing a block", () => {
		const note = "a\r\n```chess-game\r\n1. e4 *\r\n```\r\nb";
		expect(replaceBlockBody(note, 1, 3, "1. d4 *")).toBe("a\r\n```chess-game\r\n1. d4 *\r\n```\r\nb");
	});

	it("builds safe file names from the template", () => {
		const r = record();
		expect(fileNameFor("{date} {white} vs {black} ({site})", r)).toBe("2026-10-04 ethem vs opp (Lichess)");
		expect(fileNameFor("{id} {result} {timeClass}", { ...r, white: { name: "a/b:c" } })).toBe("abcd1234 1-0 rapid");
		expect(fileNameFor("{white}", { ...r, white: { name: "x/y\\z:*?" } })).toBe("xyz");
	});
});

describe("frontmatter ownership", () => {
	it("keeps user keys and tags, detects changes in plugin keys only", () => {
		const r = record();
		const wanted = syncFrontmatter(r);
		const fm: Record<string, unknown> = { ...newNoteFrontmatter(r, "done"), reviewed: true, tags: ["chess-game", "sharp"], mood: "tilted" };
		expect(changedKeys(fm, wanted, SYNC_KEYS)).toEqual([]);
		const changed = { ...wanted, "opp-rating": 2000 };
		expect(changedKeys(fm, changed, SYNC_KEYS)).toEqual(["opp-rating"]);
		applyOwnedKeys(fm, changed, SYNC_KEYS);
		expect(fm["opp-rating"]).toBe(2000);
		expect(fm.reviewed).toBe(true);
		expect(fm.mood).toBe("tilted");
		expect(fm.tags).toEqual(["chess-game", "sharp"]);
		const noTag: Record<string, unknown> = { tags: ["mine"] };
		applyOwnedKeys(noTag, wanted, SYNC_KEYS);
		expect(noTag.tags).toEqual(["mine", "chess-game"]);
	});
});

describe("fixtures exist", () => {
	it("loads", () => {
		expect(readFileSync(new URL("./fixtures/otb.pgn", import.meta.url), "utf8")).toContain("Spring Open");
	});
});

describe("finding a game block by its text", () => {
	const note = "# A\n\n```chess-game\n1. e4 e5 *\n```\n\ntext\n\n````chess-game\n1. d4 d5 *\n````\n\n```chess-game\n1. e4 e5 *\n```\n";
	it("finds the block with the expected body, ignoring position", () => {
		expect(findGameBlock(note, "1. d4 d5 *")).toEqual({ lineStart: 8, lineEnd: 10 });
		expect(findGameBlock(note, "  1. d4 d5 *\n")).toEqual({ lineStart: 8, lineEnd: 10 });
		expect(findGameBlock(note, "1. c4 *")).toBeUndefined();
	});
	it("picks the copy nearest the known position when the same game appears twice", () => {
		expect(findGameBlock(note, "1. e4 e5 *")).toEqual({ lineStart: 2, lineEnd: 4 });
		expect(findGameBlock(note, "1. e4 e5 *", 12)).toEqual({ lineStart: 12, lineEnd: 14 });
	});
	it("replacing it leaves the rest of the note unchanged", () => {
		const b = findGameBlock(note, "1. d4 d5 *")!;
		const out = replaceBlockBody(note, b.lineStart, b.lineEnd, "1. d4 Nf6 *");
		expect(out).toBe(note.replace("1. d4 d5 *", "1. d4 Nf6 *"));
	});
});

describe("legacy summary markers", () => {
	it("replaces old chess-review markers with chess-journal ones", () => {
		const old = "x\n<!-- chess-review:summary:start -->\nold\n<!-- chess-review:summary:end -->\ny";
		expect(replaceRegion(old, "NEW")).toBe("x\n<!-- chess-journal:summary:start -->\nNEW\n<!-- chess-journal:summary:end -->\ny");
	});
});

describe("time control as the sites show it", () => {
	it("converts PGN seconds to minutes+increment", () => {
		expect(formatTimeControl("180")).toBe("3+0");
		expect(formatTimeControl("180+2")).toBe("3+2");
		expect(formatTimeControl("300+3")).toBe("5+3");
		expect(formatTimeControl("600+5")).toBe("10+5");
		expect(formatTimeControl("5400+30")).toBe("90+30");
		expect(formatTimeControl("90+0")).toBe("1.5+0");
		expect(formatTimeControl("30+0")).toBe("½+0");
		expect(formatTimeControl("15")).toBe("¼+0");
		expect(formatTimeControl("1/86400")).toBe("1 day");
		expect(formatTimeControl("1/259200")).toBe("3 days");
		expect(formatTimeControl("40/5400:1800+30")).toBe("40/5400:1800+30");
		expect(formatTimeControl("-")).toBeUndefined();
	});
	it("is what new notes store", () => {
		expect(syncFrontmatter(record())["time-control"]).toBe("10+5");
	});
});

describe("site accuracy and clock keys", () => {
	it("Lichess: accuracy for both sides", () => {
		const g = lichessGame("acc12345", Date.parse("2026-10-04T18:22:10Z"), {
			players: {
				white: { user: { name: "ethem", id: "ethem" }, rating: 2004, analysis: { inaccuracy: 3, mistake: 1, blunder: 0, acpl: 31, accuracy: 88.4 } },
				black: { user: { name: "opp", id: "opp" }, rating: 1987, analysis: { inaccuracy: 2, mistake: 2, blunder: 1, acpl: 52, accuracy: 79.1 } },
			},
		});
		const n = normaliseLichess(g as never, "ethem");
		if (!n.ok) throw new Error("bad fixture");
		const fm = syncFrontmatter(n.record);
		expect(fm).toMatchObject({ "site-accuracy": 88.4, "opp-accuracy": 79.1 });
		// Lichess-only judgement counts are not stored (the dashboard uses what both sites provide).
		expect(fm["site-mistakes"]).toBeUndefined();
		// The helper's PGN has no TimeControl tag, so time trouble cannot be judged (real exports have it).
		expect(fm["time-trouble"]).toBeUndefined();
		expect(fm["first-10-seconds"]).toBeUndefined();
	});
	it("no analysis on Lichess means no accuracy keys", () => {
		const n = normaliseLichess(lichessGame("noacc123", Date.parse("2026-10-04T18:22:10Z")) as never, "ethem");
		if (!n.ok) throw new Error("bad fixture");
		const fm = syncFrontmatter(n.record);
		expect(fm["site-accuracy"]).toBeUndefined();
		expect(fm["opp-accuracy"]).toBeUndefined();
	});
	it("chess.com: accuracies for me and my opponent", () => {
		const n = normaliseChesscom({
			uuid: "u1", url: "https://www.chess.com/game/live/1", rules: "chess", time_class: "rapid", time_control: "600", rated: true,
			pgn: '[White "ethem"]\n[Black "opp"]\n[Result "1-0"]\n[TimeControl "600"]\n\n1. e4 {[%clk 0:09:58]} 1... e5 {[%clk 0:09:50]} 2. Qh5 {[%clk 0:00:20]} 1-0',
			white: { username: "ethem", rating: 2000, result: "win" }, black: { username: "opp", rating: 1990, result: "resigned" },
			accuracies: { white: 91.2, black: 70.4 },
		}, "ethem");
		if (!n.ok) throw new Error("bad fixture");
		const fm = syncFrontmatter(n.record);
		expect(fm).toMatchObject({ "site-accuracy": 91.2, "opp-accuracy": 70.4, "time-trouble": true });
	});
});
