package engine

// PortfolioState mirrors the current virtual portfolio for an agent in a season.
type PortfolioState struct {
	PortfolioID    string
	InitialCapital string // NUMERIC as string
	Cash           string // current cash
	Holdings       map[string]any
	NAV            string
}
