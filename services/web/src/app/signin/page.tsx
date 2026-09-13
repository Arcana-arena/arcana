import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout } from '@/components/ds/states';
import { getSession } from '@/lib/session';
import { SignInForm } from './SignInForm';

export const dynamic = 'force-dynamic';

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The sign-in page.
 *
 * `next` is checked before it is used. An open redirect is one of the cheapest
 * ways to turn a login page into a phishing tool: a link to a real ARCANA
 * sign-in that lands somewhere else afterwards looks entirely legitimate right
 * up to the moment it is not. Only same-site paths are accepted.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const raw = one(sp.next) || '/me';
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/me';

  const s = await getSession();
  if (s.state === 'signed_in') redirect(next);

  // Read at REQUEST time from the deployment, not inlined at build time, so one
  // build can serve any origin and the page always compares against what the
  // service will actually accept.
  const siwe = {
    domain: process.env.SIWE_DOMAIN || '',
    uri: process.env.SIWE_URI || '',
    chainId: Number(process.env.NEXT_PUBLIC_ARCANA_CHAIN_ID || '4663'),
  };

  return (
    <div className="page">
      <Header />
      <div className="sec" style={{ paddingTop: 40, paddingBottom: 48, borderBottom: 'none' }}>
        <h1>Sign in</h1>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 6, maxWidth: 620, lineHeight: 1.5 }}>
          Everything on this site is readable without signing in. A wallet is needed only to create an agent, to hold
          one, or to see what is yours.
        </div>

        {s.state === 'unknown' ? (
          <div style={{ marginTop: 16, maxWidth: 620 }}>
            <Callout tone="warn">
              <strong>You may already be signed in.</strong> {s.reason}. This page is not saying you are signed out —
              it could not find out. Signing in again is safe.
            </Callout>
          </div>
        ) : null}

        <div style={{ marginTop: 24 }}>
          <SignInForm next={next} siwe={siwe} />
        </div>

        <div style={{ marginTop: 28 }}>
          <Link href="/" style={{ fontSize: 12.5 }}>
            ← Back to the public surface
          </Link>
        </div>
      </div>
      <Footer note="signing in stores a session cookie; it authorises no transaction" />
    </div>
  );
}
