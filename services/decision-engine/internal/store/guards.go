package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// Guard is one armed take-profit / stop-loss.
//
// Levels are ABSOLUTE, in quote per share, and were computed once from the
// price actually paid. Recomputing them from a percentage on every scan would
// make the level depend on whatever the entry price is believed to be at scan
// time, which is a moving target the owner never agreed to.
type Guard struct {
	ID      int64
	AgentID string
	// SubscriptionID is nil for the creator's own position. A subscriber's
	// guard watches a different wallet, is armed from a different fill price,
	// and exits through a different signer identity.
	SubscriptionID *string
	Symbol         string
	EntryPrice     float64
	EntryQty       float64
	TakeProfit     *float64
	StopLoss       *float64
	TPPct          *float64
	SLPct          *float64
	SetAt          time.Time
	SetBy          *int64
	// Status is armed | triggered | cleared | expired | refused. Carried only
	// by the by-id read: the scan reads armed rows and has no use for it.
	Status string
}

// GuardInsert arms a guard. Percentages are carried alongside the absolute
// levels so a level can be explained later rather than only restated.
type GuardInsert struct {
	AgentID        string
	SubscriptionID *string
	Symbol         string
	EntryPrice     float64
	EntryQty       float64
	TakeProfit     *float64
	StopLoss       *float64
	TPPct          *float64
	SLPct          *float64
	DecisionID     *int64
	Note           string
}

// ErrGuardExists is returned when this agent already has an armed guard on this
// symbol. The unique index is the authority; this is the name for hitting it.
var ErrGuardExists = errors.New("an armed guard already exists for this agent and symbol")

// ArmGuard records a new guard.
//
// It REPLACES any armed guard on the same symbol rather than failing, because
// topping up a position is an ordinary thing to do and the new entry price is
// the one the levels should be measured from. The replaced row is kept with
// status 'cleared' so the history still shows what was in force before.
func (s *Store) ArmGuard(ctx context.Context, in GuardInsert) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("arm guard: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// SCOPED TO ONE WALLET. `IS NOT DISTINCT FROM` rather than `=`, because a
	// creator's guard carries NULL here and NULL = NULL is not true — an
	// unqualified comparison would quietly match nothing and leave the previous
	// guard armed alongside the new one, which is two stop losses over one
	// position. Same reason migration 0039 splits the unique index in two.
	if _, err := tx.Exec(ctx,
		`UPDATE position_guards
		    SET status = 'cleared',
		        note = coalesce(note, '') || ' | replaced by a new entry'
		  WHERE agent_id = $1 AND symbol = $2 AND status = 'armed'
		    AND subscription_id IS NOT DISTINCT FROM $3::uuid`,
		in.AgentID, in.Symbol, in.SubscriptionID); err != nil {
		return 0, fmt.Errorf("clear previous guard: %w", err)
	}

	var id int64
	err = tx.QueryRow(ctx,
		`INSERT INTO position_guards
		   (agent_id, symbol, entry_price, entry_qty, take_profit, stop_loss,
		    take_profit_pct, stop_loss_pct, set_by_decision_id, status, note, subscription_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'armed',$10,$11::uuid)
		 RETURNING id`,
		in.AgentID, in.Symbol, in.EntryPrice, in.EntryQty,
		in.TakeProfit, in.StopLoss, in.TPPct, in.SLPct, in.DecisionID, nullStr(in.Note),
		in.SubscriptionID).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("arm guard: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("arm guard commit: %w", err)
	}
	return id, nil
}

