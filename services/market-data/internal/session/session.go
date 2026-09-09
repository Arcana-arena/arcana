// Package session decides which US trading session a job run should be about.
//
// This is not the same question as "what day is it". The daily fetch runs at
// 23:00 UTC and retries at 01:00 and 03:00 UTC — the retries land on the NEXT
// calendar day in UTC, but must still be about the SAME session, or the retry
// would open a second tick instead of confirming the first. Everything here
// exists to make those three runs agree.
package session

import "time"

// closeHourET is the hour (US Eastern) after which the day's session is
// considered complete and its data fetchable. The NYSE closes at 16:00 ET; 17
// leaves an hour for the vendor's end-of-day aggregation to settle.
const closeHourET = 17

// Eastern is the exchange's own clock. Everything about a US session — the
// close, and therefore which date the session belongs to — is defined in New
// York time, and the DST shift is exactly why this cannot be done by
// subtracting a fixed offset from UTC.
func Eastern() (*time.Location, error) {
	return time.LoadLocation("America/New_York")
}

// LastCompleted returns the date of the most recent session that has finished,
// skipping weekends.
//
// Holidays are NOT handled here on purpose. A hardcoded holiday table drifts
// out of date and cannot know about unscheduled closures, so the vendor is
// asked instead: a date with no session returns no bars, and the caller treats
// that as "closed" (vendor.ErrMarketClosed). Weekends are still skipped locally
// because they are knowable without spending one of five requests per minute.
//
// Worked through the three scheduled run times, all of which must yield the
// same session D:
//
//	23:00 UTC on D  = 18:00/19:00 ET on D    -> past close, session D
//	01:00 UTC on D+1 = 20:00/21:00 ET on D   -> past close, session D
//	03:00 UTC on D+1 = 22:00/23:00 ET on D   -> past close, session D
func LastCompleted(now time.Time, et *time.Location) time.Time {
	t := now.In(et)
	d := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, et)
	if t.Hour() < closeHourET {
		// Today's session has not finished (or its data has not settled), so the
		// most recent completed one is the previous day's.
		d = d.AddDate(0, 0, -1)
	}
	return PreviousWeekday(d)
}

// PreviousWeekday walks back to the nearest Mon-Fri, returning d unchanged when
// it is already a weekday.
func PreviousWeekday(d time.Time) time.Time {
	for d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
		d = d.AddDate(0, 0, -1)
	}
	return d
}

// IsWeekend reports whether a date falls on a Saturday or Sunday.
func IsWeekend(d time.Time) bool {
	return d.Weekday() == time.Saturday || d.Weekday() == time.Sunday
}

// Walkback lists the n most recent weekday dates ending at (and including)
// `from`, most recent first. Used by the backfill to enumerate candidate
// sessions; holidays among them simply return no bars and are skipped.
func Walkback(from time.Time, n int) []time.Time {
	out := make([]time.Time, 0, n)
	d := PreviousWeekday(from)
	for len(out) < n {
		out = append(out, d)
		d = PreviousWeekday(d.AddDate(0, 0, -1))
	}
	return out
}
