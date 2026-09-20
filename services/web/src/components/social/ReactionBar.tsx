'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { setReaction } from '@/lib/social-actions';
import type { ReactionState, Subject } from '@/lib/social';

/**
 * Like and save.
 *
 * THE COUNT SHOWN IS ALWAYS THE SERVICE'S. Clicking sends the change and
 * replaces the whole state with what comes back — it never adds one locally.
 * An optimistic count is arithmetic in the browser, and this site has exactly
 * one rule it applies everywhere: the numbers are read, not computed. Two tabs
 * open on the same thread would disagree the moment either guessed.
 *
 * SIGNED OUT, THE BUTTONS ARE STILL THERE AND STILL SHOW THE COUNTS — they just
 * go to the sign-in page. Hiding them would make a public page look like it has
 * no such feature; disabling them silently would make a click do nothing.
 *
 * A FAILED CLICK SAYS SO. The two that will happen are a wallet with no creator
 * profile and the rate limit, and neither is "something went wrong": one is a
 * link to a form, the other is a wait. They are told apart by `code`.
 */
export function ReactionBar({
  subject,
  initial,
  signedIn,
  revalidate,
  size = 'normal',
}: {
  subject: Subject;
  initial: ReactionState;
  signedIn: boolean;
  /** The path to refresh after a change, so server-rendered counts follow. */
  revalidate: string;
  size?: 'normal' | 'small';
}) {
  const [state, setState] = useState<ReactionState>(initial);
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<{ reason: string; code: string | null } | null>(null);

  const click = (kind: 'like' | 'save') => {
    const on = !(kind === 'like' ? state.liked : state.saved);
    setFail(null);
    start(async () => {
      const r = await setReaction(subject, kind, on, revalidate);
      if (r.ok) setState(r.data);
      else setFail({ reason: r.reason, code: r.code });
    });
  };

  const fs = size === 'small' ? 11.5 : 12.5;

  if (!signedIn) {
    return (
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: fs }}>
        <span className="m3">♥ {state.like_count}</span>
        <span className="m3">☆ {state.save_count}</span>
        <Link href="/signin" className="m2" style={{ fontSize: fs - 0.5 }}>
          Sign in to like or save
        </Link>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: fs }}>
      <button
        type="button"
        onClick={() => click('like')}
        disabled={pending}
        aria-pressed={state.liked === true}
        className={state.liked ? 'btn' : 'btn btn-ghost'}
        title={state.liked ? 'Remove your like' : 'Like this'}
      >
        ♥ {state.like_count}
      </button>
      <button
        type="button"
        onClick={() => click('save')}
        disabled={pending}
        aria-pressed={state.saved === true}
        className={state.saved ? 'btn' : 'btn btn-ghost'}
        title={state.saved ? 'Remove from your saved list' : 'Save for later'}
      >
        {state.saved ? '★' : '☆'} {state.save_count}
      </button>
      {pending ? <span className="m3">saving…</span> : null}
      {fail ? (
        <span className="m2" style={{ fontSize: fs - 1 }}>
          {fail.code === 'creator_profile_required' ? (
            <>
              You need a creator profile first — <Link href="/me">set one up</Link>.
            </>
          ) : (
            fail.reason
          )}
        </span>
      ) : null}
    </div>
  );
}
