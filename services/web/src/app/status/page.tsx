/**
 * System status, in three states.
 *
 * THE BADGE NEVER GOES GREEN ON A PROBE THAT DID NOT RUN. `unknown` is its own
 * colour and its own word, and the overall badge inherits the worst state
 * present — a page that renders OPERATIONAL while one check failed to execute
 * is reporting the absence of a check as the success of one, which is the exact
 * failure this platform keeps writing down: healthy and wrong.
 *
 * EVERY ROW CARRIES ITS THRESHOLD. "Stale" means nothing without saying stale
 * against what, and a reader who can see the threshold can disagree with the
 * verdict instead of having to take it.
 *
 * THERE IS NO UPTIME PERCENTAGE, because there is no historical probe log to
 * compute one from. A 99.9% assembled from the rows below would be a number
 * with a decimal point and no measurement behind it.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import { utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Tag } from '@/components/ds/primitives';
import { Callout, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

type Health = 'operational' | 'degraded' | 'unknown';

type Component = {
  key: string;
  label: string;
  state: Health;
  detail: string;
  threshold: string | null;
  unknown_because: string | null;
  measured_at: string | null;
};

type StatusResponse = {
  overall: Health;
  overall_note: string;
  components: Component[];
  probes: number;
  probes_unknown: number;
  basis: string;
  as_of: string;
};

export default async function StatusPage() {
  const r = await agent<StatusResponse>('/v1/status');

  return (
    <div className="page">
      <Header />
      <div className="sec" style={{ paddingTop: 32, paddingBottom: 20, borderBottom: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <h1>System status</h1>
            <div className="m2" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 680, lineHeight: 1.5 }}>
              Measurements over ARCANA&rsquo;s own records, taken when this page was loaded. Not synthetic pings, and
              not a cached dashboard.
            </div>
          </div>
          {r.ok ? <StateTag state={r.data.overall} big /> : null}
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 44, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="System status" error={r} />
        ) : (
          <>
            <Callout tone={r.data.overall === 'operational' ? 'note' : r.data.overall === 'degraded' ? 'warn' : 'warn'}>
              {r.data.overall_note}
            </Callout>

            <div style={{ border: '1px solid var(--color-divider)', marginTop: 20 }}>
              {r.data.components.map((c) => (
                <div
                  key={c.key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    gap: '4px 16px',
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--color-divider)',
                    alignItems: 'center',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5 }}>{c.label}</div>
                    <div className="m3" style={{ fontSize: 11, lineHeight: 1.45, marginTop: 2 }}>
                      {c.detail}
                    </div>
                    {c.unknown_because ? (
                      <div className="am" style={{ fontSize: 11, lineHeight: 1.45, marginTop: 2 }}>
                        {c.unknown_because}
                      </div>
                    ) : null}
                    {c.threshold ? (
                      <div className="m3 mono" style={{ fontSize: 10, marginTop: 3 }}>
                        threshold · {c.threshold}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <StateTag state={c.state} />
                    <div className="mono m3" style={{ fontSize: 10, marginTop: 4 }}>
                      {c.measured_at ? utc(c.measured_at) : 'not measured'}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="m3" style={{ fontSize: 11.5, marginTop: 14, lineHeight: 1.5, maxWidth: 720 }}>
              {r.data.basis} {r.data.probes_unknown > 0 ? (
                <span className="am">
                  {r.data.probes_unknown} of {r.data.probes} probes could not be carried out, which is why the overall
                  state is not green.
                </span>
              ) : null}
            </div>
            <div className="mono m3" style={{ fontSize: 10.5, marginTop: 8 }}>
              read {utc(r.data.as_of)}
            </div>
            <div style={{ marginTop: 18 }}>
              <Link href="/docs/api" style={{ fontSize: 12.5 }}>
                The endpoint behind this page →
              </Link>
            </div>
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}

function StateTag({ state, big = false }: { state: Health; big?: boolean }) {
  const label = state === 'operational' ? 'OPERATIONAL' : state === 'degraded' ? 'DEGRADED' : 'UNKNOWN';
  const title =
    state === 'unknown'
      ? 'A probe could not be carried out. That is not the same as everything being fine — it is the absence of a check, and it never resolves to green.'
      : state === 'degraded'
        ? 'A measurement is outside its stated threshold.'
        : 'Every probe ran and every measurement was inside its threshold.';
  const tone = state === 'operational' ? 'accent' : state === 'degraded' ? 'amber' : 'dashed';
  return (
    <span style={big ? { fontSize: 13 } : undefined}>
      <Tag tone={tone} title={title} dot={state === 'operational'}>
        {label}
      </Tag>
    </span>
  );
}
