import { describe, expect, it } from "vitest";
import { parseInfo } from "../src/engine/stockfish";
import { ENGINE_FILES, HashMismatchError, sha256Hex, verify } from "../src/engine/engineFiles";
import { cacheFileName } from "../src/engine/cache";

describe("UCI info parsing", () => {
	it("converts scores to White's point of view", () => {
		const l = parseInfo("info depth 18 seldepth 24 multipv 1 score cp 35 nodes 1 nps 1 pv e7e5 g1f3", false);
		expect(l).toEqual({ depth: 18, multipv: 1, score: { cp: -35 }, pv: ["e7e5", "g1f3"] });
		expect(parseInfo("info depth 20 multipv 2 score mate 3 pv d1h5", true)?.score).toEqual({ mate: 3 });
		expect(parseInfo("info depth 20 multipv 2 score mate 3 pv d1h5", false)?.score).toEqual({ mate: -3 });
	});
	it("ignores bound and pv-less lines", () => {
		expect(parseInfo("info depth 10 score cp 20 lowerbound pv e2e4", true)).toBeUndefined();
		expect(parseInfo("info depth 10 currmove e2e4 currmovenumber 1", true)).toBeUndefined();
		expect(parseInfo("info string NNUE evaluation enabled", true)).toBeUndefined();
	});
});

describe("engine download verification", () => {
	it("computes SHA-256", async () => {
		const buf = new TextEncoder().encode("abc").buffer as ArrayBuffer;
		expect(await sha256Hex(buf)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
	it("rejects a bad hash", async () => {
		const buf = new TextEncoder().encode("not stockfish").buffer as ArrayBuffer;
		await expect(verify(ENGINE_FILES[0], buf)).rejects.toBeInstanceOf(HashMismatchError);
	});
});

describe("analysis cache", () => {
	it("uses file-system-safe names", () => {
		expect(cacheFileName("lichess:abcd1234")).toBe("lichess_abcd1234.json");
		expect(cacheFileName("chesscom:1a2b-3c")).toBe("chesscom_1a2b-3c.json");
	});
});
