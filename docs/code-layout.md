# Code layout

Only src/ is uploaded to Apps Script. The app has no backend and no runtime dependency outside Google Apps Script.

| Location | Responsibility |
| --- | --- |
| src/dmv_app.js | Google Sheets menu, sidebar entry point and template includes |
| src/dmv_core.js | Connector registry, catalog, validation, dates and typed result normalization |
| src/dmv_store.js | Private per-user storage of connections and reports, locks, active spreadsheet |
| src/dmv_connections.js | Save, delete and test connections; summaries never expose secrets |
| src/dmv_reports.js | Bootstrap, report validation, discovery, preview, run and refresh-all |
| src/dmv_continuation.js | Bounded per-user checkpoint storage, snapshot recovery and saved-report chunk execution |
| src/dmv_writer.js | Output ownership receipt, overlap checks and one atomic Sheets batch |
| src/dmv_schedule.js | One hourly trigger per user and spreadsheet driving normal schedules and pending continuations |
| src/dmv_http.js | Bounded HTTPS requests, retries and Google access tokens |
| src/dmv_sql.js | Shared conservative read-only SQL validation |
| src/dmv_connector_helpers.js | Provider-neutral helpers: Google credential fields, field selection, discovery check, number/text coercion, page budget, UTC date window, chunk validation/merging and complete-fetch wrapper |
| src/connectors/ | One self-contained declaration and adapter per provider |
| src/dmv_sidebar.html | Sidebar structure |
| src/dmv_client.html | Browser state, form rendering and server calls |
| src/dmv_styles.html | Sidebar styles |
| src/appsscript.json | Google scopes, runtime and Sheets service |
| tests/ | Real implementation exercised with offline services and provider fixtures |
| tests/browser/ | Sidebar behavior at narrow and wider widths |
| tools/ | Source checks, local preview and guarded development publication |
| data/ and .local/ | Ignored private snapshots, verification records and credentials |

Apps Script server files share a global namespace. The dmv prefix identifies the app's functions; names ending in an underscore are internal helpers. Node imports belong only in tools and tests.

The runtime resolves and validates the date range before calling fetch, and the context exposes checkDeadline() for connectors to enforce the shared deadline. Continuations retain the initially resolved dates across executions. Connectors call dmvSelectFields_ to resolve the user's selection against their declared or discovered descriptors, so every source shares one selection rule and one error vocabulary.

The report path validates settings, fetches all selected data, normalizes the complete result into a typed matrix, verifies the destination, then writes in one Sheets batch. A report with fetchChunk may stage validated pages in private UserProperties and pause between executions; the full result must still pass the same final normalization and writer. The same matrix supplies size checks and the output fingerprint. Provider code owns API semantics; shared code detects the optional function and never switches on a source name. See [chunk continuation](chunk-continuation.md) for checkpoint limits and recovery behavior.

Use npm run format before committing source changes and npm run format:check to verify consistent formatting. Follow connector-contract.md for new connectors. Keep changes within these existing responsibilities unless a concrete new capability needs another abstraction.
