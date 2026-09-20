/**
 * An article, the agent it names if it names one, and the claim it carries if
 * it carries one.
 *
 * MOST ARTICLES HAVE NO THESIS, and that is the intended shape. Requiring a
 * forecast on every piece of writing would fill the record with claims nobody
 * meant to make; a record of few, deliberate ones says more.
 *
 * THE PROSE IS EDITABLE. THE BINDINGS ARE NOT, and the page says which is
 * which. An article whose body could be rewritten around a claim that had
 * already resolved would let the framing move after the result — and one that
 * could be re-pointed at whichever agent later did well would be claiming a
 * track record it never discussed. The database refuses both (0052, 0056).
 *
 * TWO CARDS ARE NEVER DRAWN FOR ONE AGENT. An article may name an agent
 * directly and also carry a thesis about the same one; rendering the card twice
 * would read as two sources agreeing, when it is one source read twice.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent, qs } from '@/lib/api';
import { fracAsPct, utc } from '@/lib/format';
import { authed, getSession } from '@/lib/session';
import { Markdown } from '@/lib/markdown';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout, Failed } from '@/components/ds/states';
import { LinkedAgentCard } from '@/components/LinkedAgentCard';
import { Composer } from '@/components/social/Composer';
import { ModerationControls } from '@/components/social/ModerationControls';
import { Posts } from '@/components/social/Posts';
import { ReactionBar } from '@/components/social/ReactionBar';
import type { MyReactions, Paged, PostItem } from '@/lib/social';
import type { Thesis } from '../../theses/shapes';
import { VerdictTag, benchmarkLabel } from '../../theses/shapes';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Article — ARCANA' };

type ArticleRead = {
  id: string;
  creator: { id: string; handle: string };
  /** null when hidden by moderation. */
  title: string | null;
  body: string | null;
  created_at: string;
  updated_at: string;
  thesis: Thesis | null;
  agent: {
    id: string;
    name: string;
    status_now: string | null;
    visibility: 'public' | 'private' | null;
  } | null;
  like_count: number;
  save_count: number;
  comment_count: number;
  hidden: { at: string; reason: string } | null;
};