// ArmedGuards is every guard currently watching, across all agents.
//
// The watcher reads them all in one query and then reads one price per guard.
// An agent with no armed guard costs nothing at all: no row, no call.
func (s *Store) ArmedGuards(ctx context.Context) ([]Guard, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT g.id, g.agent_id, g.subscription_id::text, g.symbol,
		        g.entry_price::text, g.entry_qty::text,
		        g.take_profit::text, g.stop_loss::text,
		        g.take_profit_pct::text, g.stop_loss_pct::text,
		        g.set_at, g.set_by_decision_id
		   FROM position_guards g
		   JOIN agents a ON a.id = g.agent_id
		  WHERE g.status = 'armed' AND a.status = 'active'
		  ORDER BY g.set_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("read armed guards: %w", err)
	}
	defer rows.Close()

	var out []Guard
	for rows.Next() {
		var g Guard
		var entry, qty string
		var tp, sl, tpPct, slPct *string
		if err := rows.Scan(&g.ID, &g.AgentID, &g.SubscriptionID, &g.Symbol, &entry, &qty,
			&tp, &sl, &tpPct, &slPct, &g.SetAt, &g.SetBy); err != nil {
			return nil, fmt.Errorf("scan guard: %w", err)
		}
		// NUMERIC AS TEXT. pgx will not put a numeric into a float64, and the
		// first version of CapitalOf swallowed exactly that error and turned a
		// cost meter into a pass-through. Parsed explicitly here so a bad value
		// is an error rather than a zero.
		if g.EntryPrice, err = strconv.ParseFloat(entry, 64); err != nil {
			return nil, fmt.Errorf("guard %d entry_price %q: %w", g.ID, entry, err)
		}
		if g.EntryQty, err = strconv.ParseFloat(qty, 64); err != nil {
			return nil, fmt.Errorf("guard %d entry_qty %q: %w", g.ID, qty, err)
		}
		if g.TakeProfit, err = parseNullFloat(tp); err != nil {
			return nil, fmt.Errorf("guard %d take_profit: %w", g.ID, err)
		}
		if g.StopLoss, err = parseNullFloat(sl); err != nil {
			return nil, fmt.Errorf("guard %d stop_loss: %w", g.ID, err)
		}
		g.TPPct, _ = parseNullFloat(tpPct)
		g.SLPct, _ = parseNullFloat(slPct)
		out = append(out, g)
	}
	return out, rows.Err()
}

