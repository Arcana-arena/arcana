package store

import (
	"context"
	"fmt"
)

// TokensUsedToday is what an agent has spent on inference since midnight UTC.
//
// READ FROM THE RECORD, NOT FROM A COUNTER IN MEMORY. The signer's daily
// signature cap is an in-process map, and it resets every time the service
// restarts — three deploys in a day silently triple the cap it advertises.
// That is tolerable for a limit measured in tens; it is not the shape to copy
// for one that has to survive an unattended week.
//
// So the meter asks the decisions table, which is append-only and is the same
// place anybody auditing the bill would look. The cost of that is one indexed
// query per decision, which is nothing next to the model call it guards.
//
// CACHED TOKENS ARE COUNTED. They are usually billed at a discount rather than
// free, and a meter that ignored them would let a well-cached agent run further
// than its budget says. Counting them is the conservative direction, and the
// row keeps them separately so a future price model can be exact.
func (s *Store) TokensUsedToday(ctx context.Context, agentID string) (int64, error) {
	var total *int64
	err := s.pool.QueryRow(ctx,
		`SELECT sum(coalesce(prompt_tokens,0) + coalesce(completion_tokens,0))
		   FROM decisions_counted
		  WHERE agent_id = $1
		    AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
		    AND prompt_tokens IS NOT NULL`, agentID).Scan(&total)
	if err != nil {
		return 0, fmt.Errorf("read inference usage for %s: %w", agentID, err)
	}
	if total == nil {
		return 0, nil
	}
	return *total, nil
}
