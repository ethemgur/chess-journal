/** Lichess export client: GET /api/games/user/{username} as NDJSON, fetched in windows. */
import type { TimeClass } from "../types";
import { Http, HttpError, RateLimitedError } from "./http";
import type { LichessGame } from "./normalise";

export const LICHESS_HOST = "https://lichess.org";

const PERF_TYPES: Record<TimeClass, string[]> = {
	bullet: ["ultraBullet", "bullet"],
	blitz: ["blitz"],
	rapid: ["rapid"],
	classical: ["classical"],
	daily: ["correspondence"],
};

export interface LichessWindowOptions {
	username: string;
	token?: string;
	since: number; // ms, inclusive
	until: number; // ms, inclusive
	timeClasses: TimeClass[];
	ratedOnly: boolean;
}

/** What every export asks for: PGN, clocks, and Lichess's computer analysis when the game has one. */
const EXPORT_FIELDS = { pgnInJson: "true", clocks: "true", evals: "true", opening: "true", accuracy: "true" };

/** Most game IDs one POST /api/games/export/_ids request may carry. */
export const LICHESS_IDS_PER_REQUEST = 300;

export function lichessExportUrl(o: LichessWindowOptions): string {
	const q = new URLSearchParams({
		since: String(o.since),
		until: String(o.until),
		...EXPORT_FIELDS,
		sort: "dateAsc",
		finished: "true",
		ongoing: "false",
	});
	if (o.ratedOnly) q.set("rated", "true");
	const perfs = o.timeClasses.flatMap((c) => PERF_TYPES[c]);
	if (perfs.length) q.set("perfType", perfs.join(","));
	return `${LICHESS_HOST}/api/games/user/${encodeURIComponent(o.username)}?${q.toString()}`;
}

function headersFor(token?: string): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/x-ndjson" };
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function checkStatus(status: number, username?: string): void {
	if (status === 429) throw new RateLimitedError("Lichess");
	if (status === 404 && username) throw new HttpError(404, `Lichess user "${username}" was not found.`);
	if (status === 401) throw new HttpError(401, "Lichess rejected the API token.");
	if (status >= 400) throw new HttpError(status, `Lichess returned HTTP ${status}.`);
}

/** requestUrl cannot stream, so the whole NDJSON body is split on newlines. */
function parseNdjson(text: string): LichessGame[] {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as LichessGame);
}

/** Fetch one window. */
export async function fetchLichessWindow(http: Http, o: LichessWindowOptions): Promise<LichessGame[]> {
	const res = await http({ url: lichessExportUrl(o), headers: headersFor(o.token) });
	checkStatus(res.status, o.username);
	return parseNdjson(res.text);
}

/** Fetch known games by ID (at most LICHESS_IDS_PER_REQUEST), e.g. to see whether they have been analysed since. */
export async function fetchLichessByIds(http: Http, ids: string[], token?: string): Promise<LichessGame[]> {
	if (!ids.length) return [];
	const q = new URLSearchParams(EXPORT_FIELDS);
	const res = await http({
		url: `${LICHESS_HOST}/api/games/export/_ids?${q.toString()}`,
		method: "POST",
		headers: { ...headersFor(token), "Content-Type": "text/plain" },
		body: ids.slice(0, LICHESS_IDS_PER_REQUEST).join(","),
	});
	checkStatus(res.status);
	return parseNdjson(res.text);
}

/** One-month windows [since, until] covering [from, to]. */
export function monthWindows(from: number, to: number): Array<{ since: number; until: number }> {
	const out: Array<{ since: number; until: number }> = [];
	let start = from;
	while (start <= to) {
		const d = new Date(start);
		const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
		const end = Math.min(next - 1, to);
		out.push({ since: start, until: end });
		start = next;
	}
	return out;
}
