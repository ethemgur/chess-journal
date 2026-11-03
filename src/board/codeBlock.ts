/** ```chess-game``` processor: renders a lazy BoardView per block and writes edits back into that block only. */
import { MarkdownPostProcessorContext, MarkdownRenderChild, TFile } from "obsidian";
import type ChessJournalPlugin from "../main";
import { CODE_LANG, findGameBlock, replaceBlockBody } from "../notes/noteWriter";
import { PgnParseError, pgnHash } from "../pgn/tree";
import { matchMyColour, pgnTags } from "../sources/normalise";
import type { Colour } from "../types";
import { BlockState, BoardHost, BoardView, newBlockState } from "./BoardView";

/** Block state survives re-renders (e.g. after our own write-back). */
const blockStates = new Map<string, BlockState>();

/**
 * Boards on screen. When a block is re-rendered because the note changed (our own
 * write-back, a frontmatter update from analysis or sync, typing elsewhere in the
 * note), the new block takes over the existing board instead of building a new
 * one, so the board never flashes. Matching is by note and game text, because a
 * fresh block often cannot tell its position yet. Every board is registered, so
 * a board that was built anew can still be taken over by the next re-render.
 */
interface LiveBoard {
	view: BoardView;
	owner: ChessGameBlock;
	key: string;
	sourcePath: string;
	destroyTimer?: number;
}
const liveBoards = new Set<LiveBoard>();
const ADOPT_GRACE_MS = 3000;
/** How long a new block that is on the page waits for a board shown in another view (Reading view vs editor) to leave. */
const ADOPT_OTHER_VIEW_FRAMES = 5;
/** Give up waiting for a block that never reaches the page. */
const ADOPT_MAX_WAIT_MS = 10_000;

export function registerChessGameBlock(plugin: ChessJournalPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor(CODE_LANG, (source, el, ctx) => {
		ctx.addChild(new ChessGameBlock(plugin, source, el, ctx));
	});
}

export function clearBlockStates(): void {
	for (const live of liveBoards) {
		window.clearTimeout(live.destroyTimer);
		live.view.destroy();
	}
	liveBoards.clear();
	blockStates.clear();
}

/** Both elements are in the same pane and the same mode (Reading view vs editor). */
function sameView(a: HTMLElement, b: HTMLElement): boolean {
	const leaf = (e: HTMLElement) => e.closest(".workspace-leaf");
	const reading = (e: HTMLElement) => !!e.closest(".markdown-reading-view, .markdown-preview-view");
	return leaf(a) === leaf(b) && reading(a) === reading(b);
}

class ChessGameBlock extends MarkdownRenderChild {
	private view?: BoardView;
	private observer?: IntersectionObserver;
	private stopWaiting?: () => void;
	private source: string;
	private key?: string;
	unloaded = false;

	constructor(private plugin: ChessJournalPlugin, source: string, el: HTMLElement, private ctx: MarkdownPostProcessorContext) {
		super(el);
		this.source = source;
	}

	onload(): void {
		this.containerEl.addClass("cr-block");
		const candidate = this.findAdoptable();
		if (candidate) {
			// Hold the board's height while we wait, so the note does not jump.
			this.containerEl.style.minHeight = `${candidate.view.height()}px`;
			this.waitAndAdopt(candidate);
			return;
		}
		this.startNormally();
	}

	/**
	 * A board for the same note showing exactly this game text, owned by another block.
	 * Prefer one whose block has left the page or sits in this block's view.
	 */
	private findAdoptable(): LiveBoard | undefined {
		const hash = pgnHash(this.source);
		let best: LiveBoard | undefined;
		let bestScore = -1;
		for (const live of liveBoards) {
			if (live.sourcePath !== this.ctx.sourcePath || live.owner === this || !live.view.ownsText(hash)) continue;
			const gone = live.owner.unloaded || !live.owner.containerEl.isConnected;
			const score = gone ? 2 : this.containerEl.isConnected && sameView(live.owner.containerEl, this.containerEl) ? 1 : 0;
			if (score > bestScore) {
				best = live;
				bestScore = score;
			}
		}
		return best;
	}

