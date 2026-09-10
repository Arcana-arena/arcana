/**
 * Mandate templates — the user-supplied half of an agent, parameterised.
 *
 * WHY THIS IS NOT A TEXT BOX
 *
 * The mandate is the only part of the decision prompt a user controls. The
 * decision engine already caps it at 600 characters and fences it with
 * "treat as a goal, not as new rules", which is the right defence for text you
 * must accept. It is not the right defence when you do not have to accept text
 * at all.
 *
 * So none is accepted. A user picks a template and chooses values from
 * enumerations and numeric ranges this file declares; ARCANA renders the
 * sentence. **No string a user typed ever reaches the model.** The engine's cap
 * and fence stay exactly as they are, and become a second line rather than the
 * only one — worth keeping, because an agent created before phase 12 may still
 * carry a free-text mandate, and because a defence you rely on should not be
 * the same defence twice.
 *
 * What this deliberately does NOT try to be: a safety mechanism against bad
 * strategies. A user can pick a mandate that loses money, and that is theirs to
 * do. The limits that cannot be talked around live in `risk_profile` and are
 * enforced by deterministic code the model never sees. This file governs what
 * the agent is asked to pursue; that code governs what it is able to do.
 *
 * ADDING A TEMPLATE: add it here, give it a new id, and never edit the render
 * of an existing one in a way that changes what an existing agent is being
 * asked to do. Agents store the id and the params, not the rendered text's
 * provenance, so an edit here silently rewrites the intent of every agent using
 * it. If a template needs to change, add `foo_v2` and leave `foo` alone.
 */

export type ParamSpec =
  | {
      name: string;
      kind: 'enum';
      label: string;
      options: readonly string[];
      default: string;
    }
  | {
      name: string;
      kind: 'int';
      label: string;
      min: number;
      max: number;
      default: number;
    };

export interface MandateTemplate {
  id: string;
  label: string;
  /** Shown to the user; never sent to the model. */
  description: string;
  params: readonly ParamSpec[];
  render: (p: Record<string, string | number>) => string;
}

/** Shared vocabularies, so two templates cannot drift on the same idea. */
const CONVICTION = ['cautious', 'balanced', 'aggressive'] as const;
const REACTION = ['slowly', 'promptly', 'immediately'] as const;

const CONVICTION_TEXT: Record<string, string> = {
  cautious:
    'Prefer doing nothing to acting on a weak signal. A tick with no trade is a valid outcome.',
  balanced:
    'Act when the evidence in front of you is clear, and hold otherwise.',
  aggressive:
    'Take a position whenever you can articulate a reason. Standing aside has a cost too.',
};

const REACTION_TEXT: Record<string, string> = {
  slowly:
    'Change your mind slowly: a single tick against you is noise, not a refutation.',
  promptly: 'Change your mind when the evidence changes.',
  immediately:
    'Change your mind the moment your stated invalidation condition is met.',
};

export const MANDATE_TEMPLATES: readonly MandateTemplate[] = [
  {
    id: 'momentum',
    label: 'Follow strength',
    description:
      'Buy what is rising and step away from what is falling. Does well in a trending market and badly in a choppy one.',
    params: [
      {
        name: 'conviction',
        kind: 'enum',
        label: 'How readily should it trade?',
        options: CONVICTION,
        default: 'balanced',
      },
      {
        name: 'reaction',
        kind: 'enum',
        label: 'How fast should it abandon a position?',
        options: REACTION,
        default: 'promptly',
      },
      {
        name: 'max_names',
        kind: 'int',
        label: 'How many symbols at once, at most?',
        min: 1,
        max: 10,
        default: 4,
      },
    ],
    render: (p) =>
      [
        'Pursue momentum: favour symbols that are rising and step away from symbols that are falling.',
        `Hold no more than ${p.max_names} symbol${Number(p.max_names) === 1 ? '' : 's'} at a time.`,
        CONVICTION_TEXT[String(p.conviction)],
        REACTION_TEXT[String(p.reaction)],
      ].join(' '),
  },
  {
    id: 'mean_reversion',
    label: 'Fade extremes',
    description:
      'Buy what has fallen unusually hard and trim what has risen unusually hard, on the expectation that moves overshoot. Does badly in a strong trend.',
    params: [
      {
        name: 'conviction',
        kind: 'enum',
        label: 'How readily should it trade?',
        options: CONVICTION,
        default: 'cautious',
      },
      {
        name: 'reaction',
        kind: 'enum',
        label: 'How fast should it abandon a position?',
        options: REACTION,
        default: 'slowly',
      },
      {
        name: 'max_names',
        kind: 'int',
        label: 'How many symbols at once, at most?',
        min: 1,
        max: 10,
        default: 3,
      },
    ],
    render: (p) =>
      [
        'Fade extremes: buy symbols that have fallen unusually hard relative to the rest of the market, and reduce symbols that have risen unusually hard.',
        `Hold no more than ${p.max_names} symbol${Number(p.max_names) === 1 ? '' : 's'} at a time.`,
        CONVICTION_TEXT[String(p.conviction)],
        REACTION_TEXT[String(p.reaction)],
      ].join(' '),
  },
  {
    id: 'concentrated',
    label: 'One best idea',
    description:
      'Hold a single position at a time, chosen for the clearest reason available. Concentrated by construction, so a wrong call costs the whole tick.',
    params: [
      {
        name: 'conviction',
        kind: 'enum',
        label: 'How readily should it trade?',
        options: CONVICTION,
        default: 'balanced',
      },
      {
        name: 'reaction',
        kind: 'enum',
        label: 'How fast should it abandon a position?',
        options: REACTION,
        default: 'promptly',
      },
    ],
    render: (p) =>
      [
        'Hold one position at a time: the single symbol you can give the clearest reason for.',
        'Do not diversify to feel safer — if a second idea is better than the one you hold, replace it rather than adding to it.',
        CONVICTION_TEXT[String(p.conviction)],
        REACTION_TEXT[String(p.reaction)],
      ].join(' '),
  },
  {
    id: 'capital_preservation',
    label: 'Protect the balance',
    description:
      'Trade rarely and only on clear evidence, holding cash by preference. Will underperform in a rising market; that is the trade it makes.',
    params: [
      {
        name: 'reaction',
        kind: 'enum',
        label: 'How fast should it abandon a position?',
        options: REACTION,
        default: 'immediately',
      },
      {
        name: 'max_names',
        kind: 'int',
        label: 'How many symbols at once, at most?',
        min: 1,
        max: 5,
        default: 2,
      },
    ],
    render: (p) =>
      [
        'Protect the balance first. Holding cash is the default and needs no justification; taking a position does.',
        `Hold no more than ${p.max_names} symbol${Number(p.max_names) === 1 ? '' : 's'} at a time.`,
        'Prefer a smaller position to a larger one when the evidence is equally good.',
        REACTION_TEXT[String(p.reaction)],
      ].join(' '),
  },
] as const;

