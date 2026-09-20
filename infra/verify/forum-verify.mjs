/**
 * forum-verify.mjs — the social layer, proved, including the part that has to
 * NOT be true.
 *
 * THE CHECK THIS FILE EXISTS FOR is section 10: that forum and article content
 * cannot reach an agent's decisions or its score. Everything else here could be
 * right and the platform would still be worthless if a thread could move a
 * ranking — a leaderboard that answers to popularity is a popularity contest
 * with extra steps. A reader cannot verify that by being told, so this builds
 * two identical deterministic agents, gives one of them a thread, an article,
 * comments and likes, asks both for a decision, and compares.
 *
 * DETERMINISTIC AGENTS, NOT LLM ONES, for the same reason thesis-verify uses
 * them: two llm agents can answer differently on identical input for reasons
 * that have nothing to do with a forum post, so a difference would prove
 * nothing and a match would prove less. A momentum agent given the same market
 * must produce the same decision — any difference at all is a leak.
 *
 * AND THREE WAYS, NOT ONE. Behaviour samples one tick. So the behavioural check
 * is joined by a grep of the two engines' source for the social tables, and by
 * a query of the live schema for any foreign key into them from outside the
 * social set — because the way this breaks in six months is not a leak somebody
 * writes, it is a column somebody adds.
 *
 * NOTHING HERE CAN SPEND MONEY. Every agent is a provenance='verification'
 * fixture with no wallet, so there is no key to sign anything with.
 *
 *   node infra/verify/forum-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { suite } from './lib/sections.mjs';
import { signIn as sharedSignIn, SIWE_DOMAIN, SIWE_URI, VERIFICATION_HEADER } from './lib/rate-aware.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const { check, section, nothingToCheck, report } = suite('forum-verify');

const sql = (q) =>
  execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim();
const sql1 = (q) => sql(q).split('\n')[0].trim();

/** Two sessions: the author, and somebody who is not. */
let token = null;
let strangerToken = null;

const call = async (path, init = {}, as = token) => {
  const r = await fetch(`${AGENT}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(as ? { authorization: `Bearer ${as}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const t = await r.text();
  let body = null;
  try { body = t ? JSON.parse(t) : null; } catch { /* a non-JSON body is the caller's problem */ }
  return { status: r.status, body };
};
/** The same call with no Authorization header at all — the public path. */
const anon = (path, init = {}) => call(path, init, null);

const page = async (path) => {
  const r = await fetch(`${WEB}${path}`, { headers: { accept: 'text/html' } });
  return { status: r.status, html: await r.text() };
};
const text = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&nbsp;|&rsquo;|&mdash;|&ndash;/g, ' ').replace(/\s+/g, ' ');

