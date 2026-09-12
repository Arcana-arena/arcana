'use client';

/**
 * The last line of defence: a render that threw.
 *
 * Every data read on this site already returns a result rather than throwing,
 * so reaching this screen means something ELSE broke — a shape that changed
 * under the page, a bug in the rendering. It matters that it says that, rather
 * than showing a blank frame, because a blank frame is indistinguishable from
 * "there is nothing here" and that is a claim about the data.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ padding: '64px 32px', maxWidth: 720, margin: '0 auto' }}>
      <div className="status status-bad">
        <div className="status-title">This page failed to render</div>
        <div className="status-body">
          The data reads on this site return errors rather than throwing, so this is not a service that was
          unreachable — something in the page itself broke while drawing.
          <div className="mono m3" style={{ marginTop: 10, fontSize: 11, wordBreak: 'break-word' }}>
            {error.message || 'no message'}
            {error.digest ? ` · digest ${error.digest}` : ''}
          </div>
          <button className="btn" style={{ marginTop: 16 }} onClick={reset}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
