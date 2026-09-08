package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/arcana/market-data/internal/objectstore"
	"github.com/arcana/market-data/internal/snapshot"
	"github.com/arcana/market-data/internal/store"
)

// IngestRequest is the normalized payload a vendor adapter POSTs.
type IngestRequest struct {
	TickTime time.Time      `json:"tick_time"`
	Source   string         `json:"source"`
	Quotes   []snapshot.Quote `json:"quotes"`
}

// Service coordinates snapshot creation: object storage + DB ref.
type Service struct {
	store   *store.Store
	objects *objectstore.Client
}

func New(st *store.Store, objs *objectstore.Client) *Service {
	return &Service{store: st, objects: objs}
}

// CreateSnapshot normalizes quotes into an immutable snapshot and records its ref.
func (s *Service) CreateSnapshot(ctx context.Context, req IngestRequest, ref string) (*store.SnapshotRow, error) {
	if len(req.Quotes) == 0 {
		return nil, fmt.Errorf("no quotes provided")
	}
	if req.TickTime.IsZero() {
		req.TickTime = time.Now().UTC()
	}
	if req.Source == "" {
		req.Source = "unknown"
	}

	// Sort symbols for deterministic payload & hash.
	snap := snapshot.Snapshot{
		Ref:      ref,
		TickTime: req.TickTime,
		Symbols:  req.Quotes,
		Source:   req.Source,
	}

	payload, err := json.Marshal(snap)
	if err != nil {
		return nil, fmt.Errorf("marshal snapshot: %w", err)
	}

	sum := sha256.Sum256(payload)
	hash := hex.EncodeToString(sum[:])

	key := fmt.Sprintf("market/%s.json", ref)
	if err := s.objects.Put(ctx, key, payload); err != nil {
		return nil, err
	}

	row := &store.SnapshotRow{
		Ref:         ref,
		TickTime:    snap.TickTime,
		ObjectKey:   key,
		ContentHash: hash,
		SymbolCount: len(snap.Symbols),
		Status:      "stored",
	}
	if err := s.store.InsertSnapshot(ctx, row); err != nil {
		return nil, err
	}
	return row, nil
}

// GetSnapshot returns the immutable payload for a ref.
func (s *Service) GetSnapshot(ctx context.Context, ref string) ([]byte, error) {
	row, err := s.store.LookupByRef(ctx, ref)
	if err != nil {
		return nil, err
	}
	return s.objects.Get(ctx, row.ObjectKey)
}

// PreviousSnapshot returns the payload of the snapshot immediately preceding
// ref. The second return value is false when ref is the first snapshot on
// record — a caller on the very first tick has no prior prices, which is a
// normal state, not an error.
func (s *Service) PreviousSnapshot(ctx context.Context, ref string) ([]byte, bool, error) {
	prev, err := s.store.PreviousRef(ctx, ref)
	if err != nil {
		return nil, false, err
	}
	if prev == "" {
		return nil, false, nil
	}
	payload, err := s.GetSnapshot(ctx, prev)
	if err != nil {
		return nil, false, err
	}
	return payload, true, nil
}
