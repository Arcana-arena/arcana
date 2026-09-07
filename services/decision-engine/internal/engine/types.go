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
}
