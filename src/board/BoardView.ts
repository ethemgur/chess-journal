/**
 * Interactive board for one chess-game block: chessground board, nested move
 * list, eval bar and graph, engine panel, and editing with write-back.
 *
 * All text from the PGN (tags, comments) is untrusted: it is only ever set
 * with createEl/setText, never as HTML.
 */
import { App, Menu, Modal, Notice, Platform, Setting } from "obsidian";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import { chessgroundDests } from "chessops/compat";
import { makeSanVariation } from "chessops/san";
import { CommentShape, CommentShapeColor, Node, PgnNodeData } from "chessops/pgn";
import { makeSquare, parseSquare } from "chessops/util";
import type { Colour } from "../types";
import type { ChessReviewSettings } from "../settings";
import {
	MOVE_NAGS,
	POSITION_NAGS,
	Path,
	PgnGame,
	addLine,
	addMove,
	commentOf,
	deleteFrom,
	infoAt,
	initialPosition,
	mainline,
	makeMainline,
	nagGlyph,
	nodeAt,
	parseGame,
	parseMoveUci,
	parseTimeControl,
	pathKey,
	promoteVariation,
	serialise,
	setNag,
	startPly,
	timeSpent,
	updateComment,
} from "../pgn/tree";
import { Mark, classifyGame, scoreToCp, winningChances } from "../engine/classify";
import type { EngineLine, GameAnalysis, Score } from "../engine/types";
import type { EngineService, InteractiveHandle } from "../engine/service";
import { EngineNotInstalledError } from "../engine/service";

/** State that survives the block being re-rendered after a write-back. */
export interface Snapshot {
	pgn: string;
	path: Path;
}

export interface BlockState {
	path: Path;
	flipped: boolean;
	undo: Snapshot[];
	redo: Snapshot[];
	engineOn: boolean;
	hadFocus: boolean;
}

export const newBlockState = (): BlockState => ({ path: [], flipped: false, undo: [], redo: [], engineOn: false, hadFocus: false });

export interface BoardHost {
	app: App;
	settings(): ChessReviewSettings;
	engine: EngineService;
	gameKey?: string;
	myColour?: Colour;
	state: BlockState;
	loadAnalysis(): Promise<GameAnalysis | undefined>;
	onAnalysisChange(fn: () => void): () => void;
	save(pgn: string): Promise<void>;
	askDownloadEngine(): void;
	setActive(view: BoardView | null): void;
}

