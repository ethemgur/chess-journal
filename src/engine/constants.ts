/** Mistake thresholds as a drop in winning chances (W runs from -1 to +1). */
export const THRESHOLDS = {
	inaccuracy: 0.1,
	mistake: 0.2,
	blunder: 0.3,
} as const;

/** A mate score counts as this many centipawns. */
export const MATE_CP = 10_000;
/** Scores are clamped to this for the winning-chances model. */
export const WIN_CHANCE_CLAMP_CP = 1_000;
/** Per-move centipawn loss is clamped to 0..this for ACPL. */
export const ACPL_LOSS_CLAMP = 1_000;
/** Lichess's winning-chances coefficient. */
export const WIN_CHANCE_K = 0.00368208;

/** Cloud eval: at most this many opening plies per game. */
export const CLOUD_EVAL_MAX_PLIES = 20;
