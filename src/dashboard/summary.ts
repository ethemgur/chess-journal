/**
 * Per-game analysis summary: computed once after engine analysis (and again when
 * DERIVED_VERSION or the winning threshold changes) from the PGN and the cached
 * analysis, without re-running the engine. Stored in summaries.json.
 */
import type { Position } from "chessops/chess";
import { judgeMove } from "../engine/classify";
import type { GameAnalysis, Score } from "../engine/types";
import { commentOf, mainline, parseGame, parseTimeControl, timeSpent } from "../pgn/tree";
import type { Colour } from "../types";
import {
	DEFAULT_WINNING_CP,
	EVAL_CLAMP_CP,
	Material,
	MarkKind,
	MyResult,
	Phase,
	endgameStartPly,
	inTimeTrouble,
	nonPawnMaterial,
	phaseOfPly,
	reachedWinningLosing,
	timeTroubleThreshold,
} from "./definitions";

/** Bump when the way summaries are derived changes; they are rebuilt from the cache. */
export const DERIVED_VERSION = 1;

export interface PhaseCounts {
	opening: number;
	middlegame: number;
	endgame: number;
}

export interface SummaryMark {
	ply: number;
	side: "me" | "opp";
	kind: MarkKind;
	deltaW: number;
	phase: Phase;
	clockSec?: number;
	underPressure?: boolean;
	/** My-side evaluation before and after the move, clamped to ±1000 cp. */
	evalBeforeCp: number;
	evalAfterCp: number;
}

export interface GameSummary {
	derivedVersion: number;
	engine: string;
	myMoves: number;
	myMovesByPhase: PhaseCounts;
	oppMovesByPhase: PhaseCounts;
	marks: SummaryMark[];
	myAcpl: number;
	myPeakEvalCp: number;
	myLowEvalCp: number;
	myEvalAfterMove15Cp: number | null;
	reachedWinning: boolean;
	reachedLosing: boolean;
	peakPly: number | null;
	hasClocks: boolean;
	timeTrouble: boolean | null;
	secondsOnFirst10Moves: number | null;
	lostOnTime: boolean;
	biggestSwing: { ply: number; deltaW: number } | null;
	/** Moves I made with my clock below the time-trouble level (for the error rate under pressure). */
	myMovesUnderPressure: number | null;
}

export interface SummaryInput {
	pgn: string;
	analysis: GameAnalysis;
	myColour: Colour;
	myResult: MyResult;
	termination?: string;
	daily: boolean;
	winningCp?: number;
}

const clampCp = (cp: number) => Math.max(-EVAL_CLAMP_CP, Math.min(EVAL_CLAMP_CP, cp));

function scoreCp(s: Score): number {
	if (s.mate !== undefined) return s.mate > 0 ? 10_000 : s.mate < 0 ? -10_000 : 0;
	return s.cp ?? 0;
}

function material(pos: Position): Material {
	const side = (c: "white" | "black") => {
		const own = pos.board[c];
		return nonPawnMaterial({
			queen: pos.board.queen.intersect(own).size(),
			rook: pos.board.rook.intersect(own).size(),
			bishop: pos.board.bishop.intersect(own).size(),
			knight: pos.board.knight.intersect(own).size(),
		});
	};
	return { white: side("white"), black: side("black") };
}

const emptyPhases = (): PhaseCounts => ({ opening: 0, middlegame: 0, endgame: 0 });

