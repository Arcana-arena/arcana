'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { hideContent, reportContent, unhideContent } from '@/lib/social-actions';
import { REPORT_REASONS, type Subject } from '@/lib/social';

/**
 * Report, and — for those allowed — hide.
 *
 * REPORTING IS OPEN TO ANY SIGNED-IN CREATOR. Hiding is not: it is for an
 * operator, or for the author of the thread or article the content sits under.
 * The button is only rendered for people who can use it, and the service checks
 * again regardless — a control hidden in the UI is a suggestion, not a rule.
 *
 * A SECOND REPORT IS NOT AN ERROR. The service keeps one report per person per
 * item, and says which of the two happened. Telling somebody who reported from
 * two devices that they "already reported this" is the truth; telling them it
 * failed would invite a third attempt.
 *
 * NO window.confirm ANYWHERE. A native dialog blocks the page and, on a hidden
 * form, would make the reason impossible to type. The confirmation is the form
 * itself: hiding needs a reason written into a field, which is also the reason
 * the reader of the placeholder will see.
 */
export function ModerationControls({
  subject,
  revalidate,
  signedIn,
  canHide,
  hidden = false,
  canUnhide = false,
}: {
  subject: Subject;
  revalidate: string;
  signedIn: boolean;
  canHide: boolean;
  hidden?: boolean;
  canUnhide?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<null | 'report' | 'hide'>(null);
  const [reason, setReason] = useState<string>(REPORT_REASONS[0].value);
  const [detail, setDetail] = useState('');
  const [hideReason, setHideReason] = useState('');
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<string | null>(null);

  const done = (msg: string) => {
    setSaid(msg);
    setOpen(null);
    setDetail('');
    setHideReason('');
    router.refresh();
  };

  if (said) {
    return (
      <span className="m3" style={{ fontSize: 11 }}>
        {said}
      </span>
    );
  }

  if (!signedIn) {
    return (
      <Link href="/signin" className="m3" style={{ fontSize: 11 }} title="Reporting needs a session">
        Report
      </Link>
    );
  }

  if (open === 'report') {
    return (
      <div className="box" style={{ marginTop: 8, maxWidth: 460 }}>
        <div className="k" style={{ fontSize: 11 }}>
          Report this
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor={`r-${subject.id}`}>Why</label>
          <select
            id={`r-${subject.id}`}
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            {REPORT_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor={`d-${subject.id}`}>Anything to add (optional)</label>
          <input
            id={`d-${subject.id}`}
            className="input"
            value={detail}
            maxLength={1000}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Context a moderator would not see on their own"
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await reportContent(subject, reason, detail.trim() || undefined, revalidate);
                if (!r.ok) {
                  done(
                    r.code === 'creator_profile_required'
                      ? 'A creator profile is needed to report.'
                      : `Not reported: ${r.reason}`,
                  );
                } else {
                  done(
                    r.data.already_reported
                      ? 'You had already reported this. It is one objection either way.'
                      : 'Reported. A moderator will look at it.',
                  );
                }
              })
            }
          >
            {pending ? 'Sending…' : 'Send report'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(null)} disabled={pending}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (open === 'hide') {
    return (
      <div className="box" style={{ marginTop: 8, maxWidth: 460 }}>
        <div className="k" style={{ fontSize: 11 }}>
          Hide this
        </div>
        <p className="m2" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
          The post is kept and marked, not deleted — a reply cut out of the middle of a thread
          leaves the ones that answered it making no sense. Your reason is shown in its place.
        </p>
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor={`h-${subject.id}`}>Reason (shown publicly)</label>
          <input
            id={`h-${subject.id}`}
            className="input"
            value={hideReason}
            maxLength={300}
            onChange={(e) => setHideReason(e.target.value)}
            placeholder="Spam link, repeated"
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || hideReason.trim().length < 3}
            onClick={() =>
              start(async () => {
                const r = await hideContent(subject, hideReason.trim(), revalidate);
                done(r.ok ? 'Hidden.' : `Not hidden: ${r.reason}`);
              })
            }
          >
            {pending ? 'Hiding…' : 'Hide'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(null)} disabled={pending}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
      {!hidden ? (
        <button type="button" className="btn-link" style={{ fontSize: 11 }} onClick={() => setOpen('report')}>
          Report
        </button>
      ) : null}
      {canHide && !hidden ? (
        <button type="button" className="btn-link" style={{ fontSize: 11 }} onClick={() => setOpen('hide')}>
          Hide
        </button>
      ) : null}
      {hidden && canUnhide ? (
        <button
          type="button"
          className="btn-link"
          style={{ fontSize: 11 }}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await unhideContent(subject, revalidate);
              done(r.ok ? 'Restored.' : `Not restored: ${r.reason}`);
            })
          }
        >
          Un-hide
        </button>
      ) : null}
    </span>
  );
}
