'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { commentOnArticle, replyToThread } from '@/lib/social-actions';
import { Markdown } from '@/lib/markdown';

/**
 * The box you write a reply or a comment in.
 *
 * ONE COMPONENT FOR BOTH, because they are one act against one table. The only
 * difference is which endpoint it posts to, and that is a prop.
 *
 * THE PREVIEW IS THE SAME RENDERER THE PAGE USES. It imports `Markdown`, not a
 * second best-effort formatter, so what you see before posting is what appears
 * afterwards — a preview that can disagree with the result is worse than none,
 * because people trust it.
 *
 * THE LENGTH LIMIT IS SHOWN, NOT DISCOVERED. 20 000 characters is the service's
 * bound and the database's; finding it out from a 400 after writing an essay is
 * a bad way to learn it. The service stays the authority — this just spares the
 * round trip.
 *
 * SIGNED OUT, THIS IS A SENTENCE AND A LINK, not a disabled textarea. Reading
 * needs no account; being told that only when you try to post does not.
 */
const MAX = 20000;

export function Composer({
  target,
  signedIn,
  placeholder = 'Write a reply…',
  label = 'Post reply',
}: {
  target: { kind: 'thread' | 'article'; id: string };
  signedIn: boolean;
  placeholder?: string;
  label?: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<{ reason: string; code: string | null } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  if (!signedIn) {
    return (
      <div className="box m2" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
        Anyone can read this. <Link href="/signin">Sign in</Link> to reply — writing here needs a
        wallet and a creator profile, the same identity your agents and articles are published
        under.
      </div>
    );
  }

  const trimmed = body.trim();
  const tooLong = body.length > MAX;
  const ok = trimmed.length > 0 && !tooLong;

  const submit = () => {
    if (!ok) return;
    setFail(null);
    start(async () => {
      const r =
        target.kind === 'thread'
          ? await replyToThread(target.id, body)
          : await commentOnArticle(target.id, body);
      if (r.ok) {
        setBody('');
        setPreview(false);
        // The list is server-rendered; the action revalidated its path, and
        // this is what makes the new post appear without a manual reload.
        router.refresh();
      } else {
        setFail({ reason: r.reason, code: r.code });
      }
    });
  };

  return (
    <div className="box" style={{ marginTop: 16 }}>
      {preview ? (
        <div style={{ minHeight: 96 }}>
          {trimmed ? (
            <Markdown source={body} />
          ) : (
            <div className="m3" style={{ fontSize: 12.5 }}>
              Nothing to preview yet.
            </div>
          )}
        </div>
      ) : (
        <textarea
          ref={area}
          className="input"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
          rows={6}
          style={{ width: '100%', resize: 'vertical', lineHeight: 1.6, fontSize: 13.5 }}
        />
      )}

      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginTop: 10,
        }}
      >
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!ok || pending}>
          {pending ? 'Posting…' : label}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setPreview((p) => !p)}
          disabled={pending}
        >
          {preview ? 'Edit' : 'Preview'}
        </button>
        <span className="m3" style={{ fontSize: 11 }}>
          Markdown: **bold**, *italic*, `code`, &gt; quote, - list, [text](https://…)
        </span>
        <span
          className={tooLong ? 'm2' : 'm3'}
          style={{ fontSize: 11, marginLeft: 'auto' }}
          title={`The service and the database both stop at ${MAX.toLocaleString('en-US')} characters.`}
        >
          {body.length.toLocaleString('en-US')} / {MAX.toLocaleString('en-US')}
        </span>
      </div>

      {tooLong ? (
        <div className="m2" style={{ fontSize: 11.5, marginTop: 6 }}>
          That is longer than a post can be. Nothing has been sent.
        </div>
      ) : null}

      {fail ? (
        <div className="m2" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.55 }}>
          {fail.code === 'creator_profile_required' ? (
            <>
              Your wallet is signed in but has no creator profile yet, and everything published
              here belongs to one. <Link href="/me">Create one</Link> — it is a single name — and
              your text is still in the box.
            </>
          ) : fail.code === 'content_hidden' ? (
            <>This was hidden by moderation and is closed to new replies.</>
          ) : (
            <>Not posted: {fail.reason}</>
          )}
        </div>
      ) : null}
    </div>
  );
}
