package engine

import "time"

// ExecuteRequest is the payload for POST /internal/v1/decisions/execute.
type ExecuteRequest struct {
	AgentID  string    `json:"agent_id"`
	SeasonID string    `json:"season_id"`
	// Timestamp is the market tick time; zero => now (UTC).
	Timestamp time.Time `json:"timestamp"`
	// MarketSnapshotRef points to the immutable market snapshot used for this tick.
	MarketSnapshotRef string `json:"market_snapshot_ref"`

	// IsVerification is set from the X-Arcana-Verification header, never from
	// the body. A caller cannot grant itself this; it can only ever cost it
	// permissions. See internal/engine/verification.go.
	IsVerification bool `json:"-"`
}

// ManualTrade is one human-submitted order for a human_vs_ai session.
type ManualTrade struct {
	Symbol   string  `json:"symbol"`            // required for buy/sell
	Action   string  `json:"action"`            // buy | sell | hold
	Quantity float64 `json:"quantity"`          // shares for buy/sell
}

// ExecuteManualRequest is the payload for POST /internal/v1/decisions/manual.
// Only agents with strategy_type='human' may use this endpoint.
type ExecuteManualRequest struct {
	AgentID           string       `json:"agent_id"`
	SeasonID          string       `json:"season_id"`
	Timestamp         time.Time    `json:"timestamp"`
	MarketSnapshotRef string       `json:"market_snapshot_ref"`
	Trade             ManualTrade  `json:"trade"`
}
