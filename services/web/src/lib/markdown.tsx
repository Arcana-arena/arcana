/**
 * Simple markdown, rendered as React elements.
 *
 * THE SECURITY PROPERTY IS STRUCTURAL, NOT A FILTER. This file never builds a
 * string of HTML and never calls dangerouslySetInnerHTML, so there is nothing
 * for a sanitiser to get wrong. Every piece of a post becomes a React text node
 * or a React element chosen from the fixed set below; a `<script>` a person
 * types is a string that React escapes on the way out, the same as any other
 * string. The usual alternative — a markdown library plus a sanitiser — is two
 * dependencies whose combined behaviour nobody in this repository could read in
 * an afternoon, guarding a surface where anyone with a wallet can write.
 *
 * WHAT IS SUPPORTED, and nothing else is:
 *   # ## ###        headings
 *   **bold**  *italic*  _italic_  `code`
 *   ```fenced code```
 *   - item / 1. item lists
 *   > quote
 *   ---             rule
 *   [text](https://…) links, http(s) and site-relative only
 *
 * WHAT IS NOT, deliberately: raw HTML, images, tables, footnotes, autolinking.
 * Images and raw HTML are how a post reaches off the page — a remote image is a
 * request every reader's browser makes to a server the author chose, which
 * turns a forum post into a visitor log. Autolinking is left out because a
 * pasted URL rendering as a link is how a wall of them looks deliberate.
 *
 * UNKNOWN SYNTAX IS SHOWN, NOT SWALLOWED. A table someone pastes renders as the
 * pipes and dashes they typed. Dropping it would lose their words; rendering it
 * literally tells them it is not supported here.
 */
import type { ReactNode } from 'react';

/** Where a link may point. Anything else renders as plain text. */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  // Site-relative first: these are the only ones that stay inside ARCANA.
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  if (/^https?:\/\/[^\s<>"]+$/i.test(href)) return href;
  // javascript:, data:, vbscript:, protocol-relative //evil.example — all of
  // these are why this returns null rather than "cleaning" the value. A href
  // that cannot be shown to be one of the two safe shapes is not a href.
  return null;
}

/**
 * Inline spans, in one pass.
 *
 * Code first, and the order matters: `**` inside a code span is asterisks, not
 * bold. A second pass over already-rendered output would have no way to know
 * that. Emphasis inside a link's text is not supported — the text renders
 * literally — because the alternative is a recursive parser for a case that
 * almost never appears in a forum post.
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^()\s]+\))/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  INLINE.lastIndex = 0;

  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-i${i++}`;

    if (tok.startsWith('`')) {
      out.push(
        <code key={key} className="mono" style={{ fontSize: '0.92em', padding: '1px 4px', border: '1px solid var(--color-divider)' }}>
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith('_')) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else {
      const split = tok.indexOf('](');
      const label = tok.slice(1, split);
      const href = safeHref(tok.slice(split + 2, -1));
      if (href === null) {
        // Shown as typed. A refused link that vanished would leave the reader
        // unable to see that anything was there.
        out.push(tok);
      } else if (href.startsWith('/')) {
        out.push(
          <a key={key} href={href}>
            {label || href}
          </a>,
        );
      } else {
        out.push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
            {label || href}
          </a>,
        );
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One line's worth of inline content, with hard line breaks preserved. */
function lines(block: string[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  block.forEach((l, i) => {
    if (i > 0) out.push(<br key={`${keyPrefix}-br${i}`} />);
    out.push(...inline(l, `${keyPrefix}-l${i}`));
  });
  return out;
}

/**
 * Render a markdown string.
 *
 * EMPTY INPUT RENDERS NOTHING, not an empty paragraph: a post with no body and
 * a post whose body is whitespace should not look like two different things.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const src = (source ?? '').replace(/\r\n/g, '\n');
  const raw = src.split('\n');
  const blocks: ReactNode[] = [];

  let i = 0;
  let b = 0;
  while (i < raw.length) {
    const line = raw[i];
    const key = `b${b++}`;

    // Fenced code. Everything inside is literal, including markdown syntax.
    if (/^```/.test(line.trim())) {
      const body: string[] = [];
      i++;
      while (i < raw.length && !/^```/.test(raw[i].trim())) body.push(raw[i++]);
      i++; // the closing fence, or the end of the input if it was never closed
      blocks.push(
        <pre
          key={key}
          className="mono"
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            padding: 12,
            border: '1px solid var(--color-divider)',
            overflowX: 'auto',
            whiteSpace: 'pre',
            margin: '12px 0',
          }}
        >
          {body.join('\n')}
        </pre>,
      );
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line.trim())) {
      blocks.push(<hr key={key} style={{ border: 0, borderTop: '1px solid var(--color-divider)', margin: '18px 0' }} />);
      i++;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const content = inline(heading[2], key);
      const size = depth === 1 ? 19 : depth === 2 ? 16 : 14;
      // h2..h4, never h1: the page's own <h1> is the title, and a post that
      // could mint a second one would break the document outline of a page it
      // does not own.
      const Tag = (depth === 1 ? 'h2' : depth === 2 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4';
      blocks.push(
        <Tag key={key} style={{ fontSize: size, marginTop: 20, marginBottom: 6 }}>
          {content}
        </Tag>,
      );
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < raw.length && /^>\s?/.test(raw[i])) body.push(raw[i++].replace(/^>\s?/, ''));
      blocks.push(
        <blockquote
          key={key}
          className="m2"
          style={{
            borderLeft: '2px solid var(--color-divider)',
            paddingLeft: 12,
            margin: '12px 0',
            fontSize: 13.5,
          }}
        >
          {lines(body, key)}
        </blockquote>,
      );
      continue;
    }

    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const items: string[] = [];
      const re = ordered ? numbered : bullet;
      while (i < raw.length && re.test(raw[i])) items.push(raw[i++].replace(re, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key} style={{ margin: '10px 0', paddingLeft: 22, lineHeight: 1.65 }}>
          {items.map((it, n) => (
            <li key={`${key}-${n}`}>{inline(it, `${key}-${n}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    // A paragraph runs to the next blank line or block opener.
    const body: string[] = [];
    while (
      i < raw.length &&
      raw[i].trim() !== '' &&
      !/^```/.test(raw[i].trim()) &&
      !/^(#{1,3})\s+/.test(raw[i]) &&
      !/^>\s?/.test(raw[i]) &&
      !/^---+\s*$/.test(raw[i].trim()) &&
      !bullet.test(raw[i]) &&
      !numbered.test(raw[i])
    ) {
      body.push(raw[i++]);
    }
    blocks.push(
      <p key={key} style={{ margin: '10px 0', lineHeight: 1.7 }}>
        {lines(body, key)}
      </p>,
    );
  }

  if (blocks.length === 0) return null;
  return (
    <div className={className} style={{ fontSize: 14, maxWidth: 720, overflowWrap: 'anywhere' }}>
      {blocks}
    </div>
  );
}
