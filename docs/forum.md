# Forum and articles — the social layer

Discussion boards, threads, replies, article comments, like/save, and the
report/hide floor under them. Migration `0056_forum_and_social_articles`.

**The one property everything else rests on: none of this reaches an agent.**
No table here holds an agent, season or competition reference. The decision
engine and the scoring engine contain no mention of `forum_threads`,
`forum_posts`, `content_reactions` or `content_reports` — and that is asserted
by execution, not by reading: `infra/verify/forum-verify.mjs` gives one of two
identical deterministic agents a thread, an article, six comments and two
likes, asks both to decide, and compares the answers. It also queries the live
schema for any foreign key pointing into the social tables from outside them,
because the way this breaks later is not a query somebody writes — it is a
column somebody adds.

The social layer reads the platform. The platform does not read it back.

## What is where

| Thing | Table | Notes |
| --- | --- | --- |
| Boards | `forum_boards` | Seeded: `general`, `strategy`, `agent-reviews`, `market`. A table, not an enum, so renaming one is not a migration. |
| Threads | `forum_threads` | `reply_count`, `last_reply_at`, `like_count`, `save_count` are trigger-maintained. |
| Replies **and** article comments | `forum_posts` | One table. Exactly one of `thread_id` / `article_id` is set (`CHECK num_nonnulls(...) = 1`). |
| Like / save | `content_reactions` | One row per person per item per kind, enforced by partial unique indexes. |
| Reports | `content_reports` | One report per person per item. No auto-hide. |
| Articles | `articles` (from 0052) | Gains `agent_id`, the three counters, and the moderation columns. |

### Why replies and comments share a table

They are the same act: a person writing prose under something somebody else
wrote. Two tables would have meant two moderation paths, two report shapes and
two places to fix the next thing either gets wrong — and the second copy always
lags. The cost is one `CHECK` constraint and two partial indexes.

### Why every author is a creator, not a wallet

Agents, articles and theses all hang off `creators(id)`. A forum keyed on
`wallet_address` would be a second identity space, where the same person has a
handle in one half of the site and an `0x`-prefix in the other, and where
moderating one says nothing about the other. So signing in is not enough to
post: the write routes answer `403 creator_profile_required` and name the form
that makes one, which is a single field.

## Counters are recomputed, not incremented

Every counter is a `count(*)` over the rows it counts, re-run by trigger on each
change. Increment/decrement is faster and is wrong the first time a write path
forgets one half — and the symptom is a thread listing "3 replies" over two
replies, which nobody reports as a bug and everybody quietly stops trusting.
These tables are small and the write rate is human-speed.

`reply_count` **includes hidden replies**, because a hidden reply still renders
— as a placeholder. A count that excluded them would disagree with the page it
labels.

## Moderation

Deliberately thin, and shaped by three decisions:

1. **Hidden, never deleted.** The row stays and is marked with `hidden_at`,
   `hidden_by` and `hidden_reason`. A reply cut out of the middle of a thread
   leaves the ones that answered it looking like non-sequiturs, and makes the
   fact that anybody moderated anything disappear.
2. **No auto-hide on a report threshold.** N reports hiding something
   automatically is a brigading tool, and the people most worth reading are the
   easiest to organise against. Reports queue; a person decides.
3. **Who may hide:** an operator wallet (`AUTH_ADMIN_WALLETS`), **or** the
   author of the thing it sits under — their own thread, their own article,
   their own post. The second tier is what lets spam go in minutes rather than
   when an operator next looks. It is also the sharp edge: a thread author can
   hide a reply that disagrees with them. The mitigations are that hiding is on
   the record, the reason is shown publicly in the placeholder, and an operator
   can reverse it. Anyone else may only un-hide what they themselves hid.

A hidden thread is **not listed** on its board but **still answers** at its
permalink, with the reason. A board is a place to discover things and a removed
thread is not one; somebody holding a link is owed an explanation rather than a
404. A hidden reply keeps its place inside its thread.

Hidden content is withheld with `body: null`, never blanked to `""` — "removed,
and here is why" and "somebody posted nothing" are different claims.

## Articles and the agent they name

An article may name **one agent, optionally**, independently of whether it
carries a thesis. Before 0056 the only way to show an agent beside an article
was to publish a forecast about it, which pushed people into inventing claims to
get a card — the exact failure 0052 avoided by making `thesis_id` optional.

- The agent must be **the author's own**, checked by `assertOwnsAgent`. The card
  publishes that agent's score, returns, drawdown and open positions.
- The binding is **fixed once set** — `NULL → agent` is allowed once,
  `agent → another agent` is refused by the service *and* by the trigger in
  0056. An article re-pointed at an agent that later did well is claiming a
  track record it never discussed.
- `articles.agent_id` stores an **id and nothing else**. No score, no return, no
  drawdown copy. The Linked Agent card reads the agent's own endpoints live,
  which is why the card and the agent's page cannot disagree.

### A stopped or private agent still gets an honest card

This is the part that matters most, because the failure it prevents looks like
success:

- **Retired or paused** — the overview still answers with the figures the agent
  finished on. Rendered with no label they read as a live position, and the
  longer it has been retired the more confidently wrong the card looks. So the
  card says the agent is retired and calls the numbers final.
- **Private** — 0047 withholds a private agent's performance, so the endpoints
  answer with nulls, and a card rendering those draws four em-dashes: a
  perfectly reasonable way to show an agent that never traded, and the wrong
  thing to say about one whose owner simply does not publish it. The private
  case renders its own card saying so.
- **Unreachable** — `Unavailable`, as everywhere else. "Holds nothing" and "we
  could not find out" are never rendered the same way.

The article itself is unaffected by any of it: `articles.agent_id` is
`ON DELETE RESTRICT`, because an article outlives the agent it discusses.

## Markdown

`services/web/src/lib/markdown.tsx`, about 250 lines, no dependencies. It
renders to **React elements and never builds a string of HTML**, so there is
nothing for a sanitiser to get wrong — a `<script>` somebody types is a string
that React escapes like any other. Supported: headings, `**bold**`, `*italic*`,
`` `code` ``, fenced code, lists, blockquote, rules, and links restricted to
`http(s)://` or site-relative. Not supported, deliberately: raw HTML, images
(a remote image turns a post into a visitor log for whoever hosts it), tables,
autolinking. Unknown syntax renders as the characters that were typed rather
than being swallowed.

## Cleanup and foreign keys

`creator_id` on the social tables is `ON DELETE CASCADE`, unlike `public_theses`
which is `RESTRICT`. A published thesis is evidence and must outlive its
author's account; a forum post is conversation and carries no claim anything is
measured against. The practical reason is the verification sweep
(`infra/verify/lib/fixtures.mjs`), which deletes marked creators in one
transaction — a fixture thread nobody thought about would fail that delete and
take every suite's cleanup with it. There is no product path that deletes a
creator.

`articles.agent_id` is the exception at `RESTRICT`, so the sweep removes
fixture-authored articles bound to doomed agents before deleting the agents. An
article by a **real** creator bound to a marked agent is left alone on purpose:
it then blocks the sweep, the sweep says so, and that is the correct noise to
make.

## Verifying

```bash
node infra/verify/forum-verify.mjs
```

Eleven sections. The three the brief asked for are 3 (a thread, its replies,
and the order they are in — read with no session), 8 (the card prints the
agent page's own numbers) and 10 (nothing social reaches a decision, a score or
a rank). Sections 9 and 11 cover the private and retired cards; 11 is last
because retiring an agent cannot be undone, and doing it earlier would have
left section 10 comparing a refusal against a decision.
