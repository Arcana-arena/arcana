/**
 * The X account, as the mark rather than as words.
 *
 * WHY A COMPONENT AND NOT TWO COPIES. There are two footers on this site — the
 * landing page has its own — and the first version of this link was written
 * into one of them as the text "@Arcana_Arena on X". A social link is an icon
 * in every place people expect to find one, and prose set in whatever the
 * surrounding column happens to use reads as a stray sentence rather than as a
 * control. Written once here so the two footers cannot drift apart, which is
 * exactly what happened when the link existed in only one of them.
 *
 * INLINE SVG, NOT AN IMAGE FILE. It is one path. An <img> would be a second
 * request and a fixed colour; this inherits `currentColor`, so it is the same
 * ink as the footer around it in both themes and needs no dark-mode variant.
 *
 * THE LABEL IS NOT DECORATIVE. The glyph carries no text, so `aria-label` is
 * the only thing a screen reader has — an icon link with nothing but a path in
 * it is announced as "link" and nothing else.
 */

export function XLink({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <a
      href="https://x.com/Arcana_Arena"
      target="_blank"
      // Without `noopener` the opened page can reach back through
      // window.opener and navigate this tab somewhere else.
      rel="noopener noreferrer"
      aria-label="ARCANA on X"
      title="@Arcana_Arena on X"
      // `.x-link` carries the colour and the hover. An icon link has no text to
      // underline, so the hover has to be the colour — and an inline style
      // cannot express :hover at all.
      className={className ? `x-link ${className}` : 'x-link'}
      style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    </a>
  );
}
