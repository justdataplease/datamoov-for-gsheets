---
name: ship
description: Deliver finished work on the DataMoov Sheets add-on. Use at the end of EVERY task that changes this repo — improvement, fix, feature, refactor, doc or test change — without waiting to be asked. Verifies (format, source check, unit tests, browser tests), commits, pushes to main, then publishes to the Apps Script development project so the change is live in the sidebar.
---

# Ship a DataMoov change

Code that only exists in the working tree has not reached Jason. Every task that changes
this repo ends here, as part of the same turn, unless he says otherwise.

## Sequence

Run these from the repo root, in order. A failing step stops the sequence — fix the cause,
then restart from `npm run format`.

```bash
npm run format          # prettier --write over src/**
npm run check           # parses every server file, checks the combined scope
npm test                # node --test tests/*.test.mjs
npx playwright test     # sidebar behavior at 300px and 460px
git add -A && git commit -F -   # message rules below
git push origin main
npm run push:dev        # publishes src/ to the Apps Script development project
```

`npm run push:dev` prints `verifiedFiles`, the count it read back and compared byte for byte.
Check it matches the number of files under `src/` (including `appsscript.json` and
`connectors/`). A mismatch means the publish did not land; say so rather than reporting success.

## Before committing

- **Both suites must pass.** If a test already failed before your change, say so explicitly
  with its name; never let a pre-existing failure hide a new one. When unsure, stash and
  re-run to get the baseline.
- **Tests that encode removed behavior get deleted, not disabled.** Never use `.skip`.
- A test asserting old behavior that is now deliberately different gets updated, and the
  change is called out in the final message.

## Commit messages

Subject in the imperative, under 72 characters, no type prefix. Body explains what changed
and why, wrapped at ~76 characters, in the same plain register as the docs. End with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

Use a heredoc (`git commit -F - <<'MSG'`), not PowerShell here-strings — the Bash tool is
Git Bash and `@'...'@` ends up inside the message.

Branch is `main`; push there directly. `data/` is gitignored, so the publish record it
rewrites never appears in `git status`.

## Development, not production

`npm run push:dev` targets the development script bound to Jason's test spreadsheet. It is
the default and needs no permission.

`npm run push:prod` replaces the code behind the live Google Workspace Marketplace listing.
Never run it on your own initiative. It needs an explicit request, `DATAMOOV_CONFIRM=<scriptId>`,
and a release also needs a new Marketplace deployment version, consent-screen scopes and
resubmission — see the README.

## Closing the turn

Report the commit hash, that it is on main, and the verified file count. Then say to reload
the spreadsheet and reopen DataMoov, since the sidebar caches the old HTML.

State plainly what was not verified. Offline tests drive real code through fake Google and
provider services: they prove logic, never live provider permissions, billing or Apps Script
runtime behavior. Live checks live in `tools/live-check.mjs`.