// ClearGuards stands down every armed guard on one agent's symbol.
//
// Used when the position left by a route other than the guard itself — the
// agent sold it, or it turned out not to be there. A guard over nothing would
// fire on the next price tick and spend gas finding out.
func (s *Store) ClearGuards(ctx context.Context, agentID string, subID *string, symbol, note string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE position_guards SET status = 'cleared', note = $3
		  WHERE agent_id = $1 AND symbol = $2 AND status = 'armed'
		    AND subscription_id IS NOT DISTINCT FROM $4::uuid`,
		agentID, symbol, nullStr(note), subID)
	if err != nil {
		return fmt.Errorf("clear guards for %s %s: %w", agentID, symbol, err)
	}
	return nil
}

// ArmedGuardFor is the guard currently watching this agent's position in one
// symbol, or nil.
//
// Read when a position is TOPPED UP, so the new levels can be anchored to what
// the agent paid across both entries rather than only to the latest one.
func (s *Store) ArmedGuardFor(ctx context.Context, agentID string, subID *string, symbol string) (*Guard, error) {
	var g Guard
	var entry, qty string
	err := s.pool.QueryRow(ctx,
		`SELECT id, entry_price::text, entry_qty::text
		   FROM position_guards
		  WHERE agent_id = $1 AND symbol = $2 AND status = 'armed'
		    AND subscription_id IS NOT DISTINCT FROM $3::uuid`,
		agentID, symbol, subID).Scan(&g.ID, &entry, &qty)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read armed guard for %s %s: %w", agentID, symbol, err)
	}
	g.AgentID, g.Symbol, g.SubscriptionID = agentID, symbol, subID
	if g.EntryPrice, err = strconv.ParseFloat(entry, 64); err != nil {
		return nil, fmt.Errorf("guard %d entry_price %q: %w", g.ID, entry, err)
	}
	if g.EntryQty, err = strconv.ParseFloat(qty, 64); err != nil {
		return nil, fmt.Errorf("guard %d entry_qty %q: %w", g.ID, qty, err)
	}
	return &g, nil
}

// CloseGuard records how a guard ended.
//
// status is 'triggered', 'cleared' or 'expired'. The WHERE clause insists the
// guard is still armed, so two writers cannot both close it and the second one
// learns that it lost rather than overwriting the first one's account.
func (s *Store) CloseGuard(ctx context.Context, id int64, status, side string,
	price *float64, decisionID *int64, note string) (bool, error) {

	// EVERY PARAMETER IS CAST, and $2 is why.
	//
	// It appeared twice: once as `status = $2`, where Postgres inferred varchar
	// from the column, and once inside `CASE WHEN $2 = 'triggered'`, where it
	// inferred text from the literal. Two inferences for one parameter is
	//
	//	ERROR: inconsistent types deduced for parameter $2 (SQLSTATE 42P08)
	//
	// and it did not surface until a guard actually fired on chain. The exit was
	// executed, the transaction was mined, and the guard could not be closed —
	// so the row stayed `armed` over a position that no longer existed while the
	// heartbeat counted it as gone. A divergence between what the table says and
	// what the count says is the exact shape this project refuses, and it was
	// only visible at all because the failure logs at ERROR.
	tag, err := s.pool.Exec(ctx,
		`UPDATE position_guards
		    SET status = $2::text,
		        triggered_at = CASE WHEN $2::text = 'triggered' THEN now() ELSE triggered_at END,
		        triggered_side = nullif($3::text,''),
		        triggered_price = $4::numeric,
		        triggered_decision_id = $5::bigint,
		        note = $6::text
		  WHERE id = $1::bigint AND status = 'armed'`,
		id, status, side, price, decisionID, nullStr(note))
	if err != nil {
		return false, fmt.Errorf("close guard %d: %w", id, err)
	}
	return tag.RowsAffected() == 1, nil
}

// --- the lease -----------------------------------------------------------

// ErrLeaseHeld means somebody else is moving this agent's funds right now.
var ErrLeaseHeld = errors.New("another actor holds this agent's execution lease")

// AcquireLease takes the exclusive right to move one agent's funds.
//
// NOBODY WAITS. This either succeeds immediately or returns ErrLeaseHeld, and
// the caller stands down. Queuing would mean a cycle finishing its own exit and
// then handing the lease to a guard that was about to sell the same position —
// two transactions from one intent, arriving a second apart.
//
// The expiry is what makes a crash survivable without anyone being paged: a
// holder that dies mid-swap blocks its agent until the lease runs out, and no
// longer.
func (s *Store) AcquireLease(ctx context.Context, agentID, holder string, ttl time.Duration, note string) error {
	tag, err := s.pool.Exec(ctx,
		`INSERT INTO agent_execution_leases (agent_id, holder, acquired_at, expires_at, note)
		 VALUES ($1, $2, now(), now() + $3::interval, $4)
		 ON CONFLICT (agent_id) DO UPDATE
		    SET holder = EXCLUDED.holder,
		        acquired_at = EXCLUDED.acquired_at,
		        expires_at = EXCLUDED.expires_at,
		        note = EXCLUDED.note
		  WHERE agent_execution_leases.expires_at < now()`,
		agentID, holder, ttl.String(), nullStr(note))
	if err != nil {
		return fmt.Errorf("acquire lease for %s: %w", agentID, err)
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseHeld
	}
	return nil
}

// LeaseHolder is who holds it and until when, for the record and for the log.
func (s *Store) LeaseHolder(ctx context.Context, agentID string) (string, time.Time, bool, error) {
	var holder string
	var until time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT holder, expires_at FROM agent_execution_leases
		  WHERE agent_id = $1 AND expires_at >= now()`, agentID).Scan(&holder, &until)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, fmt.Errorf("read lease for %s: %w", agentID, err)
	}
	return holder, until, true, nil
}

// ReleaseLease gives it back early. A missed release is not a failure: the
// expiry covers it, which is the whole reason the expiry exists.
func (s *Store) ReleaseLease(ctx context.Context, agentID, holder string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM agent_execution_leases WHERE agent_id = $1 AND holder = $2`, agentID, holder)
	if err != nil {
		return fmt.Errorf("release lease for %s: %w", agentID, err)
	}
	return nil
}

// --- the watcher's liveness ----------------------------------------------

// Heartbeat is written on EVERY scan, including scans that found nothing.
//
// A watcher that died must not look like a watcher with nothing to report.
// Without a row written on empty scans, "no recent heartbeat" would mean either
// "the process is gone" or "there were no guards", and the alarm would have to
// guess which.
func (s *Store) Heartbeat(ctx context.Context, armed int, triggered int64, version string, lastErr error) error {
	var errText *string
	if lastErr != nil {
		t := lastErr.Error()
		errText = &t
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO guard_heartbeat (id, last_scan_at, scans, armed_guards, triggers, last_error, last_error_at, version)
		 VALUES (1, now(), 1, $1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, $4)
		 ON CONFLICT (id) DO UPDATE SET
		   last_scan_at  = now(),
		   scans         = guard_heartbeat.scans + 1,
		   armed_guards  = EXCLUDED.armed_guards,
		   triggers      = guard_heartbeat.triggers + EXCLUDED.triggers,
		   last_error    = coalesce(EXCLUDED.last_error, guard_heartbeat.last_error),
		   last_error_at = CASE WHEN EXCLUDED.last_error IS NULL
		                        THEN guard_heartbeat.last_error_at ELSE now() END,
		   version       = EXCLUDED.version`,
		armed, triggered, errText, version)
	if err != nil {
		return fmt.Errorf("write guard heartbeat: %w", err)
	}
	return nil
}

