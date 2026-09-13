/**
 * The documentation, in three columns.
 *
 * THE FIGURES ARE READ ON EVERY REQUEST. `GET /v1/docs/parameters` is fetched
 * here and handed to the page body, so a weight or a term length that changes
 * in the engine changes here in the same deploy. When it cannot be read, the
 * affected pages say so instead of printing the numbers that were true when
 * they were written — a documented constant that has since moved is worse than
 * a gap, because documentation is the version everybody quotes afterwards.
 *
 * SEARCH IS A GET FORM over the page index. It matches titles, ledes, keywords
 * and headings, and the results line says so — an empty result must not read as
 * "that word appears nowhere in the documentation" when what it means is "not
 * in the index this searches".
 *
 * THE CONTENTS COLUMN IS DECLARED, NOT SCRAPED. Each page lists its own
 * headings, so the anchors cannot drift out of step with the prose the way a
 * DOM-walking table of contents does.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { agent } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout } from '@/components/ds/states';
import { GROUPS, PAGES, pageBySlug, search } from '../content';
import type { DocParams } from '../shapes';

export const dynamic = 'force-dynamic';

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DocsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<SP>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const q = (one(sp.q) || '').trim();

  const wanted = slug && slug.length > 0 ? slug.join('/') : 'what-arcana-is';
  const page = pageBySlug(wanted);
  if (!page) notFound();

  const paramsR = await agent<DocParams>('/v1/docs/parameters');
  const live = paramsR.ok ? paramsR.data : null;
  const hits = q ? search(q) : [];

  return (
    <div className="page">
      <Header current="Docs" />

      <div className="sec docs-grid" style={{ paddingTop: 26, paddingBottom: 48, borderBottom: 'none' }}>
        {/* ---------------------------------------------------- sidebar */}
        <nav className="docnav" aria-label="Documentation">
          <form method="get" action={`/docs/${page.slug}`} style={{ marginBottom: 6 }}>
            <input
              className="input"
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search docs"
              aria-label="Search the documentation"
              style={{ width: '100%', fontSize: 12 }}
            />
          </form>
          {q ? (
            <div style={{ marginBottom: 10 }}>
              <div className="grp" style={{ marginTop: 6 }}>
                {hits.length} result{hits.length === 1 ? '' : 's'}
              </div>
              {hits.map((h) => (
                <Link key={h.slug} href={`/docs/${h.slug}`} aria-current={h.slug === page.slug ? 'page' : undefined}>
                  {h.title}
                </Link>
              ))}
              <div className="m3" style={{ fontSize: 10.5, lineHeight: 1.45, marginTop: 6 }}>
                Searches page titles, summaries, keywords and headings — not the body text. An empty result means the
                word is not in that index, not that it appears nowhere.
              </div>
              <Link href={`/docs/${page.slug}`} style={{ marginTop: 6 }}>
                clear search
              </Link>
            </div>
          ) : null}

          {GROUPS.map((g) => (
            <div key={g}>
              <div className="grp">{g}</div>
              {PAGES.filter((p) => p.group === g).map((p) => (
                <Link key={p.slug} href={`/docs/${p.slug}`} aria-current={p.slug === page.slug ? 'page' : undefined}>
                  {p.title}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        {/* ------------------------------------------------------- body */}
        <article className="prose" style={{ minWidth: 0 }}>
          <div className="mono m3" style={{ fontSize: 11, marginBottom: 10 }}>
            <Link href="/docs" className="m2">
              Docs
            </Link>{' '}
            / {page.group} / {page.title}
          </div>
          <h1>{page.title}</h1>
          <p style={{ fontSize: 15.5, color: 'var(--ink-2)' }}>{page.lede}</p>

          {!paramsR.ok ? (
            <div style={{ margin: '0 0 20px' }}>
              <Callout tone="warn">
                <strong>The live figures could not be read.</strong> The services that hold them answered{' '}
                {paramsR.status ? `${paramsR.status}: ${paramsR.reason}` : paramsR.reason}. Any number this page would
                have quoted is left out rather than filled in from memory.
              </Callout>
            </div>
          ) : null}

          {page.body(live)}
        </article>

        {/* -------------------------------------------------- contents */}
        <aside className="toc" aria-label="On this page">
          <div className="lbl" style={{ marginBottom: 10 }}>
            ON THIS PAGE
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {page.toc.map((t) => (
              <a key={t.id} href={`#${t.id}`} style={t.sub ? { paddingLeft: 22 } : undefined}>
                {t.label}
              </a>
            ))}
          </div>
          <div className="box" style={{ marginTop: 24, padding: '12px 14px' }}>
            <div className="lbl" style={{ marginBottom: 6 }}>
              WHERE THE NUMBERS COME FROM
            </div>
            <div className="m2" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              Every figure on these pages is read from the running services at request time, not written into the text.
              {live ? (
                <>
                  {' '}
                  Last read <span className="mono">{live.as_of.replace('T', ' ').slice(11, 19)}Z</span>.
                </>
              ) : null}
            </div>
            <Link href="/status" style={{ fontSize: 11.5, display: 'inline-block', marginTop: 8 }}>
              System status →
            </Link>
          </div>
        </aside>
      </div>

      <Footer />
    </div>
  );
}
