import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { draftOtb, matchMyColour, normaliseOtb, otbKey, setPgnTags } from "../src/sources/normalise";
import { importPgnText } from "../src/sources/pgnFile";
import { splitPgnGames } from "../src/pgn/tree";
import { MemorySink } from "./helpers";

const otb = readFileSync(new URL("./fixtures/otb.pgn", import.meta.url), "utf8");

describe("OTB import", () => {
	it("matches my colour from My OTB names in either name order", () => {
		expect(matchMyColour("Ethem Gur", "Demir, Can", ["Gur, Ethem"])).toBe("white");
		expect(matchMyColour("Yilmaz, Ece", "Ethem Gur", ["ethem gur"])).toBe("black");
		expect(matchMyColour("A", "B", ["C"])).toBeUndefined();
	});

	it("key is stable and independent of comments and whitespace", async () => {
		const [g1] = splitPgnGames(otb);
		const k1 = await otbKey(g1);
		const k2 = await otbKey(g1.replace("1. d4 Nf6", "1. d4  { a comment }\n Nf6"));
		expect(k1).toMatch(/^otb:[0-9a-f]{40}$/);
		expect(k2).toBe(k1);
	});

	it("imports a multi-game file as separate notes, and twice creates no duplicates", async () => {
		const sink = new MemorySink();
		const host = { app: {} as never, myNames: () => ["Ethem Gur"], upsert: (r: never) => sink.upsert(r), onCreated: () => undefined };
		const first = await importPgnText(host, otb);
		expect(first.created).toBe(2);
		const recs = [...sink.notes.values()];
		expect(recs.map((r) => r.myColour)).toEqual(["white", "black"]);
		expect(recs.map((r) => r.myResult)).toEqual(["win", "win"]);
		expect(recs[0].event).toBe("Spring Open");
		expect(recs[0].round).toBe("5");
		expect(recs[0].playedAt).toBe("2026-04-02T00:00:00Z");
		const second = await importPgnText(host, otb);
		expect(second.created).toBe(0);
		expect(second.unchanged).toBe(2);
		expect(sink.notes.size).toBe(2);
	});

	it("refuses unfinished games and fills tags", async () => {
		const pgn = '[White "x"]\n[Black "y"]\n[Result "*"]\n\n1. e4 *';
		expect((await normaliseOtb(pgn, "white")).ok).toBe(false);
		const filled = setPgnTags(pgn, { Event: "Club", Result: "1-0" });
		expect(filled).toContain('[Event "Club"]');
		expect(filled).toContain('[Result "1-0"]');
		expect(draftOtb(filled, ["x"]).myColour).toBe("white");
	});
});
