/**
 * chessops wrapper: parse a PGN into an editable tree, navigate it by path,
 * edit it, and serialise it back to standard PGN.
 *
 * A path is the list of child indices from the root (the starting position).
 * `[]` is the start, `[0, 0, 1]` is the second alternative at ply 3, and so on.
 */
import { Chess, Position, normalizeMove } from "chessops/chess";
import { makeFen } from "chessops/fen";
import {
	ChildNode,
	Comment,
	CommentShape,
	Game,
	Node,
	PgnNodeData,
	emptyHeaders,
	makeComment,
	parseComment,
	parsePgn,
	startingPosition,
} from "chessops/pgn";
import { makeSan, parseSan } from "chessops/san";
import { Move } from "chessops/types";
import { makeSquare, makeUci, parseUci, squareFile, squareRank } from "chessops/util";

export type Path = number[];
export type PgnGame = Game<PgnNodeData>;

export class PgnParseError extends Error {}

export const pathKey = (p: Path): string => p.join(".");
export const samePath = (a: Path, b: Path): boolean => pathKey(a) === pathKey(b);

/** Split a text holding one or more PGN games into one string per game. */
export function splitPgnGames(text: string): string[] {
	const out: string[] = [];
	const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
	let cur: string[] = [];
	let inMoves = false;
	for (const line of lines) {
		const isHeader = /^\s*\[[A-Za-z0-9_]+\s+".*"\s*\]\s*$/.test(line);
		if (isHeader && inMoves) {
			if (cur.join("").trim()) out.push(cur.join("\n").trim());
			cur = [];
			inMoves = false;
		}
		if (!isHeader && line.trim() && !line.trim().startsWith("%")) inMoves = true;
		cur.push(line);
	}
	if (cur.join("").trim()) out.push(cur.join("\n").trim());
	return out;
}

/** Parse exactly one game. Throws PgnParseError with a readable message. */
export function parseGame(pgn: string): PgnGame {
	const text = pgn.replace(/^\uFEFF/, "").trim();
	if (!text) throw new PgnParseError("The block is empty. Paste a PGN game here.");
	const games = parsePgn(text, emptyHeaders);
	if (games.length === 0) throw new PgnParseError("No PGN game found.");
	const game = games[0];
	if (game.headers.size === 0 && game.moves.children.length === 0 && !(game.comments?.length)) {
		throw new PgnParseError("This does not look like PGN: no tags and no moves were found.");
	}
	const variant = game.headers.get("Variant");
	if (variant && !/^(standard|chess|from position)$/i.test(variant)) {
		throw new PgnParseError(`Variant "${variant}" is not supported; only standard chess.`);
	}
	const start = startingPosition(game.headers);
	if (start.isErr) throw new PgnParseError(`Invalid starting position (FEN tag): ${start.error.message}`);
	// Check that every move in every line is legal.
	const check = (node: Node<PgnNodeData>, pos: Position, ply: number) => {
		node.children.forEach((child, i) => {
			const move = parseSan(pos, child.data.san);
			if (!move) {
				const num = Math.floor(ply / 2) + 1;
				const side = ply % 2 ? "Black" : "White";
				const where = i === 0 ? "" : ", in a variation";
				throw new PgnParseError(`Illegal or unreadable move "${child.data.san}" at move ${num} (${side}${where}).`);
			}
			const next = pos.clone();
			next.play(move);
			check(child, next, ply + 1);
		});
	};
	check(game.moves, start.value, startPly(start.value));
	return game;
}

/** Ply index of a position: 0 for the standard start, 1 after White's first move... */
/** UCI with castling written as the king's two-square move (e1g1), as engines expect. */
export function standardUci(pos: Position, move: Move): string {
	if ("from" in move) {
		const piece = pos.board.get(move.from);
		const target = pos.board.get(move.to);
		if (piece?.role === "king" && target?.role === "rook" && target.color === piece.color) {
			const file = squareFile(move.to) > squareFile(move.from) ? 6 : 2;
			return makeSquare(move.from) + makeSquare(squareRank(move.from) * 8 + file);
		}
	}
	return makeUci(move);
}

/** Parse a UCI move (either castling notation) into the form chessops plays. */
export function parseMoveUci(pos: Position, uci: string): Move | undefined {
	const m = parseUci(uci);
	return m && normalizeMove(pos, m);
}

