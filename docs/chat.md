# Chat with your data

The Chat tab answers questions in plain language by running the same saved connections and
reports that power scheduled refreshes. The model plans; the DataMoov runtime validates,
fetches, aggregates, writes and charts. There is still no DataMoov server: the only new
network destination is the AI provider you configure.

## Setup

1. Open **Extensions → DataMoov → Open DataMoov**, choose **Settings** (the Chat tab points
   there until a key is saved).
2. Under **AI provider** pick Anthropic, OpenAI or Google Gemini, paste an API key from your
   own account, keep or change the model name, then **Save** and **Test**. The card collapses
   once configured; the gear in the Chat tab reopens it. The key is stored in
   your private script properties and is never shown again; leave the field blank when
   editing to keep it. The **Create a key** link opens the provider's key page.
   **Maximum rows per chat report** sets the default and ceiling for each fetched report,
   from 1 to 20,000 rows (initially 1,000). The model can request fewer rows; it cannot exceed
   your setting. Increase it if a complete report reaches the limit.
   **Instructions for the assistant** supplies general standing context. **Source instructions**
   lets you save separate rules for each connector, such as campaign naming conventions,
   attribution or SQL table guidance. General and all source instructions share a 100,000-character
   budget, with a live counter. Source rules are included once for each source with a saved
   connection. Settings remain private; long instructions are compressed into bounded pieces,
   and a new version replaces the old pointer only after every piece has been saved.
3. Add at least one connection in **Connections**. The chat uses your own private connections;
   sharing or copying report definitions does not supply another user's connection or credentials.

Usage is billed by the AI provider to your key. A question typically costs a few model calls
plus one report fetch.

## What the chat can do

- **Answer with numbers**: "How much did we spend on Google Ads last month?"
- **Rank and compare**: "Which campaign had the highest cost per conversion in the last 30
  days?", "Compare TikTok spend this month with last month."
- **Write tables**: "Put daily GA4 sessions for September in a new tab called Sessions."
- **Chart**: "Chart weekly spend by campaign" adds a native Sheets chart beside the table.
- **Use existing tabs**: "Summarize the Orders tab by month" reads your own data (header row
  plus up to 500 rows × 30 columns).
- **SQL sources**: for PostgreSQL, BigQuery and Snowflake the model first calls `describe_database`,
  which lists the tables and columns of the schemas or datasets you chose on the connection
  (**Schemas for chat**, default `public`; **Datasets for chat** as `project.dataset`), then
  writes one read-only SELECT against those names. The same SQL guard as saved reports
  applies, and the database role should be read-only. Keep the scope small to keep the
  model to the point.
- **Ask when unsure**: if "revenue" could mean three things, it asks and shows the choices
  as buttons.

While a turn runs, live activity shows the actual actions: fetching reports, reading a sheet,
combining results, summarizing data, writing a table or creating a chart. When the answer arrives,
**Actions** stays open below it when **Show completed actions (debug)** is enabled in Settings
(the default). Turn it off to hide successful histories. Failures and completed sheet updates
remain visible, with details available. The **+** button starts a new chat.
Answers render bold and italic text, lists, headings, tables, links and code; raw HTML and images
are not executed or loaded.

For example: **"Create a new tab called Monthly winners with the highest-spend campaign in each
month, including spend, clicks and impressions."** The runtime aggregates all fetched daily rows
by month and campaign, then ranks within each month. It can instead read an existing tab and use
those rows. Currencies stay separate. Ranking selects whole aggregated rows, so the campaign name,
spend and accompanying metrics stay together. Results are cached privately for follow-up questions;
the complete source data does not need to be written to a scratch tab first.

## Editing existing sheets

Ask directly, for example: "Make the header bold, format column C as percentages and freeze the
first row", "Sort A1:F100 by spend descending", or "Put =SUM(B2:B20) in B21". Chat can list tabs,
inspect a range, replace literal cell values, enter supported formulas, format cells, sort a range,
add a basic filter, freeze rows or columns, and create or rename tabs.

Each edit is limited to an explicit range of at most 1,000 cells, 200 rows and 30 columns. Chat
inspects that range first; a private token binds the edit to the exact user, spreadsheet, tab,
range and inspected contents/formatting for five minutes. The tool checks again under the shared
write lock and applies one atomic batch. If the sheet changed, chat must inspect it again.
Report output continues to use its existing protected writer. Editing report values yourself or
through chat makes the next refresh stop until the report is moved to a fresh output area.

