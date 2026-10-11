/** Background analysis queue: one game at a time, FIFO, persisted so it resumes after a restart. */
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import type { Colour } from "../types";
import { mainline, parseGame } from "../pgn/tree";
import type { Http } from "../sources/http";
import { classifyGame } from "./classify";
import { cloudEval } from "./cloudEval";
import { CLOUD_EVAL_MAX_PLIES, MATE_CP } from "./constants";
import type { AnalysisCache } from "./cache";
import type { EngineService } from "./service";
import { SearchStopped } from "./stockfish";
import type { GameAnalysis, PlyAnalysis } from "./types";
import type { Frontmatter } from "../notes/frontmatter";
import type { AnalysisStatus } from "../types";

export interface QueueState {
	queue: string[];
	paused: boolean;
}

export interface QueueHost {
	state: QueueState;
	save(): Promise<void>;
	engine: EngineService;
	cache: AnalysisCache;
	http: Http;
	engineLabel(): string;
	limits(): { movetimeMs?: number; depth?: number };
	useCloudEval(): boolean;
	canRun(): boolean;
	readGame(key: string): Promise<{ pgn: string; myColour: Colour } | undefined>;
	writeResult(key: string, values: Frontmatter): Promise<void>;
	setStatus(key: string, status: AnalysisStatus): Promise<void>;
	status(text: string | null): void;
	notify(text: string): void;
}

export class GameNotFinishedError extends Error {}

/** Score for a position with no legal moves, White's point of view. */
function terminalScore(fen: string): { cp: number } | undefined {
	const setup = parseFen(fen);
	if (setup.isErr) return undefined;
	const pos = Chess.fromSetup(setup.value);
	if (pos.isErr) return undefined;
	const p = pos.value;
	if (p.isCheckmate()) return { cp: p.turn === "white" ? -MATE_CP : MATE_CP };
	if (p.isStalemate() || p.isInsufficientMaterial()) return { cp: 0 };
	return undefined;
}

export class AnalysisQueue {
	private running = false;
	private cancelled = false;
	private suspended = false; // e.g. app in background on mobile; not persisted
	private current?: string;
	private doneInRun = 0;

	constructor(private host: QueueHost) {}

	get length(): number {
		return this.host.state.queue.length;
	}

	get paused(): boolean {
		return this.host.state.paused;
	}

	get currentKey(): string | undefined {
		return this.current;
	}

	async enqueue(keys: string[], front = false): Promise<number> {
		const q = this.host.state.queue;
		const fresh = keys.filter((k) => k !== this.current);
		const rest = q.filter((k) => !fresh.includes(k));
		const added = fresh.filter((k) => !q.includes(k));
		if (front) {
			// Keep the game being analysed at the head.
			const head = this.current && rest[0] === this.current ? [rest.shift() as string] : [];
			this.host.state.queue = [...head, ...fresh, ...rest];
		} else this.host.state.queue = [...q, ...added];
		await this.host.save();
		for (const k of added) await this.host.setStatus(k, "queued");
		this.kick();
		return added.length;
	}

	async pause(): Promise<void> {
		this.host.state.paused = true;
		await this.host.save();
		this.host.engine.stopBatch();
		this.updateStatus();
	}

	async resume(): Promise<void> {
		this.host.state.paused = false;
		await this.host.save();
		this.kick();
	}

	/** Empty the queue; the current game is marked failed ("cancelled"). */
	async cancel(): Promise<void> {
		const pending = this.host.state.queue.filter((k) => k !== this.current);
		this.host.state.queue = this.current ? [this.current] : [];
		if (this.running) this.cancelled = true;
		this.host.engine.stopBatch();
		await this.host.save();
		for (const k of pending) await this.host.setStatus(k, "none");
	}

	setSuspended(s: boolean): void {
		this.suspended = s;
		if (s) this.host.engine.stopBatch();
		else this.kick();
	}

	kick(): void {
		if (this.running) return;
		void this.run();
	}

	private shouldStop(): boolean {
		return this.cancelled || this.host.state.paused || this.suspended || !this.host.canRun();
	}

	private updateStatus(): void {
		const n = this.host.state.queue.length;
		if (!n) return this.host.status(null);
		if (!this.running || this.shouldStop()) {
			const why = this.host.state.paused ? "paused" : "waiting";
			return this.host.status(`Analysis ${why}: ${n} game${n === 1 ? "" : "s"} queued`);
		}
		const total = this.doneInRun + n;
		this.host.status(`Analysing ${Math.min(this.doneInRun + 1, total)} of ${total} games`);
	}