export function startPly(pos: Position): number {
	return (pos.fullmoves - 1) * 2 + (pos.turn === "white" ? 0 : 1);
}

export function initialPosition(game: PgnGame): Position {
	const r = startingPosition(game.headers);
	return r.isOk ? r.value : Chess.default();
}

export function nodeAt(game: PgnGame, path: Path): Node<PgnNodeData> | undefined {
	let node: Node<PgnNodeData> = game.moves;
	for (const i of path) {
		const next = node.children[i];
		if (!next) return undefined;
		node = next;
	}
	return node;
}

export interface PathInfo {
	pos: Position;
	fen: string;
	ply: number;
	lastMove?: Move;
	lastUci?: string;
	node: Node<PgnNodeData>;
}

/** Walk a path from the start and return the position reached. */
export function infoAt(game: PgnGame, path: Path): PathInfo {
	const pos = initialPosition(game);
	let node: Node<PgnNodeData> = game.moves;
	let ply = startPly(pos);
	let lastMove: Move | undefined;
	let lastUci: string | undefined;
	for (const i of path) {
		const child = node.children[i];
		if (!child) break;
		const move = parseSan(pos, child.data.san);
		if (!move) break;
		lastUci = standardUci(pos, move);
		pos.play(move);
		lastMove = move;
		node = child;
		ply++;
	}
	return { pos, fen: makeFen(pos.toSetup()), ply, lastMove, lastUci, node };
}

/** Path of the main line from the start to its end. */
export function mainlinePath(game: PgnGame): Path {
	const p: Path = [];
	let node: Node<PgnNodeData> = game.moves;
	while (node.children.length) {
		p.push(0);
		node = node.children[0];
	}
	return p;
}

/** Positions along the main line: index 0 is the start. */
export interface MainlinePly {
	ply: number;
	fen: string;
	san?: string;
	uci?: string;
	node?: ChildNode<PgnNodeData>;
	pos: Position;
}

