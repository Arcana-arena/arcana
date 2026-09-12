package snapshot

import "time"

// Ingest modes. See migration 0021 and docs/market-data.md.
const (
	// ModeLive is a session fetched while it was the most recent completed one.
	// Nobody knew what came next. Only these may carry a scored decision.
	ModeLive = "live"
	// ModeBackfill is a historical session fetched after the fact. The prices
	// are just as real; what differs is that the outcome was already knowable
	// when the snapshot was created.
	ModeBackfill = "backfill"
)

// SourceSimulator is the provenance of every snapshot produced before the
// vendor switchover. Kept as a named constant because several consumers now
// scope themselves by it, and a typo'd string literal would silently widen
// their scope back to "everything".
const SourceSimulator = "simulator"

// Quote is one normalized symbol observation at a tick.
type Quote struct {
	Symbol string  `json:"symbol"`
	Price  float64 `json:"price"`
	Volume float64 `json:"volume"`
	Bid    float64 `json:"bid,omitempty"`
	Ask    float64 `json:"ask,omitempty"`
	// Sector comes from the universe file, so a consumer reading a snapshot can
	// group by sector without a second lookup. This is what re-enables Autopsy's
	// sector_rotation.
	Sector string `json:"sector,omitempty"`
	// Daily OHLC, carried because the vendor returns them and a close alone
	// cannot say whether a flat day was quiet or violent.
	Open   float64 `json:"open,omitempty"`
	High   float64 `json:"high,omitempty"`
	Low    float64 `json:"low,omitempty"`
	VWAP   float64 `json:"vwap,omitempty"`
	Trades int64   `json:"trades,omitempty"`

	UpdatedAt string `json:"updated_at,omitempty"` // RFC3339 from the vendor feed

	// --- referee (phase 10b) ---------------------------------------------
	//
	// A pool price is what a trade fills at, and it is also thin and movable
	// within a block. Every pool price is checked against the Chainlink feed
	// for the same symbol, and the RESULT TRAVELS ON THE QUOTE rather than
	// only in a log line, so a snapshot read out of object storage years later
	// still says whether its price was refereed and by what.
	//
	// Empty on vendor and simulator quotes, which had no referee and are not
	// retroactively claimed to have had one.

	// RefereeStatus is "agreed", "disputed" or "unrefereed".
	//
	// "unrefereed" is NOT a synonym for "agreed". It means the feed could not
	// be read, or was too stale to referee with, and collapsing the two would
	// silently remove the check on exactly the occasions it stopped working.
	RefereeStatus string `json:"referee_status,omitempty"`
	// RefereePrice is what Chainlink said, for comparison. Recorded even when
	// the two agree: "they agreed" is only checkable later if both numbers survive.
	RefereePrice     float64 `json:"referee_price,omitempty"`
	RefereeDevPct    float64 `json:"referee_deviation_pct,omitempty"`
	RefereeUpdatedAt string  `json:"referee_updated_at,omitempty"`
	RefereeNote      string  `json:"referee_note,omitempty"`
}

// Provenance records where a snapshot's prices came from and when they were
// obtained.
//
// It is stored INSIDE the immutable payload as well as on the row, so the
// evidence travels with the object: a snapshot pulled out of object storage
// years later still says what produced it, without needing the database that
// indexed it.
type Provenance struct {
	// Source is the vendor name, or "simulator" for pre-switchover data.
	Source string `json:"source"`
	// IngestMode is "live" or "backfill".
	IngestMode string `json:"ingest_mode"`
	// TradingDate is the session described, YYYY-MM-DD in US Eastern terms.
	TradingDate string `json:"trading_date,omitempty"`
	// FetchedAt is when the prices were read from the vendor.
	FetchedAt time.Time `json:"fetched_at"`
	// UniverseName identifies the symbol list applied, so a snapshot taken
	// under a different universe is recognisable as such.
	UniverseName string `json:"universe_name,omitempty"`
}

// Snapshot is the immutable point-in-time payload stored in object storage.
// Every agent in the same tick window reads the SAME snapshot (fairness).
type Snapshot struct {
	Ref      string    `json:"ref"`
	TickTime time.Time `json:"tick_time"`
	Symbols  []Quote   `json:"symbols"`
	// Source is kept at the top level for backward compatibility with snapshots
	// written before Provenance existed, and with the decision engine's decoder.
	Source     string      `json:"source"`
	Provenance *Provenance `json:"provenance,omitempty"`
}
