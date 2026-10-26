# push-guard

A Claude Code plugin that runs `npm test` before Claude runs any `git push`.

- If a test fails, the push is blocked and Claude is told which tests failed.
- If the tests pass, the push goes ahead.
- If the project has no npm tests (no `package.json`, no `test` script, or the
  placeholder script `npm init` writes), the push goes ahead without running anything.
- `git -C <dir> push` and `cd <dir> && git push` are checked in `<dir>`, the project being pushed.
  If the folder is written with `~` or a `$VARIABLE`, the session's folder is checked instead.
- If the tests pass but the push changes existing tests, the push is held until you OK it
  (see below).
- The last result shows above the prompt: `push-guard: all tests passing` or
  `push-guard: 2 tests failing`.

It only checks pushes Claude makes. Pushes you type in your own terminal are not checked.

## Pushes that change tests

A failing test can be made to pass by changing what it expects instead of fixing the code.
So when the tests pass, push-guard also looks at the commits being pushed: from where your branch
left its upstream to `HEAD` (on a new branch with no upstream, from where it left the remote's
default branch; on a first push, every commit).

- If a test file **loses lines, is deleted or is renamed** in those commits, the push is held.
  Claude is told which test files changed, to put a test back if it edited it to pass, and
  otherwise to ask you.
- If test files are only **added, or only gain lines** (new tests), the push goes ahead with a note.

To let a held push through, read the test changes and type, at the prompt:

```
/push-guard allow
```

then ask Claude to push again. Only an OK you type counts: Claude can't give it. The OK is for that one commit: a new commit that changes tests is
held again.

Test files are `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, files named `test.js` or `tests.py` and the like, and
anything in a `test/`, `tests/`, `spec/`, `specs/`, `__tests__/` or `__snapshots__/` folder.
A project can add its own in `package.json`:

```json
"pushGuard": { "testFiles": ["e2e/**", "cypress/**"] }
```

The plugin option `testChanges` sets what happens: `block` (the default) holds the push, `warn`
lets it through with a note, `off` does not look.

### What it does not catch

- It counts lines, it does not read them. A line added to a test that weakens it (an early
  `return`, a new mock, a `skip` on its own line) counts as an addition and goes through with a note.
  Any removed line holds the push, even a harmless one (a reworded test name, a tidy-up).
  A binary test file (an image snapshot, a fixture) has no line count, so any change to one holds
  the push, a new one too.
- Tests outside the names and folders above are not seen unless `package.json` names them.
- It looks at commits, from `HEAD`. A change already on the remote, a push of a branch other than
  the one checked out (`git push origin other`), or tests changed only in the working tree are not
  judged. On a force push it compares from where the branch left its upstream, so rewritten
  commits are still looked at.
- If git can't say what the push changes (no commit yet, a broken repo), the push goes ahead with
  a note rather than being held with nothing to allow.
- `/push-guard allow` only counts when a person runs it: typed at the prompt or sent from the app.
  Run by Claude, another plugin or a script (`claude -p`), it allows nothing. But Claude can still
  switch the `testChanges` option to `warn` or `off`, edit the plugin, or push from your terminal's
  shell some other way push-guard does not see. It is a guard against a quiet test edit, not a lock.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install push-guard --marketplace seanjohnson-dev/push-guard
```

Answer `y` to add the marketplace, then pick a scope (Enter picks user, so it runs in every session).

From a shell:

```
claude plugin install push-guard --marketplace seanjohnson-dev/push-guard
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with
`seanjohnson-dev/push-guard`, then Add plugin.

## It runs with your access

push-guard runs `npm test` (and, to see which files a push changes, read-only `git` commands) on your computer, as you, in the project Claude is working in.
That runs whatever the project's `test` script says, with the same access to your files,
network and credentials that you have. Only install it, and only push from projects,
whose test scripts you trust. Read `hooks/register.tsx` before installing: it is short.

## Licence

MIT. See [LICENSE](LICENSE).