export function mainline(game: PgnGame): MainlinePly[] {
	const pos = initialPosition(game);
	const out: MainlinePly[] = [{ ply: startPly(pos), fen: makeFen(pos.toSetup()), pos: pos.clone() }];
	let ply = startPly(pos);
	for (const node of game.moves.mainlineNodes()) {
		const move = parseSan(pos, node.data.san);
		if (!move) break;
		const uci = standardUci(pos, move);
		pos.play(move);
		ply++;
		out.push({ ply, fen: makeFen(pos.toSetup()), san: node.data.san, uci, node, pos: pos.clone() });
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Comments, clocks, shapes                                            */
/* ------------------------------------------------------------------ */

export function commentOf(node: Node<PgnNodeData>, game: PgnGame): Comment {
	const raw = node instanceof ChildNode ? node.data.comments ?? [] : game.comments ?? [];
	return parseComment(raw.join(" "));
}

/** Rewrite a node's comments keeping clock/eval/emt commands; only text/shapes change. */
export function updateComment(
	game: PgnGame,
	path: Path,
	change: { text?: string; shapes?: CommentShape[] },
): void {
	const node = nodeAt(game, path);
	if (!node) return;
	const current = commentOf(node, game);
	const next: Partial<Comment> = {
		text: (change.text ?? current.text).replace(/[{}]/g, "").trim(),
		shapes: change.shapes ?? current.shapes,
		clock: current.clock,
		emt: current.emt,
		evaluation: current.evaluation,
	};
	const str = makeComment(next).trim();
	const comments = str ? [str] : [];
	if (node instanceof ChildNode) node.data.comments = comments;
	else game.comments = comments;
}

/** Remaining clock (seconds) after the move at this node, if `%clk` is present. */
export function clockOf(node: Node<PgnNodeData>, game: PgnGame): number | undefined {
	if (!(node instanceof ChildNode)) return undefined;
	return commentOf(node, game).clock;
}

/** Parse a PGN TimeControl tag: "600+5" -> {base: 600, inc: 5}. */
export function parseTimeControl(tc?: string): { base: number; inc: number } | undefined {
	if (!tc) return undefined;
	const m = /^(\d+)(?:\+(\d+))?$/.exec(tc.trim());
	if (!m) return undefined;
	return { base: Number(m[1]), inc: m[2] ? Number(m[2]) : 0 };
}

/**
 * Time spent on each main-line move, from consecutive `%clk` values plus the
 * increment. Keyed by main-line ply index (1 = first move).
 */
export function timeSpent(game: PgnGame): Map<number, number> {
	const tc = parseTimeControl(game.headers.get("TimeControl"));
	const plies = mainline(game);
	const out = new Map<number, number>();
	for (let i = 1; i < plies.length; i++) {
		const clk = plies[i].node && clockOf(plies[i].node as ChildNode<PgnNodeData>, game);
		if (clk === undefined) continue;
		let prev: number | undefined;
		if (i >= 3) {
			const p = plies[i - 2].node;
			prev = p ? clockOf(p, game) : undefined;
		} else if (tc) prev = tc.base;
		if (prev === undefined) continue;
		out.set(i, Math.max(0, prev - clk + (tc?.inc ?? 0)));
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* NAGs                                                                */
/* ------------------------------------------------------------------ */

export const MOVE_NAGS: Record<number, string> = { 1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!" };
export const POSITION_NAGS: Record<number, string> = {
	10: "=", 13: "∞", 14: "+/=", 15: "=/+", 16: "+/-", 17: "-/+", 18: "+-", 19: "-+",
};
export const OTHER_NAGS: Record<number, string> = {
	7: "□", 22: "⨀", 23: "⨀", 32: "⟳", 33: "⟳", 36: "→", 37: "→", 40: "↑", 41: "↑", 132: "⇆", 133: "⇆",
	140: "∆", 146: "N",
};

export function nagGlyph(nag: number): string {
	return MOVE_NAGS[nag] ?? POSITION_NAGS[nag] ?? OTHER_NAGS[nag] ?? `$${nag}`;
}

const isMoveNag = (n: number) => n >= 1 && n <= 6;
const isPositionNag = (n: number) => n >= 10 && n <= 19;

/** Set (or with nag=0 clear) the move or position symbol on a node, replacing the old one of the same kind. */
export function setNag(game: PgnGame, path: Path, kind: "move" | "position", nag: number): void {
	const node = nodeAt(game, path);
	if (!(node instanceof ChildNode)) return;
	const same = kind === "move" ? isMoveNag : isPositionNag;
	const nags: number[] = (node.data.nags ?? []).filter((n: number) => !same(n));
	if (nag) nags.push(nag);
	nags.sort((a: number, b: number) => a - b);
	node.data.nags = nags.length ? nags : undefined;
}

/* ------------------------------------------------------------------ */
/* Tree edits                                                          */
/* ------------------------------------------------------------------ */

/**
 * Play a move from `path`. If it already exists among the children, return its
 * path; otherwise add it (as main continuation if at the end of a line, else as
 * a new variation) and return the new path.
 */
export function addMove(game: PgnGame, path: Path, uci: string): Path | undefined {
	const info = infoAt(game, path);
	const move = parseMoveUci(info.pos, uci);
	if (!move || !info.pos.isLegal(move)) return undefined;
	const parent = info.node;
	const pos = info.pos;
	for (let i = 0; i < parent.children.length; i++) {
		const m = parseSan(pos, parent.children[i].data.san);
		if (m && makeUci(m) === makeUci(move)) return [...path, i];
	}
	const san = makeSan(pos, move);
	parent.children.push(new ChildNode<PgnNodeData>({ san }));
	return [...path, parent.children.length - 1];
}

/** Move the variation containing `path` one step up at its nearest branch point. */
export function promoteVariation(game: PgnGame, path: Path): Path {
	for (let d = path.length - 1; d >= 0; d--) {
		if (path[d] > 0) {
			const parent = nodeAt(game, path.slice(0, d));
			if (!parent) return path;
			const i = path[d];
			[parent.children[i - 1], parent.children[i]] = [parent.children[i], parent.children[i - 1]];
			const np = [...path];
			np[d] = i - 1;
			return np;
		}
	}
	return path;
}

/** Make the line through `path` the main line at every branch point. */
export function makeMainline(game: PgnGame, path: Path): Path {
	let node: Node<PgnNodeData> = game.moves;
	for (const i of path) {
		const child = node.children[i];
		if (i > 0) {
			node.children.splice(i, 1);
			node.children.unshift(child);
		}
		node = child;
	}
	return path.map(() => 0);
}

/** Delete the node at `path` and everything after it. Returns the parent path. */
export function deleteFrom(game: PgnGame, path: Path): Path {
	if (!path.length) return path;
	const parentPath = path.slice(0, -1);
	const parent = nodeAt(game, parentPath);
	if (parent) parent.children.splice(path[path.length - 1], 1);
	return parentPath;
}

/** Add a line of UCI moves as a variation from `path` (used to keep an engine line). */
export function addLine(game: PgnGame, path: Path, ucis: string[]): Path {
	let p = path;
	for (const u of ucis) {
		const np = addMove(game, p, u);
		if (!np) break;
		p = np;
	}
	return p;
}

/* ------------------------------------------------------------------ */
/* Serialise                                                           */
/* ------------------------------------------------------------------ */

const escapeTag = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const commentToken = (c: string) => `{ ${c.replace(/[{}]/g, "").trim()} }`;

/**
 * Write a game as PGN: tags in their original order, move numbers re-indicated
 * after comments and variations (PGN export format), lines wrapped at 80.
 */
export function serialise(game: PgnGame): string {
	const lines: string[] = [];
	for (const [k, v] of game.headers) lines.push(`[${k} "${escapeTag(v)}"]`);
	const tokens: string[] = [];
	for (const c of game.comments ?? []) tokens.push(commentToken(c));
	const pos = initialPosition(game);
	writeLine(game.moves, startPly(pos), true, tokens);
	tokens.push(game.headers.get("Result") ?? "*");
	const movetext = wrap(tokens, 80);
	return (lines.length ? lines.join("\n") + "\n\n" : "") + movetext;
}

function moveTokens(node: ChildNode<PgnNodeData>, ply: number, force: boolean, out: string[]): boolean {
	for (const c of node.data.startingComments ?? []) {
		out.push(commentToken(c));
		force = true;
	}
	const num = Math.floor(ply / 2) + 1;
	if (ply % 2 === 0) out.push(`${num}.`);
	else if (force) out.push(`${num}...`);
	out.push(node.data.san);
	for (const n of node.data.nags ?? []) out.push(`$${n}`);
	const comments = node.data.comments ?? [];
	for (const c of comments) out.push(commentToken(c));
	return comments.length > 0;
}

function writeLine(parent: Node<PgnNodeData>, ply: number, force: boolean, out: string[]): void {
	let node = parent;
	while (node.children.length) {
		const main = node.children[0];
		force = moveTokens(main, ply, force, out);
		for (const v of node.children.slice(1)) {
			out.push("(");
			const f = moveTokens(v, ply, true, out);
			writeLine(v, ply + 1, f, out);
			out.push(")");
			force = true;
		}
		node = main;
		ply++;
	}
}

function wrap(raw: string[], width: number): string {
	// Keep "(" glued to the token after it so a line never ends with an open parenthesis.
	const tokens: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "(" && i + 1 < raw.length) tokens.push("(" + raw[++i]);
		else tokens.push(raw[i]);
	}
	const lines: string[] = [];
	let cur = "";
	for (const t of tokens) {
		const sep = cur === "" || t === ")" ? "" : " ";
		if (cur && cur.length + sep.length + t.length > width) {
			lines.push(cur);
			cur = t;
		} else cur += sep + t;
	}
	if (cur) lines.push(cur);
	return lines.join("\n");
}

/** Canonical form used to compare PGNs "apart from whitespace". */
export function normalisePgnForCompare(pgn: string): string {
	const glyphs: Record<string, string> = { "!!": "$3", "??": "$4", "!?": "$5", "?!": "$6", "!": "$1", "?": "$2" };
	return pgn
		.replace(/\r\n?/g, "\n")
		.replace(/\{([^}]*)\}/g, (_m, c: string) => `{${c.replace(/\s+/g, " ").trim()}}`)
		.replace(/([a-hNBRQKO1-8x=+#-])(!!|\?\?|!\?|\?!|!|\?)(?=[\s){]|$)/g, (_m, a: string, g: string) => `${a} ${glyphs[g]}`)
		.replace(/\s+/g, "")
		.trim();
}

/** Short stable hash (FNV-1a, hex) of a PGN, ignoring whitespace. */
export function pgnHash(pgn: string): string {
	const s = pgn.replace(/\s+/g, " ").trim();
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}
