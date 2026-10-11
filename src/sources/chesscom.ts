/** chess.com PubAPI client: monthly archives, strictly serial, with ETags. */
import { Http, HttpError, RateLimitedError } from "./http";
import type { ChesscomGame } from "./normalise";

export const CHESSCOM_HOST = "https://api.chess.com";

export function chesscomUserAgent(version: string, username: string, email: string): string {
	return `chess-journal/${version} (username: ${username}; contact: ${email || "not given"})`;
}

export async function fetchArchiveList(http: Http, username: string, userAgent: string): Promise<string[]> {
	const res = await http({
		url: `${CHESSCOM_HOST}/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`,
		headers: { "User-Agent": userAgent, Accept: "application/json" },
	});
	if (res.status === 429) throw new RateLimitedError("chess.com");
	if (res.status === 404) throw new HttpError(404, `chess.com user "${username}" was not found.`);
	if (res.status >= 400) throw new HttpError(res.status, `chess.com returned HTTP ${res.status}.`);
	const body = JSON.parse(res.text) as { archives?: string[] };
	return body.archives ?? [];
}

export type MonthResult = { status: "unchanged" } | { status: "ok"; games: ChesscomGame[]; etag?: string };

export async function fetchMonth(http: Http, url: string, userAgent: string, etag?: string): Promise<MonthResult> {
	const headers: Record<string, string> = { "User-Agent": userAgent, Accept: "application/json" };
	if (etag) headers["If-None-Match"] = etag;
	const res = await http({ url, headers });
	if (res.status === 304) return { status: "unchanged" };
	if (res.status === 429) throw new RateLimitedError("chess.com");
	if (res.status >= 400) throw new HttpError(res.status, `chess.com returned HTTP ${res.status}.`);
	const body = JSON.parse(res.text) as { games?: ChesscomGame[] };
	return { status: "ok", games: body.games ?? [], etag: res.headers["etag"] };
}

/** "https://api.chess.com/pub/player/x/games/2026/05" -> "2026-05". */
export function archiveMonth(url: string): string {
	const m = /\/(\d{4})\/(\d{2})\/?$/.exec(url);
	return m ? `${m[1]}-${m[2]}` : "";
}