// SeasonOfAgent is the season this agent is currently competing in.
//
// Read from its portfolio rather than from a competition row: a portfolio
// exists for exactly the seasons the agent has actually played, and the most
// recent one is the one a protective exit belongs to.
func (s *Store) SeasonOfAgent(ctx context.Context, agentID string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx,
		`SELECT season_id FROM portfolios WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
		agentID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("agent %s has no portfolio, so it has no season to record against", agentID)
	}
	if err != nil {
		return "", fmt.Errorf("season for %s: %w", agentID, err)
	}
	return id, nil
}

// LatestSnapshotRef is the most recent recorded market tick.
//
// A protective decision has to carry one because decisions.market_snapshot_ref
// is NOT NULL and a foreign key. It is NOT the input to the decision — the
// input was a pool quote taken seconds earlier — and the rationale says so
// explicitly rather than letting the column imply otherwise.
func (s *Store) LatestSnapshotRef(ctx context.Context) (string, error) {
	var ref string
	err := s.pool.QueryRow(ctx,
		`SELECT ref FROM market_snapshots ORDER BY tick_time DESC LIMIT 1`).Scan(&ref)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errors.New("no market snapshot has ever been recorded")
	}
	if err != nil {
		return "", fmt.Errorf("latest snapshot ref: %w", err)
	}
	return ref, nil
}

func parseNullFloat(s *string) (*float64, error) {
	if s == nil || *s == "" {
		return nil, nil
	}
	v, err := strconv.ParseFloat(*s, 64)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// RefusalState is what this guard last could not act on.
type RefusalState struct {
	At     time.Time
	Reason string
}

// LastRefusal reports the crossing this guard most recently could not act on.
//
// ok=false means there has never been one. The caller uses it to decide whether
// a refusal is NEW — a persisting condition is one fact, and the guard rescans
// every fifteen seconds.
func (s *Store) LastRefusal(ctx context.Context, guardID int64) (RefusalState, bool, error) {
	var at *time.Time
	var reason *string
	err := s.pool.QueryRow(ctx,
		`SELECT last_refusal_at, last_refusal_reason FROM position_guards WHERE id = $1`,
		guardID).Scan(&at, &reason)
	if errors.Is(err, pgx.ErrNoRows) {
		return RefusalState{}, false, nil
	}
	if err != nil {
		return RefusalState{}, false, fmt.Errorf("read last refusal for guard %d: %w", guardID, err)
	}
	if at == nil {
		return RefusalState{}, false, nil
	}
	r := ""
	if reason != nil {
		r = *reason
	}
	return RefusalState{At: *at, Reason: r}, true, nil
}

// NoteRefusal records that a crossing could not be acted on.
//
// The decision id is optional: it is set on the FIRST refusal, which is the one
// that gets a row in the decision log. Later refusals of the same condition
// update the timestamp here and write nothing to `decisions`.
func (s *Store) NoteRefusal(ctx context.Context, guardID int64, reason string, decisionID *int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE position_guards
		    SET last_refusal_at = now(),
		        last_refusal_reason = $2::text,
		        last_refusal_decision_id = coalesce($3::bigint, last_refusal_decision_id)
		  WHERE id = $1::bigint`,
		guardID, reason, decisionID)
	if err != nil {
		return fmt.Errorf("note refusal on guard %d: %w", guardID, err)
	}
	return nil
}

