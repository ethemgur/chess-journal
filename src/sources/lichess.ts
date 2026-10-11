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

export function lichessExportUrl(o: LichessWindowOptions): string {
	const q = new URLSearchParams({
		since: String(o.since),
		until: String(o.until),
		pgnInJson: "true",
		clocks: "true",
		evals: "true",
		opening: "true",
		accuracy: "true",
		sort: "dateAsc",
		finished: "true",
		ongoing: "false",
	});
	if (o.ratedOnly) q.set("rated", "true");
	const perfs = o.timeClasses.flatMap((c) => PERF_TYPES[c]);
	if (perfs.length) q.set("perfType", perfs.join(","));
	return `${LICHESS_HOST}/api/games/user/${encodeURIComponent(o.username)}?${q.toString()}`;
}

/** Fetch one window. requestUrl cannot stream, so the whole body is split on newlines. */
export async function fetchLichessWindow(http: Http, o: LichessWindowOptions): Promise<LichessGame[]> {
	const headers: Record<string, string> = { Accept: "application/x-ndjson" };
	if (o.token) headers.Authorization = `Bearer ${o.token}`;
	const res = await http({ url: lichessExportUrl(o), headers });
	if (res.status === 429) throw new RateLimitedError("Lichess");
	if (res.status === 404) throw new HttpError(404, `Lichess user "${o.username}" was not found.`);
	if (res.status === 401) throw new HttpError(401, "Lichess rejected the API token.");
	if (res.status >= 400) throw new HttpError(res.status, `Lichess returned HTTP ${res.status}.`);
	return res.text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as LichessGame);
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
