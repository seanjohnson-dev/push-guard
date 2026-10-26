# Changelog

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