Formula support covers common scalar built-ins such as SUM, COUNTIF, AVERAGE, ROUND and IF using
same-tab cell references. Arbitrary script code, external-data functions, custom functions, named
ranges, references to other tabs and formulas that spill arrays are not supported. Dependencies
are checked too. Literal values beginning with = stay text. Internal report settings remain
excluded. Tab deletion is not exposed; a tab used by a saved report or dashboard must have its saved
destination updated before it can be renamed.

### Native pivot tables

Ask, for example: "Create a pivot of Marketing data with campaign as rows and summed clicks as values."
Chat creates a real Sheets pivot in a new tab, using an explicit source range with headers, up to
20,000 data rows and 80 columns. It validates the requested fields and numeric aggregates first.
The range may include future blank rows within the existing sheet grid, so later values inside
that range participate automatically. Data outside it requires a larger source range.
Native date grouping requires actual Sheets date cells; ISO dates written as text cannot be
passed as native date groups. An already prepared month column can be an ordinary pivot group.

## Saved multi-source dashboards

A report imports one source into a table. A saved dashboard combines 2 to 8 source queries,
normalizes matching fields, and produces two outputs: combined source data and an aggregated
report. Both use the same report runtime. Create the dashboard directly in Chat; no separate
saved reports are required first.

For example: **"Create a monthly Google Ads and Facebook performance dashboard, with spend,
clicks and impressions by campaign. Save the combined data in Marketing data, put the summary
and a chart in Marketing dashboard, and make it refreshable."** Chat saves the queries,
dates, column mappings, grouping and ranking rules, then runs the dashboard. It explains the
sources, where it wrote each output and how to refresh it. Charts and optional formatting are
created separately from the two-table write.

The saved card appears under **Reports > Dashboards**. **Refresh dashboard** fetches every source
again and rebuilds both tabs without an AI call or cached chat rows. Its status shows the current
source, combination, summary and write phases. The card also shows sources, output tab names,
last refresh, row counts and failures. **Create in chat** opens a draft request you can edit.
Removing the saved setup preserves its existing tabs.

Refresh uses each query's saved row limit and resolves relative date presets again. Invoking
refresh through Chat also checks the current chat row cap; the sidebar uses the saved limits.
The complete combined result is limited to 20,000 rows and one approximately 200-second run;
there is no continuation or schedule for dashboards yet. Currency totals stay separate.
Source or destination failure preserves both previous outputs: every source and both write
areas must pass validation before the single Sheets batch runs. Editing table values prevents
an overwrite on refresh. Native charts remain in the sheet; refresh reapplies standard table header and number formats.
Charts created with includeFutureRows follow newly added rows in their selected columns. Native pivots retain their
explicit source range. Changing a saved column layout may require updating its charts or pivots.

Plans, connection references and refresh state stay in the creator's private Google properties,
scoped to this spreadsheet. They do not contain provider credentials and are not shared or copied
with the workbook. Their output tables remain visible to spreadsheet collaborators. Single-source
report definitions continue to use the shared hidden DataMoovReports tab.

## What the model sees

- The catalog: your connection labels and ids, non-secret connection values (account or
  property ids, chat schemas or datasets), the reports with their fields, the spreadsheet's
  tab names and timezone, and your saved instructions.
- Tool results: column descriptors, row counts, per-column statistics and a few sample rows
  (the first five and last three). Small results (20 rows or fewer) are returned whole.
  Summaries follow the same sampling rule. The requested summary limit controls the complete
  aggregate stored privately and available for writing; it does not send large tables to the model.
- Data you read with **read_sheet** is sampled the same way.

Provider credentials and AI keys are not included in model messages. Large results are
sampled; results of 20 rows or fewer may be sent whole. Your prompts, conversation context,
saved instructions and the metadata described above also go to the chosen AI provider.
Values that come back from providers are framed as data, not instructions.

## Guarantees

- Every fetch goes through the report runtime: your configured chat row cap (initially 1,000,
  at most 20,000), column caps, deadline and host allowlists. Reports fail instead
  of truncating.
