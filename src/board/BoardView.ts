/**
 * Interactive board for one chess-game block: chessground board, move list,
 * eval gauge and graph, compact engine panel, and editing with write-back.
 *
 * All text from the PGN (tags, comments) is untrusted: it is only ever set
 * with createEl/setText, never as HTML.
 */
import { App, Menu, Modal, Notice, Setting, setIcon } from "obsidian";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import { chessgroundDests } from "chessops/compat";
import { makeSanVariation } from "chessops/san";
import { Chess, Position } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { ChildNode, CommentShape, CommentShapeColor, Node, PgnNodeData } from "chessops/pgn";
import { makeSquare, parseSquare } from "chessops/util";
import type { Colour } from "../types";
import type { ChessReviewSettings } from "../settings";
import {
	MOVE_NAGS,
	POSITION_NAGS,
	Path,
	PgnGame,
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
	updateComment,
} from "../pgn/tree";
import { Mark, classifyGame, scoreToCp, winningChances } from "../engine/classify";
import type { EngineLine, GameAnalysis, Score } from "../engine/types";
import type { EngineService, InteractiveHandle } from "../engine/service";
import { EngineNotInstalledError } from "../engine/service";

export interface Snapshot {
	pgn: string;
	path: Path;
}

/** State that survives the block being re-rendered after a write-back. */
export interface BlockState {
	path: Path;
	flipped: boolean;
	undo: Snapshot[];
	redo: Snapshot[];
	engineOn: boolean;
	threatOn: boolean;
	drawMode: boolean;
	drawColour: CommentShapeColor;
	hadFocus: boolean;
	rendered: boolean;
}

export const newBlockState = (): BlockState => ({
	path: [],
	flipped: false,
	undo: [],
	redo: [],
	engineOn: false,
	threatOn: false,
	drawMode: false,
	drawColour: "green",
	hadFocus: false,
	rendered: false,
});

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
/** Glyph colour class per move NAG, as on Lichess. */
const NAG_CLASS: Record<number, string> = { 1: "good", 2: "mistake", 3: "brilliant", 4: "blunder", 5: "interesting", 6: "dubious" };
/** A drawn-shape change counts as the user's only shortly after a right-button press on the board. */
const DRAW_WINDOW_MS = 5000;
/** Engine and threat arrows are thinner than chessground's pale brushes (15). */
const ENGINE_ARROW_WIDTH = 8;
const DRAW_COLOURS: CommentShapeColor[] = ["green", "red", "blue", "yellow"];

/** Position after passing the move (for "show threat"); undefined if that is illegal (in check). */
export function nullMoveFen(fen: string): string | undefined {
	const parts = fen.split(" ");
	if (parts.length < 4) return undefined;
	parts[1] = parts[1] === "w" ? "b" : "w";
	parts[3] = "-";
	const nf = parts.join(" ");
	const setup = parseFen(nf);
	if (setup.isErr) return undefined;
	return Chess.fromSetup(setup.value).isOk ? nf : undefined;
}

function positionFromFen(fen: string): Position | undefined {
	const setup = parseFen(fen);
	if (setup.isErr) return undefined;
	const pos = Chess.fromSetup(setup.value);
	return pos.isOk ? pos.value : undefined;
}

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

type MoveNode = ChildNode<PgnNodeData>;

