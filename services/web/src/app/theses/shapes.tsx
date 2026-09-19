/**
 * The thesis shape as `/v1/theses/*` returns it, plus the two bits of
 * presentation every page that shows one needs.
 *
 * `result` is null while pending rather than a set of zeroes. A claim not yet
 * answered and a claim answered with no movement are different facts, and a
 * page given zeroes cannot tell them apart — the same rule the API applies at
 * src/theses/theses.service.ts.
 */
import { Tag } from '@/components/ds/primitives';

export type Benchmark =
  | { kind: 'symbol'; symbols: string[] }
  | { kind: 'basket'; symbols: string[] }
  | { kind: 'arcana_index' };

export type Thesis = {
  id: string;
  creator: { id: string; handle: string };
  agent: { id: string; name: string; status_now: string | null };
  claim: string;
  benchmark: Benchmark;
  criteria: { comparison: string; margin_pct: number };
  created_at: string;
  resolves_at: string;
  status: 'pending' | 'proven' | 'not_proven';
  result: {
    agent_return: number;
    benchmark_return: number;
    margin: number;
    resolved_at: string;
    agent_status_at_resolution: string | null;
    measurement: unknown;
  } | null;
  basis: string;
};

export type ThesisList = { items: Thesis[]; limit?: number };

export type CreatorTheses = {
  creator_id: string;
  record: { published: number; proven: number; proven_rate: number | null; basis: string };
  items: Thesis[];
};

/** What the claim is measured against, in words. */
export function benchmarkLabel(b: Benchmark): string {
  if (b.kind === 'arcana_index') {
    return 'the ARCANA market index — every symbol, equal-weighted, per tick';
  }
  if (b.kind === 'symbol') return `${b.symbols[0]}`;
  return `an equal-weighted basket held from the start: ${b.symbols.join(', ')}`;
}

/**
 * PENDING is its own colour and its own word.
 *
 * It is never drawn as a soft version of not_proven. A claim still running has
 * not failed; rendering the two alike would let a reader skim a creator's page
 * and count losses that have not happened.
 */
export function VerdictTag({
  status,
  big = false,
}: {
  status: 'pending' | 'proven' | 'not_proven';
  big?: boolean;
}) {
  const label = status === 'proven' ? 'PROVEN' : status === 'not_proven' ? 'NOT PROVEN' : 'PENDING';
  const tone = status === 'proven' ? 'accent' : status === 'not_proven' ? 'red' : 'dashed';
  const title =
    status === 'pending'
      ? 'Still running. The verdict is attached automatically when the deadline passes.'
      : status === 'proven'
        ? 'The agent beat the benchmark by at least the margin fixed when this was published.'
        : 'The agent did not beat the benchmark by the margin fixed when this was published.';
  return (
    <span style={big ? { fontSize: 13 } : undefined}>
      <Tag tone={tone} title={title} dot={status === 'proven'}>
        {label}
      </Tag>
    </span>
  );
}
