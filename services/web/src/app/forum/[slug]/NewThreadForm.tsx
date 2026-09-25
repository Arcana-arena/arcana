'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createThread } from '@/lib/social-actions';
import { Markdown } from '@/lib/markdown';

/**
 * Starting a thread.
 *
 * COLLAPSED UNTIL ASKED FOR. A board is a place to read first; an open editor
 * at the top of every one pushes the threads down the page for the majority of
 * visits that were never going to post.
 *
 * ON SUCCESS IT NAVIGATES TO THE NEW THREAD rather than clearing itself. The
 * thing somebody wanted after writing a post is the post.
 *
 * THE TWO REFUSALS THAT WILL ACTUALLY HAPPEN get their own sentences: no
 * creator profile (a link to the form that makes one) and the rate limit (ten
 * threads an hour, per wallet). Everything else prints what the service said.
 */
export function NewThreadForm({
  board,
  boardName,
  signedIn,
}: {
  board: string;
  boardName: string;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<{ reason: string; code: string | null } | null>(null);

  if (!signedIn) {
    return (
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Link href="/signin" className="btn">
          Sign in to start a thread
        </Link>
        <span className="m3" style={{ fontSize: 11.5 }}>
          Reading needs nothing; writing is published under your creator handle.
        </span>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        Start a thread
      </button>
    );
  }

  const okTitle = title.trim().length >= 3 && title.trim().length <= 200;
  const okBody = body.trim().length > 0 && body.length <= 50000;

  return (
    <div className="box surface" style={{ maxWidth: 760 }}>
      <div className="k">New thread in {boardName}</div>

      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="t-title">Title</label>
        <input
          id="t-title"
          className="input"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What is this about?"
        />
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="t-body">Body</label>
        {preview ? (
          <div style={{ minHeight: 120, border: '1px solid var(--color-divider)', padding: 12 }}>
            {body.trim() ? <Markdown source={body} className="fm-body" /> : <span className="m3">Nothing to preview yet.</span>}
          </div>
        ) : (
          <textarea
            id="t-body"
            className="input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            placeholder="Markdown: **bold**, *italic*, `code`, > quote, - list, [text](https://…)"
            style={{ width: '100%', resize: 'vertical', lineHeight: 1.6, fontSize: 13.5 }}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!okTitle || !okBody || pending}
          onClick={() => {
            setFail(null);
            start(async () => {
              const r = await createThread({ board, title: title.trim(), body });
              if (r.ok) router.push(`/forum/thread/${r.data.id}`);
              else setFail({ reason: r.reason, code: r.code });
            });
          }}
        >
          {pending ? 'Posting…' : 'Post thread'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setPreview((p) => !p)} disabled={pending}>
          {preview ? 'Edit' : 'Preview'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
        <span className="m3" style={{ fontSize: 11, marginLeft: 'auto' }}>
          {body.length.toLocaleString('en-US')} / 50,000
        </span>
      </div>

      {fail ? (
        <div className="m2" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.55 }}>
          {fail.code === 'creator_profile_required' ? (
            <>
              Your wallet is signed in but has no creator profile, and threads are published under
              one. <Link href="/me">Create a profile</Link> — your draft is still here.
            </>
          ) : fail.code === 'rate_limited' ? (
            <>You have started several threads in the last hour. Give it a little while.</>
          ) : (
            <>Not posted: {fail.reason}</>
          )}
        </div>
      ) : null}
    </div>
  );
}
