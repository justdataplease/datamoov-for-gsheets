# Code layout

Only src/ is uploaded to Apps Script. The app has no backend and no runtime dependency outside Google Apps Script.

| Location | Responsibility |
| --- | --- |
| src/dmv_app.js | Google Sheets menu, sidebar entry point and template includes |
| src/dmv_core.js | Connector registry, catalog, validation, canonical JSON, relative dates including adjacent completed weeks, and typed result normalization |
| src/dmv_store.js | Private per-user records, runtime locks, active spreadsheet and validated output-tab links |
| src/dmv_credentials.js | Saved credentials: connector-derived types, Google token and available consumer checks on edits, delete refused while in use, and credential merging into connections at run time |
| src/dmv_credential_import.js | Validated local credential-bundle import through the existing private save APIs, exact-match reuse and per-item results |
| src/dmv_connections.js | Save, delete and test connections (a saved credential plus per-connection values); summaries never expose secrets |
| src/dmv_reports.js | Bootstrap, report validation, discovery, preview, run and refresh-all |
| src/dmv_continuation.js | Bounded per-user checkpoint storage, snapshot recovery and saved-report chunk execution |
| src/dmv_writer.js | Output ownership receipts, overlap checks and one atomic Sheets batch for one or multiple report destinations |
| src/dmv_schedule.js | Private schedule enrollment and hourly refresh of explicitly approved reports and pending continuations |
| src/dmv_http.js | Bounded HTTPS requests, retries and Google access tokens |
| src/dmv_sql.js | Shared conservative read-only SQL validation |
| src/dmv_connector_helpers.js | Provider-neutral helpers: Google credential fields, field selection, discovery check, number/text coercion, page budget, UTC date window, chunk validation/merging and complete-fetch wrapper |
| src/dmv_ai.js | Private AI settings, general and per-connection instructions with legacy source defaults and bounded versioned storage, and the Anthropic, OpenAI and Gemini adapters |
| src/dmv_chat.js | One chat turn: system prompt from the live catalog, tool schemas, bounded tool loop, private live progress, transcript replay, budget-exhausted final answer |
| src/dmv_chat_tools.js | Chat tools, complete-query reuse within one turn, combination and per-group ranking, protected sheet output with tab links; result IDs available through a one-hour private cache |
| src/dmv_chat_sheets.js | Bounded sheet inspection and atomic typed edits, stale-range tokens, scalar formula validation and protected-tab checks |
| src/dmv_chat_pivots.js | Native pivot creation from explicit validated sheet ranges |
| src/dmv_dashboards.js | Private dashboard plans (datasets and tiles), fresh dataset execution, the dashboard page layout, native charts and the atomic multi-tab refresh |
| src/dmv_chat_dashboards.js | Chat adapters for saving, listing and running the dashboard runtime |
| src/connectors/ | One self-contained declaration and adapter per provider |
| src/dmv_welcome.js | The one-time "Start here" page: what DataMoov does and the order to do it in |
| src/dmv_sidebar.html | Sidebar structure |
| src/dmv_client.html | Browser state, forms, connection form with its chat instructions, saved dashboard cards and server calls |
| src/dmv_client_chat.html | Chat panel: AI and general settings, safe Markdown and output links, live activity, default-on completed actions and option chips |
| src/dmv_styles.html | Sidebar styles |
| src/appsscript.json | Google scopes, runtime and Sheets service |
| tests/ | Real implementation exercised with offline services and provider fixtures |
| tests/browser/ | Sidebar behavior at narrow and wider widths |
| tools/ | Source checks, local preview and guarded development publication |
| data/ and .local/ | Ignored private snapshots, verification records and credentials |

Apps Script server files share a global namespace. The dmv prefix identifies the app's functions; names ending in an underscore are internal helpers. Node imports belong only in tools and tests.

Reports and dashboards are private records in the owner's UserProperties, scoped to their spreadsheet; the spreadsheet holds only output. A report record carries its full query, destination, schedule and run state, and its ID identifies locks, continuation state and output receipts. Private record mutations use the user lock; output verification and writes use a short script lock, and provider requests happen outside it. See [report storage](report-storage.md).

Saved dashboards are private, workbook-scoped plans: 1 to 6 datasets (a report query, its own tab and optional shared column names) and up to 12 tiles (kpi, chart or table over one or more datasets). The plan is stored gzipped inside the record so wide field lists fit the 8 KB property limit; the record lists its tabs and connection ids beside it for the sidebar card and the connection guards. Refresh reuses the report validator and fetcher, then the chat's combine and summarize functions for each tile, without calling AI. The dashboard tab is one owned page (title, scorecards, a row band reserved for charts, data sources, tile tables) written through the ordinary writer with a `layout`; the wide table behind each chart goes to a hidden `<dashboard tab> (chart data)` tab. Charts are added, updated in place (ranges included, so they follow a refresh with more rows) or removed in the same Sheets batch through the writer's `extra` hook; the runtime picks chart ids and saves them before the batch, so a failure after the write cannot duplicate charts. Each dataset tab, the chart data tab and the dashboard tab has its own ownership receipt (`<id>-d-<dataset>`, `<id>-charts`, `<id>-report`), and removing a dashboard deletes exactly the tabs those receipts name. A tab that already holds content is refused at save time, by name. Weekly comparisons save `lastWeek` and `previousWeek` datasets per account; trends save one dataset per account and bucket in the tiles. Refresh applies the higher of each saved dataset limit and the current chat row cap, and names the failing dataset. Connection revisions and plan fingerprints are rechecked immediately before the write; status updates carry a run token.

The runtime resolves and validates the date range before calling fetch, and the context exposes checkDeadline() for connectors to enforce the shared deadline. Continuations retain the initially resolved dates across executions. Connectors call dmvSelectFields_ to resolve the user's selection against their declared or discovered descriptors, so every source shares one selection rule and one error vocabulary.

The chat path reuses the report path: `dmvValidateQuery_` validates a model-supplied query exactly like a saved report, `dmvFetchReport_` fetches it, `dmvWriteReport_` writes it. Within one turn, `run_report` can reuse an explicitly complete result under a canonical query key containing sorted selected fields, configuration, resolved dates and the effective connection/credential revision. It checks the requested row cap before reuse and checks revisions again before storing a reusable result. This map is execution-local; cross-turn reuse requires an existing result ID, and dashboard refresh always fetches fresh data. The model sees summaries and bounded samples; `dmv_chat_tools.js` owns the summarization rules. See [chat](chat.md).

The report path validates settings, fetches all selected data, normalizes the complete result into a typed matrix, verifies the destination, then writes in one Sheets batch. A report with fetchChunk may stage validated pages in private UserProperties and pause between executions; the full result must still pass the same final normalization and writer. The same matrix supplies size checks and the output fingerprint. Provider code owns API semantics; shared code detects the optional function and never switches on a source name. See [chunk continuation](chunk-continuation.md) for checkpoint limits and recovery behavior.

Use npm run format before committing source changes and npm run format:check to verify consistent formatting. Follow connector-contract.md for new connectors. Keep changes within these existing responsibilities unless a concrete new capability needs another abstraction.
