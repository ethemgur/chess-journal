/** Lichess cloud eval: a handful of opening positions per game, one request at a time. */
import { Http, RateLimitedError } from "../sources/http";
import type { PlyAnalysis } from "./types";

export const CLOUD_EVAL_URL = "https://lichess.org/api/cloud-eval";

interface CloudEvalBody {
	fen: string;
	depth: number;
	pvs: Array<{ moves: string; cp?: number; mate?: number }>;
}

/** Returns undefined on 404 (position not in the database). Scores are White's point of view. */
export async function cloudEval(http: Http, fen: string, ply: number): Promise<PlyAnalysis | undefined> {
	const res = await http({ url: `${CLOUD_EVAL_URL}?fen=${encodeURIComponent(fen)}&multiPv=1`, headers: { Accept: "application/json" } });
	if (res.status === 404) return undefined;
	if (res.status === 429) throw new RateLimitedError("Lichess");
	if (res.status !== 200) return undefined;
	const body = JSON.parse(res.text) as CloudEvalBody;
	const pv = body.pvs?.[0];
	if (!pv) return undefined;
	const moves = pv.moves.split(" ").filter(Boolean);
	return {
		ply,
		fen,
		score: pv.mate !== undefined ? { mate: pv.mate } : { cp: pv.cp ?? 0 },
		best: moves[0] ?? "",
		pv: moves.slice(0, 8),
		depth: body.depth,
		source: "cloud",
	};
}