/** Short label for the gauge: "0.3", "2.1", "M3". */
function gaugeLabel(s: Score): string {
	if (s.mate !== undefined) return s.mate === 0 ? "#" : `M${Math.abs(s.mate)}`;
	const v = Math.abs((s.cp ?? 0) / 100);
	return v >= 10 ? v.toFixed(0) : v.toFixed(1);
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
	private interactive?: InteractiveHandle;
	private interactiveTimer?: number;
	private liveLines: EngineLine[] = [];
	private liveFen?: string;
	private cleanups: Array<() => void> = [];
	private longPressTimer?: number;
	private lastRightDown = 0;
	private lastSaved: string;
	private drawPending?: Key;

	constructor(private container: HTMLElement, pgn: string, private host: BoardHost) {
		this.game = parseGame(pgn);
		this.lastSaved = pgn;
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
		this.root.addClass(`cr-theme-${s.boardTheme}`);
		// Grid: the move list sits beside the board row only, so its top and bottom line up with the board.
		const main = this.root.createDiv({ cls: "cr-main" });
		this.els.topPlayer = main.createDiv({ cls: "cr-player cr-player-top" });
		const boardRow = main.createDiv({ cls: "cr-board-row" });
		this.els.evalBar = boardRow.createDiv({ cls: "cr-gauge" });
		this.els.evalFill = this.els.evalBar.createDiv({ cls: "cr-gauge-fill" });
		// Faint ticks every 12.5%, as on Lichess (no highlighted middle line).
		for (let i = 1; i < 8; i++) this.els.evalBar.createDiv({ cls: "cr-gauge-tick" }).style.top = `${i * 12.5}%`;
		this.els.evalText = this.els.evalBar.createDiv({ cls: "cr-gauge-text" });
		const cgWrap = boardRow.createDiv({ cls: "cr-cg-wrap" });
		this.els.cg = cgWrap.createDiv({ cls: "cr-cg" });
		this.els.promo = cgWrap.createDiv({ cls: "cr-promo" });
		this.els.bottomPlayer = main.createDiv({ cls: "cr-player cr-player-bottom" });
		this.renderControls(main.createDiv({ cls: "cr-controls" }));
		this.els.drawBar = main.createDiv({ cls: "cr-drawbar" });
		this.els.graph = main.createDiv({ cls: "cr-graph" });
		const side = main.createDiv({ cls: "cr-side" });
		this.els.engine = side.createDiv({ cls: "cr-ceval" });
		this.els.moves = side.createDiv({ cls: "cr-moves" });

		this.cg = Chessground(this.els.cg, {
			orientation: this.orientation(),
			coordinates: true,
			animation: { enabled: true, duration: 120 },
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
		this.renderDrawBar();
		void this.reloadAnalysis();
		this.cleanups.push(this.host.onAnalysisChange(() => void this.reloadAnalysis()));
		this.update();
		this.state.rendered = true;
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

	private playerLabel(c: Colour): { name: string; elo?: string } {
		const h = this.game.headers;
		const name = h.get(c === "white" ? "White" : "Black") ?? "?";
		const elo = h.get(c === "white" ? "WhiteElo" : "BlackElo");
		return { name, elo: elo && elo !== "?" ? elo : undefined };
	}

	/** First, previous, next, last, and a menu for everything else. */
	private renderControls(el: HTMLElement): void {
		const btn = (icon: string, title: string, fn: (e: MouseEvent) => void, cls = "") => {
			const b = el.createEl("button", { cls: `cr-ctrl clickable-icon ${cls}`, attr: { "aria-label": title } });
			setIcon(b, icon);
			// Keep keyboard focus on the board, not the button.
			b.addEventListener("mousedown", (e) => e.preventDefault());
			b.addEventListener("click", (e) => {
				e.preventDefault();
				fn(e);
			});
			return b;
		};
		btn("chevrons-left", "First move", () => this.goto([]));
		btn("chevron-left", "Previous move", () => this.prev());
		btn("chevron-right", "Next move", () => this.next());
		btn("chevrons-right", "Last move", () => this.end());
		btn("more-horizontal", "More", (e) => this.openBoardMenu(e), "cr-ctrl-menu");
	}

	private openBoardMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Flip board").setIcon("arrow-up-down").onClick(() => this.flip()));
		menu.addItem((i) =>
			i.setTitle("Draw arrows and circles").setIcon("pencil").setChecked(this.state.drawMode).onClick(() => this.setDrawMode(!this.state.drawMode)),
		);
		menu.addItem((i) =>
			i.setTitle("Show threat").setIcon("crosshair").setChecked(this.state.threatOn).onClick(() => this.toggleThreat()),
		);
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Copy PGN").setIcon("copy").onClick(async () => {
			await navigator.clipboard.writeText(this.getPgn());
			new Notice("PGN copied.");
		}));
		menu.showAtMouseEvent(e);
	}

	private bindEvents(): void {
		const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, ev: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
			el.addEventListener(ev, fn, opts);
			this.cleanups.push(() => el.removeEventListener(ev, fn, opts));
		};
		on(this.root, "keydown", (e) => this.onKey(e));
		on(this.root, "focusin", () => this.host.setActive(this));
		// In Live Preview, a click that reaches the editor puts the cursor inside the
		// block and the board is re-rendered as source. Keep pointer events here.
		for (const ev of ["mousedown", "pointerdown", "touchstart", "click"] as const) {
			on(this.root, ev, (e) => {
				if (ev === "pointerdown" || ev === "mousedown") this.host.setActive(this);
				e.stopPropagation();
			});
		}
		// Shapes are only the user's when drawn with the right button.
		on(this.els.cg, "pointerdown", (e) => {
			if (e.button === 2) this.lastRightDown = Date.now();
		}, { capture: true });
		// Draw mode: tap two squares for an arrow, one square twice for a circle.
		on(this.els.cg, "pointerup", (e) => {
			if (!this.state.drawMode || e.button !== 0) return;
			const key = this.cg?.getKeyAtDomPos([e.clientX, e.clientY]);
			if (key) this.onDrawTap(key);
		});
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
		this.updateEvalBar();
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
		else if (e.key === "x" || e.key === "X") this.toggleThreat();
		else if (e.key === "Escape" && this.state.drawMode) this.setDrawMode(false);
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
		// Highlight castling as king to g1/c1, as Lichess does.
		const lastMove = info.lastUci ? ([info.lastUci.slice(0, 2), info.lastUci.slice(2, 4)] as Key[]) : undefined;
		const comment = commentOf(info.node, this.game);
		this.cg?.set({
			fen: info.fen,
			turnColor: pos.turn,
			lastMove,
			check: pos.isCheck() ? pos.turn : false,
			movable: { color: pos.isEnd() || this.state.drawMode ? undefined : pos.turn, dests: chessgroundDests(pos) as Map<Key, Key[]> },
			draggable: { enabled: !this.state.drawMode },
			selectable: { enabled: !this.state.drawMode },
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
		const turn = infoAt(this.game, this.state.path).pos.turn;
		for (const [el, c] of [[this.els.topPlayer, top], [this.els.bottomPlayer, bottom]] as Array<[HTMLElement, Colour]>) {
			el.empty();
			const p = this.playerLabel(c);
			el.createSpan({ cls: `cr-player-colour cr-${c}` });
			el.createSpan({ cls: "cr-player-name", text: p.name });
			if (p.elo) el.createSpan({ cls: "cr-player-elo", text: p.elo });
			const clk = clocks[c];
			if (clk !== undefined) el.createSpan({ cls: "cr-clock" + (turn === c ? " is-running" : ""), text: fmtClock(clk) });
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

	/* ------------------------------------------------------------ */
	/* Move list                                                    */
	/* ------------------------------------------------------------ */

	/**
	 * Main line as rows "n. white black"; comments and side lines break the
	 * row and are shown inline below it, Lichess-style.
	 */
	private renderMoves(): void {
		const el = this.els.moves;
		const scroll = el.scrollTop;
		el.empty();
		const rootComment = commentOf(this.game.moves, this.game).text;
		if (rootComment) el.createDiv({ cls: "cr-interrupt" }).createSpan({ cls: "cr-comment", text: rootComment });

		let node: Node<PgnNodeData> = this.game.moves;
		let path: Path = [];
		let ply = startPly(initialPosition(this.game));
		// Starting with Black to move: open the first row with an empty White cell.
		let openRow = ply % 2 === 1;
		if (openRow) {
			el.createDiv({ cls: "cr-index", text: `${Math.floor(ply / 2) + 1}` });
			el.createDiv({ cls: "cr-move cr-empty", text: "…" });
		}
		while (node.children.length) {
			const main = node.children[0];
			const mainPath = [...path, 0];
			const white = ply % 2 === 0;
			if (white) {
				el.createDiv({ cls: "cr-index", text: `${Math.floor(ply / 2) + 1}` });
				openRow = true;
			} else if (!openRow) {
				el.createDiv({ cls: "cr-index", text: `${Math.floor(ply / 2) + 1}` });
				el.createDiv({ cls: "cr-move cr-empty", text: "…" });
			}
			this.moveEl(el, main, mainPath, true, "div");
			if (!white) openRow = false;
			const text = commentOf(main, this.game).text;
			const alts = node.children.slice(1);
			if (text || alts.length) {
				if (white) el.createDiv({ cls: "cr-move cr-empty", text: "…" });
				openRow = false;
				const box = el.createDiv({ cls: "cr-interrupt" });
				if (text) box.createSpan({ cls: "cr-comment", text });
				alts.forEach((v, j) => {
					const line = box.createDiv({ cls: "cr-line" });
					this.renderSideline(line, v, [...path, j + 1], ply, true);
				});
			}
			node = main;
			path = mainPath;
			ply++;
		}
		const result = this.game.headers.get("Result");
		if (result && result !== "*") el.createDiv({ cls: "cr-result", text: result });

		el.scrollTop = scroll;
		const active = el.querySelector(".cr-move.is-active") as HTMLElement | null;
		if (active) {
			const top = active.offsetTop - el.offsetTop;
			if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 28) el.scrollTop = top - el.clientHeight / 2;
		}
	}

	/** A side line, inline ("6. Bg5 Qb6 7. O-O"); its own branches nest below it. */
	private renderSideline(container: HTMLElement, first: MoveNode, firstPath: Path, ply: number, force: boolean): void {
		const f = this.inlineMove(container, first, firstPath, ply, force);
		this.renderInline(container, first, firstPath, ply + 1, f);
	}

	private renderInline(container: HTMLElement, parent: Node<PgnNodeData>, path: Path, ply: number, force: boolean): void {
		let node = parent;
		let p = path;
		while (node.children.length) {
			const main = node.children[0];
			const mainPath = [...p, 0];
			force = this.inlineMove(container, main, mainPath, ply, force);
			if (node.children.length > 1) {
				const nested = container.createDiv({ cls: "cr-nested" });
				node.children.slice(1).forEach((v, j) => this.renderSideline(nested.createDiv({ cls: "cr-line" }), v, [...p, j + 1], ply, true));
				force = true;
			}
			node = main;
			p = mainPath;
			ply++;
		}
	}

	/** One move in a side line; returns whether the next move needs its number repeated. */
	private inlineMove(container: HTMLElement, node: MoveNode, path: Path, ply: number, force: boolean): boolean {
		for (const c of node.data.startingComments ?? []) {
			container.createSpan({ cls: "cr-comment", text: c });
			force = true;
		}
		const num = Math.floor(ply / 2) + 1;
		if (ply % 2 === 0) container.createSpan({ cls: "cr-num", text: `${num}.` });
		else if (force) container.createSpan({ cls: "cr-num", text: `${num}…` });
		this.moveEl(container, node, path, false, "span");
		const text = commentOf(node, this.game).text;
		if (text) {
			container.createSpan({ cls: "cr-comment", text });
			return true;
		}
		return false;
	}

	private moveEl(container: HTMLElement, node: MoveNode, path: Path, isMain: boolean, tag: "div" | "span"): HTMLElement {
		const isActive = pathKey(path) === pathKey(this.state.path);
		const m: HTMLElement = container.createEl(tag, { cls: "cr-move" + (isActive ? " is-active" : "") + (isMain ? "" : " is-side") });
		m.createSpan({ cls: "cr-san", text: node.data.san });
		for (const n of node.data.nags ?? []) {
			m.createSpan({ cls: `cr-nag cr-nag-${NAG_CLASS[n] ?? "other"}`, text: nagGlyph(n) });
		}
		if (isMain) {
			const mark = this.marks.get(path.length);
			if (mark) m.createSpan({ cls: `cr-mark cr-mark-${mark}`, attr: { "aria-label": MARK_LABEL[mark], title: MARK_LABEL[mark] } });
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
		return m;
	}

	/* ------------------------------------------------------------ */
	/* Editing                                                      */
	/* ------------------------------------------------------------ */

	private openMoveMenu(path: Path, at: { x: number; y: number }): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Comment…").setIcon("message-square").onClick(() => this.editComment(path)));
		menu.addSeparator();
		for (const [nag, glyph] of Object.entries(MOVE_NAGS)) {
			menu.addItem((i) => i.setTitle(`${glyph}  move`).onClick(() => this.edit(() => setNag(this.game, path, "move", Number(nag)))));
		}
		menu.addItem((i) => i.setTitle("Clear move symbol").onClick(() => this.edit(() => setNag(this.game, path, "move", 0))));
		menu.addSeparator();
		for (const [nag, glyph] of Object.entries(POSITION_NAGS)) {
			menu.addItem((i) => i.setTitle(`${glyph}  position`).onClick(() => this.edit(() => setNag(this.game, path, "position", Number(nag)))));
		}
		menu.addItem((i) => i.setTitle("Clear position symbol").onClick(() => this.edit(() => setNag(this.game, path, "position", 0))));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Promote variation").setIcon("arrow-up").onClick(() => this.edit(() => (this.state.path = promoteVariation(this.game, path)))));
		menu.addItem((i) => i.setTitle("Make main line").setIcon("arrow-up-to-line").onClick(() => this.edit(() => (this.state.path = makeMainline(this.game, path)))));
		menu.addItem((i) => i.setTitle("Delete from here").setIcon("trash-2").onClick(() => this.edit(() => (this.state.path = deleteFrom(this.game, path)))));
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
			const b = el.createEl("button", { cls: "cr-promo-btn", attr: { "aria-label": name } });
			const piece = b.appendChild(document.createElement("piece"));
			piece.className = `${color} ${name}`;
			b.addEventListener("click", () => {
				close();
				done(role);
			});
		}
		el.addEventListener("click", (e) => {
			if (e.target === el) {
				close();
				this.update();
			}
		}, { once: true });
	}

	/** Play a move from the current position: go to it if it exists, else add it as a side line. */
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
		// chessground also clears shapes when an empty square is tapped; that is not an edit.
		if (Date.now() - this.lastRightDown > DRAW_WINDOW_MS) {
			const node = nodeAt(this.game, this.state.path);
			if (node) this.cg?.setShapes(commentOf(node, this.game).shapes.map(toDrawShape));
			return;
		}
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
			this.lastSaved = pgn;
		} catch (e) {
			new Notice(`Chess Review: could not save the game: ${(e as Error).message}`);
		}
	}

	getPgn(): string {
		return serialise(this.game);
	}

	/** The PGN last written to the note (what a re-rendered block will contain). */
	savedPgn(): string {
		return this.lastSaved;
	}

	/** Move this board into a re-rendered block instead of rebuilding it. */
	adopt(container: HTMLElement, host: BoardHost): void {
		this.host = host;
		this.container = container;
		container.appendChild(this.root);
		window.requestAnimationFrame(() => this.cg?.redrawAll());
		if (this.state.hadFocus) {
			this.state.hadFocus = false;
			this.root.focus({ preventScroll: true });
		}
	}

	/* ------------------------------------------------------------ */
	/* Draw mode (touch-friendly arrows and circles)                */
	/* ------------------------------------------------------------ */

	private setDrawMode(on: boolean): void {
		this.state.drawMode = on;
		this.drawPending = undefined;
		this.root.toggleClass("is-drawing", on);
		this.renderDrawBar();
		this.update();
	}

	private renderDrawBar(): void {
		const el = this.els.drawBar;
		if (!el) return;
		el.empty();
		el.toggleClass("is-open", this.state.drawMode);
		this.root.toggleClass("is-drawing", this.state.drawMode);
		if (!this.state.drawMode) return;
		for (const c of DRAW_COLOURS) {
			const b = el.createEl("button", { cls: `cr-swatch cr-swatch-${c}` + (this.state.drawColour === c ? " is-selected" : ""), attr: { "aria-label": c } });
			b.addEventListener("click", () => {
				this.state.drawColour = c;
				this.renderDrawBar();
			});
		}
		el.createSpan({ cls: "cr-drawbar-hint", text: "Tap two squares for an arrow, a square twice for a circle." });
		const done = el.createEl("button", { cls: "cr-drawbar-done", text: "Done" });
		done.addEventListener("click", () => this.setDrawMode(false));
	}

	private onDrawTap(key: Key): void {
		if (!this.drawPending) {
			this.drawPending = key;
			this.renderEngine(); // refreshes auto shapes, including the pending marker
			return;
		}
		const from = parseSquare(this.drawPending);
		const to = parseSquare(key);
		this.drawPending = undefined;
		if (from === undefined || to === undefined) return;
		const node = nodeAt(this.game, this.state.path);
		if (!node) return;
		const colour = this.state.drawColour;
		const shapes = commentOf(node, this.game).shapes.slice();
		const i = shapes.findIndex((s) => s.from === from && s.to === to);
		if (i >= 0 && shapes[i].color === colour) shapes.splice(i, 1);
		else if (i >= 0) shapes[i] = { color: colour, from, to };
		else shapes.push({ color: colour, from, to });
		this.edit(() => updateComment(this.game, this.state.path, { shapes }), false);
		this.cg?.setShapes(shapes.map(toDrawShape));
		this.renderEngine();
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
		const whiteAtBottom = this.orientation() === "white";
		this.els.evalFill.style.height = `${whitePct}%`;
		this.els.evalFill.toggleClass("is-top", !whiteAtBottom);
		bar.setAttribute("aria-label", s ? formatScore(s) : "No evaluation");
		// The number sits at the end of the side that is better, as on the board's edge.
		const text = this.els.evalText;
		if (!s) {
			text.setText("");
			return;
		}
		const whiteBetter = scoreToCp(s) >= 0;
		text.setText(gaugeLabel(s));
		text.toggleClass("on-white", whiteBetter);
		text.toggleClass("at-bottom", whiteBetter === whiteAtBottom);
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
		svg.append(area, mid);
		el.appendChild(svg);
		const me = this.host.myColour;
		const startWhite = mainline(this.game)[0].pos.turn === "white";
		for (const [idx, mark] of this.marks) {
			const mover: Colour = ((idx - 1) % 2 === 0) === startWhite ? "white" : "black";
			if (me && mover !== me) continue;
			const pt = pts[idx];
			if (!pt) continue;
			const dot = el.createDiv({ cls: `cr-graph-dot cr-mark-${mark}`, attr: { title: `${MARK_LABEL[mark]} (move ${Math.ceil(idx / 2)})` } });
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

	private toggleEngine(on: boolean): void {
		this.state.engineOn = on;
		if (!on) this.state.threatOn = false;
		this.restartInteractive();
		this.renderEngine();
	}

	/** Show the opponent's best move if it were their turn (Lichess's "show threat"). */
	private toggleThreat(): void {
		this.state.threatOn = !this.state.threatOn;
		if (this.state.threatOn) this.state.engineOn = true;
		this.restartInteractive();
		this.renderEngine();
		this.updateEvalBar();
	}

	/** The position the engine looks at: the one on screen, or after a pass in threat mode. */
	private engineFen(): string | undefined {
		const fen = infoAt(this.game, this.state.path).fen;
		return this.state.threatOn ? nullMoveFen(fen) : fen;
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
		const target = this.engineFen();
		if (!target) return;
		this.interactiveTimer = window.setTimeout(() => {
			const fen = target;
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

	/** Compact engine panel: a switch, the evaluation, and up to 3 one-line PVs. */
	private renderEngine(): void {
		const el = this.els.engine;
		if (!el) return;
		el.empty();
		const info = infoAt(this.game, this.state.path);
		const threat = this.state.engineOn && this.state.threatOn;
		const target = this.engineFen();
		const rows: Array<{ score: Score; pv: string[]; depth: number }> = [];
		let label = "";
		if (this.state.engineOn && target && this.liveFen === target) {
			for (const l of this.liveLines.slice(0, 3)) rows.push({ score: l.score, pv: l.pv, depth: l.depth });
			if (rows[0]) label = `${threat ? "Threat · " : ""}depth ${rows[0].depth}`;
		} else if (!this.state.engineOn) {
			const c = this.cachedPly();
			if (c && c.pv.length) {
				rows.push({ score: c.score, pv: c.pv, depth: c.depth });
				label = c.source === "cloud" ? `cloud · depth ${c.depth}` : `saved · depth ${c.depth}`;
			}
		}

		const head = el.createDiv({ cls: "cr-ceval-head" });
		const sw = head.createEl("label", { cls: "cr-switch", attr: { "aria-label": "Local engine" } });
		const input = sw.createEl("input", { attr: { type: "checkbox" } });
		input.checked = this.state.engineOn;
		sw.createSpan({ cls: "cr-switch-track" });
		input.addEventListener("change", () => this.toggleEngine(input.checked));
		head.createSpan({ cls: "cr-ceval-score", text: rows[0] && !threat ? formatScore(rows[0].score) : "" });
		let idle = "Stockfish 18";
		if (this.state.engineOn) idle = info.pos.isEnd() ? "Game over" : threat && !target ? "No threat while in check" : threat ? "Threat · calculating…" : "Calculating…";
		head.createSpan({ cls: "cr-ceval-label", text: label || idle });
		const tb = head.createEl("button", {
			cls: "cr-threat clickable-icon" + (this.state.threatOn ? " is-on" : ""),
			attr: { "aria-label": "Show threat (X)" },
		});
		setIcon(tb, "crosshair");
		tb.addEventListener("click", () => this.toggleThreat());

		const auto: DrawShape[] = [];
		if (this.drawPending) auto.push({ orig: this.drawPending, brush: BRUSH[this.state.drawColour] });
		if (rows.length) {
			const pvs = el.createDiv({ cls: "cr-pvs" + (threat ? " is-threat" : "") });
			const pvPos = threat && target ? positionFromFen(target) : info.pos;
			for (const r of rows) {
				const row = pvs.createDiv({ cls: "cr-pv", attr: threat ? {} : { title: "Play the first move" } });
				row.createSpan({ cls: "cr-pv-score", text: formatScore(r.score) });
				row.createSpan({ cls: "cr-pv-moves", text: pvPos ? this.pvSan(pvPos, r.pv) : r.pv.join(" ") });
				// Threat lines start from a passed move, so they cannot be played here.
				if (!threat) row.addEventListener("click", () => {
					if (r.pv[0]) this.playUci(r.pv[0]);
				});
			}
			const best = rows[0].pv[0];
			if (best && best.length >= 4) {
				auto.push({
					orig: best.slice(0, 2) as Key,
					dest: best.slice(2, 4) as Key,
					brush: threat ? "paleRed" : "paleBlue",
					modifiers: { lineWidth: ENGINE_ARROW_WIDTH },
				});
			}
		}
		this.cg?.setAutoShapes(auto);
	}

	private pvSan(start: Position, pv: string[]): string {
		try {
			const ok = [];
			const p = start.clone();
			for (const u of pv) {
				const m = parseMoveUci(p, u);
				if (!m || !p.isLegal(m)) break;
				ok.push(m);
				p.play(m);
			}
			return makeSanVariation(start, ok);
		} catch {
			return pv.join(" ");
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
