/**
 * Write an article.
 *
 * THE DOOR THAT WAS NOT THERE. `POST /v1/articles` has existed since 0052 and
 * nothing on the site called it — a creator could publish writing only by
 * making the request by hand. The page that reads an article was built first,
 * which is how a read-only feature ships looking complete.
 *
 * THE PICKERS ARE FILTERED TO WHAT IS ACTUALLY BINDABLE. Agents the signed-in
 * creator owns; theses they published that no other article has already taken.
 * Offering the rest would be offering choices the service refuses — and finding
 * that out from a 409 after writing an essay is a bad way to learn it.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout } from '@/components/ds/states';
import { ArticleForm, type AgentChoice, type ThesisChoice } from '../ArticleForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Write an article — ARCANA' };

type Dashboard = { agents: Array<{ id: string; name: string; status: string }> };
type CreatorTheses = {
  items: Array<{ id: string; claim: string; article: { id: string } | null }>;
};

export default async function NewArticlePage() {
  const s = await getSession();
  if (s.state === 'signed_out') redirect('/signin?next=/me/articles/new');
  if (s.state === 'unknown') {
    return (
      <div className="page">
        <Header />
        <div className="sec" style={{ paddingTop: 32, paddingBottom: 40, borderBottom: 'none' }}>
          {/* NOT "you are signed out". There is a session and the service could
              not be reached to confirm it; telling somebody to sign in again
              against a service that is down invites them to do it repeatedly. */}
          <Callout tone="warn">
            Your session could not be confirmed: {s.reason}. Nothing has been lost — try again in a
            moment.
          </Callout>
        </div>
        <Footer />
      </div>
    );
  }

  const creatorId = s.session.creator_id;
  if (!creatorId) {
    return (
      <div className="page">
        <Header />
        <div className="sec" style={{ paddingTop: 32, paddingBottom: 40, borderBottom: 'none' }}>
          <h1 style={{ fontSize: 22 }}>A profile comes first</h1>
          <p className="m2" style={{ fontSize: 13, marginTop: 10, maxWidth: 620, lineHeight: 1.6 }}>
            Articles are published under a creator handle — the same one your agents and theses
            carry. <Link href="/me">Create a profile</Link>; it is a single name.
          </p>
        </div>
        <Footer />
      </div>
    );
  }

  const [dashR, thesesR] = await Promise.all([
    authed<Dashboard>(`/v1/creators/${creatorId}/dashboard`),
    authed<CreatorTheses>(`/v1/creators/${creatorId}/theses?page_size=100`),
  ]);

  const agents: AgentChoice[] = dashR.ok
    ? dashR.data.agents.map((a) => ({ id: a.id, name: a.name, status: a.status }))
    : [];
  // A thesis already carried by an article cannot be carried by a second one
  // (0052 makes articles.thesis_id UNIQUE), so it is not offered.
  const theses: ThesisChoice[] = thesesR.ok
    ? thesesR.data.items.filter((t) => t.article === null).map((t) => ({ id: t.id, claim: t.claim }))
    : [];

  return (
    <div className="page">
      <Header />

      <div className="sec" style={{ paddingTop: 30, paddingBottom: 16 }}>
        <div className="m3" style={{ fontSize: 11.5 }}>
          <Link href="/me">Dashboard</Link> · <Link href="/articles">Articles</Link>
        </div>
        <h1 style={{ fontSize: 23, marginTop: 6 }}>Write an article</h1>
        <p className="m2" style={{ fontSize: 12.5, marginTop: 8, maxWidth: 680, lineHeight: 1.6 }}>
          Published under your handle, readable by anyone, and editable afterwards. Naming an agent
          or carrying a thesis are both optional — and both are fixed once set.
        </p>
      </div>

      <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
        {!dashR.ok ? (
          <Callout tone="warn">
            Your agents could not be read ({dashR.reason}), so the agent picker is empty. You can
            still publish — the binding can be added later, once.
          </Callout>
        ) : null}
        <div style={{ marginTop: 14 }}>
          <ArticleForm agents={agents} theses={theses} />
        </div>
      </div>

      <Footer />
    </div>
  );
}
