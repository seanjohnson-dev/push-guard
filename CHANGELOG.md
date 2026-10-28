# Changelog

## 0.5.0

- New: with Baseline installed, a push is blocked only by test failures it caused. push-guard runs
  `baseline check --json --base <B> -- npm test`, `<B>` being where `HEAD` left its upstream (or the
  remote's default branch). NEW failures, NEW load errors included, block the push, each listed with
  its evidence. Failures that were already there (pre-existing, pre-existing with a changed error,
  flaky, environment) let it through, with a short toast, `0 new, 3 still failing (not yours)` above
  the prompt, and a note to Claude on the push's result.
- Whenever Baseline can't answer clearly (exit 2 or 3, UNKNOWN, output that isn't its JSON report, a
  crash or timeout, a runner it can't read per test, a verdict without the runs to show for it, nothing
  new to push, a first push), push-guard runs `npm test` as before and blocks on any failure, adding a
  line saying why Baseline wasn't used.
- New: the `baseline` option, `auto` (default) or `off`. Baseline is found once per session through
  `BASELINE_BIN`, `$PATH`, or an installed Baseline plugin; without it nothing changes.
- The hold for pushes that change existing tests still applies, also when the only failures are old.
- Limits: npm `test` scripts that run vitest, jest or another runner Baseline reads per test only;
  flaky and environment failures go through. See "With Baseline" in the README.

## 0.4.0

- New: a push whose commits change existing tests is held, even when the tests pass. When a test
  file loses lines, is deleted or is renamed between where the branch left its upstream (or the
  remote's default branch, for a new branch) and `HEAD`, Claude is told which files changed and to
  ask you. Type `/push-guard allow` to let that commit through; it only counts when a person runs
  it, not Claude, another plugin or `claude -p`. New test files, and lines only added
  to a test file, go through with a note.
- New: the `testChanges` option: `block` (default), `warn` or `off`.
- New: `"pushGuard": { "testFiles": [globs] }` in `package.json` adds a project's own test paths
  (`*`, `?` and `**`).
- Limits: it counts removed lines, it does not read them; tests outside the usual names and folders
  are not seen unless named; only the checked-out branch's commits are judged. See the README.
  Suggested by u/kaijurules on r/ClaudeCode.

## 0.3.1

- Fixed: `git -C <dir> push`, `cd <dir> && git push` and `cd <dir>; git push` now read
  `<dir>/package.json` and run `npm test` in `<dir>`, the project being pushed. Before, they were
  checked against the folder the session was started in, so the push was judged on the wrong project.
  Relative folders are taken from the session's folder, quoted folders (with spaces) work, and
  several `-C` options combine the way git combines them.
  When the folder can't be told from the command (a `$VARIABLE`, `~`, a wildcard, `cd -`), the session's
  folder is used, as before.
  Reported by u/atp_studio_coll on r/ClaudeCode.
