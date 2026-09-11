package engine

import (
	"context"
	"fmt"
)

// A verification may not spend money.
//
// WHY THIS IS IN THE ENGINE AND NOT IN THE SUITES.
//
// On 2026-09-11 running `phase10-verify` bought $5.96 of MSFT on the production
// wallet. The suite invoked the cadence with a one-hour interval to prove the
// four-hour floor refused it. That floor had been deliberately retired, so
// nothing refused: the cadence opened a real tick, every active agent decided,
// and the chain-backed one traded. Gas and fees came to $0.079, and the position
// it opened could not be guarded because the level the mandate asked for is
// inside that pool's round trip.
//
// The suite was not reckless. It was CORRECT until a lever it depended on was
// removed, and nothing connected the two. That is the shape of every expensive
// mistake in this project, and the answer has never been "remember harder":
//
//	a verification must not be able to redeploy what it is verifying
//	  -> so the build goes to a temp directory, and the live dist is untouched
//	a verification must not be able to measure a stranger
//	  -> so a suite refuses to start when something else holds its port
//	a verification must not be able to spend money
//	  -> this file
//
// HOW IT REFUSES. A caller states that it is a verification — a header on the
// HTTP path, an environment variable on the binaries. From then on the ENGINE
// refuses to act on any agent that holds a wallet, whatever the suite asks for.
// The suite cannot talk it round, because the suite is not the one deciding.
//
// THE FLAG CAN ONLY EVER REFUSE MORE. That is what makes it safe to have in
// production code at all. There is no path where setting it permits something
// that would otherwise be forbidden, so a stray export cannot weaken anything —
// at worst it stops a real cadence from trading, loudly, with this reason in the
// record.

// VerificationHeader is set by every request a verification suite makes.
const VerificationHeader = "X-Arcana-Verification"

// VerificationEnv does the same for the binaries, which take no headers.
const VerificationEnv = "ARCANA_VERIFICATION"

// THERE IS NO REASON CODE FOR THIS, deliberately.
//
// A refusal here is an ERROR to the caller, not a recorded decision: the caller
// is a test, and the right answer is to fail its run rather than write a row
// into a competition record about something that never happened.
//
// The first version declared one anyway. docs-verify caught it within the hour
// -- a reason code that nothing emits is precisely what that check exists to
// find, and it found one I had just written.

// ErrVerificationWouldSpend is returned rather than recorded, because the caller
// is a test and the right answer is to fail its run rather than to write a row
// into the competition record.
type ErrVerificationWouldSpend struct {
	AgentID string
	Wallet  string
}

func (e *ErrVerificationWouldSpend) Error() string {
	return fmt.Sprintf(
		"refusing: this request is marked as a verification (%s) and agent %s holds the on-chain "+
			"wallet %s, so acting on it could broadcast a transaction and spend real funds. "+
			"Point the verification at an agent with no wallet. This refusal is enforced here "+
			"rather than in the suite, because a suite that has to remember is a suite that "+
			"forgets — and one already did, for $0.079 and an unguarded position",
		VerificationHeader, e.AgentID, e.Wallet)
}

// refuseIfVerificationWouldSpend is called before anything that can reach the
// chain. It is a no-op for ordinary traffic.
func (e *Engine) refuseIfVerificationWouldSpend(ctx context.Context, isVerification bool, agentID string) error {
	if !isVerification {
		return nil
	}
	wallet, err := e.store.ChainWalletFor(ctx, agentID)
	if err != nil {
		// UNREADABLE MEANS REFUSE. Not knowing whether this agent holds funds is
		// not the same as knowing it does not, and the cost of being wrong here
		// is money rather than a failed check.
		return fmt.Errorf("refusing: this request is marked as a verification and whether agent %s "+
			"holds a wallet could not be read (%w)", agentID, err)
	}
	if wallet != nil {
		return &ErrVerificationWouldSpend{AgentID: agentID, Wallet: wallet.Address}
	}

	// AND THE WALLETS THE AGENT ROW CANNOT SEE. One decision now reaches every
	// subscriber's wallet, so an agent with no wallet of its own can still move
	// somebody else's money. Checking only agent_wallets would have left the
	// whole fan-out outside the rule that was just paid for.
	subWallet, has, serr := e.store.AnyFundedSubscriptionWallet(ctx, agentID)
	if serr != nil {
		return fmt.Errorf("refusing: this request is marked as a verification and whether agent %s "+
			"has subscriber wallets could not be read (%w)", agentID, serr)
	}
	if has {
		return &ErrVerificationWouldSpend{AgentID: agentID, Wallet: subWallet}
	}
	return nil
}
