# Report storage

Saved report definitions live in a hidden tab named `DataMoovReports` inside the spreadsheet. This tab is the authoritative source of each report's name, source, report type, selected fields, settings, date range, row limit and output location. Report settings include SQL when the source uses it.

Spreadsheet collaborators can read these definitions, and a spreadsheet copy retains them. Hiding the tab is a convenience, not a privacy boundary. Credentials, connection choices and refresh authorization remain private to each Google user.

## Using shared definitions

Use **Extensions > DataMoov > Manage report definitions** to show the configuration tab. Normal report creation and editing remain available in the sidebar.

When another user opens a shared report, or when you open a copied spreadsheet, choose your own connection and save the report before running it. New private bindings start on demand; enable a refresh schedule explicitly for your own account. A shared definition never supplies someone else's credentials or turns on their schedule for you.

Changes made directly in `DataMoovReports` mark an existing private binding as needing approval. Open **Edit** in the sidebar, review the settings and connection, and **Save** to validate and approve the current definition. A scheduler cannot silently run changed sheet content with an earlier approval.

Output ownership also stays private. A copy retains the existing output cells but does not copy the receipt that permits replacing them. Choose an empty output area or a new tab before running a copied report. A collaborator likewise cannot replace another user's output without their own valid receipt. If a shared definition is removed, its previous owner can remove the remaining private setup from the sidebar without deleting output.

## What is shared and what stays private

| Storage | Contents |
| --- | --- |
| `DataMoovReports` tab | Stable definition ID and report recipe: name, connector/report type, fields, configuration, dates, limits and target |
| Private user properties | Credentials, connections, the definition-to-connection binding, approved definition fingerprint, schedule, runtime report ID, run status/locks, continuation rows/cursors and output receipts |
| Output tabs | Complete report results after validation and one atomic Sheets write |

The shared `definitionId` identifies a recipe. Each user's private report has its own runtime `id` and records the `spreadsheetId` and `definitionId` it belongs to. A copied definition can therefore keep its ID without adopting the original spreadsheet's private runtime state. Existing private report IDs are retained during migration so their output receipts and continuation references remain associated with the right report.

Private approval records the definition fingerprint. The runtime checks the current definition against that approval before using the user's connection, and verifies that it has not changed before committing fetched output. A private schedule belongs to that binding; it is not a property of the shared recipe.

## Editing the tab

Cell A1 identifies the format as `DataMoov report definitions v1`. Row 2 contains the following 13 headers, in order; definitions start on row 3.

| Column | Header | Value |
| --- | --- | --- |
| A | Report ID | Stable shared definition ID |
| B | Name | Report name |
| C | Source | Connector ID |
| D | Report type | Report type declared by that connector |
| E | Date preset | Date-range preset |
| F | Start date | Start date for a custom range |
| G | End date | End date for a custom range |
| H | Fields (JSON) | JSON array of selected field keys |
| I | Options (JSON) | JSON object containing report configuration, including SQL when applicable |
| J | Output tab | Destination tab name |
| K | Start cell | A1-style output anchor |
| L | Row limit | Maximum accepted report rows |
| M | Schema version | Definition schema version |

Keep the generated headers and schema intact. DataMoov rejects formulas, malformed JSON, duplicate definition IDs and invalid rows instead of guessing which configuration to execute. JSON values and all other cells are treated as data, never as instructions. Use the sidebar when unsure how a setting should be represented. If the settings sheet is malformed, refreshes stop until it is repaired; use **Manage report definitions** to open it even when the sidebar cannot load. Unchanged reports do not lose their private approval because another row is malformed.

Do not put access tokens, passwords or service-account keys in report configuration. Those belong in **Settings > Credentials**. Anything entered in this tab is spreadsheet content visible to collaborators.

`DataMoovReports` is reserved for configuration. It cannot be a report output target or a chat data source, output tab or chart source. DataMoov does not overwrite an unrelated existing tab with that name; resolve the name conflict before creating the configuration tab.

## Existing reports

Legacy reports can still have their definition embedded in the current user's private properties. When that user's reports are loaded for use, inactive legacy definitions are migrated to `DataMoovReports` with a private binding to the same connection and runtime ID. The migration is idempotent and preserves output receipts. A shared definition is written successfully before the private record switches to it.

Active and paused legacy reports retain their existing private definition until their work is complete. Migration does not replace the definition underneath a running fetch or rewrite an in-progress continuation. Each collaborator's private legacy reports can be migrated only when that user opens or uses them.

## Runtime boundaries

`src/dmv_report_store.js` owns the schema and shared/private binding boundary. `dmvWorkbookReports_(spreadsheet)` supplies workbook summaries, `dmvMigrateReports_` handles eligible legacy definitions, and `dmvCheckReportDefinition_(report, spreadsheet)` rejects a definition that no longer matches the user's approved fingerprint.

Shared definition mutations and the output writer's verification/write section use a short script lock so different users cannot pass the same checks concurrently. Provider requests happen outside that shared lock. Private record changes retain the per-user lock.

Fetching still goes through the connector contract, full result validation and the protected atomic writer. A shared definition never contains a credential, run lock, provider cursor, output receipt or error history. Continuations remain in private user properties; see [chunk continuation](chunk-continuation.md).
