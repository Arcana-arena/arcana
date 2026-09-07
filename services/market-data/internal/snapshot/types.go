package snapshot

import "time"

// Quote is one normalized symbol observation at a tick.
type Quote struct {
	Symbol    string  `json:"symbol"`
	Price     float64 `json:"price"`
	Volume    float64 `json:"volume"`
	Bid       float64 `json:"bid,omitempty"`
	Ask       float64 `json:"ask,omitempty"`
	UpdatedAt string  `json:"updated_at"` // RFC3339 from the vendor feed
}

// Snapshot is the immutable point-in-time payload stored in object storage.
// Every agent in the same tick window reads the SAME snapshot (fairness).
type Snapshot struct {
	Ref      string    `json:"ref"`
	TickTime time.Time `json:"tick_time"`
	Symbols  []Quote   `json:"symbols"`
	Source   string    `json:"source"` // vendor name (polygon/iex/...)
}
