---
name: todo-next-session
description: "2026-10-07 continuation: chat self-check, live RFM findings, deployment and deferred video"
metadata:
  node_type: memory
  type: project
  originSessionId: bb3250c7-6717-4ca0-afc7-08b993b31fb5
  modified: 2026-10-07T00:27:14.000Z
---

Latest Claude conversation checked: session bb3250c7-6717-4ca0-afc7-08b993b31fb5 ended with the request for two correction attempts, numeric evidence and a generic classification review. The older attached transcript was also reconciled: its large-data, formula, dashboard and UI fixes had already shipped, including the successful 100,000-row memory fix. Production and dev were verified at 8f21670 before this work. This handoff records the completed self-check and architecture changes; publication metadata is recorded privately in data/production-project.json.

Completed on 2026-10-07:

1. Live production check on JustDataPlease with both exact prompts. Generated 10,000 clothing retail rows; all totals matched quantity x unit price. All 2,181 customer keys were present, with correct live R/F/M formulas and no formula errors. Recency is anchored to the latest observed source date (2026-10-02). The dashboard had live formulas and two visible native charts.
   - Material issue: the column labeled "FM Score" uses frequency alone. Segments depend on recency and frequency, excluding monetary value despite the RFM/FM labels.
   - Removed all test tabs and the fresh dashboard draft through guarded application paths. Preserved original sheet IDs 838144882, 1493348232 and 150267733, hidden state, and Sheet1!I3=122. Restored Start here. Chrome was restored before interaction; no consent was clicked.
   - Private evidence: .scratch/selfcheck/live-production.md, live-dashboard.png and live-native-formulas.json.
2. Chat self-check implementation: up to two correction attempts within the existing request limits, successful tool/cell numeric evidence with bounded rereads, and one generic review of derived classifier counts and thresholds. Unsupported findings are marked after the allowance or deadline. Source data remains untrusted; no domain-specific prompt rules were added.
   - Final formatting/static checks and 977 repository tests passed; offline benchmark checks passed 279/279. Regression coverage includes row positions, rounding, query/configuration echoes, warnings that exceed their abbreviated list, and classifier payload privacy bounds.
   - Completed a matched 16-turn comparison per phase: four domains, two repeats, including held-out clothing retail and clinic cases. Checked answer accuracy went from 7/16 to 12/15 (one after answer unscored; conservative 12/16 verified). Claims matched 14/16 to 16/16; completion 13/16 to 15/16; no cell errors in either phase. All eight after entity cases had live entity tabs and segment columns.
   - Mean parsed AI responses (benchmark rounds) went from 27.063 to 30.813 (433 to 493 total, +13.9%); mean benchmark seconds 83.444 to 77.900. Calculator time is excluded. Latency and generated tables differ between phases; do not claim a speed improvement or broad regression certification from this sample. No token usage or dollar cost was retained.
   - Entity-only workflows cost more: mean rounds 23.125 to 34.750, seconds 72.100 to 90.363. Faster generation offsets this in the pooled time mean; the comparison does not isolate correction overhead from changed planning, retries or incomplete baseline work.
   - Evidence: .scratch/selfcheck/before.json, after.json, compare.md, audit.md and methodology.md. Preliminary after runs were stopped and archived after identifying row-position and echoed-query flaws, and excluded from the final comparison. The final frozen common-case comparison started before the additional classifier payload guard; that rare branch is tested separately. Normal short-label payloads are unchanged. The methodology report records both hashes and this coverage limit.
   - Scorer limitations: it can mistake a numbered list after "USD" for a currency claim, omit genuine intermediate rates held in source cells, and leave small patient counts unscored. Raw scores were preserved, with no scoring changes.

Architecture pass on 2026-10-07:

- Report execution: chunked fetches inherit the caller's deadline; completed ordinary and chunked results cannot enter the writer after the remaining write reserve is exhausted. PostgreSQL checks the budget before connecting and after queries, including empty results, and bounds JDBC timeouts by the remaining budget.
- Recovery: deleting reports, dashboard tabs or dataset definitions recovers and prunes only their pending journal entries. Removed ownership cannot reappear; other owners' recovery and manually edited cells are preserved. Invalid calendar dates remain literal, and valid early years retain their year.
- Credentials: service-account and OAuth token validation/cache behavior now share helpers. Invalid/expired tokens are refused, cache failures are optional, and rotated-token cache reuse avoids a second immediate exchange. Reused discovery credentials retain their saved identity; unsaved edits cannot rotate it. Concurrent rotations compare the full saved secret bundle and logical revision. Declared short secrets are redacted from errors.
- Chat/UI: cached results require the current workbook and conversation evidence. Classifier boundary examples use one batched read (5 to 2 total Sheets requests in the measured fixture, unchanged 206 cells and evidence). Late discovery/preview/save responses respect editor state, active report runs survive rerenders, conversation saves/clears are ordered, and source changes wait for the active answer before starting fresh context on the next request.
- Regression evidence: all ten new credential/JDBC regression cases fail against HEAD and pass with these changes. The full repository suite passes 996/996; formatting/static checks and offline benchmark self-tests pass 279/279. All 194 browser checks pass across both viewport widths, including 16 new lifecycle checks. Existing dashboard goldens are unchanged; one new recovery case was added. Temporary baseline source/test copies were removed; evidence logs were retained.
- Private logs: .scratch/architecture-tests-final.log, architecture-browser.log, architecture-bench.log and architecture-security-baseline.log. The earlier paid AI benchmark predates this architecture pass; its accuracy figures are historical evidence, not a new measurement of the final source. No new paid model calls or live provider certification were performed for this pass.

Next work:

1. Validate the new self-check and architecture behavior in live Apps Script after deployment. Development re-authorization remains a user action.
2. Resolve the live RFM omission with general dimension-completeness checks: a derived classification must use the requested measures or state a justified simplification. The benchmark also flagged inconsistent numeric repeat flags in both clinic runs, and one shop run hit the step cap with an 84.5% main segment and one blank label. Numeric existence and one threshold review do not certify those definitions. Re-test without adding domain-specific runtime rules.
3. User creates a new Marketplace deployment version if the listing is pinned; development script re-authorization requires the user. Never click consent.
4. Video remains deferred at the user's request. Later re-record videos/retail-retention from a real RFM run, showing the per-key formulas, then update videos/linkedin/out/2026-10-29 post and copy.
5. Known weak spots still need measurement: web-session data copied as values, unsupported quoted findings, delete_sheet frequency, and per-key QUERY filtered to one status losing keys. Automatic closing rereads cover recorded written/inspected areas; saved reports, dashboard outputs and native pivots can require an explicit inspect_sheet during correction.
6. Website: "DataMoov Lite (Free)" rename edits remain local/uncommitted in jdp-website-revamped; user deploys manually.

The earlier fix4 comparison remains .scratch/heldout/compare-heldout-fix4.md (dev entity tabs 64% to 86%; held-out improvements mostly within noise, with consistent data 50% to 88%). Tests use fixtures and do not certify live provider access. Keep .local/, data/ and .scratch/ private and ignored.

Related: [[measure-and-generalize]], [[formulas-first]].