	/**
	 * Take the board once its old block has left the page, or once both blocks are in the
	 * same view (the old one is about to be removed). A block in another view that stays on
	 * the page keeps its board; then this block builds its own.
	 *
	 * Besides checking every frame, a MutationObserver checks right after each DOM change
	 * (before the browser paints), so the swap never shows an empty block for a frame.
	 */
	private waitAndAdopt(live: LiveBoard): void {
		const owner = live.owner;
		const started = Date.now();
		let otherViewFrames = 0;
		let raf = 0;
		let done = false;
		const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(() => check()) : undefined;
		const finish = () => {
			done = true;
			mo?.disconnect();
			window.cancelAnimationFrame(raf);
			this.stopWaiting = undefined;
			this.containerEl.style.minHeight = "";
		};
		const check = (fromFrame = false) => {
			if (done) return;
			if (this.unloaded) return finish();
			if (!liveBoards.has(live) || live.owner !== owner) {
				// Destroyed meanwhile, or another block took it (never steal it back): build our own.
				finish();
				this.startNormally();
				return;
			}
			const ownerGone = owner.unloaded || !owner.containerEl.isConnected;
			const here = this.containerEl.isConnected;
			if (ownerGone || (here && sameView(owner.containerEl, this.containerEl))) {
				finish();
				this.adopt(live);
				return;
			}
			if (fromFrame && here && ++otherViewFrames >= ADOPT_OTHER_VIEW_FRAMES) {
				finish();
				this.startNormally();
				return;
			}
			if (Date.now() - started > ADOPT_MAX_WAIT_MS) {
				finish();
				this.startNormally();
			}
		};
		const frame = () => {
			check(true);
			if (!done) raf = window.requestAnimationFrame(frame);
		};
		this.stopWaiting = finish;
		check();
		if (done) return;
		mo?.observe(document.body, { childList: true, subtree: true });
		raf = window.requestAnimationFrame(frame);
	}

	private adopt(live: LiveBoard): void {
		window.clearTimeout(live.destroyTimer);
		live.destroyTimer = undefined;
		const previous = live.owner;
		live.owner = this;
		this.key = live.key;
		this.view = live.view;
		// The previous block no longer owns the board; make sure it will not destroy it.
		previous.release(live.view);
		let state = blockStates.get(live.key);
		if (!state) {
			state = newBlockState();
			blockStates.set(live.key, state);
		}
		this.view.adopt(this.containerEl, this.makeHost(state));
	}

	/** Forget a board that another block has taken over. */
	release(view: BoardView): void {
		if (this.view === view) this.view = undefined;
	}

