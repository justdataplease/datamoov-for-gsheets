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
   from 1 to 20,000 rows (initially 10,000). The model can request fewer rows; it cannot exceed
   your setting. Increase it if a complete report reaches the limit.
   **Instructions for the assistant** supplies general standing context.
3. Add at least one connection in **Connections**. To set account-specific rules, fill
   **Chat instructions** in the connection form; the form's one **Save** button saves them.
   Rules can describe campaign naming, attribution or SQL tables for that particular connection;
   two accounts on the same platform can have different rules. General and connection instructions
   share a 100,000-character limit, shown by the live counters.
   Earlier source-wide instructions remain inherited defaults until a connection saves its own
   rules. The editor shows the inherited text; migrating one account keeps the defaults for the
   others. Remaining legacy defaults count toward the same limit.
   Instructions stay in private Google properties and are sent to your chosen AI provider as
   context. Long instructions are compressed into bounded pieces; a new version becomes active
   only after every piece has been saved and read back successfully. Existing compressed instructions
   remain readable without resetting the API key or connection rules. The chat uses your own private
   connections; sharing or copying the spreadsheet does not supply another user's connection or credentials.

Usage is billed by the AI provider to your key. A question uses model calls plus any required
source fetches; multi-account and period comparisons can require several fetches.

## What the chat can do

- **Answer with numbers**: "How much did we spend on Google Ads last month?"
- **Rank and compare**: "Which campaign had the highest cost per conversion in the last 30
  days?", "Compare TikTok spend this month with last month."
- **Write tables**: "Put daily GA4 sessions for September in a new tab called Sessions."
- **Chart**: "Chart weekly spend by campaign" adds a native Sheets chart beside the table.
- **Use existing tabs**: "Summarize the Orders tab by month" reads your own data (header row
  plus up to 500 rows × 30 columns).
- **Any Google Ads resource**: beyond daily campaign performance, the **Custom query (GAQL)**
  report lets chat read ad groups, ads, keywords, search terms, negative keywords, asset groups,
  geography or account totals with one GAQL query. `discover_fields` lists the resources and the
  fields each one supports. The report date range is applied whenever the query selects metrics.
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

## Dashboards

A report imports one source into a table. A **dashboard** is what you ask Chat for when you want
to *see* performance: it fetches 1 to 6 datasets, writes each to its own tab, and builds one
**Dashboard** tab with scorecards on top, native Sheets charts below them, then the data sources
and any tables. The numbers behind the charts go to a hidden **(chart data)** tab. You do not
create reports first; the dashboard carries its own queries.

For example: **"Create a performance dashboard for Google Ads and Facebook Ads for the last 3
months, every week."** Chat saves the plan and runs it once. You get:

- **Google Ads Data**, **Facebook Ads Data** (one tab per dataset). The first rows say where the
  data came from: dataset, source, connection, report, date range, row count and refresh time.
  The table starts on row 4.
- **Performance Dashboard**: the title and refresh time, scorecards (spend, clicks, conversions),
  charts such as weekly spend by platform and top campaigns, and a **Data sources** table that
  lists every dataset with its date range, rows and tab.
