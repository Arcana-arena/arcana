package engine

import "context"

// ---------------------------------------------------------------------------
// Deciders.
//
// A Decider turns "here is the market and your book" into "here is what I want
// to do". It is the seam that lets an LLM replace three if-then functions
// without the rest of the pipeline noticing: the same snapshot loading, the
// same risk limits, the same append-only record, the same portfolio mark.
//
// WHAT A DECIDER IS NOT ALLOWED TO DO. It returns an INTENT, not a trade.
// Everything it asks for still passes through buyableQty() and applyIntent(),
// which are deterministic and which it cannot talk out of their limits. That
// separation is the whole safety model for user-written agents: the prompt
// decides intent, the code decides what is permitted. A prompt can be
// jailbroken; buyableQty() cannot.
//
// It is also why strategy.go is still here and still used. The deterministic
// deciders are not legacy to be swept away — they are the reference the LLM is
// measured against, and the risk arithmetic they carry is shared.
// ---------------------------------------------------------------------------

// DeciderInput is everything a decider may see. Deliberately no more than the
// old strategies got: the current snapshot, the one before it, the book, and
// the agent's own configured limits. No future data, no other agents.
type DeciderInput struct {
	AgentID  string
	Mandate  string // the user's bounded statement of intent; empty for built-ins
	Strategy string // agents.strategy_type
	View     marketView
	Holdings map[string]any
	Cash     float64
	NAV      float64
	Limits   RiskLimits

	// MinGuardPct is the smallest protective level each symbol's pool will
	// accept, keyed by symbol: its round trip, 2 x the fee tier.
	//
	// WHY THE MODEL IS TOLD THIS PER SYMBOL. The prompt used to say "0.001 on the
	// tight pools and 0.006 on the wide ones" and never said which symbol was
	// which. So a mandate asking for one number — "get out if it drops 0.15%" —
	// produced 0.0015 for every symbol, which the 5 bp pools accept and the 30 bp
	// pools refuse. Four of the nine listed symbols therefore opened positions
	// with NO protective level at all, and the only trace was a refusal in a
	// rationale nobody was reading.
	//
	// The platform still does not choose the level. It states what each pool will
	// take, which is a fact about the venue, and the model decides what to ask
	// for. A level narrower than this is still refused, and the refusal is still
	// recorded — what changes is that the model now has what it needs to avoid
	// asking for one by accident.
	MinGuardPct map[string]float64

	// EntryFeePct is what each symbol's pool charges to enter, one way, keyed by
	// symbol: 0.0005 on the tight pools, 0.003 on the rest. It is the floor under
	// the rebalance band — a move smaller than the fee cannot pay for the swap
	// that acts on it — and it is applied per symbol because the fee is per pool.
	// Empty on the paper path: no pool, no fee, and an unknown fee must not become
	// a floor of zero. See band.go.
	EntryFeePct map[string]float64

	// THE INFERENCE METER, read before anything is spent.
	//
	// TokensUsedToday is what this agent has already spent on the model since
	// midnight UTC, summed from the decisions table rather than from a counter
	// in memory -- a counter resets on every deploy, and a limit that quietly
	// triples on a busy day is not a limit.
	//
	// TokenBudget of 0 means unmetered, which is the correct state for a
	// deployment that has not configured one and for every deterministic
	// strategy, since they buy no inference at all.
	TokensUsedToday int64
	TokenBudget     int64
}

// Evidence is what the decision record keeps about HOW a decision was reached.
//
// For a deterministic decider this is nearly empty and that is correct: the
// function and the snapshot are the whole story, and it can be replayed. For an
// LLM it is the entire story, because it cannot.
type Evidence struct {
	Decider      string // deterministic | llm | human
	Provider     string // deepseek, ... — as it was at the time, not as configured now
	Model        string
	ModelVersion string         // what the provider says it actually served
	Params       map[string]any // temperature, top_p, seed, max_tokens
	PromptBody   string         // exact text sent, including the prices it saw
	ResponseBody string         // raw, before parsing: a malformed answer is still evidence
	// SystemPromptBody is ARCANA's own frame around the prompt. It was sent and
	// never stored; the commitment now names it, so it is kept.
	SystemPromptBody string
	// ReasonCode is set when the decision was not a free choice —
	// llm_unavailable, llm_invalid_output, no_material_move. Empty means the
	// decider chose. A hold because nothing looked good and a hold because the
	// provider timed out are different events and must not look alike.
	ReasonCode string
	// Thesis is the forward-looking, falsifiable claim:
	// {claim, horizon_ticks, invalidated_if}. Nil when the decider makes none —
	// which is every deterministic one, and is exactly why Agent Autopsy has
	// always refused thesis_failure.
	Thesis map[string]any
	// Usage, for the cost meter. Zero for deciders that cost nothing.
	PromptTokens, CompletionTokens, CachedTokens int
	LatencyMS                                    int64
}

// Decider produces one intent per tick.
type Decider interface {
	// Name is recorded on the decision.
	Name() string
	// Decide never returns an error for "the provider was down". That is a
	// decision — a recorded hold with a reason — not a failure of the tick.
	// An error here means the tick genuinely could not be processed, and the
	// caller refuses rather than inventing a hold.
	Decide(ctx context.Context, in DeciderInput) (tradeIntent, Evidence, error)
}

// ---------------------------------------------------------------------------
// The deterministic decider: the three strategies that shipped, unchanged.
// ---------------------------------------------------------------------------

type deterministicDecider struct{}

// NewDeterministicDecider returns the momentum / mean_reversion / buy_and_hold
// decider. It stays because it works, because it is the reference an LLM's
// behaviour is compared against, and because nothing is deleted here before its
// replacement has been proven.
func NewDeterministicDecider() Decider { return deterministicDecider{} }

func (deterministicDecider) Name() string { return "deterministic" }

func (deterministicDecider) Decide(_ context.Context, in DeciderInput) (tradeIntent, Evidence, error) {
	intent := decide(in.Strategy, in.View, in.Holdings, in.Cash, in.NAV, in.Limits, in.EntryFeePct)
	return intent, Evidence{Decider: "deterministic"}, nil
}
