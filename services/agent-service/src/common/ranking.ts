/**
 * How many recorded decisions an agent needs before it is ranked.
 *
 * WHY THIS FILE EXISTS. The number 5 was written out six times: five TypeScript
 * files (series, passport, dna, autopsy, evolution) and `minParticipationDecisions`
 * in the scoring engine. Nothing checked that they agreed. Five copies agree on
 * every day they still agree, and the day they stop, an agent is ranked by one
 * endpoint and withheld by another — with no error anywhere, because each copy
 * is individually correct.
 *
 * THE AUTHORITY IS GO, not this file. `minParticipationDecisions` in
 * services/scoring-engine/internal/engine/score.go is the constant that decides
 * whether a score is written at all: below it the engine stores NULL for
 * `arcana_score`, `risk_score` and `consistency_score`, and that NULL is the
 * stored verdict every reader here is describing. This constant exists so the
 * TypeScript side has one place to be wrong, and `leaderboard-verify` holds it
 * to the Go one.
 *
 * WHAT RANKED-NESS IS NOT. It is not a judgement about quality. An unranked
 * agent has not competed enough to be measured, which is a different statement
 * from measuring badly — and the whole point of carrying a reason alongside the
 * flag is that a reader can tell those apart.
 */
export const MIN_DECISIONS = 5;

/**
 * The sentence that goes with `ranked: false`.
 *
 * ONE WORDING, because this is the sentence a user reads when their agent is
 * missing from a list they expected to be in. Three services phrasing it three
 * ways would make the same fact look like three different problems.
 */
export function unrankedNote(decisions: number): string {
  return (
    `This agent has ${decisions} recorded decision(s), below the ${MIN_DECISIONS} needed to be ` +
    'ranked. That is not a low score — it is not enough of a record to score at all, so the ' +
    'composite, risk and consistency figures are withheld rather than estimated.'
  );
}

/**
 * How the composite is weighted — and the two factors that are not weights.
 *
 * THE AUTHORITY IS GO, exactly as it is for MIN_DECISIONS above.
 * services/scoring-engine/internal/engine/score.go declares wPerformance,
 * wRisk, wConsistency, wRegime, wCreator and wLongevity, and they sum to 1.0.
 * This constant exists so the read surface has ONE place to be wrong, and
 * leaderboard-verify holds it to the Go one — the same arrangement that keeps
 * MIN_DECISIONS honest.
 *
 * STRATEGY IS NOT IN THIS MAP BECAUSE IT IS NOT A TERM. Since 2026-09-09 it is
 * a MULTIPLIER on the weighted total, not a summand: an agent that does what it
 * said keeps 100% of what it earned, and a mislabelled one keeps less. Printing
 * it as a seventh weight — as the original design did — would tell a reader it
 * trades off against performance, which it does not.
 *
 * REGIME HAS A WEIGHT AND MEASURES NOTHING. The classifier is not implemented
 * and the engine writes the same neutral value for every agent, so the 0.10 is
 * real arithmetic over a constant. That is worth showing precisely because it
 * looks like a measurement and is not.
 */
export const SCORE_WEIGHTS: Record<string, number> = {
  performance: 0.35,
  risk: 0.25,
  consistency: 0.15,
  regime: 0.10,
  longevity: 0.10,
  creator: 0.05,
};

/** Said once, so every surface says it the same way. */
export const STRATEGY_NOTE =
  'Strategy is a multiplier on the weighted total, not one of its terms. An agent that behaves ' +
  'like the strategy it declared keeps everything it earned; one that does not keeps less.';

export const REGIME_WEIGHT_NOTE =
  'Regime carries a weight and measures nothing yet: the classifier is not implemented and the ' +
  'engine writes the same neutral value for every agent, so this term is arithmetic over a ' +
  'constant rather than a judgement about this agent.';
