/** Clock statistics read from a PGN's %clk times. No engine involved. */
import type { ClockStats, Colour } from "../types";
import { commentOf, mainline, parseGame, parseTimeControl, timeSpent } from "../pgn/tree";
import { CLOCK_CHECKPOINTS, inTimeTrouble } from "../dashboard/definitions";

export function clockStats(pgn: string, myColour: Colour, daily: boolean): ClockStats | undefined {
	let game;
	try {
		game = parseGame(pgn);
	} catch {
		return undefined;
	}
	const plies = mainline(game);
	if (plies.length < 2) return undefined;
	const startWhite = plies[0].pos.turn === "white";
	const mine = (i: number) => (((i - 1) % 2 === 0) === startWhite) === (myColour === "white");
	const myClocks: number[] = [];
	const oppClocks: number[] = [];
	for (let i = 1; i < plies.length; i++) {
		const node = plies[i].node;
		const c = node ? commentOf(node, game).clock : undefined;
		if (c === undefined) continue;
		if (mine(i)) myClocks.push(c);
		else oppClocks.push(c);
	}
	if (!myClocks.length) return undefined;
	const tc = parseTimeControl(game.headers.get("TimeControl"));
	let first10: number | null = null;
	let longest: number | null = null;
	let longestMove: number | null = null;
	if (!daily) {
		const spent = timeSpent(game);
		const mineSpent: number[] = [];
		let moveNo = 0;
		for (let i = 1; i < plies.length; i++) {
			if (!mine(i)) continue;
			moveNo++;
			const s = spent.get(i);
			if (s === undefined) continue;
			if (mineSpent.length < 10 && mineSpent.length === moveNo - 1) mineSpent.push(s);
			if (longest === null || s > longest) {
				longest = Math.round(s);
				longestMove = moveNo;
			}
		}
		if (mineSpent.length === 10) first10 = Math.round(mineSpent.reduce((a, b) => a + b, 0));
	}
	// Clock left after move 10, 20, 30, 40, as % of base time (live games with a known base only).
	const curve = (clocks: number[]) =>
		daily || !tc?.base ? [] : CLOCK_CHECKPOINTS.filter((m) => clocks.length >= m).map((m) => Math.round((clocks[m - 1] / tc.base) * 100));
	return {
		timeTrouble: inTimeTrouble(myClocks, tc?.base, daily),
		first10Seconds: first10,
		oppTimeTrouble: inTimeTrouble(oppClocks, tc?.base, daily),
		clockCurve: curve(myClocks),
		oppClockCurve: curve(oppClocks),
		longestThink: longest,
		longestThinkMove: longestMove,
	};
}
