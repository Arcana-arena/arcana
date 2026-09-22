/**
 * Publish a thesis.
 *
 * THE DOOR THAT WAS NOT THERE. `POST /v1/theses` has existed since 0052, and
 * the article form's thesis picker lists "theses you published" — which, with
 * no way to publish one from the site, was always empty. This page is what
 * makes that picker mean something.
 *
 * ONLY ACTIVE AGENTS ARE OFFERED, because the service refuses the rest: a
 * thesis is measured over an agent that is deciding.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authed, getSession } from '@/lib/session';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout } from '@/components/ds/states';
import { ThesisForm, type ThesisAgentChoice } from '../ThesisForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Publish a thesis — ARCANA' };

type Dashboard = { agents: Array<{ id: string; name: string; status: string }> };

export default async function NewThesisPage() {
  const s = await getSession();
  if (s.state === 'signed_out') redirect('/signin?next=/me/theses/new');
  if (s.state === 'unknown') {
    return (
      <div className="page">
        <Header />
        <div className="sec" style={{ paddingTop: 32, paddingBottom: 40, borderBottom: 'none' }}>
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
            A thesis is published under a creator handle — the same one your agents and articles
            carry. <Link href="/me">Create a profile</Link>; it is a single name.
          </p>
        </div>
        <Footer />
      </div>
    );
  }

  const dashR = await authed<Dashboard>(`/v1/creators/${creatorId}/dashboard`);
  const agents: ThesisAgentChoice[] = dashR.ok
    ? dashR.data.agents.filter((a) => a.status === 'active').map((a) => ({ id: a.id, name: a.name }))
    : [];

  return (
    <div className="page">
      <Header />

      <div className="sec" style={{ paddingTop: 30, paddingBottom: 16 }}>
        <div className="m3" style={{ fontSize: 11.5 }}>
          <Link href="/me">Dashboard</Link> · <Link href="/me/theses">Your theses</Link> ·{' '}
          <Link href="/theses">All theses</Link>
        </div>
        <h1 style={{ fontSize: 23, marginTop: 6 }}>Publish a thesis</h1>
        <p className="m2" style={{ fontSize: 12.5, marginTop: 8, maxWidth: 680, lineHeight: 1.6 }}>
          State what you expect one of your agents to do against a benchmark, and by when. ARCANA
          timestamps it now and attaches the result when the deadline passes. It is public from the
          moment you publish, and it cannot be edited or taken down.
        </p>
      </div>

      <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
        {!dashR.ok ? (
          <Callout tone="warn">
            Your agents could not be read ({dashR.reason}), so there is nothing to bind a thesis to
            right now. Try again in a moment.
          </Callout>
        ) : (
          <ThesisForm agents={agents} />
        )}
      </div>

      <Footer />
    </div>
  );
}