const MARK_LABEL: Record<Mark, string> = { inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder" };
const BRUSH: Record<CommentShapeColor, string> = { green: "green", red: "red", blue: "blue", yellow: "yellow" };

const fmtSeconds = (s: number) => {
	if (s < 60) return `${Math.round(s)}s`;
	const m = Math.floor(s / 60);
	const r = Math.round(s % 60);
	return `${m}:${String(r).padStart(2, "0")}`;
};

const fmtClock = (s: number) => {
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = Math.floor(s % 60);
	return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

export function formatScore(s: Score): string {
	if (s.mate !== undefined) return s.mate === 0 ? "#" : `#${s.mate > 0 ? "" : "-"}${Math.abs(s.mate)}`;
	const v = (s.cp ?? 0) / 100;
	return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

export class BoardView {
	private game: PgnGame;
	private cg?: Api;
	private root: HTMLElement;
	private els: Record<string, HTMLElement> = {};
	private saveTimer?: number;
	private pendingSave?: string;
	private analysis?: GameAnalysis;
	private marks = new Map<number, Mark>();
	private spent = new Map<number, number>();
	private longThink = Infinity;
	private interactive?: InteractiveHandle;
	private interactiveTimer?: number;
	private liveLines: EngineLine[] = [];
	private liveFen?: string;
	private cleanups: Array<() => void> = [];
	private longPressTimer?: number;

	constructor(private container: HTMLElement, pgn: string, private host: BoardHost) {
		this.game = parseGame(pgn);
		this.root = container.createDiv({ cls: "cr-board" });
		this.root.tabIndex = 0;
		if (!nodeAt(this.game, this.state.path)) this.state.path = [];
	}

	private get state(): BlockState {
		return this.host.state;
	}

	private get settings(): ChessReviewSettings {
		return this.host.settings();
	}

	/* ------------------------------------------------------------ */
	/* Build                                                        */
	/* ------------------------------------------------------------ */

	render(): void {
		const s = this.settings;
		this.root.empty();
		this.root.addClass(`cr-theme-${s.boardTheme}`, `cr-pieces-${s.pieceSet}`);
		this.renderHeader();
		const main = this.root.createDiv({ cls: "cr-main" });
		const left = main.createDiv({ cls: "cr-left" });
		this.els.topPlayer = left.createDiv({ cls: "cr-player cr-player-top" });
		const boardRow = left.createDiv({ cls: "cr-board-row" });
		this.els.evalBar = boardRow.createDiv({ cls: "cr-evalbar" });
		this.els.evalFill = this.els.evalBar.createDiv({ cls: "cr-evalbar-fill" });
		this.els.evalText = this.els.evalBar.createDiv({ cls: "cr-evalbar-text" });
		const cgWrap = boardRow.createDiv({ cls: "cr-cg-wrap" });
		this.els.cg = cgWrap.createDiv({ cls: "cr-cg" });
		this.els.promo = cgWrap.createDiv({ cls: "cr-promo" });
		this.els.bottomPlayer = left.createDiv({ cls: "cr-player cr-player-bottom" });
		this.renderControls(left.createDiv({ cls: "cr-controls" }));
		this.els.graph = left.createDiv({ cls: "cr-graph" });
		this.els.engine = left.createDiv({ cls: "cr-engine" });
		this.els.moves = main.createDiv({ cls: "cr-moves" });

		this.cg = Chessground(this.els.cg, {
			orientation: this.orientation(),
			coordinates: true,
			animation: { enabled: true, duration: 150 },
			highlight: { lastMove: true, check: true },
			premovable: { enabled: false },
			draggable: { showGhost: true },
			movable: {
				free: false,
				showDests: true,
				events: { after: (orig, dest) => this.onBoardMove(orig, dest) },
			},
			drawable: {
				enabled: true,
				visible: true,
				eraseOnClick: false,
				onChange: (shapes) => this.onShapes(shapes),
			},
		});

		this.bindEvents();
		this.refreshTiming();
		void this.reloadAnalysis();
		this.cleanups.push(this.host.onAnalysisChange(() => void this.reloadAnalysis()));
		this.update();
		if (this.state.hadFocus) {
			this.state.hadFocus = false;
			this.root.focus({ preventScroll: true });
		}
	}

	private orientation(): Colour {
		const s = this.settings;
		let o: Colour = s.orientation === "black" ? "black" : s.orientation === "white" ? "white" : this.host.myColour ?? "white";
		if (this.state.flipped) o = o === "white" ? "black" : "white";
		return o;
	}

	private renderHeader(): void {
		const h = this.game.headers;
		const head = this.root.createDiv({ cls: "cr-header" });
		const bits = [
			h.get("Result"),
			h.get("TimeControl") && h.get("TimeControl") !== "-" ? h.get("TimeControl") : undefined,
			(h.get("UTCDate") ?? h.get("Date"))?.replace(/\./g, "-"),
			h.get("Event") && h.get("Event") !== "?" ? h.get("Event") : undefined,
		].filter((x): x is string => !!x && !x.includes("?"));
		head.createSpan({ cls: "cr-header-players", text: `${this.playerLabel("white")} – ${this.playerLabel("black")}` });
		if (bits.length) head.createSpan({ cls: "cr-header-meta", text: bits.join(" · ") });
	}

	private playerLabel(c: Colour): string {
		const h = this.game.headers;
		const name = h.get(c === "white" ? "White" : "Black") ?? "?";
		const elo = h.get(c === "white" ? "WhiteElo" : "BlackElo");
		return elo && elo !== "?" ? `${name} (${elo})` : name;
	}

	private renderControls(el: HTMLElement): void {
		const btn = (label: string, title: string, fn: () => void) => {
			const b = el.createEl("button", { cls: "cr-btn", text: label, attr: { "aria-label": title, title } });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				fn();
			});
			return b;
		};
		btn("⏮", "First move (Home)", () => this.goto([]));
		btn("◀", "Previous move (←)", () => this.prev());
		btn("▶", "Next move (→)", () => this.next());
		btn("⏭", "Last move (End)", () => this.end());
		if (Platform.isMobile) {
			btn("▲", "Previous variation (↑)", () => this.sibling(-1));
			btn("▼", "Next variation (↓)", () => this.sibling(1));
		}
		btn("⇅", "Flip board (F)", () => this.flip());
		btn("↶", "Undo (Ctrl/Cmd+Z)", () => this.undo());
		btn("↷", "Redo (Ctrl/Cmd+Shift+Z)", () => this.redo());
		this.els.engineBtn = btn("Engine", "Analyse this position", () => this.toggleEngine());
	}

	private bindEvents(): void {
		const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, ev: K, fn: (e: HTMLElementEventMap[K]) => void) => {
			el.addEventListener(ev, fn);
			this.cleanups.push(() => el.removeEventListener(ev, fn));
		};
		on(this.root, "keydown", (e) => this.onKey(e));
		on(this.root, "focusin", () => this.host.setActive(this));
		on(this.root, "pointerdown", () => this.host.setActive(this));
		const ro = new ResizeObserver(() => {
			this.root.toggleClass("cr-narrow", this.root.clientWidth < 560);
			this.cg?.redrawAll();
		});
		ro.observe(this.root);
		this.cleanups.push(() => ro.disconnect());
	}

	/* ------------------------------------------------------------ */
	/* Navigation                                                   */
	/* ------------------------------------------------------------ */

	goto(path: Path): void {
		if (!nodeAt(this.game, path)) return;
		this.state.path = path;
		this.update();
	}

	private next(): void {
		const n = nodeAt(this.game, this.state.path);
		if (n?.children.length) this.goto([...this.state.path, 0]);
	}

	private prev(): void {
		if (this.state.path.length) this.goto(this.state.path.slice(0, -1));
	}

	private end(): void {
		const p = [...this.state.path];
		let n = nodeAt(this.game, p);
		while (n?.children.length) {
			p.push(0);
			n = n.children[0];
		}
		this.goto(p);
	}

	/** At a branch, move to the previous/next alternative of the current move. */
	private sibling(dir: number): void {
		const p = this.state.path;
		if (!p.length) return;
		const parent = nodeAt(this.game, p.slice(0, -1));
		if (!parent || parent.children.length < 2) return;
		const i = (p[p.length - 1] + dir + parent.children.length) % parent.children.length;
		this.goto([...p.slice(0, -1), i]);
	}

	private flip(): void {
		this.state.flipped = !this.state.flipped;
		this.cg?.set({ orientation: this.orientation() });
		this.updatePlayers();
	}

	private onKey(e: KeyboardEvent): void {
		const t = e.target as HTMLElement;
		if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
		const mod = e.ctrlKey || e.metaKey;
		let handled = true;
		if (mod && e.key.toLowerCase() === "z") e.shiftKey ? this.redo() : this.undo();
		else if (mod && e.key.toLowerCase() === "y") this.redo();
		else if (mod || e.altKey) handled = false;
		else if (e.key === "ArrowLeft") this.prev();
		else if (e.key === "ArrowRight") this.next();
		else if (e.key === "Home") this.goto([]);
		else if (e.key === "End") this.end();
		else if (e.key === "ArrowUp") this.sibling(-1);
		else if (e.key === "ArrowDown") this.sibling(1);
		else if (e.key === "f" || e.key === "F") this.flip();
		else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	/* ------------------------------------------------------------ */
	/* Update the UI for the current path                           */
	/* ------------------------------------------------------------ */

	private update(): void {
		const info = infoAt(this.game, this.state.path);
		const pos = info.pos;
		const lastMove = info.lastMove && "from" in info.lastMove ? [makeSquare(info.lastMove.from), makeSquare(info.lastMove.to)] as Key[] : undefined;
		const comment = commentOf(info.node, this.game);
		this.cg?.set({
			fen: info.fen,
			turnColor: pos.turn,
			lastMove,
			check: pos.isCheck() ? pos.turn : false,
			movable: { color: pos.isEnd() ? undefined : pos.turn, dests: chessgroundDests(pos) as Map<Key, Key[]> },
			drawable: { shapes: comment.shapes.map(toDrawShape) },
		});
		this.renderMoves();
		this.updatePlayers();
		this.renderGraph();
		this.restartInteractive();
		this.renderEngine();
		this.updateEvalBar();
	}

	private updatePlayers(): void {
		const bottom = this.orientation();
		const top: Colour = bottom === "white" ? "black" : "white";
		const clocks = this.settings.showClocks ? this.clocksAt(this.state.path) : {};
		for (const [el, c] of [[this.els.topPlayer, top], [this.els.bottomPlayer, bottom]] as Array<[HTMLElement, Colour]>) {
			el.empty();
			el.createSpan({ cls: `cr-player-dot cr-${c}` });
			el.createSpan({ cls: "cr-player-name", text: this.playerLabel(c) });
			const clk = clocks[c];
			if (clk !== undefined) el.createSpan({ cls: "cr-player-clock", text: fmtClock(clk) });
		}
	}

	/** Remaining clock for each side at a path, from the last %clk seen for that side. */
	private clocksAt(path: Path): Partial<Record<Colour, number>> {
		const out: Partial<Record<Colour, number>> = {};
		const tc = parseTimeControl(this.game.headers.get("TimeControl"));
		if (tc) out.white = out.black = tc.base;
		let node: Node<PgnNodeData> = this.game.moves;
		let ply = startPly(initialPosition(this.game));
		for (const i of path) {
			node = node.children[i];
			if (!node) break;
			const clk = commentOf(node, this.game).clock;
			if (clk !== undefined) out[ply % 2 === 0 ? "white" : "black"] = clk;
			ply++;
		}
		return out;
	}

	private refreshTiming(): void {
		this.spent = timeSpent(this.game);
		const tc = parseTimeControl(this.game.headers.get("TimeControl"));
		this.longThink = tc && tc.base > 0 ? tc.base * 0.1 : Infinity;
	}

	/* ------------------------------------------------------------ */
	/* Move list                                                    */
	/* ------------------------------------------------------------ */

	private renderMoves(): void {
		const el = this.els.moves;
		const scroll = el.scrollTop;
		el.empty();
		const rootComment = commentOf(this.game.moves, this.game).text;
		if (rootComment) el.createDiv({ cls: "cr-comment cr-root-comment", text: rootComment });
		const line = el.createDiv({ cls: "cr-line cr-mainline" });
		this.renderLine(line, this.game.moves, [], startPly(initialPosition(this.game)), true, true);
		const result = this.game.headers.get("Result");
		if (result && result !== "*") el.createDiv({ cls: "cr-result", text: result });
		el.scrollTop = scroll;
		const active = el.querySelector(".cr-move.is-active") as HTMLElement | null;
		if (active) {
			const top = active.offsetTop - el.offsetTop;
			if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 24) el.scrollTop = top - el.clientHeight / 2;
		}
	}

	private renderLine(container: HTMLElement, parent: Node<PgnNodeData>, path: Path, ply: number, isMain: boolean, force: boolean): void {
		let node = parent;
		let p = path;
		while (node.children.length) {
			const main = node.children[0];
			const mainPath = [...p, 0];
			force = this.renderMove(container, main, mainPath, ply, force, isMain);
			if (node.children.length > 1) {
				const vars = container.createDiv({ cls: "cr-variations" });
				node.children.slice(1).forEach((v, j) => {
					const vEl = vars.createDiv({ cls: "cr-line cr-variation" });
					const vPath = [...p, j + 1];
					const f = this.renderMove(vEl, v, vPath, ply, true, false);
					this.renderLine(vEl, v, vPath, ply + 1, false, f);
				});
				force = true;
			}
			node = main;
			p = mainPath;
			ply++;
		}
	}

	/** Render one move; returns whether the next move needs its number re-indicated. */
	private renderMove(container: HTMLElement, node: Node<PgnNodeData> & { data: PgnNodeData }, path: Path, ply: number, force: boolean, isMain: boolean): boolean {
		for (const c of node.data.startingComments ?? []) {
			container.createSpan({ cls: "cr-comment", text: c });
			force = true;
		}
		const num = Math.floor(ply / 2) + 1;
		const white = ply % 2 === 0;
		if (white || force) container.createSpan({ cls: "cr-num", text: white ? `${num}.` : `${num}…` });
		const isActive = pathKey(path) === pathKey(this.state.path);
		const m = container.createSpan({ cls: "cr-move" + (isActive ? " is-active" : "") });
		m.createSpan({ cls: "cr-san", text: node.data.san });
		for (const n of node.data.nags ?? []) m.createSpan({ cls: "cr-nag", text: nagGlyph(n) });
		const mainIdx = isMain ? path.length : -1;
		if (isMain) {
			const mark = this.marks.get(mainIdx);
			if (mark) m.createSpan({ cls: `cr-badge cr-badge-${mark}`, attr: { title: MARK_LABEL[mark], "aria-label": MARK_LABEL[mark] } });
			const sp = this.spent.get(mainIdx);
			if (this.settings.showClocks && sp !== undefined) {
				m.createSpan({ cls: "cr-spent" + (sp > this.longThink ? " is-long" : ""), text: fmtSeconds(sp), attr: { title: "Time spent" } });
			}
		}
		m.addEventListener("click", () => {
			this.goto(path);
			this.root.focus({ preventScroll: true });
		});
		m.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.goto(path);
			this.openMoveMenu(path, { x: e.clientX, y: e.clientY });
		});
		m.addEventListener("touchstart", (e) => {
			const t = e.touches[0];
			window.clearTimeout(this.longPressTimer);
			this.longPressTimer = window.setTimeout(() => {
				this.goto(path);
				this.openMoveMenu(path, { x: t.clientX, y: t.clientY });
			}, 500);
		}, { passive: true });
		const cancel = () => window.clearTimeout(this.longPressTimer);
		m.addEventListener("touchend", cancel);
		m.addEventListener("touchmove", cancel);
		const text = commentOf(node, this.game).text;
		if (text) {
			container.createSpan({ cls: "cr-comment", text });
			return true;
		}
		return false;
	}

	/* ------------------------------------------------------------ */
	/* Editing                                                      */
	/* ------------------------------------------------------------ */

	private openMoveMenu(path: Path, at: { x: number; y: number }): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Add / edit comment").setIcon("message-square").onClick(() => this.editComment(path)));
		menu.addSeparator();
		for (const [nag, glyph] of Object.entries(MOVE_NAGS)) {
			menu.addItem((i) => i.setTitle(`Move symbol ${glyph}`).onClick(() => this.edit(() => setNag(this.game, path, "move", Number(nag)))));
		}
		menu.addItem((i) => i.setTitle("Clear move symbol").onClick(() => this.edit(() => setNag(this.game, path, "move", 0))));
		menu.addSeparator();
		for (const [nag, glyph] of Object.entries(POSITION_NAGS)) {
			menu.addItem((i) => i.setTitle(`Position symbol ${glyph}`).onClick(() => this.edit(() => setNag(this.game, path, "position", Number(nag)))));
		}
		menu.addItem((i) => i.setTitle("Clear position symbol").onClick(() => this.edit(() => setNag(this.game, path, "position", 0))));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Promote variation").setIcon("arrow-up").onClick(() => this.edit(() => (this.state.path = promoteVariation(this.game, path)))));
		menu.addItem((i) => i.setTitle("Make main line").setIcon("arrow-up-to-line").onClick(() => this.edit(() => (this.state.path = makeMainline(this.game, path)))));
		menu.addItem((i) => i.setTitle("Delete from here").setIcon("trash").onClick(() => this.edit(() => (this.state.path = deleteFrom(this.game, path)))));
		menu.showAtPosition(at);
	}

	private editComment(path: Path): void {
		const node = nodeAt(this.game, path);
		if (!node) return;
		const current = commentOf(node, this.game).text;
		new CommentModal(this.host.app, current, (text) => this.edit(() => updateComment(this.game, path, { text }))).open();
	}

	private onBoardMove(orig: Key, dest: Key): void {
		const info = infoAt(this.game, this.state.path);
		const from = parseSquare(orig);
		const piece = from !== undefined ? info.pos.board.get(from) : undefined;
		const rank = dest[1];
		if (piece?.role === "pawn" && (rank === "8" || rank === "1")) {
			this.choosePromotion(piece.color, (role) => this.playUci(orig + dest + role));
			return;
		}
		this.playUci(orig + dest);
	}

	private choosePromotion(color: Colour, done: (role: string) => void): void {
		const el = this.els.promo;
		el.empty();
		el.addClass("is-open");
		const close = () => {
			el.removeClass("is-open");
			el.empty();
		};
		for (const [role, name] of [["q", "queen"], ["r", "rook"], ["b", "bishop"], ["n", "knight"]]) {
			const b = el.createEl("button", { cls: "cr-promo-btn", attr: { "aria-label": name, title: name } });
			const piece = b.appendChild(document.createElement("piece"));
			piece.className = `${color} ${name}`;
			b.addEventListener("click", () => {
				close();
				done(role);
			});
		}
		const cancel = el.createEl("button", { cls: "cr-promo-cancel", text: "✕", attr: { "aria-label": "Cancel" } });
		cancel.addEventListener("click", () => {
			close();
			this.update();
		});
	}

	private playUci(uci: string): void {
		const before = this.snapshot();
		const p = addMove(this.game, this.state.path, uci);
		if (!p) {
			this.update();
			return;
		}
		this.state.path = p;
		const after = serialise(this.game);
		if (after !== before.pgn) this.commit(before, after);
		else this.update();
	}

	private onShapes(shapes: DrawShape[]): void {
		const cs: CommentShape[] = [];
		for (const s of shapes) {
			const from = parseSquare(s.orig);
			const to = s.dest ? parseSquare(s.dest) : from;
			const color = (Object.keys(BRUSH) as CommentShapeColor[]).find((c) => BRUSH[c] === s.brush);
			if (from === undefined || to === undefined || !color) continue;
			cs.push({ color, from, to });
		}
		const node = nodeAt(this.game, this.state.path);
		if (!node) return;
		const old = commentOf(node, this.game).shapes;
		if (JSON.stringify(old) === JSON.stringify(cs)) return;
		this.edit(() => updateComment(this.game, this.state.path, { shapes: cs }), false);
	}

	/** Run an edit, record undo, re-render and schedule the write-back. */
	private edit(fn: () => void, rerenderBoard = true): void {
		const before = this.snapshot();
		fn();
		if (!nodeAt(this.game, this.state.path)) this.state.path = [];
		const after = serialise(this.game);
		if (after === before.pgn) return;
		this.commit(before, after, rerenderBoard);
	}

	private commit(before: Snapshot, after: string, rerenderBoard = true): void {
		this.state.undo.push(before);
		if (this.state.undo.length > 200) this.state.undo.shift();
		this.state.redo = [];
		this.afterChange(after, rerenderBoard);
	}

	private snapshot(): Snapshot {
		return { pgn: serialise(this.game), path: [...this.state.path] };
	}

	private restore(s: Snapshot): void {
		this.game = parseGame(s.pgn);
		this.state.path = [...s.path];
		while (!nodeAt(this.game, this.state.path)) this.state.path = this.state.path.slice(0, -1);
		this.afterChange(s.pgn, true);
	}

	undo(): void {
		const prev = this.state.undo.pop();
		if (!prev) return;
		this.state.redo.push(this.snapshot());
		this.restore(prev);
	}

	redo(): void {
		const next = this.state.redo.pop();
		if (!next) return;
		this.state.undo.push(this.snapshot());
		this.restore(next);
	}

	private afterChange(pgn: string, rerenderBoard: boolean): void {
		this.refreshTiming();
		if (rerenderBoard) this.update();
		else this.renderMoves();
		this.scheduleSave(pgn);
	}

	/** Debounced write-back (1 s). */
	private scheduleSave(pgn: string): void {
		this.pendingSave = pgn;
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.flushSave(), 1000);
	}

	async flushSave(): Promise<void> {
		window.clearTimeout(this.saveTimer);
		const pgn = this.pendingSave;
		this.pendingSave = undefined;
		if (pgn === undefined) return;
		this.state.hadFocus = this.root.contains(document.activeElement);
		try {
			await this.host.save(pgn);
		} catch (e) {
			new Notice(`Chess Review: could not save the game: ${(e as Error).message}`);
		}
	}

	getPgn(): string {
		return serialise(this.game);
	}

	/* ------------------------------------------------------------ */
	/* Analysis display                                             */
	/* ------------------------------------------------------------ */

	private async reloadAnalysis(): Promise<void> {
		this.analysis = await this.host.loadAnalysis();
		this.marks = new Map();
		if (this.analysis) {
			const plies = mainline(this.game);
			this.marks = classifyGame(this.analysis.plies, plies.slice(1).map((p) => p.uci as string), plies[0].pos.turn).marks;
		}
		this.renderMoves();
		this.renderGraph();
		this.renderEngine();
		this.updateEvalBar();
	}

	/** Main-line ply index of the current path, or -1 if in a variation. */
	private mainIndex(): number {
		return this.state.path.every((i) => i === 0) ? this.state.path.length : -1;
	}

	private cachedPly() {
		const i = this.mainIndex();
		return i >= 0 ? this.analysis?.plies.find((p) => p.ply === i) : undefined;
	}

	private currentScore(): Score | undefined {
		const fen = infoAt(this.game, this.state.path).fen;
		if (this.liveFen === fen && this.liveLines[0]) return this.liveLines[0].score;
		return this.cachedPly()?.score;
	}

	private updateEvalBar(): void {
		const s = this.currentScore();
		const bar = this.els.evalBar;
		if (!bar) return;
		bar.toggleClass("is-empty", !s);
		const w = s ? winningChances(scoreToCp(s)) : 0;
		const whitePct = 50 + 50 * w;
		const flipped = this.orientation() === "black";
		this.els.evalFill.style.height = `${whitePct}%`;
		this.els.evalFill.toggleClass("is-top", flipped);
		this.els.evalText.setText(s ? formatScore(s) : "");
	}

	private renderGraph(): void {
		const el = this.els.graph;
		if (!el) return;
		el.empty();
		const a = this.analysis;
		if (!a || a.plies.length < 2) {
			el.addClass("is-empty");
			return;
		}
		el.removeClass("is-empty");
		const n = a.plies.length - 1;
		const pts = a.plies.map((p) => [(p.ply / n) * 100, 50 - 50 * winningChances(scoreToCp(p.score))]);
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "0 0 100 100");
		svg.setAttribute("preserveAspectRatio", "none");
		svg.classList.add("cr-graph-svg");
		const area = document.createElementNS(ns, "path");
		area.setAttribute("d", `M0,100 ${pts.map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`).join(" ")} L100,100 Z`);
		area.classList.add("cr-graph-area");
		const mid = document.createElementNS(ns, "line");
		mid.setAttribute("x1", "0");
		mid.setAttribute("x2", "100");
		mid.setAttribute("y1", "50");
		mid.setAttribute("y2", "50");
		mid.classList.add("cr-graph-mid");
		const line = document.createElementNS(ns, "polyline");
		line.setAttribute("points", pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "));
		line.classList.add("cr-graph-line");
		svg.append(area, mid, line);
		el.appendChild(svg);
		const me = this.host.myColour;
		const startWhite = mainline(this.game)[0].pos.turn === "white";
		for (const [idx, mark] of this.marks) {
			const mover: Colour = ((idx - 1) % 2 === 0) === startWhite ? "white" : "black";
			if (me && mover !== me) continue;
			const pt = pts[idx];
			if (!pt) continue;
			const dot = el.createDiv({ cls: `cr-graph-dot cr-badge-${mark}`, attr: { title: `${MARK_LABEL[mark]} (move ${Math.ceil(idx / 2)})` } });
			dot.style.left = `${pt[0]}%`;
			dot.style.top = `${pt[1]}%`;
		}
		const cur = this.mainIndex();
		if (cur >= 0) {
			const c = el.createDiv({ cls: "cr-graph-cursor" });
			c.style.left = `${(cur / n) * 100}%`;
		}
		el.onclick = (e: MouseEvent) => {
			const r = el.getBoundingClientRect();
			const idx = Math.round(((e.clientX - r.left) / r.width) * n);
			const ml = mainline(this.game).length - 1;
			this.goto(new Array(Math.max(0, Math.min(idx, ml))).fill(0));
		};
	}

	private toggleEngine(): void {
		this.state.engineOn = !this.state.engineOn;
		this.restartInteractive();
		this.renderEngine();
	}

	private stopInteractive(): void {
		window.clearTimeout(this.interactiveTimer);
		this.interactive?.stop();
		this.interactive = undefined;
	}

	/** Restart interactive analysis for the position on screen (stops when you navigate away). */
	private restartInteractive(): void {
		this.stopInteractive();
		this.liveLines = [];
		this.liveFen = undefined;
		if (!this.state.engineOn) return;
		const info = infoAt(this.game, this.state.path);
		if (info.pos.isEnd()) return;
		this.interactiveTimer = window.setTimeout(() => {
			const fen = info.fen;
			const h = this.host.engine.interactive(fen, (lines) => {
				this.liveFen = fen;
				this.liveLines = lines;
				this.renderEngine();
				this.updateEvalBar();
			});
			this.interactive = h;
			h.done.catch((e) => {
				if (e instanceof EngineNotInstalledError) {
					this.state.engineOn = false;
					this.renderEngine();
					this.host.askDownloadEngine();
				} else new Notice(`Chess Review: engine error: ${(e as Error).message}`);
			});
		}, 150);
	}

	private renderEngine(): void {
		const el = this.els.engine;
		if (!el) return;
		el.empty();
		this.els.engineBtn?.toggleClass("is-on", this.state.engineOn);
		const info = infoAt(this.game, this.state.path);
		const rows: Array<{ score: Score; pv: string[]; depth: number; label: string }> = [];
		if (this.state.engineOn && this.liveFen === info.fen) {
			for (const l of this.liveLines.slice(0, 3)) rows.push({ score: l.score, pv: l.pv, depth: l.depth, label: "" });
		} else {
			const c = this.cachedPly();
			if (c && c.pv.length) rows.push({ score: c.score, pv: c.pv, depth: c.depth, label: c.source === "cloud" ? "cloud" : this.analysis?.engine ?? "" });
		}
		if (!rows.length) {
			if (this.state.engineOn) el.createDiv({ cls: "cr-engine-empty", text: info.pos.isEnd() ? "Game over." : "Thinking…" });
			this.cg?.setAutoShapes([]);
			return;
		}
		for (const r of rows) {
			const row = el.createDiv({ cls: "cr-engine-line" });
			row.createSpan({ cls: "cr-engine-score", text: formatScore(r.score) });
			const moves = r.pv.map((u) => parseMoveUci(info.pos, u));
			let san = "";
			try {
				const ok = [];
				const p = info.pos.clone();
				for (const m of moves) {
					if (!m || !p.isLegal(m)) break;
					ok.push(m);
					p.play(m);
				}
				san = makeSanVariation(info.pos, ok);
			} catch {
				san = r.pv.join(" ");
			}
			row.createSpan({ cls: "cr-engine-pv", text: san });
			row.createSpan({ cls: "cr-engine-depth", text: `d${r.depth}${r.label ? ` · ${r.label}` : ""}` });
			const keep = row.createEl("button", { cls: "cr-btn cr-engine-keep", text: "+", attr: { title: "Add this line to the game as a variation", "aria-label": "Keep line" } });
			keep.addEventListener("click", () => this.edit(() => {
				addLine(this.game, this.state.path, r.pv);
			}));
		}
		const best = rows[0].pv[0];
		if (best && best.length >= 4) {
			this.cg?.setAutoShapes([{ orig: best.slice(0, 2) as Key, dest: best.slice(2, 4) as Key, brush: "paleBlue" }]);
		}
	}

	destroy(): void {
		void this.flushSave();
		this.stopInteractive();
		this.cleanups.forEach((f) => f());
		this.cleanups = [];
		this.cg?.destroy();
		this.cg = undefined;
		this.host.setActive(null);
	}
}

function toDrawShape(s: CommentShape): DrawShape {
	const orig = makeSquare(s.from) as Key;
	const dest = makeSquare(s.to) as Key;
	return s.from === s.to ? { orig, brush: BRUSH[s.color] } : { orig, dest, brush: BRUSH[s.color] };
}

class CommentModal extends Modal {
	constructor(app: App, private initial: string, private onSubmit: (text: string) => void) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Comment");
		const ta = this.contentEl.createEl("textarea", { cls: "cr-comment-input" });
		ta.value = this.initial;
		ta.rows = 5;
		ta.focus();
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Save").setCta().onClick(() => {
				this.onSubmit(ta.value);
				this.close();
			}))
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