- **Performance Dashboard (chart data)**, hidden: the small table each chart reads. Every refresh
  rewrites these tables and points each chart at the new range, so a period that grows ("this
  month", "until today") adds points to the chart instead of being cut off. Unhide the tab from
  the Sheets tab menu to check a chart's numbers.

Datasets can be different subjects, not only the same report from several accounts. With the
Google Ads **Custom query (GAQL)** report one dashboard can hold campaigns, ad groups, keywords,
search terms and negative keywords, each on its own tab, with charts drawn from any of them.
Charts that compare platforms read several datasets together; Chat gives their columns shared
names (date, spend, clicks) so Google's cost and Facebook's spend line up.

The answer in Chat lists what was fetched, links to every tab, and repeats the scorecard values.
The saved card appears under **Reports > Dashboards** with a link per tab and the rows of the
last refresh. **Refresh dashboard** fetches every dataset again and rebuilds every tab, scorecard
and chart from the saved plan: no AI call, no AI key needed. Charts the dashboard created are
updated in place, so a chart you moved or resized stays where you put it; one you deleted comes
back. **Create in chat** opens a draft request you can edit. **Remove** deletes the saved plan
together with the tabs the dashboard created (the dataset tabs, the Dashboard tab and the hidden
chart data tab) after listing them for confirmation. Tabs you made yourself are never touched.

A request such as **"Create a marketing performance week vs previous period"** follows the same
workflow, including after you answer a source-selection question. It saves two datasets per
account, `lastWeek` and `previousWeek` (the last completed Monday-to-Sunday week and the one
before, in the spreadsheet timezone), so three accounts use six datasets and both weeks advance
on refresh. A trend request saves one dataset per account for the whole period (`last90` for the
last 3 months) and the charts group it by week or month. A simple question about spend remains an
analysis unless you ask for a dashboard.

Limits and guarantees:

- 1 to 6 datasets and up to 12 tiles (scorecard groups, charts, tables), at least one chart.
  Charts keep up to 12 series; by default 400 dates or 15 categories, tables 50 rows (1,000 at
  most). A shortened tile says so in its title, for example "top 15 of 129".
- Datasets together hold at most 20,000 rows, and the whole refresh is one roughly 200-second run
  written in one Sheets request; there is no continuation or schedule for dashboards yet. Keep
  datasets lean: a custom query without `segments.date` returns totals for the period instead of
  one row per day.
- Each dataset uses the higher of its saved row limit and your current **Maximum rows per chat
  report**, so raising the setting also fixes dashboards saved earlier. A dataset that fails is
  named in the error, with the limit it used.
- Every dataset and every tab must pass validation before anything is written. A failed source
  or an occupied destination leaves all previous tabs and charts unchanged.
- A dashboard writes to tabs of its own. A tab name that already holds content is refused when
  the plan is saved, before anything is fetched, and the message names the tab and suggests a
  free name.
- Money in different currencies is never added: scorecards and chart series split by currency.
  Rates and averages cannot be summed.
- The tabs belong to the dashboard. Editing values inside its tables, or typing into the blank
  rows reserved under the charts, stops the next refresh until the edit is undone; put your own
  notes on another tab. Formatting you add is reset on refresh.
- Relative date presets resolve again on every refresh, all at one local date; fixed dates stay
  fixed.

Plans, connection references and refresh state stay in the creator's private Google properties,
scoped to this spreadsheet. Plans are stored compressed, contain no provider credentials and are
not shared or copied with the workbook. Their output tabs remain visible to spreadsheet
collaborators, provenance rows included, so anyone can see what fed each number. Dashboards saved
before datasets and tiles existed are listed with a note to remove and recreate them.

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

- Every fetch goes through the report runtime: your configured chat row cap (initially 10,000,
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
- Within one turn, repeated `run_report` requests reuse a complete result only when the validated
  configuration, selected fields, resolved dates and connection/credential revisions match.
  **Reused** appears in Actions. A lower requested row cap still applies; results are never
  truncated to fit. A new turn or changed query fetches again. Dashboard refresh always fetches
  fresh sources.
- Results are staged in your private user cache for one hour. Each answer's activity lines
  carry the result ids into the next turn, so "now chart that" reuses the cached result
  instead of running the report again; after an hour the chat runs it again.
- Metrics that cannot be added across rows (user counts, reach, rates, averages) are marked
  as such; the chat offers no total for them and `summarize` refuses to sum them.
- Text read from your own tabs is kept whole when written elsewhere; only the samples shown
  to the model are shortened.

## Tools (for developers)

| Tool | Purpose |
| --- | --- |
| `run_report` | Run a report of a saved connection; reuse exact complete queries within the turn; return a `resultId`, columns, row count, statistics and samples |
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
| `save_dashboard` | Save a plan: datasets (a query, a tab and optional shared column names each) and tiles (kpi, chart or table over one or more datasets) plus the dashboard tab |
| `run_dashboard` | Fetch every dataset and atomically rebuild all tabs, scorecards, charts and tables; return scorecard values, tile row counts and tab links |

Providers are adapted in `src/dmv_ai.js`: Anthropic Messages API, OpenAI Chat Completions
and Gemini `generateContent`, each with its own tool-call format, normalized to one shape for
the loop in `src/dmv_chat.js`. Tool implementations live in `src/dmv_chat_tools.js`, `src/dmv_chat_sheets.js`,
`src/dmv_chat_pivots.js` and `src/dmv_chat_dashboards.js`. Saved dashboard plans execute in
`src/dmv_dashboards.js`, which lays out the dashboard tab and builds its charts itself.

Offline tests (`tests/chat.test.mjs`) drive the loop with scripted provider replies through an
arbitrary test connector and assert that provider secrets and the AI key never appear in a
request body, that tool errors teach (unknown columns list the real ones), that `ask_user`
skips the rest of its round, and that the budget path disables tools for the final answer.
They do not certify any provider's live behavior or pricing.

### Multi-platform comparisons

Chat can use `combine_results` to append fetched reports with explicit matching column maps and a source label per platform/account, then `summarize` by week or campaign. It never invents rows or exchanges currencies. Currency is required for combined monetary results, and mixed currencies cannot be aggregated without grouping or filtering by currency. Weekly buckets start Monday and include only dates inside the requested range; the first and last buckets of a month may be partial weeks. Google Ads already includes YouTube campaigns, so a YouTube subset is not an additional platform total. GA4 acquisition metrics are not substituted for advertising clicks or spend. Full summaries support up to 20,000 groups within the shared row and size limits.
