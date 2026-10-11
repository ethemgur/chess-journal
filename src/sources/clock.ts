/** Clock statistics read from a PGN's %clk times. No engine involved. */
import type { ClockStats, Colour } from "../types";
import { commentOf, mainline, parseGame, parseTimeControl, timeSpent } from "../pgn/tree";
import { inTimeTrouble } from "../dashboard/definitions";

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
	for (let i = 1; i < plies.length; i++) {
		const node = plies[i].node;
		const c = node ? commentOf(node, game).clock : undefined;
		if (c !== undefined && mine(i)) myClocks.push(c);
	}
	if (!myClocks.length) return undefined;
	const tc = parseTimeControl(game.headers.get("TimeControl"));
	let first10: number | null = null;
	if (!daily) {
		const spent = timeSpent(game);
		const mineSpent: number[] = [];
		for (let i = 1; i < plies.length && mineSpent.length < 10; i++) {
			if (!mine(i)) continue;
			const s = spent.get(i);
			if (s === undefined) break;
			mineSpent.push(s);
		}
		if (mineSpent.length === 10) first10 = Math.round(mineSpent.reduce((a, b) => a + b, 0));
	}
	return { timeTrouble: inTimeTrouble(myClocks, tc?.base, daily), first10Seconds: first10 };
}
