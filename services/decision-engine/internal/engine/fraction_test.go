package engine

import "testing"

// The retired field names must keep arming levels.
//
// WHY THIS IS THE TEST AND NOT A COMMENT. `stop_loss_pct` was a FRACTION with
// "pct" in its name, and on 2026-09-11 two consecutive live ticks from one
// mandate — "get out if it drops 0.15% below what you paid" — produced 0.0015
// and then 0.15: the level asked for, and one a hundred times wider. Nothing
// downstream could catch it, because 0.15 is a perfectly valid fraction.
//
// The only fixable thing was the contract, so the fields are now
// `stop_loss_fraction` and `take_profit_fraction`. The DANGER in that rename is
// the opposite failure: an agent that set `stop_loss_pct` months ago silently
// arming nothing, which is a stop loss that does not exist and nobody is told
// about. That is strictly worse than the ambiguity it replaced.
func TestTheRetiredNamesStillArmLevels(t *testing.T) {
	for _, c := range []struct {
		name    string
		profile map[string]any
		wantSL  float64
		wantTP  float64
	}{
		{"retired snake_case", map[string]any{"stop_loss_pct": 0.05, "take_profit_pct": 0.08}, 0.05, 0.08},
		{"retired camelCase", map[string]any{"stopLossPct": 0.05, "takeProfitPct": 0.08}, 0.05, 0.08},
		{"current snake_case", map[string]any{"stop_loss_fraction": 0.05, "take_profit_fraction": 0.08}, 0.05, 0.08},
		{"current camelCase", map[string]any{"stopLossFraction": 0.05, "takeProfitFraction": 0.08}, 0.05, 0.08},
		// BOTH WRITTEN: the unambiguous one wins, because an owner who has
		// migrated half their profile means the half they migrated.
		{"both, the clear one wins",
			map[string]any{"stop_loss_pct": 0.15, "stop_loss_fraction": 0.0015}, 0.0015, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			l := riskLimitsFrom(c.profile)
			if l.StopLossPct != c.wantSL {
				t.Fatalf("stop loss is %v, want %v — a renamed key that stops being read is a "+
					"position its owner believes is protected and is not", l.StopLossPct, c.wantSL)
			}
			if l.TakeProfitPct != c.wantTP {
				t.Fatalf("take profit is %v, want %v", l.TakeProfitPct, c.wantTP)
			}
		})
	}
}

// An explicit zero from the model is an answer, not an absence.
//
// "No level on this trade" and "I did not mention levels" mean opposite things:
// the first must stand, the second must fall back to the owner's standing
// instruction. Collapsing them would let a model that deliberately declined a
// stop have one armed anyway — or, the other way round, silently drop the
// owner's standing level on every tick the model stayed quiet.
func TestAnExplicitZeroIsNotAnAbsentField(t *testing.T) {
	zero := 0.0
	val := 0.05

	if v, asked := pickFraction("a", "stop_loss", &zero, nil); !asked || v != 0 {
		t.Fatalf("an explicit 0 read as (%v, asked=%v); it must be an ANSWER meaning no level", v, asked)
	}
	if v, asked := pickFraction("a", "stop_loss", nil, nil); asked || v != 0 {
		t.Fatalf("an absent field read as (%v, asked=%v); it must be silence, so the owner's "+
			"standing level applies", v, asked)
	}
	if v, asked := pickFraction("a", "stop_loss", &val, nil); !asked || v != val {
		t.Fatalf("the current field read as (%v, asked=%v)", v, asked)
	}
	// The retired field is still read, and still counts as having been asked.
	if v, asked := pickFraction("a", "stop_loss", nil, &val); !asked || v != val {
		t.Fatalf("the retired field read as (%v, asked=%v); a model answering in it must not "+
			"silently arm nothing", v, asked)
	}
	// And the current one wins when both arrive.
	other := 0.0015
	if v, _ := pickFraction("a", "stop_loss", &other, &val); v != other {
		t.Fatalf("with both fields present the value is %v, want the unambiguous %v", v, other)
	}
}

// The schema the model is shown must not still advertise the retired names.
//
// A worked example in the prose and the old field in the JSON would be a
// contract that contradicts itself, and the model would be right either way.
func TestThePromptAdvertisesOnlyTheUnambiguousNames(t *testing.T) {
	for _, bad := range []string{`"stop_loss_pct"`, `"take_profit_pct"`} {
		if contains(decisionSchema, bad) {
			t.Fatalf("the schema still offers %s; the model will answer in it and the number "+
				"will be ambiguous again", bad)
		}
	}
	for _, want := range []string{`"stop_loss_fraction"`, `"take_profit_fraction"`, "0.0015 means 0.15%"} {
		if !contains(decisionSchema, want) {
			t.Fatalf("the schema does not carry %q, so the model is not told the scale", want)
		}
	}
	// The worked example belongs in the prose too: the schema line is easy to
	// skim and the rule is the whole point of the change.
	if !contains(systemPrompt, "0.0015") || !contains(systemPrompt, "0.15") {
		t.Fatal("the system prompt does not work the conversion through, so a mandate written " +
			"in percent has nothing to convert against")
	}
}

func contains(hay, needle string) bool {
	return len(needle) > 0 && len(hay) >= len(needle) && indexOf(hay, needle) >= 0
}

func indexOf(hay, needle string) int {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if hay[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
