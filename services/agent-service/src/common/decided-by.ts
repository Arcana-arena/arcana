/**
 * Who decided a decision — the one place that answers it.
 *
 * WHY THIS IS NOT A ONE-LINE TERNARY IN THE SERIALISER. Because the answer is
 * not `decider === 'protective'`. That reading is wrong on the data this
 * platform already holds: of the rows marked `protective`, only the `sell`s
 * carrying `stop_loss` or `take_profit` are exits a level actually took. The
 * rest are `hold`s carrying `cost_budget_exceeded` — rows the engine writes when
 * a level WAS crossed and the exit was NOT taken because the cost meter refused
 * it. Those two are close to opposite facts, and a page that labels both
 * "protective exit" says a stop fired when it did not.
 *
 * The passport already counts these correctly, in SQL, in aggregate
 * (passport.service.ts, loadParticipation). This is the per-row counterpart of
 * the SAME rule, and decided-by-verify aggregates what this function returns
 * and requires the totals to equal the passport's. Two implementations of one
 * rule are allowed to exist here only because something fails when they
 * disagree.
 *
 * NULL IS ITS OWN ANSWER. Rows written before `decider` existed do not say who
 * acted. They are not folded into the agent's column and not folded into the
 * platform's: "not recorded" is a third thing, and the counts that matter would
 * both be overstated by picking either side.
 *
 * The vocabulary of `decider` itself is closed by the engine:
 *   engine.DeciderProtective = "protective"   (protective.go)
 *   deterministicDecider.Name() = "deterministic"
 *   llmDecider.Name() = "llm"
 * and NULL. Anything else is new and is reported as unknown rather than guessed
 * into one of the buckets.
 */

/** The reason codes a protective decision carries (engine/protective.go). */
export const REASON_STOP_LOSS = 'stop_loss';
export const REASON_TAKE_PROFIT = 'take_profit';
/** engine/costmeter.go — the brake that can refuse even a stop loss. */
export const REASON_COST_BUDGET = 'cost_budget_exceeded';

/** engine/protective.go */
export const DECIDER_PROTECTIVE = 'protective';

export type DecidedByCategory =
  /** The agent's own call: a decider is recorded and it is not the platform. */
  | 'agent'
  /** A level fired and the position was sold. */
  | 'protective_exit'
  /** A level was crossed and the exit was NOT taken. */
  | 'protective_held_back'
  /** Marked protective, but matching neither of the two above. */
  | 'protective_other'
  /** `decider` is NULL: the row does not say. */
  | 'unattributed';

export type DecidedBy = {
  category: DecidedByCategory;
  /** Short enough for a table cell. */
  label: string;
  /** One sentence a reader can act on. Always present. */
  note: string;
  /** The columns, verbatim, so nothing here has to be trusted. */
  decider: string | null;
  reason_code: string | null;
};

/**
 * Classify one row.
 *
 * Takes the three columns it actually depends on and nothing else. It never
 * substitutes a default: a NULL decider comes back as `unattributed`, and an
 * unrecognised decider comes back marked unknown rather than quietly counted
 * as the agent's.
 */
export function decidedBy(row: {
  action: string | null | undefined;
  decider: string | null | undefined;
  reason_code: string | null | undefined;
}): DecidedBy {
  const decider = row.decider ?? null;
  const reason = row.reason_code ?? null;
  const action = (row.action ?? '').toLowerCase();

  if (decider === null || decider === '') {
    return {
      category: 'unattributed',
      label: 'not recorded',
      note:
        'This row predates the decider column, so it does not say whether the agent or a ' +
        'protective level acted. That is not the same as the agent having decided it.',
      decider: decider === '' ? '' : null,
      reason_code: reason,
    };
  }

  if (decider === DECIDER_PROTECTIVE) {
    if (action !== 'hold' && (reason === REASON_STOP_LOSS || reason === REASON_TAKE_PROFIT)) {
      return {
        category: 'protective_exit',
        label: reason === REASON_STOP_LOSS ? 'stop-loss exit' : 'take-profit exit',
        note:
          reason === REASON_STOP_LOSS
            ? 'The platform sold this position because the price crossed the stop it was holding. ' +
              'The agent did not decide this trade and is not credited with it.'
            : 'The platform sold this position because the price reached the target it was holding. ' +
              'The agent did not decide this trade and is not credited with it.',
        decider,
        reason_code: reason,
      };
    }
    if (action === 'hold') {
      return {
        category: 'protective_held_back',
        label: 'level crossed · exit NOT taken',
        note:
          reason === REASON_COST_BUDGET
            ? 'A protective level was crossed and the exit was refused by the cost meter. The level ' +
              'stays armed, and the position is still open — this row is the record of a stop that ' +
              'did not fire, not of a decision to hold.'
            : 'A protective level was crossed and no sale was recorded' +
              (reason ? ` (${reason})` : '') +
              '. The position is still open.',
        decider,
        reason_code: reason,
      };
    }
    return {
      category: 'protective_other',
      label: 'protective',
      note:
        'Marked as decided by the platform rather than by the agent, with a reason this page has ' +
        `not been taught${reason ? `: ${reason}` : ' and no reason code'}. It is shown as-is.`,
      decider,
      reason_code: reason,
    };
  }

  // Everything else with a recorded decider is the agent acting, which is the
  // same rule the passport counts by: NOT NULL and NOT 'protective'.
  const known = decider === 'deterministic' || decider === 'llm' || decider === 'human';
  return {
    category: 'agent',
    label: known ? `agent · ${decider}` : `agent · ${decider} (unrecognised)`,
    note: known
      ? `The agent's own decision, produced by its ${decider} decider.`
      : `The agent's own decision. The decider "${decider}" is not one this build knows about; it is ` +
        'printed as recorded rather than mapped onto a known one.',
    decider,
    reason_code: reason,
  };
}