export default async function ArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page: pageRaw } = await searchParams;
  const page = Number(pageRaw) > 0 ? Number(pageRaw) : 1;

  const [r, cr, s] = await Promise.all([
    agent<ArticleRead>(`/v1/articles/${id}`),
    agent<Paged<PostItem>>(`/v1/articles/${id}/comments${qs({ page, page_size: 50 })}`),
    getSession(),
  ]);
  if (!r.ok && r.status === 404) notFound();

  const signedIn = s.state === 'signed_in';
  const creatorId = signedIn ? s.session.creator_id : null;
  const isOperator = signedIn ? s.session.is_operator === true : false;

  const mine = signedIn
    ? await authed<MyReactions>(`/v1/me/reactions${qs({ articles: id })}`)
    : null;
  const myState = mine?.ok ? mine.data.articles[id] : undefined;

  const here = `/articles/${id}`;
  const thesisAgentId = r.ok ? (r.data.thesis?.agent.id ?? null) : null;
  // The direct binding is only drawn when it is not the same agent the thesis
  // block below already draws.
  const showDirectAgent = r.ok && r.data.agent !== null && r.data.agent.id !== thesisAgentId;

  return (
    <div className="page">
      <Header />

      {!r.ok ? (
        <div className="sec" style={{ paddingTop: 32 }}>
          <Failed what="This article" error={r} />
        </div>
      ) : r.data.hidden ? (
        <div className="sec" style={{ paddingTop: 32, paddingBottom: 44, borderBottom: 'none' }}>
          <div
            className="m2"
            style={{
              padding: '16px 18px',
              border: '1px dashed var(--ink-3)',
              fontSize: 13.5,
              lineHeight: 1.6,
              maxWidth: 720,
            }}
          >
            <strong>This article was hidden by moderation</strong> on{' '}
            <span className="mono">{utc(r.data.hidden.at)}</span>. Reason given:{' '}
            <em>{r.data.hidden.reason}</em>.
            <div className="m3" style={{ fontSize: 11.5, marginTop: 10 }}>
              It was written by{' '}
              <Link href={`/creators/${r.data.creator.id}`}>{r.data.creator.handle}</Link> on{' '}
              <span className="mono">{utc(r.data.created_at)}</span>. The row is kept rather than
              deleted, so this page can tell you what happened instead of returning a 404. Any
              thesis it carried is unaffected: a published claim resolves whatever becomes of the
              prose around it.
            </div>
          </div>
          {isOperator ? (
            <div style={{ marginTop: 14 }}>
              <ModerationControls
                subject={{ kind: 'article', id }}
                revalidate={here}
                signedIn={signedIn}
                canHide={false}
                hidden
                canUnhide
              />
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="sec" style={{ paddingTop: 32, paddingBottom: 16, borderBottom: 'none' }}>
            <h1 style={{ fontSize: 26, lineHeight: 1.25, maxWidth: 760 }}>{r.data.title}</h1>
            <div className="m2" style={{ fontSize: 12.5, marginTop: 8 }}>
              <Link href={`/creators/${r.data.creator.id}`}>{r.data.creator.handle}</Link>
              {' · '}
              <span className="mono">{utc(r.data.created_at)}</span>
              {r.data.updated_at !== r.data.created_at ? (
                <>
                  {' · '}
                  <span
                    className="mono m3"
                    title="The prose was edited. A thesis or agent attached to it was not — those bindings are fixed once set."
                  >
                    edited {utc(r.data.updated_at)}
                  </span>
                </>
              ) : null}
            </div>
          </div>

          <div className="sec" style={{ paddingBottom: 16, borderBottom: 'none' }}>
            <Markdown source={r.data.body ?? ''} />

            <div
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'center',
                flexWrap: 'wrap',
                marginTop: 24,
              }}
            >
              <ReactionBar
                subject={{ kind: 'article', id }}
                initial={{
                  like_count: r.data.like_count,
                  save_count: r.data.save_count,
                  liked: signedIn ? (myState?.liked ?? false) : null,
                  saved: signedIn ? (myState?.saved ?? false) : null,
                }}
                signedIn={signedIn}
                revalidate={here}
              />
              {creatorId !== null && creatorId === r.data.creator.id ? (
                <Link href={`/me/articles/${id}`} className="btn btn-ghost" style={{ fontSize: 12 }}>
                  Edit
                </Link>
              ) : null}
              <ModerationControls
                subject={{ kind: 'article', id }}
                revalidate={here}
                signedIn={signedIn}
                canHide={isOperator || (creatorId !== null && creatorId === r.data.creator.id)}
                hidden={false}
                canUnhide={isOperator}
              />
            </div>

            {showDirectAgent && r.data.agent ? (
              <>
                <h2 style={{ marginTop: 32, fontSize: 15 }}>The agent this article is about</h2>
                <LinkedAgentCard
                  agentId={r.data.agent.id}
                  agentName={r.data.agent.name}
                  statusNow={r.data.agent.status_now}
                  visibility={r.data.agent.visibility}
                />
                <div className="m3" style={{ fontSize: 11, marginTop: 8, maxWidth: 700, lineHeight: 1.55 }}>
                  Naming an agent is not a forecast and nothing here is scored. The card reads that
                  agent&rsquo;s own endpoints live — it is the same data as its page, not a copy
                  taken when this was written.
                </div>
              </>
            ) : null}

            {r.data.thesis ? (
              <>
                <h2 style={{ marginTop: 32, fontSize: 15 }}>The claim this article made</h2>

                <div style={{ border: '1px solid var(--color-divider)', marginTop: 10 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '14px 16px',
                      borderBottom: '1px solid var(--color-divider)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <Link href={`/theses/${r.data.thesis.id}`} style={{ fontSize: 14, maxWidth: 560 }}>
                      {r.data.thesis.claim}
                    </Link>
                    <VerdictTag status={r.data.thesis.status} />
                  </div>
                  <div className="m3" style={{ fontSize: 11, padding: '10px 16px' }}>
                    vs {benchmarkLabel(r.data.thesis.benchmark)} ·{' '}
                    <span className="mono">
                      {utc(r.data.thesis.created_at)} → {utc(r.data.thesis.resolves_at)}
                    </span>
                  </div>
                  {r.data.thesis.result ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                        borderTop: '1px solid var(--color-divider)',
                      }}
                    >
                      <Figure label="Agent" value={fracAsPct(r.data.thesis.result.agent_return)} />
                      <Figure
                        label="Benchmark"
                        value={fracAsPct(r.data.thesis.result.benchmark_return)}
                      />
                      <Figure label="Margin" value={fracAsPct(r.data.thesis.result.margin)} />
                    </div>
                  ) : null}
                </div>

                <Callout tone={r.data.thesis.status === 'pending' ? 'note' : 'warn'}>
                  {r.data.thesis.status === 'pending'
                    ? 'This claim is still running. Its result will attach itself here when the deadline passes, whether or not it goes the author’s way.'
                    : 'This result was attached automatically and is permanent. The article above can be rewritten; the claim, its benchmark and its verdict cannot.'}
                </Callout>

                <h2 style={{ marginTop: 28, fontSize: 15 }}>The agent it rests on</h2>
                <LinkedAgentCard
                  agentId={r.data.thesis.agent.id}
                  agentName={r.data.thesis.agent.name}
                  statusNow={r.data.thesis.agent.status_now}
                />
              </>
            ) : !showDirectAgent ? (
              <div className="m3" style={{ fontSize: 11.5, marginTop: 28, lineHeight: 1.55, maxWidth: 700 }}>
                This article carries no thesis and names no agent. It is writing, not a forecast,
                and nothing here is scored.
              </div>
            ) : null}
          </div>

          <div className="sec" style={{ paddingBottom: 8, borderBottom: 'none' }}>
            <h2 style={{ fontSize: 14 }}>
              Comments{r.data.comment_count > 0 ? ` (${r.data.comment_count})` : ''}
            </h2>
            <div className="m3" style={{ fontSize: 11, marginBottom: 6 }}>
              The same mechanism as a forum reply — one table, one moderation path.
            </div>

            {!cr.ok ? (
              <Failed what="The comments" error={cr} />
            ) : (
              <Posts
                posts={cr.data.items}
                viewer={{ signedIn, creatorId, isOperator }}
                parentAuthorId={r.data.creator.id}
                revalidate={here}
                emptyNote="No comments yet."
              />
            )}

            <Composer
              target={{ kind: 'article', id }}
              signedIn={signedIn}
              placeholder="Write a comment…"
              label="Post comment"
            />
            <div style={{ height: 40 }} />
          </div>
        </>
      )}

      <Footer />
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '12px 16px', borderRight: '1px solid var(--color-divider)' }}>
      <div className="m3" style={{ fontSize: 10.5, letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 18, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}
