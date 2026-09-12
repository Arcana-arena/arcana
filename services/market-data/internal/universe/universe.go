// Package universe loads the competition symbol list from a version-controlled
// file.
//
// The universe is part of a competition's RULES, not its configuration: which
// symbols an agent may trade decides what its score means, and a change to it
// changes what every subsequent season measures. So it lives in a JSON file in
// git, where a change is reviewable and dated, rather than in a .env line that
// nobody can diff. Only the PATH comes from the environment.
package universe

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// Member is one symbol and its sector.
//
// Sector is carried because Autopsy's sector_rotation analysis was disabled
// with the literal reason "the universe is two symbols and no sector
// classification exists anywhere". Classifying here, at the point the universe
// is defined, is the only place it cannot drift out of step with the symbol
// list.
type Member struct {
	Symbol string `json:"symbol"`
	Sector string `json:"sector"`
}

// Universe is the loaded symbol list.
type Universe struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Rationale    string   `json:"rationale"`
	SectorScheme string   `json:"sector_scheme"`
	Symbols      []Member `json:"symbols"`

	bySymbol map[string]Member
}

// Load reads and validates a universe file.
func Load(path string) (*Universe, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read universe file %s: %w", path, err)
	}
	var u Universe
	if err := json.Unmarshal(raw, &u); err != nil {
		return nil, fmt.Errorf("parse universe file %s: %w", path, err)
	}
	if len(u.Symbols) == 0 {
		return nil, fmt.Errorf("universe file %s lists no symbols", path)
	}

	u.bySymbol = make(map[string]Member, len(u.Symbols))
	for _, m := range u.Symbols {
		if m.Symbol == "" {
			return nil, fmt.Errorf("universe file %s: a member has no symbol", path)
		}
		if m.Sector == "" {
			return nil, fmt.Errorf("universe file %s: %s has no sector", path, m.Symbol)
		}
		if _, dup := u.bySymbol[m.Symbol]; dup {
			// A duplicate would double-weight one name in every portfolio built
			// from this list, quietly.
			return nil, fmt.Errorf("universe file %s: %s listed twice", path, m.Symbol)
		}
		u.bySymbol[m.Symbol] = m
	}
	return &u, nil
}

// Has reports whether a symbol is in the universe.
func (u *Universe) Has(symbol string) bool {
	_, ok := u.bySymbol[symbol]
	return ok
}

// Sector returns a symbol's sector, or "" when it is not a member.
func (u *Universe) Sector(symbol string) string {
	return u.bySymbol[symbol].Sector
}

// Size is how many symbols the universe holds.
func (u *Universe) Size() int { return len(u.Symbols) }

// Sectors lists the distinct sectors present, sorted.
func (u *Universe) Sectors() []string {
	seen := map[string]bool{}
	for _, m := range u.Symbols {
		seen[m.Sector] = true
	}
	out := make([]string, 0, len(seen))
	for s := range seen {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}