export function computeSummary(input: SummaryInput): GameSummary {
	const winningCp = input.winningCp ?? DEFAULT_WINNING_CP;
	const game = parseGame(input.pgn);
	const plies = mainline(game);
	const startWhite = plies[0].pos.turn === "white";
	const mover = (i: number): Colour => (((i - 1) % 2 === 0) === startWhite ? "white" : "black");
	const sign = input.myColour === "white" ? 1 : -1;
	const myCp = (s: Score) => clampCp(sign * scoreCp(s));
	const endgameStart = endgameStartPly(plies.map((p) => material(p.pos)));
	const byPly = new Map(input.analysis.plies.map((p) => [p.ply, p]));

	// Clocks.
	const tc = parseTimeControl(game.headers.get("TimeControl"));
	const clockAt = new Map<number, number>();
	for (let i = 1; i < plies.length; i++) {
		const node = plies[i].node;
		const c = node ? commentOf(node, game).clock : undefined;
		if (c !== undefined) clockAt.set(i, c);
	}
	const hasClocks = clockAt.size > 0;
	const pressureLevel = tc && !input.daily ? timeTroubleThreshold(tc.base) : undefined;

	const myMovesByPhase = emptyPhases();
	const oppMovesByPhase = emptyPhases();
	const marks: SummaryMark[] = [];
	let myMoves = 0;
	let lossSum = 0;
	let lossN = 0;
	let biggest: { ply: number; deltaW: number } | null = null;
	let underPressureMoves = 0;
	const myClocksAfter: number[] = [];
	const evalsAfterMyMoves: number[] = [];
	let lastMyClock = tc?.base;

	for (let i = 1; i < plies.length; i++) {
		const side = mover(i) === input.myColour ? "me" : "opp";
		const phase = phaseOfPly(i, endgameStart);
		if (side === "me") {
			myMoves++;
			myMovesByPhase[phase]++;
		} else oppMovesByPhase[phase]++;

		// Clock before my move = clock after my previous move (base time for the first).
		let underPressure: boolean | undefined;
		const clock = clockAt.get(i);
		if (side === "me") {
			if (pressureLevel !== undefined && lastMyClock !== undefined && hasClocks) {
				underPressure = lastMyClock < pressureLevel;
				if (underPressure) underPressureMoves++;
			}
			if (clock !== undefined) {
				myClocksAfter.push(clock);
				lastMyClock = clock;
			}
		}

		const before = byPly.get(i - 1);
		const after = byPly.get(i);
		if (!before || !after) continue;
		if (side === "me") evalsAfterMyMoves.push(myCp(after.score));
		const j = judgeMove(before.score, after.score, mover(i), plies[i].uci ?? "", before.best);
		if (side === "me") {
			lossSum += j.cpLoss;
			lossN++;
			if (j.delta > 0 && (!biggest || j.delta > biggest.deltaW)) biggest = { ply: i, deltaW: j.delta };
		}
		if (j.mark) {
			marks.push({
				ply: i,
				side,
				kind: j.mark,
				deltaW: j.delta,
				phase,
				clockSec: clock,
				underPressure: side === "me" ? underPressure : undefined,
				evalBeforeCp: myCp(before.score),
				evalAfterCp: myCp(after.score),
			});
		}
	}

	// Peak and low evaluation from my side (positions after ply 1 onwards).
	let peak = -Infinity;
	let low = Infinity;
	let peakPly: number | null = null;
	for (const p of input.analysis.plies) {
		if (p.ply < 1) continue;
		const v = myCp(p.score);
		if (v > peak) {
			peak = v;
			peakPly = p.ply;
		}
		if (v < low) low = v;
	}
	const after15 = byPly.get(30);
	const wl = reachedWinningLosing(evalsAfterMyMoves, winningCp);

	// Seconds on my first 10 moves, from consecutive clocks plus increment.
	let first10: number | null = null;
	if (hasClocks && !input.daily) {
		const spent = timeSpent(game);
		const mine: number[] = [];
		for (let i = 1; i < plies.length && mine.length < 10; i++) {
			if (mover(i) !== input.myColour) continue;
			const s = spent.get(i);
			if (s === undefined) break;
			mine.push(s);
		}
		if (mine.length === 10) first10 = Math.round(mine.reduce((a, b) => a + b, 0));
	}

	return {
		derivedVersion: DERIVED_VERSION,
		engine: input.analysis.engine,
		myMoves,
		myMovesByPhase,
		oppMovesByPhase,
		marks,
		myAcpl: lossN ? Math.round(lossSum / lossN) : 0,
		myPeakEvalCp: Number.isFinite(peak) ? peak : 0,
		myLowEvalCp: Number.isFinite(low) ? low : 0,
		myEvalAfterMove15Cp: after15 ? myCp(after15.score) : null,
		reachedWinning: wl.winning,
		reachedLosing: wl.losing,
		peakPly,
		hasClocks,
		timeTrouble: hasClocks ? inTimeTrouble(myClocksAfter, tc?.base, input.daily) : null,
		secondsOnFirst10Moves: first10,
		lostOnTime: input.myResult === "loss" && /time/i.test(input.termination ?? ""),
		biggestSwing: biggest,
		myMovesUnderPressure: hasClocks && pressureLevel !== undefined ? underPressureMoves : null,
	};
}

/* ------------------------------------------------------------------ */
/* summaries.json                                                       */
/* ------------------------------------------------------------------ */

export interface SummaryFile {
	derivedVersion: number;
	winningCp: number;
	games: Record<string, GameSummary>;
}

export interface SummaryStorage {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

export class SummaryStore {
	private data: SummaryFile = { derivedVersion: DERIVED_VERSION, winningCp: DEFAULT_WINNING_CP, games: {} };
	private loaded = false;
	private writeTimer?: number;
	private listeners = new Set<() => void>();

	constructor(private storage: SummaryStorage, private path: string) {}

	async load(): Promise<void> {
		try {
			if (await this.storage.exists(this.path)) this.data = JSON.parse(await this.storage.read(this.path)) as SummaryFile;
		} catch {
			// A damaged file is rebuilt from the analysis cache.
		}
		this.data.games ??= {};
		this.loaded = true;
	}

	get isLoaded(): boolean {
		return this.loaded;
	}

	/** Summaries must be rebuilt when the derivation or the winning threshold changed. */
	isCurrent(key: string, winningCp: number): boolean {
		const s = this.data.games[key];
		return !!s && s.derivedVersion === DERIVED_VERSION && this.data.winningCp === winningCp;
	}

	needsFullRebuild(winningCp: number): boolean {
		return this.data.derivedVersion !== DERIVED_VERSION || this.data.winningCp !== winningCp;
	}

	resetFor(winningCp: number): void {
		this.data = { derivedVersion: DERIVED_VERSION, winningCp, games: {} };
	}

	get(key: string): GameSummary | undefined {
		return this.data.games[key];
	}

	all(): Record<string, GameSummary> {
		return this.data.games;
	}

	set(key: string, s: GameSummary): void {
		this.data.games[key] = s;
		this.scheduleWrite();
	}

	remove(key: string): void {
		if (!(key in this.data.games)) return;
		delete this.data.games[key];
		this.scheduleWrite();
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private scheduleWrite(): void {
		for (const l of this.listeners) l();
		if (typeof window === "undefined") return;
		window.clearTimeout(this.writeTimer);
		this.writeTimer = window.setTimeout(() => void this.flush(), 1000);
	}

	async flush(): Promise<void> {
		if (typeof window !== "undefined") window.clearTimeout(this.writeTimer);
		await this.storage.write(this.path, JSON.stringify(this.data));
	}
}