- Report writes go through the report writer: only empty cells, or cells the chat wrote earlier at
  the same anchor and that were not edited since, are ever replaced. Formulas and manual edits
  stop a rewrite.
- Charts are native Sheets charts over the written table; delete them like any chart.
- A turn is bounded: at most 8 tool rounds and roughly 200 seconds, and every tool in the
  turn shares that one deadline (a report started late in the turn stops at the deadline
  instead of getting its own). When the budget runs out the model answers from what it has
  and says what is missing.
- If the AI provider fails after a tool already wrote to the sheet, the answer says so and
  lists the completed steps; nothing that happened is hidden.
- Results are staged in your private user cache for one hour. Each answer's activity lines
  carry the result ids into the next turn, so "now chart that" reuses the cached result
  instead of running the report again; after an hour the chat runs it again.
- Metrics that cannot be added across rows (user counts, reach, rates, averages) are marked
  as such; the chat offers no total for them and `summarize` refuses to sum them.
- Text read from your own tabs is kept whole when written elsewhere; only the samples shown
  to the model are shortened.
- The hidden `DataMoovReports` configuration tab is excluded from chat tab listings and
  cannot be read, written or charted through chat tools. Manage shared definitions through
  **Reports > Manage report definitions** in the sidebar. See
  [report storage](report-storage.md).

## Tools (for developers)

| Tool | Purpose |
| --- | --- |
| `run_report` | Run a report of a saved connection; returns a `resultId`, columns, row count, statistics and samples |
| `discover_fields` | Account-specific fields (GA4 custom definitions, HubSpot/Zendesk properties, SQL result columns), with a `search` filter |
| `describe_database` | Tables and columns of the schemas/datasets a SQL connection scoped for chat, with a `search` filter on table names |
| `combine_results` | Append complete fetched results with matching column maps and a source label; preserves currency and source caveats |
| `summarize` | Group, filter, aggregate and sort a result server-side; rankWithin and limitPerGroup select top rows separately per month or other group; rates and averages cannot be summed |
| `write_to_sheet` | Write a result as a formatted table through the protected writer |
| `read_sheet` | Read a tab into a result |
| `create_chart` | Add a line, column, bar, area, scatter or pie chart over a written table |
| `ask_user` | Ask one clarifying question with up to six options; ends the turn |
| `list_sheets` | List ordinary tabs and grid sizes |
| `inspect_sheet` | Inspect a bounded range and issue a private, short-lived edit token |
| `edit_sheet` | Apply validated values, scalar formulas, formatting, sorting, filters, freeze panes, or tab creation/rename |
| `create_pivot` | Create a native pivot on a new tab from a validated source range |
| `list_dashboards` | List private saved dashboards for this spreadsheet |
| `save_dashboard` | Save source queries, mappings, aggregation rules and two output destinations |
| `run_dashboard` | Fetch fresh source data and atomically refresh both saved outputs |

Providers are adapted in `src/dmv_ai.js`: Anthropic Messages API, OpenAI Chat Completions
and Gemini `generateContent`, each with its own tool-call format, normalized to one shape for
the loop in `src/dmv_chat.js`. Tool implementations live in `src/dmv_chat_tools.js`, `src/dmv_chat_sheets.js`,
`src/dmv_chat_pivots.js` and `src/dmv_chat_dashboards.js`. Saved refresh plans execute in
`src/dmv_dashboards.js`.

Offline tests (`tests/chat.test.mjs`) drive the loop with scripted provider replies through an
arbitrary test connector and assert that provider secrets and the AI key never appear in a
request body, that tool errors teach (unknown columns list the real ones), that `ask_user`
skips the rest of its round, and that the budget path disables tools for the final answer.
They do not certify any provider's live behavior or pricing.

### Multi-platform comparisons

Chat can use `combine_results` to append fetched reports with explicit matching column maps and a source label per platform/account, then `summarize` by week or campaign. It never invents rows or exchanges currencies. Currency is required for combined monetary results, and mixed currencies cannot be aggregated without grouping or filtering by currency. Weekly buckets start Monday and include only dates inside the requested range; the first and last buckets of a month may be partial weeks. Google Ads already includes YouTube campaigns, so a YouTube subset is not an additional platform total. GA4 acquisition metrics are not substituted for advertising clicks or spend. Full summaries support up to 20,000 groups within the shared row and size limits.
