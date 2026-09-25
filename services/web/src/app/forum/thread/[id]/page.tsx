/**
 * One thread and its replies.
 *
 * A HIDDEN THREAD ANSWERS, it does not 404. The service withholds the title and
 * body and sends the reason; this page prints that reason. "Removed, and here
 * is why" and "never existed" are different facts, and somebody arriving from a
 * link elsewhere is owed the true one.
 *
 * THE REPLIES ARE RENDERED IN THE SERVICE'S ORDER, oldest first. Nothing here
 * sorts, and the hidden ones keep their place — see components/social/Posts.
 *
 * THE VIEWER'S LIKE STATE IS A SEPARATE, AUTHENTICATED READ. The thread and its
 * replies are fetched anonymously, identically for everyone; only when somebody
 * is signed in does the page ask which of these ids they have reacted to. That
 * is what keeps the public read public.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent, qs } from '@/lib/api';
import { ago, utc } from '@/lib/format';
import { authed, getSession } from '@/lib/session';
import { Markdown } from '@/lib/markdown';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Failed } from '@/components/ds/states';
import { Pager } from '@/components/ds/nav';
import { Avatar } from '@/components/social/Avatar';
import { Composer } from '@/components/social/Composer';
import { ModerationControls } from '@/components/social/ModerationControls';
import { Posts } from '@/components/social/Posts';
import { ReactionBar } from '@/components/social/ReactionBar';
import type { MyReactions, Paged, PostItem, ThreadDetail } from '@/lib/social';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Thread — ARCANA' };

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page: pageRaw } = await searchParams;
  const page = Number(pageRaw) > 0 ? Number(pageRaw) : 1;

  const [tr, pr, s] = await Promise.all([
    agent<ThreadDetail>(`/v1/forum/threads/${id}`),
    agent<Paged<PostItem>>(`/v1/forum/threads/${id}/posts${qs({ page, page_size: 50 })}`),
    getSession(),
  ]);
  if (!tr.ok && tr.status === 404) notFound();

  const signedIn = s.state === 'signed_in';
  const creatorId = signedIn ? s.session.creator_id : null;
  const isOperator = signedIn ? s.session.is_operator === true : false;

  // Only asked when there is somebody to ask about. A signed-out visitor makes
  // no authenticated request at all from this page.
  const mine = signedIn
    ? await authed<MyReactions>(`/v1/me/reactions${qs({ threads: id })}`)
    : null;
  const myState = mine?.ok ? mine.data.threads[id] : undefined;

  const here = `/forum/thread/${id}`;

  return (
    <div className="page">
      <Header current="forum" />

      {!tr.ok ? (
        <div className="sec" style={{ paddingTop: 32 }}>
          <Failed what="This thread" error={tr} />
        </div>
      ) : (
        <>
          <div className="sec" style={{ paddingTop: 28, paddingBottom: 24 }}>
            <nav className="fm-crumbs" aria-label="Breadcrumb">
              <Link href="/forum">Forum</Link>
              <span aria-hidden="true">/</span>
              <Link href={`/forum/${tr.data.board.slug}`}>{tr.data.board.name}</Link>
            </nav>

            {tr.data.hidden ? (
              <div
                className="m2"
                style={{
                  marginTop: 14,
                  padding: '14px 16px',
                  border: '1px dashed var(--ink-3)',
                  fontSize: 13,
                  lineHeight: 1.6,
                  maxWidth: 820,
                }}
              >
                <strong>This thread was hidden by moderation</strong> on{' '}
                <span className="mono">{utc(tr.data.hidden.at)}</span>. Reason given:{' '}
                <em>{tr.data.hidden.reason}</em>.
                <div className="m3" style={{ fontSize: 11.5, marginTop: 8 }}>
                  The replies below are kept so the record of what happened is complete. Nothing
                  here ever affected an agent&rsquo;s score.
                </div>
              </div>
            ) : (
              <h1 style={{ fontSize: 26, marginTop: 10, lineHeight: 1.25, maxWidth: 820 }}>
                {tr.data.title}
              </h1>
            )}

            <article className="fm-post" style={{ marginTop: 18, maxWidth: 820 }}>
              <div className="fm-post-hd">
                <Avatar handle={tr.data.author.handle} />
                <div style={{ minWidth: 0 }}>
                  <Link href={`/creators/${tr.data.author.id}`}>{tr.data.author.handle}</Link>
                  <div className="m3 mono" style={{ fontSize: 10.5, marginTop: 2 }}>
                    <span title={utc(tr.data.created_at)}>{ago(tr.data.created_at)}</span>
                    {tr.data.updated_at !== tr.data.created_at ? (
                      <> · <span title={`Edited ${utc(tr.data.updated_at)}`}>edited</span></>
                    ) : null}
                  </div>
                </div>
                <span className="tag tag-accent" style={{ marginLeft: 'auto' }}>
                  AUTHOR
                </span>
              </div>

              {tr.data.hidden ? null : (
                <div className="fm-post-bd">
                  <Markdown source={tr.data.body ?? ''} className="fm-body" />
                </div>
              )}

              <div className="fm-post-ft">
                <ReactionBar
                  subject={{ kind: 'thread', id }}
                  initial={{
                    like_count: tr.data.like_count,
                    save_count: tr.data.save_count,
                    liked: signedIn ? (myState?.liked ?? false) : null,
                    saved: signedIn ? (myState?.saved ?? false) : null,
                  }}
                  signedIn={signedIn}
                  revalidate={here}
                />
                <span style={{ marginLeft: 'auto' }}>
                  <ModerationControls
                    subject={{ kind: 'thread', id }}
                    revalidate={here}
                    signedIn={signedIn}
                    canHide={isOperator || (creatorId !== null && creatorId === tr.data.author.id)}
                    hidden={tr.data.hidden !== null}
                    canUnhide={isOperator}
                  />
                </span>
              </div>
            </article>
          </div>

          <div className="sec" style={{ paddingTop: 24, paddingBottom: 8, borderBottom: 'none' }}>
            <div style={{ maxWidth: 820 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
                <h2 style={{ fontSize: 16 }}>Replies</h2>
                <span className="mono m3" style={{ fontSize: 12 }}>
                  {tr.data.reply_count}
                </span>
              </div>
              {!pr.ok ? (
                <Failed what="The replies" error={pr} />
              ) : (
                <>
                  <Posts
                    posts={pr.data.items}
                    viewer={{ signedIn, creatorId, isOperator }}
                    parentAuthorId={tr.data.author.id}
                    revalidate={here}
                    offset={(pr.data.page - 1) * pr.data.page_size}
                    emptyNote="Nobody has replied yet. Start the conversation."
                  />
                  {pr.data.total > pr.data.page_size ? (
                    <Pager
                      page={pr.data.page}
                      pageSize={pr.data.page_size}
                      total={pr.data.total}
                      hasMore={pr.data.has_more}
                      hrefFor={(p) => `${here}${qs({ page: p > 1 ? p : null })}`}
                      unit="replies"
                    />
                  ) : null}
                </>
              )}

              {tr.data.hidden ? (
                <div className="m3" style={{ fontSize: 12, marginTop: 16 }}>
                  This thread is closed to new replies.
                </div>
              ) : (
                <Composer target={{ kind: 'thread', id }} signedIn={signedIn} />
              )}
            </div>

            <div style={{ height: 40 }} />
          </div>
        </>
      )}

      <Footer />
    </div>
  );
}
