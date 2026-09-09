package service

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/arcana/market-data/internal/snapshot"
)

// MaxPriceLookupRefs bounds one batch. A caller asking for prices behind a page
// of decisions needs at most one ref per row, and the page sizes on those
// endpoints are capped well below this.
const MaxPriceLookupRefs = 200

// PriceLookupEntry is the evidence behind one decision: what the market was
// when it was made, and where that reading came from.
type PriceLookupEntry struct {
	Ref         string             `json:"ref"`
	TickTime    string             `json:"tick_time"`
	Source      string             `json:"source"`
	IngestMode  string             `json:"ingest_mode"`
	TradingDate string             `json:"trading_date,omitempty"`
	ContentHash string             `json:"content_hash"`
	Prices      map[string]float64 `json:"prices"`
}

// LookupPrices resolves a batch of snapshot refs to their per-symbol prices.
//
// WHY THIS IS A BATCH. The decision series needs the price a trade was made at,
// and that price lives only inside the immutable snapshot object — it is
// deliberately not copied into the decisions table, because a second copy of
// market data is a second thing that can disagree with the evidence. Resolving
// one ref per decision row would mean one HTTP call per row; this collapses a
// whole page into one call.
//
// A ref that cannot be read is REPORTED AS MISSING rather than silently
// omitted or defaulted to zero. A trade shown at a price of 0.00 would be a
// lie, and a trade shown with no price at all — with no indication that a price
// was expected — is the same lie told quietly. The caller gets the list of refs
// that failed and can say so.
func (s *Service) LookupPrices(ctx context.Context, refs []string, symbols []string) (map[string]PriceLookupEntry, []string, error) {
	if len(refs) == 0 {
		return map[string]PriceLookupEntry{}, nil, nil
	}
	if len(refs) > MaxPriceLookupRefs {
		return nil, nil, fmt.Errorf("too many refs: %d (max %d)", len(refs), MaxPriceLookupRefs)
	}

	wanted := make(map[string]bool, len(symbols))
	for _, sym := range symbols {
		wanted[sym] = true
	}

	out := make(map[string]PriceLookupEntry, len(refs))
	missing := make([]string, 0)

	// De-duplicate: several decisions in a page commonly cite the same tick.
	seen := make(map[string]bool, len(refs))
	for _, ref := range refs {
		if ref == "" || seen[ref] {
			continue
		}
		seen[ref] = true

		row, err := s.store.LookupByRef(ctx, ref)
		if err != nil {
			missing = append(missing, ref)
			continue
		}
		payload, err := s.objects.Get(ctx, row.ObjectKey)
		if err != nil {
			missing = append(missing, ref)
			continue
		}

		var snap snapshot.Snapshot
		if err := json.Unmarshal(payload, &snap); err != nil {
			missing = append(missing, ref)
			continue
		}

		prices := make(map[string]float64, len(snap.Symbols))
		for _, q := range snap.Symbols {
			if len(wanted) > 0 && !wanted[q.Symbol] {
				continue
			}
			prices[q.Symbol] = q.Price
		}

		entry := PriceLookupEntry{
			Ref:         row.Ref,
			TickTime:    row.TickTime.UTC().Format("2006-01-02T15:04:05Z"),
			Source:      row.Source,
			IngestMode:  row.IngestMode,
			ContentHash: row.ContentHash,
			Prices:      prices,
		}
		if row.TradingDate != nil {
			entry.TradingDate = row.TradingDate.Format("2006-01-02")
		}
		out[row.Ref] = entry
	}

	return out, missing, nil
}
