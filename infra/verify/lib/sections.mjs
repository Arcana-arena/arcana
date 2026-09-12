/**
 * lib/sections.mjs — a section that proves nothing is not allowed to be quiet.
 *
 * WHY THIS EXISTS. subscription-chain-verify printed this, in the middle of a
 * green run:
 *
 *     === Each wallet sized the position against its own book ===
 *
 *     === A wallet that could not act was refused on its own, and recorded ===
 *
 * A header, then nothing. The section ran ZERO checks and said not one word
 * about it, and the suite reported 38 pass, 0 fail. The cause was a section that
 * read `subscriber[0]` where row [0] happened to be a `blocked` leg, so its one
 * guard condition was false and the whole body was stepped over — while a mined
 * subscriber leg, the row it was looking for, sat right behind it.
 *
 * That is the same defect as `go test` printing `ok` over a package whose six
 * tests never ran, and it happened inside a file whose own header refuses the
 * pattern: "a verification that reports success because it found no data is the
 * failure this project keeps writing down."
 *
 * WHY A SHARED GUARD RATHER THAN THREE REPAIRS. The same file had two more
 * sections with the identical latent shape — every check inside a `for` over
 * mined rows, which proves nothing if nothing is mined — and patching them one
 * by one leaves the seventh section, written next month, with the same hole.
 * So the structure enforces it instead: run the body, count the checks, and if
 * there were none, the section must have SAID so.
 *
 * THE TWO CASES ARE DIFFERENT AND ARE KEPT DIFFERENT.
 *
 *   - No data to check. Legitimate: nobody has triggered a subscriber guard yet,
 *     no wallet was ever refused. The section calls nothingToCheck() or notYet()
 *     and is listed by name in the summary as unproven. Not a pass.
 *
 *   - Data present, wrong row chosen. A bug, and the one above. Nothing is
 *     declared, the body simply falls through, and the section FAILS — because
 *     a section silently proving nothing is indistinguishable, from the outside,
 *     from a section that passed.
 *
 * A body that throws also fails rather than taking the run down with it, so the
 * summary still prints. The summary is the only part anybody reads.
 */

export function suite(title) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  const notYets = [];
  const unproven = [];
  const ledger = [];
  let open = null;

  const check = (name, ok, detail = '') => {
    if (open) open.ran++;
    if (ok) {
      pass++;
      console.log(`  PASS  ${name}`);
    } else {
      fail++;
      failures.push(`${name} — ${detail}`);
      console.log(`  FAIL  ${name} — ${detail}`);
    }
  };

  // Declared by a section that genuinely had nothing to look at. Counts as
  // neither a pass nor a failure, and is named in the summary.
  const nothingToCheck = (reason) => {
    if (open) open.declared = true;
    unproven.push(`${open ? open.name : title}: ${reason}`);
    console.log(`  NOTHING TO CHECK  ${reason}`);
  };

  // The narrower cousin: the mechanism is built and the market has not yet done
  // the thing. Same accounting, different list, because "waiting on a price" and
  // "this run had no rows" are different reports to a person.
  const notYet = (reason) => {
    if (open) open.declared = true;
    notYets.push(reason);
  };

  const section = async (name, body) => {
    console.log(`\n=== ${name} ===`);
    const prev = open;
    open = { name, ran: 0, declared: false };
    try {
      await body();
    } catch (e) {
      open.ran++;
      fail++;
      failures.push(`${name} — the section itself threw: ${e && e.message}`);
      console.log(`  FAIL  ${name} — the section itself threw: ${e && e.message}`);
    }
    if (open.ran === 0 && !open.declared) {
      // Deliberately counted as a failure of the SECTION, not of a claim: no
      // claim was made, and that is the problem.
      fail++;
      const why = `it ran zero checks and did not say why. A section that silently proves ` +
        `nothing cannot be told apart from one that passed — if there was nothing to look at, ` +
        `call nothingToCheck(); if there should have been, this is the bug`;
      failures.push(`${name} — ${why}`);
      console.log(`  FAIL  ${name} — ${why}`);
    }
    ledger.push({ ...open });
    open = prev;
  };

  const report = () => {
    console.log(`\n${pass} pass, ${fail} fail`);
    const quiet = ledger.filter((s) => s.ran === 0);
    if (quiet.length > 0) {
      console.log(`\nSections that checked nothing (${quiet.length} of ${ledger.length}):`);
      for (const s of quiet) console.log(`  - ${s.name}`);
    }
    if (notYets.length > 0) {
      console.log('\nNot yet proven on chain (waiting on the market, not on the code):');
      for (const n of notYets) console.log('  - ' + n);
    }
    if (unproven.length > 0) {
      console.log('\nNot proven by this run, for want of data:');
      for (const u of unproven) console.log('  - ' + u);
    }
    if (failures.length > 0) {
      console.log('\nFailures:');
      for (const f of failures) console.log('  - ' + f);
      return 1;
    }
    return 0;
  };

  return { check, section, nothingToCheck, notYet, report, counts: () => ({ pass, fail }) };
}
