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
 * Boards on screen. When a block is re-rendered because the note changed (most
 * often our own write-back), the new block takes over the existing board
 * instead of building a new one, so the board never flashes. Matching is by
 * note and game text, because a fresh block often cannot tell its position yet.
 */
interface LiveBoard {
	view: BoardView;
	owner: ChessGameBlock;
	sourcePath: string;
	destroyTimer?: number;
}
const liveBoards = new Map<string, LiveBoard>();
const ADOPT_GRACE_MS = 3000;
/** How long a new block waits (in frames) for the block it replaces to leave the page. */
const ADOPT_MAX_FRAMES = 30;

export function registerChessGameBlock(plugin: ChessJournalPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor(CODE_LANG, (source, el, ctx) => {
		ctx.addChild(new ChessGameBlock(plugin, source, el, ctx));
	});
}

export function clearBlockStates(): void {
	for (const live of liveBoards.values()) {
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
			this.containerEl.style.minHeight = `${candidate[1].view.height()}px`;
			this.waitAndAdopt(candidate[0], candidate[1], 0);
			return;
		}
		this.startNormally();
	}

	/** A board for the same note showing exactly this game text, owned by another block. */
	private findAdoptable(): [string, LiveBoard] | undefined {
		const hash = pgnHash(this.source);
		for (const [key, live] of liveBoards) {
			if (live.sourcePath === this.ctx.sourcePath && live.owner !== this && pgnHash(live.view.savedPgn()) === hash) {
				return [key, live];
			}
		}
		return undefined;
	}

	/**
	 * Take the board once its old block has left the page, or once both blocks are in the
	 * same view (the old one is about to be removed). A block in another view (Reading view
	 * vs editor) that stays on the page keeps its board; then this block builds its own.
	 */
	private waitAndAdopt(key: string, live: LiveBoard, frames: number): void {
		if (this.unloaded) return;
		const ownerGone = live.owner.unloaded || !live.owner.containerEl.isConnected;
		const sameVisibleView = this.containerEl.isConnected && sameView(live.owner.containerEl, this.containerEl);
		if (liveBoards.get(key) === live && (ownerGone || sameVisibleView)) {
			this.containerEl.style.minHeight = "";
			this.adopt(key, live);
			return;
		}
		if (frames >= ADOPT_MAX_FRAMES || liveBoards.get(key) !== live) {
			this.containerEl.style.minHeight = "";
			this.startNormally();
			return;
		}
		window.requestAnimationFrame(() => this.waitAndAdopt(key, live, frames + 1));
	}

	private adopt(key: string, live: LiveBoard): void {
		window.clearTimeout(live.destroyTimer);
		live.destroyTimer = undefined;
		const previous = live.owner;
		live.owner = this;
		this.key = key;
		this.view = live.view;
		// The previous block no longer owns the board; make sure it will not destroy it.
		previous.release(live.view);
		this.view.adopt(this.containerEl, this.makeHost(blockStates.get(key) ?? newBlockState()));
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
		this.observer?.disconnect();
		const live = this.key ? liveBoards.get(this.key) : undefined;
		if (this.view && live && live.owner === this && live.view === this.view) {
			// Keep the board alive briefly in case the re-rendered block takes it over.
			const key = this.key as string;
			live.destroyTimer = window.setTimeout(() => {
				if (liveBoards.get(key) === live) liveBoards.delete(key);
				live.view.destroy();
			}, ADOPT_GRACE_MS);
		} else if (this.view && live?.view !== this.view) {
			// Not the registered board (e.g. a second view of the same block): clean up now.
			this.view.destroy();
		}
		this.view = undefined;
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
		const names = [s.lichessUsername, s.chesscomUsername, ...s.otbNames.split(",")].map((x) => x.trim()).filter(Boolean);
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
		const old = liveBoards.get(key);
		if (old && (old.owner.unloaded || !old.owner.containerEl.isConnected)) {
			// A leftover board for this block with different text: replace it.
			window.clearTimeout(old.destroyTimer);
			old.view.destroy();
			liveBoards.delete(key);
		}
		try {
			this.view = new BoardView(this.containerEl, this.source, this.makeHost(state));
			this.view.render();
			// Register unless another, still visible block already owns this key.
			if (!liveBoards.has(key)) liveBoards.set(key, { view: this.view, owner: this, sourcePath: this.ctx.sourcePath });
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
