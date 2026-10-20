// The arbitrage opt-in, per agent. These rows are the creator's decision, not
// chain state: an absent row means DISABLED (see migration 0069), and the loop
// reads the enabled set once per pass to decide what it may propose.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrNoSetting is not a failure: it is the documented default, off.
var ErrNoSetting = errors.New("no arbitrage setting for this agent")

// AgentSetting is one agent's arbitrage switch, with the audit trail of who
// flipped it.
type AgentSetting struct {
	AgentID string `json:"agent_id"`
	// Exists distinguishes "never asked for" from "switched off". Both mean
	// disabled; the UI is allowed to say which.
	Exists     bool       `json:"exists"`
	Enabled    bool       `json:"enabled"`
	EnabledAt  *time.Time `json:"enabled_at"`
	DisabledAt *time.Time `json:"disabled_at"`
	UpdatedBy  string     `json:"updated_by,omitempty"`
	UpdatedAt  *time.Time `json:"updated_at"`
}

const agentSettingCols = `agent_id::text, enabled, enabled_at, disabled_at, coalesce(updated_by, ''), updated_at`

func scanAgentSetting(row pgx.Row) (AgentSetting, error) {
	var s AgentSetting
	s.Exists = true
	if err := row.Scan(&s.AgentID, &s.Enabled, &s.EnabledAt, &s.DisabledAt, &s.UpdatedBy, &s.UpdatedAt); err != nil {
		return AgentSetting{}, err
	}
	return s, nil
}

// AgentSetting reads one agent's switch. A missing row returns ErrNoSetting
// with Exists=false and Enabled=false — the caller prints the default rather
// than an error, because "off" is what an absent row means everywhere else.
func (s *Store) AgentSetting(ctx context.Context, agentID string) (AgentSetting, error) {
	set, err := scanAgentSetting(s.pool.QueryRow(ctx,
		`SELECT `+agentSettingCols+` FROM arbitrage_agent_settings WHERE agent_id = $1::uuid`, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return AgentSetting{AgentID: agentID, Exists: false, Enabled: false}, ErrNoSetting
	}
	if err != nil {
		return AgentSetting{}, fmt.Errorf("agent setting: %w", err)
	}
	return set, nil
}

// SetAgentSetting writes the switch, keeping the moment it was FIRST enabled
// (a re-enable does not rewrite history) and stamping the actor for the audit
// trail. The actor is the creator wallet that asked for it.
func (s *Store) SetAgentSetting(ctx context.Context, agentID string, enabled bool, actor string) (AgentSetting, error) {
	if actor == "" {
		return AgentSetting{}, errors.New("agent setting: the actor is required — a switch nobody is named for is not auditable")
	}
	set, err := scanAgentSetting(s.pool.QueryRow(ctx, `
		INSERT INTO arbitrage_agent_settings (agent_id, enabled, enabled_at, disabled_at, updated_by, updated_at)
		VALUES ($1::uuid, $2, CASE WHEN $2 THEN now() END, CASE WHEN NOT $2 THEN now() END, $3, now())
		ON CONFLICT (agent_id) DO UPDATE SET
			enabled     = EXCLUDED.enabled,
			enabled_at  = CASE WHEN EXCLUDED.enabled THEN coalesce(arbitrage_agent_settings.enabled_at, now())
			                   ELSE arbitrage_agent_settings.enabled_at END,
			disabled_at = CASE WHEN EXCLUDED.enabled THEN arbitrage_agent_settings.disabled_at
			                   ELSE now() END,
			updated_by  = EXCLUDED.updated_by,
			updated_at  = now()
		RETURNING `+agentSettingCols,
		agentID, enabled, actor))
	if err != nil {
		return AgentSetting{}, fmt.Errorf("set agent setting: %w", err)
	}
	return set, nil
}

// AllAgentSettings lists the switches that have been touched, newest first, for
// the dashboard's one read.
func (s *Store) AllAgentSettings(ctx context.Context, limit int) ([]AgentSetting, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+agentSettingCols+` FROM arbitrage_agent_settings ORDER BY updated_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("agent settings: %w", err)
	}
	defer rows.Close()
	out := []AgentSetting{}
	for rows.Next() {
		var s AgentSetting
		s.Exists = true
		if err := rows.Scan(&s.AgentID, &s.Enabled, &s.EnabledAt, &s.DisabledAt, &s.UpdatedBy, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// EnabledAgentIDs is what the loop asks once per pass: who may be given new
// exposure. The set is intentionally tiny — a partial index answers it.
func (s *Store) EnabledAgentIDs(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT agent_id::text FROM arbitrage_agent_settings WHERE enabled`)
	if err != nil {
		return nil, fmt.Errorf("enabled agents: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
