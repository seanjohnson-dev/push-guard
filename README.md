# push-guard

A Claude Code plugin that runs `npm test` before Claude runs any `git push`.

- If a test fails, the push is blocked and Claude is told which tests failed.
- If the tests pass, the push goes ahead.
- If the project has no npm tests (no `package.json`, no `test` script, or the
  placeholder script `npm init` writes), the push goes ahead without running anything.
- `git -C <dir> push` and `cd <dir> && git push` are checked in `<dir>`, the project being pushed.
  If the folder is written with `~` or a `$VARIABLE`, the session's folder is checked instead.
- The last result shows above the prompt: `push-guard: all tests passing` or
  `push-guard: 2 tests failing`.

It only checks pushes Claude makes. Pushes you type in your own terminal are not checked.

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

push-guard runs `npm test` on your computer, as you, in the project Claude is working in.
That runs whatever the project's `test` script says, with the same access to your files,
network and credentials that you have. Only install it, and only push from projects,
whose test scripts you trust. Read `hooks/register.tsx` before installing: it is short.

## Licence

MIT. See [LICENSE](LICENSE).
