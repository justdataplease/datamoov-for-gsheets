# Code layout

Only src/ is uploaded to Apps Script. The app has no backend and no runtime dependency outside Google Apps Script.

| Location | Responsibility |
| --- | --- |
| src/dmv_app.js | Google Sheets menu, sidebar entry point and template includes |
| src/dmv_core.js | Connector registry, catalog, validation, dates and typed result normalization |
| src/dmv_store.js | Private per-user storage of connections, report bindings and runtime state, locks, active spreadsheet |
| src/dmv_report_store.js | Shared report definitions in DataMoovReports, schema validation, fingerprints, private bindings and legacy migration |
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
| src/dmv_ai.js | Private AI settings, bounded versioned instruction storage and the Anthropic, OpenAI and Gemini adapters over the shared transport |
| src/dmv_chat.js | One chat turn: system prompt from the live catalog, tool schemas, bounded tool loop, private live progress, transcript replay, budget-exhausted final answer |
| src/dmv_chat_tools.js | Chat tools: run_report, discover_fields, describe_database, combine_results, summarize with per-group ranking, write_to_sheet, read_sheet, create_chart, ask_user; per-turn results with a one-hour private cache |
| src/dmv_chat_sheets.js | Bounded sheet inspection and atomic typed edits, stale-range tokens, scalar formula validation and protected-tab checks |
| src/dmv_chat_pivots.js | Native pivot creation from explicit validated sheet ranges |
| src/dmv_dashboards.js | Private multi-source plans, fresh source execution, phase status and atomic two-tab refresh |
| src/dmv_chat_dashboards.js | Chat adapters for saving, listing and running the dashboard runtime |
| src/connectors/ | One self-contained declaration and adapter per provider |
| src/dmv_sidebar.html | Sidebar structure |
| src/dmv_client.html | Browser state, form rendering and server calls |
| src/dmv_client_chat.html | Chat panel: AI and per-source settings, safe Markdown, live activity, default-on completed action history and option chips |
| src/dmv_styles.html | Sidebar styles |
| src/appsscript.json | Google scopes, runtime and Sheets service |
| tests/ | Real implementation exercised with offline services and provider fixtures |
| tests/browser/ | Sidebar behavior at narrow and wider widths |
| tools/ | Source checks, local preview and guarded development publication |
| data/ and .local/ | Ignored private snapshots, verification records and credentials |

Apps Script server files share a global namespace. The dmv prefix identifies the app's functions; names ending in an underscore are internal helpers. Node imports belong only in tools and tests.

Report definitions are authoritative in the spreadsheet's hidden `DataMoovReports` tab. A stable shared definition ID identifies the recipe; each user's private binding connects that definition and spreadsheet to their own connection, approved definition fingerprint and schedule. The private report keeps a separate runtime ID for locks, continuation state and output receipts. Direct sheet edits require validation and renewed approval in the sidebar. Shared definition mutations and output verification/write use a short script lock; provider requests happen outside that shared lock. Private record mutations keep the user lock. See [report storage](report-storage.md) for copying, migration and the storage boundary.

Saved multi-source dashboards are private, workbook-scoped plans with source queries and mappings, aggregation rules and two destinations. Refresh reuses the report validator and fetcher, then the same combination and summary functions used by chat, without calling AI. All source results and both destinations pass validation before one Sheets batch. Connection revisions and plan fingerprints are rechecked immediately before the write; status updates carry a run token. This private plan storage is separate from shared single-source report definitions.

The runtime resolves and validates the date range before calling fetch, and the context exposes checkDeadline() for connectors to enforce the shared deadline. Continuations retain the initially resolved dates across executions. Connectors call dmvSelectFields_ to resolve the user's selection against their declared or discovered descriptors, so every source shares one selection rule and one error vocabulary.

The chat path reuses the report path: `dmvValidateQuery_` validates a model-supplied query exactly like a saved report, `dmvFetchReport_` fetches it, `dmvWriteReport_` writes it. The model only sees summaries; `dmv_chat_tools.js` owns the summarization rules. See [chat](chat.md).

The report path validates settings, fetches all selected data, normalizes the complete result into a typed matrix, verifies the destination, then writes in one Sheets batch. A report with fetchChunk may stage validated pages in private UserProperties and pause between executions; the full result must still pass the same final normalization and writer. The same matrix supplies size checks and the output fingerprint. Provider code owns API semantics; shared code detects the optional function and never switches on a source name. See [chunk continuation](chunk-continuation.md) for checkpoint limits and recovery behavior.

Use npm run format before committing source changes and npm run format:check to verify consistent formatting. Follow connector-contract.md for new connectors. Keep changes within these existing responsibilities unless a concrete new capability needs another abstraction.