	private startNormally(): void {
		// A block that was already shown (e.g. re-rendered) renders at once, without a placeholder.
		if (blockStates.get(this.stateKey())?.rendered) {
			this.renderBoard();
			return;
		}
		const placeholder = this.containerEl.createDiv({ cls: "cr-placeholder" });
		// Boards render lazily when scrolled into view.
		if (typeof IntersectionObserver === "undefined") {
			placeholder.remove();
			this.renderBoard();
			return;
		}
		this.observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) {
				this.observer?.disconnect();
				this.observer = undefined;
				placeholder.remove();
				this.renderBoard();
			}
		}, { rootMargin: "200px" });
		this.observer.observe(this.containerEl);
	}

	onunload(): void {
		this.unloaded = true;
		this.stopWaiting?.();
		this.observer?.disconnect();
		const view = this.view;
		this.view = undefined;
		if (!view) return;
		const live = [...liveBoards].find((l) => l.view === view && l.owner === this);
		if (!live) {
			view.destroy();
			return;
		}
		// Keep the board alive briefly in case the re-rendered block takes it over.
		live.destroyTimer = window.setTimeout(() => {
			if (live.owner !== this) return;
			liveBoards.delete(live);
			live.view.destroy();
		}, ADOPT_GRACE_MS);
	}

	private stateKey(): string {
		const info = this.ctx.getSectionInfo(this.containerEl);
		if (info) {
			const before = info.text.split("\n").slice(0, info.lineStart);
			const index = before.filter((l) => new RegExp("^\\s*(`{3,}|~{3,})" + CODE_LANG).test(l)).length;
			return `${this.ctx.sourcePath}::${index}`;
		}
		return `${this.ctx.sourcePath}::${pgnHash(this.source)}`;
	}

	private frontmatter(): Record<string, unknown> | undefined {
		const f = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		return f instanceof TFile ? this.plugin.app.metadataCache.getFileCache(f)?.frontmatter : undefined;
	}

	private myColour(fm?: Record<string, unknown>): Colour | undefined {
		const c = fm?.["my-colour"];
		if (c === "white" || c === "black") return c;
		const s = this.plugin.settings;
		const tags = pgnTags(this.source);
		const names = [s.lichessUsername, ...s.otbNames.split(",")].map((x) => x.trim()).filter(Boolean);
		return matchMyColour(tags.get("White") ?? "", tags.get("Black") ?? "", names);
	}

	private makeHost(state: BlockState): BoardHost {
		const fm = this.frontmatter();
		const gameKey = typeof fm?.["game-key"] === "string" ? (fm["game-key"] as string) : undefined;
		const plugin = this.plugin;
		return {
			app: plugin.app,
			settings: () => plugin.settings,
			engine: plugin.engine,
			gameKey,
			myColour: this.myColour(fm),
			state,
			loadAnalysis: async () => (gameKey ? plugin.cache.get(gameKey) : undefined),
			onAnalysisChange: (fn) => plugin.cache.onChange((k) => k === gameKey && fn()),
			save: (pgn, expected) => this.save(pgn, expected, gameKey),
			askDownloadEngine: () => plugin.confirmEngineDownload(),
			setActive: (v) => plugin.setActiveBoard(v),
			onGoto: gameKey ? (fn) => plugin.subscribeGoto(gameKey, fn) : undefined,
		};
	}

	private renderBoard(): void {
		const key = this.stateKey();
		this.key = key;
		let state = blockStates.get(key);
		if (!state) {
			state = newBlockState();
			blockStates.set(key, state);
		}
		for (const old of liveBoards) {
			if (old.key === key && old.sourcePath === this.ctx.sourcePath && old.owner.unloaded) {
				// A leftover board for this block with different text: replace it.
				window.clearTimeout(old.destroyTimer);
				liveBoards.delete(old);
				old.view.destroy();
			}
		}
		try {
			this.view = new BoardView(this.containerEl, this.source, this.makeHost(state));
			this.view.render();
			liveBoards.add({ view: this.view, owner: this, key, sourcePath: this.ctx.sourcePath });
		} catch (e) {
			this.renderError(e);
		}
	}

	private renderError(e: unknown): void {
		this.containerEl.empty();
		const box = this.containerEl.createDiv({ cls: "cr-error" });
		box.createDiv({ cls: "cr-error-title", text: "Chess Journal could not read this game" });
		const msg = e instanceof PgnParseError ? e.message : `Unexpected error: ${(e as Error)?.message ?? String(e)}`;
		box.createDiv({ cls: "cr-error-message", text: msg });
		if (this.source.trim()) box.createEl("pre", { cls: "cr-error-source", text: this.source.slice(0, 2000) });
		if (!(e instanceof PgnParseError)) console.error("Chess Journal:", e);
	}

	/**
	 * Replace only this block's body. The block is found by its current text (`expected`),
	 * so this works even after the block has left the page; its position from
	 * getSectionInfo only breaks ties when the same game appears twice.
	 */
	private async save(pgn: string, expected: string, gameKey?: string): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!(file instanceof TFile)) throw new Error("the note was not found");
		const info = this.containerEl.isConnected ? this.ctx.getSectionInfo(this.containerEl) : null;
		await this.plugin.app.vault.process(file, (data) => {
			const block = findGameBlock(data, expected, info?.lineStart);
			if (!block) throw new Error("the game text changed outside the board; use Copy PGN to keep your edits");
			return replaceBlockBody(data, block.lineStart, block.lineEnd, pgn);
		});
		this.source = pgn;
		if (gameKey) await this.plugin.recordEditedPgn(gameKey, pgnHash(pgn));
	}
}