// ClearRefusal forgets the refusal, so the next one is recorded again.
//
// Called when the guard acts, because a condition that has ended and returns is
// a new fact rather than a continuation of the old one.
func (s *Store) ClearRefusal(ctx context.Context, guardID int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE position_guards SET last_refusal_at = NULL, last_refusal_reason = NULL
		  WHERE id = $1::bigint`, guardID)
	if err != nil {
		return fmt.Errorf("clear refusal on guard %d: %w", guardID, err)
	}
	return nil
}

// RefusedGuardInsert records a position whose owner asked for protection and
// did not get it.
type RefusedGuardInsert struct {
	AgentID          string
	SubscriptionID   *string
	Symbol           string
	EntryPrice       float64
	EntryQty         float64
	MinAcceptablePct float64
	DecisionID       *int64
	Reason           string
}

// RecordRefusedGuard writes the absence of protection as a fact.
//
// ONE ROW PER POSITION, not one per attempt: re-entering the same symbol
// replaces the previous refusal rather than stacking, so a count of unprotected
// positions is a count of positions and not of buys.
//
// It also clears any ARMED guard on the symbol first. An agent that had a valid
// level, then topped up with one this pool refuses, is no longer protected on
// the terms it thinks it is — and leaving the old row armed would say otherwise.
func (s *Store) RecordRefusedGuard(ctx context.Context, in RefusedGuardInsert) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("record refused guard: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`UPDATE position_guards
		    SET status = 'cleared',
		        note = coalesce(note,'') || ' | superseded by an entry whose levels were refused'
		  WHERE agent_id = $1 AND symbol = $2 AND status = 'armed'
		    AND subscription_id IS NOT DISTINCT FROM $3::uuid`,
		in.AgentID, in.Symbol, in.SubscriptionID); err != nil {
		return fmt.Errorf("clear armed guard before recording a refusal: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM position_guards
		  WHERE agent_id = $1 AND symbol = $2 AND status = 'refused'
		    AND subscription_id IS NOT DISTINCT FROM $3::uuid`,
		in.AgentID, in.Symbol, in.SubscriptionID); err != nil {
		return fmt.Errorf("replace previous refusal: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO position_guards
		   (agent_id, symbol, entry_price, entry_qty, status, min_acceptable_pct,
		    set_by_decision_id, note, subscription_id)
		 VALUES ($1,$2,$3,$4,'refused',$5,$6,$7,$8::uuid)`,
		in.AgentID, in.Symbol, in.EntryPrice, in.EntryQty,
		in.MinAcceptablePct, in.DecisionID, nullStr(in.Reason), in.SubscriptionID); err != nil {
		return fmt.Errorf("record refused guard: %w", err)
	}
	return tx.Commit(ctx)
}

// ClearRefusedGuard removes the refusal when the position is gone, so an
// unprotected position that has been closed stops being reported as one.
func (s *Store) ClearRefusedGuard(ctx context.Context, agentID string, subID *string, symbol string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM position_guards
		  WHERE agent_id = $1 AND symbol = $2 AND status = 'refused'
		    AND subscription_id IS NOT DISTINCT FROM $3::uuid`, agentID, symbol, subID)
	if err != nil {
		return fmt.Errorf("clear refused guard for %s %s: %w", agentID, symbol, err)
	}
	return nil
}

// GuardByID reads one guard whatever its status.
//
// Used by the read-only inspection binary, which has to be able to look at a
// guard that has already been stood down — "it is not armed" is an answer, and
// a lookup that returned nothing would make it indistinguishable from a guard
// that never existed.
func (s *Store) GuardByID(ctx context.Context, id int64) (*Guard, error) {
	var g Guard
	var entry, qty string
	var tp, sl, tpPct, slPct *string
	err := s.pool.QueryRow(ctx,
		`SELECT id, agent_id::text, subscription_id::text, symbol, status,
		        entry_price::text, entry_qty::text,
		        take_profit::text, stop_loss::text,
		        take_profit_pct::text, stop_loss_pct::text,
		        set_at, set_by_decision_id
		   FROM position_guards WHERE id = $1`, id).
		Scan(&g.ID, &g.AgentID, &g.SubscriptionID, &g.Symbol, &g.Status,
			&entry, &qty, &tp, &sl, &tpPct, &slPct, &g.SetAt, &g.SetBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("guard %d does not exist", id)
	}
	if err != nil {
		return nil, fmt.Errorf("read guard %d: %w", id, err)
	}
	if g.EntryPrice, err = strconv.ParseFloat(entry, 64); err != nil {
		return nil, fmt.Errorf("guard %d entry_price %q: %w", id, entry, err)
	}
	if g.EntryQty, err = strconv.ParseFloat(qty, 64); err != nil {
		return nil, fmt.Errorf("guard %d entry_qty %q: %w", id, qty, err)
	}
	g.TakeProfit, _ = parseNullFloat(tp)
	g.StopLoss, _ = parseNullFloat(sl)
	g.TPPct, _ = parseNullFloat(tpPct)
	g.SLPct, _ = parseNullFloat(slPct)
	return &g, nil
}