	private async run(): Promise<void> {
		this.running = true;
		this.doneInRun = 0;
		try {
			if (this.host.state.queue.length && !this.shouldStop() && !(await this.host.engine.installed())) {
				// Leave the queue as it is; it resumes once the engine is downloaded.
				this.host.notify("analysis is waiting for the engine. Run “Download engine”.");
				return;
			}
			while (this.host.state.queue.length && !this.shouldStop()) {
				const key = this.host.state.queue[0];
				this.current = key;
				this.updateStatus();
				try {
					await this.analyse(key);
					this.doneInRun++;
				} catch (e) {
					if (e instanceof SearchStopped && !this.cancelled) {
						// Paused or suspended: leave the game at the head of the queue.
						await this.host.setStatus(key, "queued");
						break;
					}
					const reason = this.cancelled ? "cancelled" : (e as Error).message;
					await this.host.setStatus(key, "failed");
					if (!this.cancelled) this.host.notify(`Analysis of ${key} failed: ${reason}`);
				}
				this.host.state.queue = this.host.state.queue.filter((k) => k !== key);
				await this.host.save();
				if (this.cancelled) {
					this.cancelled = false;
					this.host.notify("Analysis cancelled.");
				}
			}
		} finally {
			this.current = undefined;
			this.running = false;
			this.cancelled = false;
			this.updateStatus();
		}
	}

	private async analyse(key: string): Promise<void> {
		const game = await this.host.readGame(key);
		if (!game) throw new Error("the game note was not found");
		const parsed = parseGame(game.pgn);
		const result = parsed.headers.get("Result");
		// Fair play: never analyse a game without a final result.
		if (result !== "1-0" && result !== "0-1" && result !== "1/2-1/2") {
			throw new GameNotFinishedError("the game has no final result");
		}
		await this.host.setStatus(key, "running");
		const plies = mainline(parsed);
		const out: PlyAnalysis[] = [];
		let cloud = this.host.useCloudEval();
		const limits = this.host.limits();
		let engineReady = false;
		const total = plies.length;
		for (let i = 0; i < plies.length; i++) {
			if (this.shouldStop()) throw new SearchStopped("stopped");
			const p = plies[i];
			this.host.status(`Analysing ${this.doneInRun + 1} of ${this.doneInRun + this.host.state.queue.length} games · move ${Math.ceil(i / 2)}/${Math.ceil((total - 1) / 2)}`);
			const term = terminalScore(p.fen);
			if (term) {
				out.push({ ply: i, fen: p.fen, score: term, best: "", pv: [], depth: 0, source: "local" });
				continue;
			}
			if (cloud && i < CLOUD_EVAL_MAX_PLIES) {
				let c: PlyAnalysis | undefined;
				try {
					c = await cloudEval(this.host.http, p.fen, i);
				} catch {
					c = undefined;
				}
				if (c) {
					out.push(c);
					continue;
				}
				cloud = false; // first miss: switch to local analysis for the rest
			}
			if (!engineReady) {
				await this.host.engine.newGame();
				engineReady = true;
			}
			const r = await this.host.engine.batchSearch(p.fen, limits, () => this.shouldStop());
			const best = r.lines[0];
			out.push({
				ply: i,
				fen: p.fen,
				score: best?.score ?? { cp: 0 },
				best: r.bestmove,
				pv: (best?.pv ?? []).slice(0, 8),
				depth: best?.depth ?? 0,
				source: "local",
			});
		}
		const analysis: GameAnalysis = { key, engine: this.host.engineLabel(), createdAt: new Date().toISOString(), plies: out };
		await this.host.cache.set(analysis);
		const startTurn: Colour = plies[0].pos.turn;
		const marks = classifyGame(out, plies.slice(1).map((p) => p.uci as string), startTurn);
		const me = marks[game.myColour];
		const opp = marks[game.myColour === "white" ? "black" : "white"];
		await this.host.writeResult(key, {
			"analysis-status": "done",
			engine: analysis.engine,
			"my-acpl": me.acpl ?? null,
			"my-inaccuracies": me.inaccuracies,
			"my-mistakes": me.mistakes,
			"my-blunders": me.blunders,
			"opp-mistakes": opp.mistakes,
			"opp-blunders": opp.blunders,
		});
	}
}
