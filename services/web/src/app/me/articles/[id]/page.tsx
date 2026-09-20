/**
 * Edit an article you wrote.
 *
 * THE PROSE IS EDITABLE AND THE BINDINGS ARE NOT, which is the whole shape of
 * this screen. An article is writing and can be improved; the thesis under it
 * is a claim that was timestamped before the market answered, and the agent
 * named under it publishes that agent's live score. Either one being movable
 * afterwards would let the framing follow the result.
 *
 * OWNERSHIP IS CHECKED HERE AND AGAIN BY THE SERVICE. This page refuses to
 * render somebody else's article; `PATCH /v1/articles/:id` refuses to apply it.
 * The first is courtesy, the second is the rule — a form that is merely absent
 * has never stopped anyone.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { agent } from '@/lib/api';
import { authed, getSession } from '@/lib/session';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout, Failed } from '@/components/ds/states';
import { ArticleForm, type AgentChoice } from '../ArticleForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Edit article — ARCANA' };

type Dashboard = { agents: Array<{ id: string; name: string; status: string }> };
type ArticleRead = {
  id: string;
  creator: { id: string; handle: string };
  title: string | null;
  body: string | null;
  agent: { id: string } | null;
  thesis: { id: string } | null;
  hidden: { at: string; reason: string } | null;
};

export default async function EditArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  if (s.state === 'signed_out') redirect(`/signin?next=/me/articles/${id}`);

  const r = await agent<ArticleRead>(`/v1/articles/${id}`);
  if (!r.ok && r.status === 404) notFound();

  return (
    <div className="page">
      <Header />

      <div className="sec" style={{ paddingTop: 30, paddingBottom: 40, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="This article" error={r} />
        ) : s.state !== 'signed_in' ? (
          <Callout tone="warn">
            Your session could not be confirmed, so this form is not shown. Nothing has been lost.
          </Callout>
        ) : s.session.creator_id !== r.data.creator.id ? (
          <>
            <h1 style={{ fontSize: 22 }}>Not yours to edit</h1>
            <p className="m2" style={{ fontSize: 13, marginTop: 10, maxWidth: 620, lineHeight: 1.6 }}>
              This article was published by{' '}
              <Link href={`/creators/${r.data.creator.id}`}>{r.data.creator.handle}</Link>. You can{' '}
              <Link href={`/articles/${id}`}>read it</Link> and comment on it.
            </p>
          </>
        ) : r.data.hidden ? (
          <>
            <h1 style={{ fontSize: 22 }}>Hidden by moderation</h1>
            <p className="m2" style={{ fontSize: 13, marginTop: 10, maxWidth: 640, lineHeight: 1.6 }}>
              This article was hidden on <span className="mono">{r.data.hidden.at}</span> — reason
              given: <em>{r.data.hidden.reason}</em> — and cannot be edited while it is. Editing it
              would change what was acted on while the record still says it was acted on. An
              operator can restore it.
            </p>
          </>
        ) : (
          <EditBody article={r.data} creatorId={s.session.creator_id} />
        )}
      </div>

      <Footer />
    </div>
  );
}

async function EditBody({ article, creatorId }: { article: ArticleRead; creatorId: string }) {
  const dashR = await authed<Dashboard>(`/v1/creators/${creatorId}/dashboard`);
  const agents: AgentChoice[] = dashR.ok
    ? dashR.data.agents.map((a) => ({ id: a.id, name: a.name, status: a.status }))
    : [];

  return (
    <>
      <div className="m3" style={{ fontSize: 11.5 }}>
        <Link href="/me">Dashboard</Link> · <Link href={`/articles/${article.id}`}>View article</Link>
      </div>
      <h1 style={{ fontSize: 23, marginTop: 6 }}>Edit article</h1>
      <p className="m2" style={{ fontSize: 12.5, marginTop: 8, maxWidth: 680, lineHeight: 1.6 }}>
        The page will show that it was edited, and when. Readers can see the difference between
        prose that moved and a claim that did not.
      </p>
      <div style={{ marginTop: 16 }}>
        <ArticleForm
          agents={agents}
          theses={[]}
          existing={{
            id: article.id,
            title: article.title ?? '',
            body: article.body ?? '',
            agentId: article.agent?.id ?? null,
            thesisId: article.thesis?.id ?? null,
          }}
        />
      </div>
    </>
  );
}
