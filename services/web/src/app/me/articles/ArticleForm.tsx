'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createArticle, updateArticle } from '@/lib/social-actions';
import { Markdown } from '@/lib/markdown';

/**
 * Writing or editing an article.
 *
 * THE SAME FORM FOR BOTH, because they are the same fields with one difference
 * that matters and is stated on screen: what is already bound cannot be
 * rebound. A separate edit form would be a second place for the markdown
 * preview, the length rule and the failure copy to drift.
 *
 * WHY THE BINDINGS ARE DISABLED RATHER THAN HIDDEN once set. Hiding the control
 * would leave an author wondering where their agent went and trying again
 * somewhere else; showing it greyed out with the reason says what happened. The
 * service and the trigger in 0056 refuse the change regardless — this is
 * courtesy, not enforcement.
 *
 * A THESIS IS NOT A REQUIREMENT AND THE COPY SAYS SO. Most articles carry none.
 * The picker only lists claims this author published that no other article has
 * already taken, because one thesis belongs to at most one article.
 */

export type AgentChoice = { id: string; name: string; status: string };
export type ThesisChoice = { id: string; claim: string };

const MAX_BODY = 50000;

export function ArticleForm({
  agents,
  theses,
  existing,
}: {
  agents: AgentChoice[];
  theses: ThesisChoice[];
  /** Absent when writing a new one. */
  existing?: {
    id: string;
    title: string;
    body: string;
    agentId: string | null;
    thesisId: string | null;
  };
}) {
  const router = useRouter();
  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [agentId, setAgentId] = useState(existing?.agentId ?? '');
  const [thesisId, setThesisId] = useState(existing?.thesisId ?? '');
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<{ reason: string; code: string | null } | null>(null);

  const agentLocked = Boolean(existing?.agentId);
  const thesisLocked = Boolean(existing);

  const okTitle = title.trim().length >= 3 && title.trim().length <= 200;
  const okBody = body.trim().length > 0 && body.length <= MAX_BODY;

  const submit = () => {
    setFail(null);
    start(async () => {
      const r = existing
        ? await updateArticle(existing.id, {
            title: title.trim(),
            body,
            ...(agentLocked || !agentId ? {} : { agent_id: agentId }),
          })
        : await createArticle({
            title: title.trim(),
            body,
            ...(agentId ? { agent_id: agentId } : {}),
            ...(thesisId ? { thesis_id: thesisId } : {}),
          });
      if (r.ok) router.push(`/articles/${existing ? existing.id : (r.data as { id: string }).id}`);
      else setFail({ reason: r.reason, code: r.code });
    });
  };

  return (
    <div style={{ maxWidth: 780 }}>
      <div className="field">
        <label htmlFor="a-title">Title</label>
        <input
          id="a-title"
          className="input"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What this is about"
        />
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="a-body">Body</label>
        {preview ? (
          <div style={{ minHeight: 200, border: '1px solid var(--color-divider)', padding: 14 }}>
            {body.trim() ? <Markdown source={body} /> : <span className="m3">Nothing to preview yet.</span>}
          </div>
        ) : (
          <textarea
            id="a-body"
            className="input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={18}
            placeholder={'Markdown: # heading, **bold**, *italic*, `code`, > quote, - list, [text](https://…)'}
            style={{ width: '100%', resize: 'vertical', lineHeight: 1.65, fontSize: 13.5 }}
          />
        )}
        <div className="m3" style={{ fontSize: 11, marginTop: 4 }}>
          {body.length.toLocaleString('en-US')} / {MAX_BODY.toLocaleString('en-US')} · raw HTML,
          images and tables are not rendered — they appear as the characters you typed.
        </div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="a-agent">Agent (optional)</label>
        <select
          id="a-agent"
          className="input"
          value={agentId}
          disabled={agentLocked || agents.length === 0}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">No agent — this is just writing</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.status})
            </option>
          ))}
        </select>
        <div className="m3" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
          {agentLocked ? (
            <>
              Already set, and fixed. The card under this article publishes that agent&rsquo;s score
              and returns, so moving it to another agent would be claiming a track record this
              article never discussed.
            </>
          ) : agents.length === 0 ? (
            <>
              You have no agents yet. <Link href="/me/agents/new">Create one</Link> if you want a
              live card under this article — it is entirely optional.
            </>
          ) : (
            <>
              Adds a live card reading that agent&rsquo;s own numbers. It makes no claim and is not
              scored. <strong>It can be set once and not moved afterwards.</strong>
            </>
          )}
        </div>
      </div>

      {!existing ? (
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="a-thesis">Thesis (optional)</label>
          <select
            id="a-thesis"
            className="input"
            value={thesisId}
            disabled={theses.length === 0}
            onChange={(e) => setThesisId(e.target.value)}
          >
            <option value="">No thesis — most articles carry none</option>
            {theses.map((t) => (
              <option key={t.id} value={t.id}>
                {t.claim.slice(0, 90)}
                {t.claim.length > 90 ? '…' : ''}
              </option>
            ))}
          </select>
          <div className="m3" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
            {theses.length === 0 ? (
              <>
                You have no unclaimed theses. <Link href="/theses">Prove This Thesis</Link> is where
                a claim with a deadline is published; an article can then carry one.
              </>
            ) : (
              <>
                Carries one of your published claims. The claim, its benchmark and its verdict are
                fixed — only the prose above stays editable. One thesis, one article.
              </>
            )}
          </div>
        </div>
      ) : thesisLocked && existing.thesisId ? (
        <div className="m3" style={{ fontSize: 11.5, marginTop: 16, lineHeight: 1.5 }}>
          This article carries a thesis. That binding cannot be changed or removed — a forecast
          that could be re-pointed after the market answered is not a forecast.
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!okTitle || !okBody || pending}
          onClick={submit}
        >
          {pending ? 'Saving…' : existing ? 'Save changes' : 'Publish article'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setPreview((p) => !p)} disabled={pending}>
          {preview ? 'Edit' : 'Preview'}
        </button>
        {existing ? (
          <Link href={`/articles/${existing.id}`} className="btn btn-ghost">
            Cancel
          </Link>
        ) : null}
      </div>

      {fail ? (
        <div className="m2" style={{ fontSize: 12.5, marginTop: 12, lineHeight: 1.55 }}>
          {fail.code === 'creator_profile_required' ? (
            <>
              Your wallet has no creator profile yet. <Link href="/me">Create one</Link> — your
              draft is still on this page.
            </>
          ) : fail.code === 'article_agent_fixed' ? (
            <>The agent binding cannot be moved once set. {fail.reason}</>
          ) : fail.code === 'forbidden_not_owner' ? (
            <>That agent belongs to another creator. An article can only name your own.</>
          ) : (
            <>Not saved: {fail.reason}</>
          )}
        </div>
      ) : null}
    </div>
  );
}
