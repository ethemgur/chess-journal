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
import { applyOwnedKeys, changedKeys, displayTimeControl, formatTimeControl, newNoteFrontmatter, shouldWriteSiteAnalysis, siteAnalysisFrontmatter, SYNC_KEYS, syncFrontmatter } from "../src/notes/frontmatter";
import { gameAnalysisFromLichess } from "../src/sources/lichessAnalysis";
import { normaliseLichess } from "../src/sources/normalise";
import { LICHESS_ANALYSIS, lichessGame } from "./helpers";
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
		expect(note).toContain(`${SUMMARY_START}\nRapid 10+5 · Lichess · 1-0 by checkmate · [open game](https://lichess.org/abcd1234)\nAwaiting Lichess analysis: request a computer analysis on lichess.org, then sync.\n${SUMMARY_END}`);
		expect(firstGameBlock(note)?.trim()).toBe(r.pgn);
		expect(note.trimEnd().endsWith("## My review")).toBe(true);
	});

	it("summary after analysis", () => {
		const s = renderSummary({
			site: "otb",
			"time-class": "rapid",
			"time-control": "10+5",
			result: "0-1",
			termination: "resignation",
			url: "https://example.org/game/1",
			"analysis-status": "done",
			"my-inaccuracies": 3,
			"my-mistakes": 1,
			"my-blunders": 0,
			"my-acpl": 31,
		});
		expect(s).toBe("Rapid 10+5 · OTB · 0-1 by resignation · [open game](https://example.org/game/1)\nMy mistakes: 3 inaccuracies, 1 mistake, 0 blunders · ACPL 31");
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
});

describe("Lichess analysis", () => {
	const analysed = (colour: "white" | "black" = "white") => {
		const n = normaliseLichess(lichessGame("anal1234", Date.parse("2026-10-04T18:22:10Z"), LICHESS_ANALYSIS) as never, colour === "white" ? "ethem" : "opp");
		if (!n.ok) throw new Error("bad fixture");
		return n.record;
	};

	it("an unanalysed Lichess game is awaiting", () => {
		const r = record();
		expect(r.siteAnalysis).toBe("awaiting");
		expect(siteAnalysisFrontmatter(r)).toEqual({ "analysis-status": "awaiting" });
		expect(newNoteFrontmatter(r, "none")["analysis-status"]).toBe("awaiting");
		expect(renderSummary(newNoteFrontmatter(r, "none"))).toContain("Awaiting Lichess analysis");
	});

	it("takes Lichess's counts for my side and the opponent's", () => {
		expect(siteAnalysisFrontmatter(analysed())).toEqual({
			"analysis-status": "done", engine: "lichess", "my-acpl": 12, "my-inaccuracies": 0, "my-mistakes": 0, "my-blunders": 0, "opp-mistakes": 0, "opp-blunders": 1,
		});
		expect(siteAnalysisFrontmatter(analysed("black"))).toMatchObject({ "my-acpl": 410, "my-inaccuracies": 1, "my-blunders": 1, "opp-blunders": 0 });
		const fm = newNoteFrontmatter(analysed(), "none");
		expect(fm["site-accuracy"]).toBe(96);
		expect(renderSummary(fm)).toContain("· Lichess analysis");
	});

	it("OTB games have no site analysis", () => {
		expect(siteAnalysisFrontmatter({ ...record(), site: "otb", siteAnalysis: undefined })).toBeUndefined();
	});

	it("awaiting never replaces an analysis made on this device; a Lichess analysis always wins", () => {
		const awaiting = { "analysis-status": "awaiting" } as const;
		expect(shouldWriteSiteAnalysis({ "analysis-status": "none" }, awaiting)).toBe(true);
		expect(shouldWriteSiteAnalysis(undefined, awaiting)).toBe(true);
		expect(shouldWriteSiteAnalysis({ "analysis-status": "done", engine: "stockfish-18-lite@1.5s" }, awaiting)).toBe(false);
		expect(shouldWriteSiteAnalysis({ "analysis-status": "queued" }, awaiting)).toBe(false);
		expect(shouldWriteSiteAnalysis({ "analysis-status": "done", engine: "stockfish-18-lite@1.5s" }, siteAnalysisFrontmatter(analysed())!)).toBe(true);
	});

	it("builds the board's analysis: one evaluation per position, Lichess's marks, best lines in UCI", () => {
		const r = analysed();
		if (r.siteAnalysis === "awaiting" || !r.siteAnalysis) throw new Error("expected analysis");
		const a = gameAnalysisFromLichess(r.key, r.pgn, r.siteAnalysis)!;
		expect(a.engine).toBe("lichess");
		expect(a.plies.map((p) => p.ply)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(a.plies[1].score).toEqual({ cp: 25 });
		expect(a.plies[6].score).toEqual({ mate: 1 });
		// After 4.Qxf7# Lichess gives no evaluation: the checkmate is scored from the position.
		expect(a.plies[7].score.cp).toBeGreaterThan(0);
		expect(a.marks).toEqual({ 4: "inaccuracy", 6: "blunder" });
		expect(a.comments?.[6]).toMatch(/g6 was best/);
		// The alternative to 3...Nf6 is shown on the position before it (ply 5).
		expect(a.plies[5].best).toBe("g7g6");
		expect(a.plies[5].pv).toEqual(["g7g6", "h5f3", "g8f6"]);
		expect(a.plies[0].score).toEqual({ cp: 25 });
	});
});
