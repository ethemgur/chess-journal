/**
 * One shared engine for the board (interactive) and the queue (batch).
 * Interactive analysis always pre-empts the queue; the queue then retries the
 * same position.
 */
import { EngineFiles } from "./engineFiles";
import { SearchLimits, SearchResult, SearchStopped, StockfishEngine } from "./stockfish";
import type { EngineLine } from "./types";

export class EngineNotInstalledError extends Error {
	constructor() {
		super("The Stockfish engine is not downloaded yet. Run “Download engine” first.");
	}
}

export interface InteractiveHandle {
	stop(): void;
	done: Promise<SearchResult | undefined>;
}

export class EngineService {
	private engine?: StockfishEngine;
	private starting?: Promise<StockfishEngine>;
	private interactiveCount = 0;
	private idleWaiters: Array<() => void> = [];
	private batchRunning = false;

	constructor(private files: EngineFiles, private hashMb: () => number) {}

	async installed(): Promise<boolean> {
		return this.files.installed();
	}

	private async get(): Promise<StockfishEngine> {
		if (this.engine) return this.engine;
		if (!this.starting) {
			this.starting = (async () => {
				if (!(await this.files.installed())) throw new EngineNotInstalledError();
				const e = new StockfishEngine(await this.files.load(), this.hashMb());
				await e.start();
				this.engine = e;
				return e;
			})();
			this.starting.catch(() => (this.starting = undefined));
		}
		return this.starting;
	}

	async newGame(): Promise<void> {
		await (await this.get()).newGame();
	}

	private waitInteractiveIdle(): Promise<void> {
		if (this.interactiveCount === 0) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}

	/** Batch search: waits while the board is analysing and retries if pre-empted. */
	async batchSearch(fen: string, limits: SearchLimits, isCancelled: () => boolean): Promise<SearchResult> {
		const engine = await this.get();
		for (;;) {
			await this.waitInteractiveIdle();
			if (isCancelled()) throw new SearchStopped("cancelled");
			this.batchRunning = true;
			try {
				return await engine.search(fen, { ...limits, multiPv: 1 });
			} catch (e) {
				if (!(e instanceof SearchStopped) || this.interactiveCount === 0) throw e;
				// Pre-empted by interactive analysis: wait, then retry this position.
			} finally {
				this.batchRunning = false;
			}
		}
	}

	/** Stop whatever batch search is running (used by cancel/pause). */
	stopBatch(): void {
		if (this.batchRunning) this.engine?.stop();
	}

	/** Interactive analysis of the position on screen: up to 3 lines, until stopped. */
	interactive(
		fen: string,
		onInfo: (lines: EngineLine[]) => void,
		limits: { movetimeMs: number; multiPv: number } = { movetimeMs: 12_000, multiPv: 3 },
	): InteractiveHandle {
		this.interactiveCount++;
		let stopped = false;
		let finished = false;
		let release = () => {
			release = () => undefined;
			this.interactiveCount--;
			if (this.interactiveCount === 0) {
				const w = this.idleWaiters;
				this.idleWaiters = [];
				w.forEach((f) => f());
			}
		};
		const done = (async () => {
			try {
				const engine = await this.get();
				if (this.batchRunning) engine.stop();
				if (stopped) return undefined;
				return await engine.search(fen, limits, onInfo);
			} catch (e) {
				if (e instanceof SearchStopped) return undefined;
				throw e;
			} finally {
				finished = true;
				release();
			}
		})();
		return {
			done,
			stop: () => {
				// Never stop a search this handle does not own any more.
				if (stopped || finished) return;
				stopped = true;
				this.engine?.stop();
			},
		};
	}

	terminate(): void {
		this.engine?.terminate();
		this.engine = undefined;
		this.starting = undefined;
	}
}