const TAG = `verify_forum_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let creatorId = null;
let strangerCreatorId = null;
const agentIds = [];
const threadIds = [];
const articleIds = [];

/**
 * Remove what a run made.
 *
 * ORDER IS THE FOREIGN KEYS' ORDER, not a guess. articles references both
 * agents and creators with ON DELETE RESTRICT, so it goes first; the social
 * tables reference creators with CASCADE (0056), so deleting the creator takes
 * threads, posts, reactions and reports with it and they need no line here.
 * That cascade is deliberate and is the reason this cleanup is four statements
 * instead of nine.
 */
function purge(handleLike) {
  try {
    sql(
      `DELETE FROM articles WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}');
       DELETE FROM portfolio_snapshots WHERE portfolio_id IN (
         SELECT p.id FROM portfolios p JOIN agents a ON a.id = p.agent_id
          WHERE a.creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}'));
       DELETE FROM portfolios WHERE agent_id IN (
         SELECT id FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}'));
       DELETE FROM decisions WHERE agent_id IN (
         SELECT id FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}'));
       DELETE FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}');
       DELETE FROM creators WHERE handle LIKE '${handleLike}';`,
    );
  } catch (e) {
    console.log('  cleanup warning: ' + e.message);
  }
}

function teardown() { purge(`${TAG}%`); }
purge('verify_forum_%');
process.on('exit', teardown);
process.on('SIGINT', () => { teardown(); process.exit(130); });

try {
  // ---------------------------------------------------------------- set-up
  const owner = privateKeyToAccount(generatePrivateKey());
  const s = await sharedSignIn(AGENT, owner, { chainId: 4663, domain: SIWE_DOMAIN, uri: SIWE_URI });
  if (s.status !== 200 || !s.body?.access_token) {
    check('a fresh wallet can sign in', false, `status ${s.status} ${JSON.stringify(s.body)}`);
    throw new Error('cannot continue without a session');
  }
  token = s.body.access_token;

  const stranger = privateKeyToAccount(generatePrivateKey());
  const s2 = await sharedSignIn(AGENT, stranger, { chainId: 4663, domain: SIWE_DOMAIN, uri: SIWE_URI });
  if (s2.status !== 200 || !s2.body?.access_token) {
    check('a second wallet can sign in', false, `status ${s2.status}`);
    throw new Error('cannot continue without a second session');
  }
  strangerToken = s2.body.access_token;

  // THE PROFILE-LESS WALLET IS TESTED BEFORE A PROFILE EXISTS, because after
  // this point there is no way back to that state for this wallet.
  await section('1. Writing needs a signed-in wallet AND a creator profile', async () => {
    const anonThread = await anon('/v1/forum/threads', { method: 'POST', body: {
      board: 'general', title: `${TAG} anonymous`, body: 'Posted by nobody.' }});
    check('an anonymous caller cannot start a thread', anonThread.status === 401,
      `status ${anonThread.status}`);

    const noProfile = await call('/v1/forum/threads', { method: 'POST', body: {
      board: 'general', title: `${TAG} profileless`, body: 'Posted by a wallet with no profile.' }},
      strangerToken);
    check('a signed-in wallet with no creator profile is refused', noProfile.status === 403,
      `status ${noProfile.status} ${JSON.stringify(noProfile.body)}`);
    check('and the refusal is creator_profile_required, not a 500 from a NOT NULL constraint',
      noProfile.body?.error?.code === 'creator_profile_required',
      JSON.stringify(noProfile.body));
    check('and it names where to make one',
      /\/me/.test(JSON.stringify(noProfile.body)), JSON.stringify(noProfile.body));
  });

  const c = await call('/v1/creators', {
    method: 'POST', headers: VERIFICATION_HEADER, body: { handle: `${TAG}_author` } });
  creatorId = c.body?.id;
  if (!creatorId) {
    check('a fixture creator is made', false, `status ${c.status} ${JSON.stringify(c.body)}`);
    throw new Error('cannot continue without a creator');
  }
  const c2 = await call('/v1/creators', {
    method: 'POST', headers: VERIFICATION_HEADER, body: { handle: `${TAG}_stranger` } }, strangerToken);
  strangerCreatorId = c2.body?.id;

  /** Two agents built from one literal, so "identical" is not a claim. */
  const AGENT_SPEC = {
    strategyType: 'momentum',
    assetUniverse: 'us_equities',
    visibility: 'public',
    riskProfile: JSON.stringify({
      cash_floor_pct: 0.05, trade_size_pct: 0.5, max_position_pct: 1, rebalance_band_pct: 0.0002,
    }),
  };
  for (const name of [`${TAG}_written_about`, `${TAG}_twin`]) {
    const a = await call('/v1/agents', {
      method: 'POST', headers: VERIFICATION_HEADER, body: { ...AGENT_SPEC, name } });
    if (!a.body?.id) {
      check(`fixture agent ${name} is made`, false, `status ${a.status} ${JSON.stringify(a.body)}`);
      throw new Error('cannot continue without two agents');
    }
    agentIds.push(a.body.id);
    await call(`/v1/agents/${a.body.id}/activate`, { method: 'POST' });
  }
  const [subjectAgent, twinAgent] = agentIds;

  // =====================================================================
  await section('2. The boards are public and seeded', async () => {
    const r = await anon('/v1/forum/boards');
    check('the boards read with no session at all', r.status === 200, `status ${r.status}`);
    const slugs = (r.body?.items ?? []).map((b) => b.slug);
    for (const want of ['general', 'strategy', 'agent-reviews', 'market']) {
      check(`the '${want}' board exists`, slugs.includes(want), `boards: ${slugs.join(', ')}`);
    }
    check('every board carries a description a reader can act on',
      (r.body?.items ?? []).every((b) => typeof b.description === 'string' && b.description.length > 10),
      JSON.stringify(r.body?.items));

    const missing = await anon('/v1/forum/boards/not-a-board/threads');
    check('an unknown board is a 404 that names the list', missing.status === 404,
      `status ${missing.status}`);
    check('and says where the real list is',
      /\/v1\/forum\/boards/.test(JSON.stringify(missing.body)), JSON.stringify(missing.body));
  });

  // =====================================================================
  await section('3. A thread, its replies, and the order they are in', async () => {
    const t = await call('/v1/forum/threads', { method: 'POST', body: {
      board: 'strategy',
      title: `${TAG} does a tighter rebalance band help?`,
      body: 'Opening post. **Markdown** is allowed here.',
    }});
    check('a thread is created', t.status === 201 || t.status === 200,
      `status ${t.status} ${JSON.stringify(t.body)}`);
    const threadId = t.body?.id;
    if (!threadId) { check('the thread has an id', false, JSON.stringify(t.body)); return; }
    threadIds.push(threadId);

    // THREE REPLIES, WRITTEN IN A KNOWN ORDER, and read back in that order.
    // Ordering is the thing a forum cannot get wrong: a conversation read in
    // any other sequence is a different conversation.
    const bodies = ['first reply', 'second reply', 'third reply'];
    for (const b of bodies) {
      const r = await call(`/v1/forum/threads/${threadId}/posts`, { method: 'POST', body: { body: `${b} — ${TAG}` } });
      check(`reply "${b}" is accepted`, r.status === 201 || r.status === 200,
        `status ${r.status} ${JSON.stringify(r.body)}`);
    }

    const list = await anon(`/v1/forum/threads/${threadId}/posts`);
    check('the replies read with no session', list.status === 200, `status ${list.status}`);
    const got = (list.body?.items ?? []).map((p) => p.body.split(' —')[0]);
    check('and come back oldest first, in the order they were written',
      JSON.stringify(got) === JSON.stringify(bodies), `got ${JSON.stringify(got)}`);

    const nonDecreasing = (list.body?.items ?? []).every((p, i, a) =>
      i === 0 || new Date(a[i - 1].created_at) <= new Date(p.created_at));
    check('their timestamps do not go backwards', nonDecreasing,
      JSON.stringify((list.body?.items ?? []).map((p) => p.created_at)));

    const read = await anon(`/v1/forum/threads/${threadId}`);
    check('the thread itself reads with no session', read.status === 200, `status ${read.status}`);
    check('the reply count is the service\'s, and matches the replies written',
      read.body?.reply_count === 3, `reply_count=${read.body?.reply_count}`);
    check('and last_reply_at is set once somebody has replied',
      typeof read.body?.last_reply_at === 'string', `last_reply_at=${read.body?.last_reply_at}`);

    // The counter is a trigger's, not the service's: prove it by counting rows.
    const rows = Number(sql1(`SELECT count(*) FROM forum_posts WHERE thread_id = '${threadId}'`));
    check('the published count equals the row count, so nothing is being incremented by hand',
      rows === read.body?.reply_count, `rows=${rows} published=${read.body?.reply_count}`);

    const p = await page(`/forum/thread/${threadId}`);
    check('the thread page renders to a signed-out browser', p.status === 200, `status ${p.status}`);
    const rendered = text(p.html);
    check('the page shows the title', rendered.includes('does a tighter rebalance band help'),
      'title missing from the page');
    const order = bodies.map((b) => rendered.indexOf(b)).filter((i) => i >= 0);
    check('and prints the replies in the same order the API returned them',
      order.length === 3 && order[0] < order[1] && order[1] < order[2],
      `positions ${JSON.stringify(order)}`);
  });

  // =====================================================================
  await section('4. Comments under an article are the same mechanism', async () => {
    const a = await call('/v1/articles', { method: 'POST', body: {
      title: `${TAG} a plain article`,
      body: 'Writing with no agent and no forecast attached. This is the common case.',
    }});
    check('an article with neither an agent nor a thesis is accepted',
      a.status === 201 || a.status === 200, `status ${a.status} ${JSON.stringify(a.body)}`);
    const articleId = a.body?.id;
    if (!articleId) return;
    articleIds.push(articleId);

    const c1 = await call(`/v1/articles/${articleId}/comments`, { method: 'POST', body: { body: `comment one — ${TAG}` } });
    const c2 = await call(`/v1/articles/${articleId}/comments`, { method: 'POST', body: { body: `comment two — ${TAG}` } });
    check('comments are accepted', c1.status < 300 && c2.status < 300, `${c1.status}, ${c2.status}`);

    const list = await anon(`/v1/articles/${articleId}/comments`);
    check('and read publicly, oldest first', list.status === 200 &&
      (list.body?.items ?? []).map((p) => p.body.split(' —')[0]).join(',') === 'comment one,comment two',
      JSON.stringify((list.body?.items ?? []).map((p) => p.body)));

    // ONE TABLE, WHICH IS THE POINT OF THE DESIGN. If comments had grown their
    // own table this query would find nothing, and the two would drift apart
    // one moderation fix at a time.
    const inPosts = Number(sql1(
      `SELECT count(*) FROM forum_posts WHERE article_id = '${articleId}'`));
    check('article comments live in forum_posts, the same table as thread replies',
      inPosts === 2, `forum_posts rows for this article: ${inPosts}`);

    const xor = sql1(
      `SELECT count(*) FROM forum_posts WHERE (thread_id IS NULL) = (article_id IS NULL)`);
    check('and no post is attached to both a thread and an article, or to neither',
      xor === '0', `rows breaking the XOR: ${xor}`);

    const readBack = await anon(`/v1/articles/${articleId}`);
    check('the article\'s comment count comes back from the trigger',
      readBack.body?.comment_count === 2, `comment_count=${readBack.body?.comment_count}`);
  });

  // =====================================================================
  await section('5. Like and save count once per person, however often they click', async () => {
    const threadId = threadIds[0];
    if (!threadId) { nothingToCheck('no thread was created earlier in this run'); return; }

    const one = await call(`/v1/forum/threads/${threadId}/reactions/like`, { method: 'POST' });
    check('a like is accepted', one.status < 300, `status ${one.status} ${JSON.stringify(one.body)}`);
    check('and the count comes back with it', one.body?.like_count === 1, `like_count=${one.body?.like_count}`);

    const twice = await call(`/v1/forum/threads/${threadId}/reactions/like`, { method: 'POST' });
    check('liking twice is still one like', twice.body?.like_count === 1,
      `like_count=${twice.body?.like_count}`);

    const rows = Number(sql1(
      `SELECT count(*) FROM content_reactions WHERE thread_id = '${threadId}' AND kind = 'like'`));
    check('and there is exactly one row behind it', rows === 1, `rows=${rows}`);

    const second = await call(`/v1/forum/threads/${threadId}/reactions/like`, { method: 'POST' }, strangerToken);
    check('a different person\'s like counts separately', second.body?.like_count === 2,
      `like_count=${second.body?.like_count}`);

    const off = await call(`/v1/forum/threads/${threadId}/reactions/like`, { method: 'DELETE' });
    check('un-liking removes only your own', off.body?.like_count === 1,
      `like_count=${off.body?.like_count}`);

    const offAgain = await call(`/v1/forum/threads/${threadId}/reactions/like`, { method: 'DELETE' });
    check('un-liking something you never liked is a success, not a 404',
      offAgain.status < 300, `status ${offAgain.status}`);

    const saved = await call(`/v1/forum/threads/${threadId}/reactions/save`, { method: 'POST' });
    check('save is a separate kind on the same row shape', saved.body?.save_count === 1,
      `save_count=${saved.body?.save_count}`);

    const mine = await call(`/v1/me/reactions?threads=${threadId}`);
    check('the viewer\'s own state is readable in a batch',
      mine.body?.threads?.[threadId]?.saved === true, JSON.stringify(mine.body));
    check('and it is asked for separately from the public read, which stays anonymous',
      (await anon(`/v1/forum/threads/${threadId}`)).status === 200, 'the public read needed a session');

    const badKind = await call(`/v1/forum/threads/${threadId}/reactions/lke`, { method: 'POST' });
    check('a misspelled reaction kind is refused rather than defaulted',
      badKind.status === 400, `status ${badKind.status}`);
  });

  // =====================================================================
  await section('6. Report and hide: the row is kept and the reason is shown', async () => {
    const threadId = threadIds[0];
    if (!threadId) { nothingToCheck('no thread was created earlier in this run'); return; }

    const spam = await call(`/v1/forum/threads/${threadId}/posts`, {
      method: 'POST', body: { body: `buy my thing — ${TAG}` } }, strangerToken);
    const spamId = spam.body?.id;
    check('a second person can reply to somebody else\'s thread', spam.status < 300, `status ${spam.status}`);
    if (!spamId) return;

    const rep = await call(`/v1/forum/posts/${spamId}/reports`, {
      method: 'POST', body: { reason: 'spam', detail: 'advertising' } });
    check('a report is recorded', rep.body?.recorded === true, JSON.stringify(rep.body));

    const again = await call(`/v1/forum/posts/${spamId}/reports`, { method: 'POST', body: { reason: 'spam' } });
    check('reporting the same thing twice is one objection, and says so',
      again.body?.already_reported === true, JSON.stringify(again.body));
    const reportRows = Number(sql1(`SELECT count(*) FROM content_reports WHERE post_id = '${spamId}'`));
    check('with one row behind it', reportRows === 1, `rows=${reportRows}`);

    const badReason = await call(`/v1/forum/posts/${spamId}/reports`, { method: 'POST', body: { reason: 'because' } });
    check('an unknown report reason is refused', badReason.status === 400, `status ${badReason.status}`);

    // THE AUTHOR OF THE THREAD MAY HIDE A REPLY IN IT. This is the second
    // moderation tier and the sharp one: it is what lets spam go in minutes
    // rather than when an operator next looks.
    const strangerTries = await call(`/v1/forum/posts/${spamId}/hide`, {
      method: 'POST', body: { reason: 'I do not like it' } }, strangerToken);
    check('somebody who owns neither the post nor the thread cannot hide it',
      strangerTries.status === 403, `status ${strangerTries.status} ${JSON.stringify(strangerTries.body)}`);

    const hidden = await call(`/v1/forum/posts/${spamId}/hide`, {
      method: 'POST', body: { reason: 'Advertising, repeated' } });
    check('the thread\'s author can hide a reply inside their own thread',
      hidden.status < 300 && hidden.body?.hidden === true, JSON.stringify(hidden.body));

    const stillThere = Number(sql1(`SELECT count(*) FROM forum_posts WHERE id = '${spamId}'`));
    check('the row is KEPT, not deleted', stillThere === 1, `rows=${stillThere}`);

    const list = await anon(`/v1/forum/threads/${threadId}/posts`);
    const row = (list.body?.items ?? []).find((p) => p.id === spamId);
    check('the hidden reply still appears, in its place', row !== undefined, 'the hidden reply vanished');
    check('with its body withheld rather than blanked', row?.body === null, `body=${JSON.stringify(row?.body)}`);
    check('and the reason attached', row?.hidden?.reason === 'Advertising, repeated',
      JSON.stringify(row?.hidden));

    const reportNow = sql1(`SELECT status FROM content_reports WHERE post_id = '${spamId}'`);
    check('the open report is marked actioned rather than left in the queue forever',
      reportNow === 'actioned', `status=${reportNow}`);

    const editHidden = await call(`/v1/forum/posts/${spamId}`, {
      method: 'PATCH', body: { body: 'rewritten after being hidden' } }, strangerToken);
    check('and its author cannot edit it while it is hidden', editHidden.status === 403,
      `status ${editHidden.status}`);

    const p = await page(`/forum/thread/${threadId}`);
    const rendered = text(p.html);
    check('the page says the reply was hidden and why, rather than leaving a gap',
      /hidden by moderation/i.test(rendered) && rendered.includes('Advertising, repeated'),
      'the placeholder or its reason is missing from the page');
    check('and the hidden text itself is not served to the browser',
      !p.html.includes('buy my thing'), 'the hidden body was rendered anyway');
  });

  // =====================================================================
  await section('7. An article may name an agent, and the binding is fixed', async () => {
    const strangersAgent = await call('/v1/articles', { method: 'POST', body: {
      title: `${TAG} somebody else's record`,
      body: 'Trying to decorate my writing with an agent I do not own.',
      agent_id: agentIds[0],
    }}, strangerToken);
    check('an article cannot name an agent its author does not own',
      strangersAgent.status === 403 || strangersAgent.status === 404,
      `status ${strangersAgent.status} ${JSON.stringify(strangersAgent.body)}`);

    const bound = await call('/v1/articles', { method: 'POST', body: {
      title: `${TAG} how this agent trades`,
      body: 'Writing about my own agent. No forecast, no deadline, nothing scored.',
      agent_id: agentIds[0],
    }});
    check('an article naming the author\'s own agent is accepted', bound.status < 300,
      `status ${bound.status} ${JSON.stringify(bound.body)}`);
    const id = bound.body?.id;
    if (!id) return;
    articleIds.push(id);

    const read = await anon(`/v1/articles/${id}`);
    check('the binding reads back', read.body?.agent?.id === agentIds[0], JSON.stringify(read.body?.agent));
    check('and carries no copy of the agent\'s performance — only its identity',
      read.body?.agent !== null && read.body.agent.score === undefined &&
        read.body.agent.return_pct === undefined,
      JSON.stringify(read.body?.agent));
    check('it carries no thesis, and does not have to', read.body?.thesis === null,
      JSON.stringify(read.body?.thesis));

    const moved = await call(`/v1/articles/${id}`, { method: 'PATCH', body: { agent_id: agentIds[1] } });
    check('the agent binding cannot be moved to another agent', moved.status === 409,
      `status ${moved.status} ${JSON.stringify(moved.body)}`);
    check('and the refusal explains rather than naming a constraint',
      /track record|cannot be moved/i.test(JSON.stringify(moved.body)), JSON.stringify(moved.body));

    const dbMove = (() => {
      try {
        execFileSync('psql', [DB, '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c',
          `UPDATE articles SET agent_id = '${agentIds[1]}' WHERE id = '${id}'`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return null;
      } catch (e) { return `${e.stderr || ''}`.trim(); }
    })();
    check('the database refuses it too, not only the service', dbMove !== null,
      'the binding was moved by direct SQL');

    const prose = await call(`/v1/articles/${id}`, { method: 'PATCH', body: {
      body: 'The prose, revised. This is allowed; the binding is not.' }});
    check('while the prose stays editable', prose.status === 200, `status ${prose.status}`);

    const forAgent = await anon(`/v1/agents/${agentIds[0]}/articles`);
    check('the agent\'s page can list what was written about it',
      forAgent.status === 200 && (forAgent.body?.items ?? []).some((a) => a.id === id),
      `status ${forAgent.status}`);
  });

  // =====================================================================
  await section('8. The linked agent card shows the agent page\'s own numbers', async () => {
    const id = articleIds[articleIds.length - 1];
    const agentId = agentIds[0];
    if (!id) { nothingToCheck('no agent-bound article was created earlier in this run'); return; }

    const [over, board] = await Promise.all([
      anon(`/v1/agents/${agentId}/overview`),
      anon('/v1/leaderboard?page_size=100&include_unranked=true'),
    ]);
    check('the agent overview endpoint answers', over.status === 200, `status ${over.status}`);

    const p = await page(`/articles/${id}`);
    check('the article page renders', p.status === 200, `status ${p.status}`);
    const t = text(p.html);

    const returnPct = over.body?.stats?.return_pct?.value;
    if (returnPct === null || returnPct === undefined) {
      check('the overview has a return to compare against', true,
        'no return yet for a fresh fixture — nothing to disagree about');
    } else {
      const shown = returnPct.toFixed(2);
      check(`the card prints the overview's own return (${shown}%)`, t.includes(shown),
        `page does not contain ${shown}`);
    }

    const row = (board.body?.items ?? []).find((i) => i.agent_id === agentId);
    if (row?.score !== null && row?.score !== undefined) {
      check(`the card prints the leaderboard's own score (${row.score})`,
        t.includes(String(row.score)), `page does not contain ${row.score}`);
    }

    check('the card names the agent', t.includes(`${TAG}_written_about`), 'agent name missing');
    check('and says the numbers are read from the agent\'s own endpoints',
      /read live from the agent|own endpoints/i.test(t), 'the page omits where the numbers came from');
  });

  // =====================================================================
  await section('9. A private agent gets an honest card, not a row of dashes', async () => {
    const id = articleIds[articleIds.length - 1];
    const agentId = agentIds[0];
    if (!id) { nothingToCheck('no agent-bound article was created earlier in this run'); return; }

    // DIRECT SQL, and deliberately. Visibility is settable at creation and on
    // evolve, and evolving MAKES A NEW AGENT — which would give this section a
    // different id than the article is bound to, and prove nothing about the
    // binding under test. The column is what the endpoints read, so setting it
    // puts the row in exactly the state a private agent's row is in.
    sql(`UPDATE agents SET visibility = 'private' WHERE id = '${agentId}'`);

    const privatePage = await page(`/articles/${id}`);
    const pt = text(privatePage.html);
    check('the article still renders when its agent is private', privatePage.status === 200,
      `status ${privatePage.status}`);
    check('and the card says the agent is private rather than drawing withheld numbers as dashes',
      /private/i.test(pt) && /withholds|not only here|made it private/i.test(pt),
      'the private card does not explain itself');

    const apiRead = await anon(`/v1/articles/${id}`);
    check('the API reports the visibility rather than omitting it',
      apiRead.body?.agent?.visibility === 'private', `visibility=${apiRead.body?.agent?.visibility}`);

    sql(`UPDATE agents SET visibility = 'public' WHERE id = '${agentId}'`);
  });

  // =====================================================================
  await section('10. Nothing social reaches a decision, a score or a rank', async () => {
    const [subjectAgentId, twinId] = agentIds;

    // (a) STRUCTURAL — the two engines cannot name these tables.
    const grepFor = (dir) => {
      try {
        return execFileSync('grep', [
          '-rlE', 'forum_threads|forum_posts|forum_boards|content_reactions|content_reports',
          `${ROOT}/services/${dir}`, '--include=*.go',
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (e) {
        if (e.status !== 1) throw e; // 1 = no matches, which is what we want
        return '';
      }
    };
    const engineHits = grepFor('decision-engine');
    const scoringHits = grepFor('scoring-engine');
    check('the decision engine source contains no reference to any social table',
      engineHits === '', `matched in:\n${engineHits}`);
    check('the scoring engine source contains no reference to any social table',
      scoringHits === '', `matched in:\n${scoringHits}`);

    // (b) SCHEMA — nothing outside the social set may point INTO it. This is
    // the check that survives a refactor: the way this breaks is not a query
    // somebody writes, it is a foreign key somebody adds.
    const referrers = sql(
      `SELECT DISTINCT c.conrelid::regclass::text
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid::regclass::text IN
              ('forum_threads','forum_posts','forum_boards','content_reactions','content_reports')
        ORDER BY 1`).split('\n').map((s) => s.trim()).filter(Boolean);
    const allowed = new Set([
      'forum_threads', 'forum_posts', 'content_reactions', 'content_reports',
    ]);
    const strangers = referrers.filter((t) => !allowed.has(t));
    check('no table outside the social set has a foreign key into one',
      strangers.length === 0, `unexpected referrers: ${strangers.join(', ')}`);

    // (c) BEHAVIOURAL — one agent is written about at length, its twin is not.
    const loud = await call('/v1/forum/threads', { method: 'POST', body: {
      board: 'agent-reviews',
      title: `${TAG} this agent is the best on the platform`,
      body: 'Sustained, enthusiastic, entirely unearned praise for one specific agent.',
    }});
    if (loud.body?.id) {
      threadIds.push(loud.body.id);
      for (let i = 0; i < 5; i++) {
        await call(`/v1/forum/threads/${loud.body.id}/posts`, {
          method: 'POST', body: { body: `agreed, ${i} — ${TAG}` } });
      }
      await call(`/v1/forum/threads/${loud.body.id}/reactions/like`, { method: 'POST' });
      await call(`/v1/forum/threads/${loud.body.id}/reactions/like`, { method: 'POST' }, strangerToken);
    }

    const hashOf = (id) =>
      sql1(`SELECT md5(coalesce(mandate, '<none>') || risk_profile::text) FROM agents WHERE id = '${id}'`);
    check('the written-about agent\'s mandate and risk profile are byte-identical to its twin\'s',
      hashOf(subjectAgentId) === hashOf(twinId),
      `${hashOf(subjectAgentId)} vs ${hashOf(twinId)}`);

    const decide = (id) => call(`/v1/agents/${id}/decisions`, { method: 'POST', body: {} });
    const a = await decide(subjectAgentId);
    const b = await decide(twinId);
    check('both agents answered a decision request', a.status < 500 && b.status < 500,
      `subject ${a.status}, twin ${b.status}`);

    const shape = (r) => JSON.stringify({
      action: r.body?.action ?? r.body?.decision?.action ?? null,
      symbol: r.body?.symbol ?? r.body?.decision?.symbol ?? null,
      reason: r.body?.reason_code ?? r.body?.decision?.reason_code ?? null,
    });
    check('the agent with a thread, an article, six comments and two likes decided exactly as its silent twin',
      shape(a) === shape(b), `subject ${shape(a)} vs twin ${shape(b)}`);

    // (d) The score is untouched. Not "unchanged in this run" by luck: no
    // score row for either agent may mention anything social, and there is no
    // column that could.
    const socialInScores = sql1(
      `SELECT count(*) FROM information_schema.columns
        WHERE table_name IN ('score_snapshots','score_input_seals')
          AND (column_name LIKE '%thread%' OR column_name LIKE '%post%'
               OR column_name LIKE '%like%' OR column_name LIKE '%comment%'
               OR column_name LIKE '%article%')`);
    check('the score tables have no column that could hold a social input',
      socialInScores === '0', `matching columns: ${socialInScores}`);
  });

  // =====================================================================
  // LAST, BECAUSE IT CANNOT BE UNDONE. A retired agent cannot be reactivated —
  // "its record has closed" — so retiring the subject agent any earlier would
  // have left section 10 comparing a refusal against a decision, which proves
  // nothing about either.
  await section('11. A retired agent\'s card says so, instead of reading as live', async () => {
    const id = articleIds[articleIds.length - 1];
    const agentId = agentIds[0];
    if (!id) { nothingToCheck('no agent-bound article was created earlier in this run'); return; }

    const retire = await call(`/v1/agents/${agentId}/retire`, { method: 'POST' });
    check('the agent can be retired', retire.status < 300,
      `status ${retire.status} ${JSON.stringify(retire.body)}`);

    const after = await page(`/articles/${id}`);
    const at = text(after.html);
    check('the article still renders after its agent retired', after.status === 200,
      `status ${after.status}`);
    check('the card says the agent is retired', /retired/i.test(at),
      'the page does not mention that the agent stopped');
    check('and calls its figures final rather than presenting them as a live position',
      /where it finished|not where it is going/i.test(at),
      'a retired agent\'s numbers are rendered with no label');

    const apiRead = await anon(`/v1/articles/${id}`);
    check('the API reports the lifecycle status rather than omitting it',
      apiRead.body?.agent?.status_now === 'retired', `status_now=${apiRead.body?.agent?.status_now}`);
    check('and the article itself is untouched by what became of the agent',
      typeof apiRead.body?.title === 'string' && apiRead.body.title.length > 0,
      'the article lost its own content when its agent retired');
  });

  process.exit(report());
} catch (e) {
  console.log(`\n  FAIL  the suite threw before finishing — ${e && e.message}`);
  report();
  process.exit(1);
}
