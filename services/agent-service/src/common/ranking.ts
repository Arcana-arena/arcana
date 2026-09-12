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