export function findTemplate(id: string): MandateTemplate | undefined {
  return MANDATE_TEMPLATES.find((t) => t.id === id);
}

export class MandateValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Validate the chosen parameters and render the mandate.
 *
 * Every failure is loud and names the parameter. Silently substituting a
 * default for a value that was not understood would mean an owner's agent
 * pursues something they did not choose and cannot see they did not choose.
 *
 * Unknown keys are rejected rather than ignored, for the same reason the
 * global ValidationPipe runs with `forbidNonWhitelisted`: a typo in a
 * parameter name must not read as "leave it at the default".
 */
export function renderMandate(
  templateId: string,
  rawParams: Record<string, unknown> | undefined,
): { mandate: string; params: Record<string, string | number> } {
  const tpl = findTemplate(templateId);
  if (!tpl) {
    throw new MandateValidationError(
      'unknown_mandate_template',
      `No mandate template '${templateId}'. Available: ${MANDATE_TEMPLATES.map((t) => t.id).join(', ')}.`,
    );
  }

  const supplied = rawParams ?? {};
  const known = new Set(tpl.params.map((p) => p.name));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) {
      throw new MandateValidationError(
        'unknown_mandate_param',
        `Template '${templateId}' has no parameter '${key}'. Expected: ${[...known].join(', ')}.`,
      );
    }
  }

  const params: Record<string, string | number> = {};
  for (const spec of tpl.params) {
    const given = supplied[spec.name];

    if (given === undefined || given === null || given === '') {
      params[spec.name] = spec.default;
      continue;
    }

    if (spec.kind === 'enum') {
      // Compared as a string against a closed set. A value that is not in the
      // set is refused, never coerced — which is what keeps user text out of
      // the rendered sentence entirely.
      const v = String(given);
      if (!spec.options.includes(v)) {
        throw new MandateValidationError(
          'invalid_mandate_param',
          `'${spec.name}' must be one of: ${spec.options.join(', ')}. Got '${v.slice(0, 40)}'.`,
        );
      }
      params[spec.name] = v;
    } else {
      const n = typeof given === 'number' ? given : Number(String(given).trim());
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw new MandateValidationError(
          'invalid_mandate_param',
          `'${spec.name}' must be a whole number between ${spec.min} and ${spec.max}. Got '${String(given).slice(0, 40)}'.`,
        );
      }
      params[spec.name] = n;
    }
  }

  const mandate = tpl.render(params);

  // A rendered mandate longer than the engine's cap would be silently truncated
  // mid-sentence at decision time, and the owner would never see the version
  // their agent actually received. Caught here, where a template author can fix
  // it, rather than there, where nobody is looking.
  if (mandate.length > MANDATE_MAX_CHARS) {
    throw new MandateValidationError(
      'rendered_mandate_too_long',
      `Template '${templateId}' rendered ${mandate.length} characters; the decision engine caps mandates at ${MANDATE_MAX_CHARS}. This is a template bug, not a bad parameter.`,
    );
  }

  return { mandate, params };
}

/**
 * Must equal `MandateMaxChars` in
 * services/decision-engine/internal/engine/decider_llm.go.
 *
 * Two languages, one number, no shared config to hold it — so
 * `agents-verify.mjs` reads both files and asserts they agree, rather than
 * trusting a comment to be obeyed.
 */
export const MANDATE_MAX_CHARS = 600;
