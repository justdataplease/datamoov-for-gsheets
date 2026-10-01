# Chat with your data

The Chat tab answers questions in plain language by running the same saved connections and
reports that power scheduled refreshes. The model plans; the DataMoov runtime validates,
fetches, aggregates, writes and charts. There is still no DataMoov server: the only new
network destination is the AI provider you configure.

## Setup

1. Open **Extensions → DataMoov → Open**, choose **Settings** (the Chat tab points
   there until a key is saved).
2. Under **AI provider** pick Anthropic, OpenAI or Google Gemini, paste an API key from your
   own account, keep or change the model name, then **Test** and **Save**. The model field starts
   at the provider's default, shown under the field; **Use default** puts it back, and switching
   provider swaps a default model for the new provider's but keeps a name you typed. **Test**
   checks what the form holds without saving it: it asks the provider whether the model exists,
   then sends a one-word request to prove it answers. An unknown model shows **Model not found**
   with up to six similar models from your provider's list; click one to use it. Test sends a
   saved key only to the provider it was saved for. The card collapses
   once configured; the gear in the Chat tab reopens it. The key is stored in
   your private script properties and is never shown again; leave the field blank when
   editing to keep it. The **Create a key** link opens the provider's key page.
   **Maximum rows per chat report** sets the default and ceiling for each fetched report,
   from 1 to 30,000 rows (initially 10,000). The model can request fewer rows; it cannot exceed
   your setting. Increase it if a complete report reaches the limit. The 30,000-row ceiling is
   deliberate: each dashboard is written in one all-or-nothing Sheets request, which a few huge
   tabs would overflow, so a long list keeps its top rows instead (see
   [Action lists](#action-lists-the-top-rows-labelled)).
   **Time limit per chat request** sets how long one question may work before it answers
   from what it has: 60 to 1,800 seconds (initially 600).
   **Instructions for the assistant** supplies general standing context.
3. Add at least one source in **Sources**. To set account-specific rules, fill
   **Chat instructions** in the source form; the form's one **Save** button saves them.
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
   sources; sharing or copying the spreadsheet does not supply another user's connection or credentials.

In **Chat**, open the **Sources** dropdown to select one or more saved sources before asking.
All available sources are selected initially. The selected source names and report metadata go
to the AI provider; only those sources can be fetched or used for a saved report or dashboard
in that chat turn. Changing the selection starts a new chat. Use **Select all** or **Clear**
for quick changes.

Usage is billed by the AI provider to your key. A question uses model calls plus any required
source fetches; multi-account and period comparisons can require several fetches.

## What the chat can do

- **Answer with numbers**: "How much did we spend on Google Ads last month?"
- **Rank and compare**: "Which campaign had the highest cost per conversion in the last 30
  days?", "Compare LinkedIn spend this month with last month."
- **Write tables**: "Put daily GA4 sessions for September in a new tab called Sessions."
- **Chart**: "Chart weekly spend by campaign" adds a native Sheets chart beside the table.
- **Use existing tabs**: "Summarize the Orders tab by month" reads your own data (header row
  plus up to 500 rows × 30 columns).
- **Facebook Ads below the campaign**: the **Insights** report answers ad set and ad questions,
  weekly or monthly reach, and splits by age, gender, country, platform or placement; the
  selected fields decide the level, the period and the breakdowns.
- **Any Google Ads resource**: beyond daily campaign performance, chat reads keywords with their
  quality scores, search terms and ad asset performance (Low, Good and Best labels) from their
  own ranked reports, which can keep only their top rows by spend, and the **Custom query
  (GAQL)** report lets it read ad groups, ads, negative keywords, asset groups, geography or
  account totals with one GAQL query. `discover_fields` lists the resources and the
  fields each one supports. The report date range is applied whenever the query selects metrics.
- **SQL sources**: for PostgreSQL, BigQuery and Snowflake the model first calls `describe_database`,
  which lists the tables and columns of the schemas or datasets you chose on the connection
  (**Schemas for chat**, default `public`; **Datasets for chat** as `project.dataset`), then
  writes one read-only SELECT against those names. The same SQL guard as saved reports
  applies, and the database role should be read-only. Keep the scope small to keep the
  model to the point. A dashboard list from SQL keeps its top rows with the report's **Keep the
  top rows** and **Rank by column**, never a `LIMIT` (see
  [Action lists](#action-lists-the-top-rows-labelled)).
- **Save a report**: "Create a report of daily GA4 sessions in its own tab" saves a refreshable
  report and runs it once; it appears under **Reports > Drafts** (see [Saved reports and
  drafts](#saved-reports-and-drafts)).
- **Ask when unsure**: if "revenue" could mean three things, it asks and shows the choices
  as buttons.
- **Explain the add-on**: "What can you do?" or "How do I schedule this?" is answered from a
  fixed description of the sidebar and the chat, naming your own connections and the next click.
  Places in the sidebar come back as links that open the right tab. The first chip in an empty
  chat asks exactly this.

While a turn runs, live activity shows the actual actions: fetching reports, reading a sheet,
combining results, summarizing data, writing a table or creating a chart. When the answer arrives,
a collapsed **Actions** line appears below it when **Show completed actions (debug)** is enabled
in Settings (the default); click it to list the steps. Each action is one line; click it to see what the step used (connection, fields,
dates, grouping, range) and the tab it wrote. Turn the setting off to hide successful histories.
Failures and completed sheet updates remain visible, with details available. The **+** button
starts a new chat.
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
30,000 data rows and 80 columns. It validates the requested fields and numeric aggregates first.
The range may include future blank rows within the existing sheet grid, so later values inside
that range participate automatically. Data outside it requires a larger source range.
Native date grouping requires actual Sheets date cells; ISO dates written as text cannot be
passed as native date groups. An already prepared month column can be an ordinary pivot group.

## Dashboards

A report imports one source into a table. A **dashboard** is what you ask Chat for when you want
to *see* performance: it fetches 1 to 8 datasets, writes each to its own tab, and builds one
**Dashboard** tab laid out as a page of cards. The numbers behind the charts go to a hidden
**(chart data)** tab. You do not create reports first; the dashboard carries its own queries.

For example: **"Create a performance dashboard for Google Ads and Facebook Ads for the last 3
months, every week."** Chat saves the plan and runs it once. You get:

- **Google Ads Data**, **Facebook Ads Data** (one tab per dataset). The first rows say where the
  data came from: dataset, source, connection, report, date range, row count and refresh time.
  The table starts on row 4.
- **Performance Dashboard**, placed before its data tabs, from top to bottom:
  - a navy title band with the dashboard name, the period it covers ("1 Sep – 30 Sep 2026") and
    the refresh time, plus the previous period ("vs 1 Aug – 31 Aug 2026") when the dashboard
    compares periods;
  - a row of links that jump to each section below. The band and the links stay in view as you
    scroll;
  - **KPI cards** such as spend, conversions, CPA and ROAS: one large number each and, when there
    is a previous period, its change against the previous value, for example "▲ 12.4% vs 1,234"
    in green, red or grey;
  - **Highlights**: up to six sentences written from the numbers on the page, such as the
    largest changes, the rows a highlight rule flagged, the segment holding most of the spend or
    the top row of a table. They are worked out again on every refresh, without AI;
  - **chart cards**, two per row or one full row for a long trend, with a dashed line for the
    previous period when a trend compares periods. A share by category (spend by channel) is
    drawn as bars, largest first: a Sheets pie takes the workbook theme's colors, and its second
    slice would be the red this page keeps for a bad change;
  - **table cards** with an in-cell bar beside the main amount, blue shading on rate and average
    columns (darker is better, so the lowest CPA is the darkest), a **Δ %** column after each
    metric when the table compares periods, a total row ("Total (top 300)" over a list cut to its
    top rows), and whole rows tinted by highlight rules, with a **Row tints** line under the
    table saying what each tint means;
  - a **Data sources** card listing every dataset with its source, connection, report, date
    range, rows and tab, and the source's note when a list was cut to its top rows ("Top 300 by
    spend");
  - a footer saying how to refresh the dashboard.
- **Performance Dashboard (chart data)**, hidden: the small table each chart reads. Every refresh
  rewrites these tables and points each chart at the new range, so a period that grows ("this
  month", "until today") adds points to the chart instead of being cut off. Unhide the tab from
  the Sheets tab menu to check a chart's numbers.

Datasets can be different subjects, not only the same report from several accounts. One Google
Ads dashboard can hold campaigns, ad groups, keywords with their quality scores, search terms,
ads, negative keywords and ad asset performance (each asset's own clicks, conversions and spend), each on its own
tab, with charts and tables drawn from any of them. Chat takes each subject from the source's
report for it, or from the **Custom query (GAQL)** report when there is none. It builds every
section you ask for this way instead of describing how it could be built; when a request needs
more than eight datasets, it says which section it left out. Charts that compare platforms read
several datasets together; Chat gives their columns shared names (date, spend, clicks) so
Google's cost and Facebook's spend line up.

### Action lists: the top rows, labelled

A list of keywords, search terms, ads, assets, placements, landing pages or products is there to
act on, not to hold every row an account or table has. A whole account's ad asset view alone
returns one row per ad group, ad, asset and field, easily tens of thousands. So Chat builds each
list as a ranked dataset, on every source that can rank one:

- It uses the source's ranked report for the subject with **Keep the top rows** set: 300 unless
  you ask for another number, 1,000 at most. The ranked reports are Google Ads' **Keyword
  performance**, **Search terms** and **Ad assets**, every Microsoft Ads report level except
  account and goals and funnels, Facebook Ads **Insights** and LinkedIn Ads **Analytics**. Each
  ranks the totals for the period by spend, or by impressions when spend is not selected. For
  other Google Ads lists (ads, placements, landing pages) Chat writes a custom query that keeps
  the top n, which Google Ads labels: `ORDER BY metrics.cost_micros DESC LIMIT 300`.
- From PostgreSQL, BigQuery or Snowflake, Chat aggregates the list in the query to one row per
  item and sets **Keep the top rows** with **Rank by column**, a column of the query's result
  such as `revenue`: the report keeps the rows with that column's highest values and labels the
  cut ("Top 300 by revenue"). Chat never writes a `LIMIT` into a dashboard's SQL, because the
  rows a `LIMIT` drops would go unmentioned. A SQL dataset that feeds totals aggregates and has
  neither setting.
- The condition that makes a row worth acting on goes into the query or a tile filter: spend
  with no conversions, a low CTR over plenty of impressions.
- The dataset has no date column, so each row covers the whole period.
- A top-N dataset never feeds KPI totals or shares; those read complete datasets such as the
  campaign or account totals.

A list cut to its top rows says so wherever it appears: the **Data sources** card shows the
source's note ("Top 300 by spend"), a card that reads the list carries "top 300 by spend" beside
its title, its table's total row reads "Total (top 300)" ("top 300 each" over several such
lists, "top rows" when their tops differ or the table also reads a complete dataset), and a
highlight about a share says it is a share of the top rows ("Brand holds 40% of the top 300").
Should a KPI card read one anyway, its label says so: "Spend (AED, top 300)". A Google Ads
custom query's own `LIMIT` is labelled the same way when it returns exactly that many rows: "Top
100 by spend" after `ORDER BY metrics.cost_micros DESC`, "Lowest 100 by CTR" after an ascending
metric, "First 100 rows (query LIMIT)" without an `ORDER BY`; the totals and cards then read
"lowest 100" or "first 100", never "top". A list shorter than its top is the whole list and
carries no label. A cut is never silent: a Google Ads or Microsoft Ads level left without a top
keeps the row limit's worth of rows by spend and says so ("Top 10,000 rows by spend"); other
reports without a top, those levels without spend, and any report split by a period column
such as Date, Week, Month or Hour of day (a trend, which **Keep the top rows** refuses, naming
the column) fail at the row limit like any other report. A top above the report's row limit
is refused with both numbers.

A dataset over the row limit fails with its name and what narrows it: the report's **Keep the
top rows**, a condition or aggregation in the query, or fewer dimensions; raising **Maximum rows
per chat report** comes last. A dashboard too large for one Sheets write names its largest
tabs with their rows and columns. A setting Chat puts on a report that does not have it (a top
on a custom query) is refused with the report's own settings instead of being dropped, so the
same query is never run again unchanged.

### Comparing with the previous period

A performance dashboard compares with the previous period unless you ask otherwise. For each
account Chat adds a small dataset holding only the totals the KPI cards need, for the period just
before the current one: `previous7`, `previous14`, `previous30` or `previous90` before `last7`,
`last14`, `last30` or `last90`; `previousWeek` before `lastWeek`; `previousMonth` before
`lastMonth`; and a custom range of the same length before a custom range. Both periods move
together on every refresh. One group of KPI cards reads the current and previous datasets of every
account, so each card shows the total and its change. Trend charts and tables can compare too
when their previous dataset has the same date or grouping columns. The previous-period datasets
(the side of a comparison marked previous, and any dataset with a `previous` preset) feed only
the tiles that compare; every other tile reads the current period alone, so the two periods are
never added together. A compared tile without its own dataset list reads its two compare lists.
`yesterday`, `thisMonth`, `thisYear` and `lastYear` have no previous preset, so a dashboard
over one of them is not compared.

So **"Create a marketing performance week vs previous period"** for three accounts saves six
datasets, `lastWeek` and `previousWeek` for each (the last completed Monday-to-Sunday week and the
one before, in the spreadsheet timezone), and every card shows the week's value and its change
against the week before. A trend request saves one dataset per account for the whole period
(`last90` for the last 3 months) and the charts group it by week or month. A simple question about
spend remains an analysis unless you ask for a dashboard.

Each previous dataset must cover the period just before its current one, with as many days, or
as many whole calendar months when both are whole months (a month to date is not). Relative
periods move with the refresh day, so the save checks every refresh day of the coming year before
anything is fetched: `last7` against `previousWeek` lines up on Mondays only and is refused, with
the first day it would fail.
A compared trend lines up the two periods by their own days, the first week of this period over
the first week of the last. When the previous period is longer (31 days before 30), its extra
days are left out and the card says so: "vs 1 Aug – 30 Aug 2026 (same days)". A compared table
groups by names such as campaigns or channels, not by dates, and matches each row with the same
names in the previous period.

Whether a rise is good depends on the metric. Chat marks cost-per metrics such as CPA, CPC and CPM
as lower-is-better, so their rise shows as a red ▲, and spend, cost and budget as neutral, shown
in grey; names the tiles do not show are dropped. Every other rise is green. A dashboard saved before changes had colors keeps them grey
until Chat saves it again.

### Highlight rules

Ask for rows to be flagged, for example **"highlight campaigns whose CPA is more than 150% of the
overall CPA in light red and campaigns with more than 50 conversions in light green"**. Chat turns
this into up to four rules per table, each a column, a comparison and either a fixed value or a
multiple of the table's total (1.5 × the overall CPA), with the color red, green or amber. A rule
can also match the text of a column the table is grouped by: equal to, not equal to, containing,
or one of several values, so **"flag broad match keywords"** tints the rows whose match type is
Broad. Weak assets are flagged by their numbers (CTR below half the overall, spend without
conversions): Google no longer fills its performance label for Search and Display assets. The
first matching rule tints the whole row. A rule against the total stays meaningful as the
numbers change. The **Row tints** line under the table names each rule with the threshold it
used on this refresh ("CPA > 1.5× overall (AED 1,734)"), and the Highlights card says how many rows
each rule matched.

### What a spreadsheet dashboard cannot do

Date range pickers and dropdown filters do not exist in Sheets. The period is the dataset's date
preset; ask Chat to change it ("make it the last 90 days"). A segment such as one campaign type
becomes its own chart or table, or a filter on a tile. When a request asks for such a control,
Chat builds the closest equivalent and says so in one sentence.

The answer in Chat quotes the Highlights, adds a few findings with their numbers and the action
each suggests, and links to every tab.
The saved card appears under **Reports > Dashboards > Drafts** with a link per tab and the rows of
the last refresh; a schedule asked for in the request ("refresh it daily at 8") saves it under
**Saved** instead. See [Saved reports and drafts](#saved-reports-and-drafts). **Refresh dashboard**
fetches every dataset again and rebuilds every tab, card and chart from the saved plan: no AI
call, no AI key needed. Charts the dashboard created are updated in place and set back on their
card, so a chart you moved or resized returns to its place; one you deleted comes back. **Create
in chat** opens a draft request you can edit. **Remove** deletes the saved plan together with the
tabs the dashboard created (the dataset tabs, the Dashboard tab and the hidden chart data tab)
after listing them for confirmation. Tabs you made yourself are never touched.

Limits and guarantees:

- 1 to 8 datasets and up to 12 tiles (KPI groups, charts, tables), at least one chart.
  A tile can restrict its rows with filters (Brand campaigns only, one country) and show
  ratios such as CPC, CTR, CPA or ROAS, computed from the summed counts of each group rather
  than by averaging a rate column. A chart can stack its series, draw a rate on a right axis
  (as a line on a column chart) and take a whole row. Chat draws one measure per chart, or a
  volume with a rate on the right axis; a chart whose values differ twentyfold or more moves the
  smaller ones to the right axis, so conversions never lie flat under spend.
  Charts keep up to 12 series; by default 400 dates or 15 categories, tables 50 rows (1,000 at
  most). A shortened tile says so beside its title, for example "top 15 of 129".
- Datasets together hold at most 30,000 rows, and the whole refresh is one roughly 200-second run
  written in one all-or-nothing Sheets request (at most 8,000,000 characters of values and
  formats); there is no continuation for dashboards. Keep datasets lean: a dataset without a date
  column (a custom query without `segments.date`) returns totals for the period instead of one
  row per day, and a list keeps its top rows.
- A refresh too large for that one request stops before anything is written: "This dashboard is
  too large for one Sheets write", followed by its largest parts with their size, for example
  "Largest parts: Google Ads assets (9,412 rows x 11 columns), Google Ads keywords (2,869 rows x
  9 columns)", and how to keep only the rows worth acting on in them. Chat narrows the dataset
  named first (its top rows, fewer fields, no date column) and runs the dashboard again.
- A dashboard can refresh itself every hour, daily or weekly at a chosen hour (and weekday) of
  the spreadsheet's day: pick them on its card under **Reports > Dashboards**, or ask Chat for it
  when creating the dashboard ("refresh it daily at 8"). Scheduled refreshes run in the background
  from your own account within the hour after the chosen time, one dashboard per hourly tick, and
  never call AI.
- Each dataset uses the higher of its saved row limit and your current **Maximum rows per chat
  report**, so raising the setting also fixes dashboards saved earlier. A dataset over its limit
  is named in the error, with the limit it used and what to try first: keep only the rows worth
  acting on (a ranked report's **Keep the top rows**, with **Rank by column** for SQL, or a
  Google Ads query that orders by a metric and keeps the top n), put conditions in the query, or
  use fewer dimensions; the row limit comes after
  that. Chat does the same when it meets the error: it narrows the named dataset and runs the
  dashboard again, and suggests a higher limit only when the narrowed dataset still needs one.
- Every dataset and every tab must pass validation before anything is written. A failed source
  or an occupied destination leaves all previous tabs and charts unchanged.
- A dashboard writes to tabs of its own. A tab name that already holds content is refused when
  the plan is saved, before anything is fetched, and the message names the tab and suggests a
  free name.
- Money in different currencies is never added: KPI cards, totals and chart series split by
  currency. Rates and averages cannot be summed.
- The tabs belong to the dashboard. Editing values inside its cards and tables, or typing into
  the rows the charts sit on, stops the next refresh until the edit is undone; put your own notes
  on another tab. Cells hold plain values, never formulas. Formatting and layout changes on the
  Dashboard tab (colors, column widths, row heights, merged cells, chart positions) are reset on
  every refresh.
- Relative date presets resolve again on every refresh, all at one local date; fixed dates stay
  fixed.

Plans, connection references and refresh state stay in the creator's private Google properties,
scoped to this spreadsheet. Plans are stored compressed, contain no provider credentials and are
not shared or copied with the workbook. Their output tabs remain visible to spreadsheet
collaborators, provenance rows included, so anyone can see what fed each number. Dashboards saved
before datasets and tiles existed are listed with a note to remove and recreate them.

## Saved reports and drafts

Chat can save a single-source report the same way the form does: **"Create a report of daily
campaign cost for the last 30 days"** calls `list_reports`, then `save_report` with the connection,
report, fields, dates, a name and a tab. The report is validated, stored and run through the
ordinary report runtime, so it refreshes from its card, can be edited in the form and follows every
report guarantee. A plain request for data in a tab ("put daily sessions in a tab") stays a one-off
write with no card, and a question stays an answer.

Everything Chat saves, reports and dashboards alike, lands under **Drafts**:

- The Reports tab shows **Saved** and **Drafts** for reports and again for dashboards. Each group is
  collapsible and open by default; an empty Drafts group is hidden.
- A draft can be run or refreshed by hand, edited and removed, but not scheduled. Its card shows
  a **Draft** badge, a **Save** button and "save to schedule" in place of the schedule.
- **Save** moves the card to Saved and unlocks the schedule. Editing a draft report in the form and
  saving it does the same. Chat editing a saved item never turns it back into a draft.
- A schedule asked for in chat ("every morning at 8") saves the item outright with that schedule.
  Chat never sets a schedule you did not ask for.
- **Remove** on a report deletes the card and keeps the tab; on a dashboard it deletes the card and
  the tabs the dashboard created.

Under every answer that saved something the sidebar adds one fixed line, for example "Saved as a
draft under Reports > Dashboards > Drafts. Save it to keep it and schedule refreshes, or remove it
to delete its tabs." with an **Open the dashboard** button that opens the Reports tab and outlines
the card. Chat-created cards say "from Chat" in their subtitle.

## What the model sees

- The catalog: your connection labels and ids, non-secret connection values (account or
  property ids, chat schemas or datasets), the reports with their fields (listed once per source;
  its other connections refer to the first), the spreadsheet's tab names and timezone, and your
  saved instructions. The tools' `config` lists only the settings of the selected sources'
  reports, each wording once with the reports that share it.
- A fixed description of what the sidebar and the chat can and cannot do, with your connection
  labels and the current row limit filled in.
- Tool results: column descriptors, row counts, per-column statistics and a few sample rows
  (the first five and last three). Small results (20 rows or fewer) are returned whole.
  Summaries follow the same sampling rule. The requested summary limit controls the complete
  aggregate stored privately and available for writing; it does not send large tables to the model.
- Data you read with **read_sheet** is sampled the same way.
- After a dashboard refresh: the scorecard values, the Highlights sentences and a preview of each
  chart and table (its first five rows, or the latest five points of a trend, eight columns at
  most, within a fixed size per tile), so the answer can quote the Highlights and state findings
  from what the dashboard shows.

Provider credentials and AI keys are not included in model messages. Large results are
sampled; results of 20 rows or fewer may be sent whole. Your prompts, conversation context,
saved instructions and the metadata described above also go to the chosen AI provider.
Values that come back from providers are framed as data, not instructions.

## Guarantees

- Every fetch goes through the report runtime: your configured chat row cap (initially 10,000,
  at most 30,000), column caps, deadline and host allowlists. Reports fail instead
  of truncating. The only cuts are a ranked report's top rows (its **Keep the top rows**, ranked
  by spend, impressions or a SQL report's **Rank by column**, or a Google Ads or Microsoft Ads
  level's row limit's worth by spend when that is blank) and the `LIMIT` of a custom query whose
  source labels it (Google Ads), each labelled wherever its rows appear. A SQL query has a
  `LIMIT` only for a top N you asked for in a one-off answer; a dashboard's SQL list keeps its
  top rows through **Keep the top rows** and **Rank by column** instead.
- Report writes go through the report writer: only empty cells, or cells the chat wrote earlier at
  the same anchor and that were not edited since, are ever replaced. Formulas and manual edits
  stop a rewrite.
- Charts are native Sheets charts over the written table; delete them like any chart.
- A turn is bounded by **Time limit per chat request** (initially 600 seconds) and by 8 tool
  rounds per 200 seconds of that limit. Apps Script stops any single execution at 6 minutes,
  so each execution works for about 200 seconds, and every tool in it shares that deadline (a
  report started late stops at the deadline instead of getting its own). When an execution
  runs low and time remains, the conversation is saved compressed in your private cache for
  15 minutes, and the sidebar continues it at once in a new execution; the saved state is
  removed as it is picked up, so no step runs twice, and it never holds the AI key. Keep the
  sidebar open until the answer arrives. The request keeps the provider, model and limit it
  started with, and Settings cannot be saved until it answers. A request holding a result too
  large for the cache (about 900,000 characters), or whose state cannot be saved, finishes
  within its current execution instead. When the limit runs out the model answers from what
  it has and says what is missing.
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
| `summarize` | Group, filter, aggregate and sort a result server-side; ratios (CPC, CTR, CPA, ROAS) divide two per-group sums; rankWithin and limitPerGroup select top rows separately per month or other group; rates and averages cannot be summed |
| `write_to_sheet` | Write a result as a formatted table through the protected writer |
| `read_sheet` | Read a tab into a result |
| `create_chart` | Add a line, column, bar, area, scatter or pie chart over a written table |
| `ask_user` | Ask one clarifying question with up to six options; ends the turn |
| `list_sheets` | List ordinary tabs and grid sizes |
| `inspect_sheet` | Inspect a bounded range and issue a private, short-lived edit token |
| `edit_sheet` | Apply validated values, scalar formulas, formatting, sorting, filters, freeze panes, or tab creation/rename |
| `create_pivot` | Create a native pivot on a new tab from a validated source range |
| `list_dashboards` | List private saved dashboards for this spreadsheet |
| `save_dashboard` | Save a plan: up to 8 datasets (a query, a tab and optional shared column names each), tiles (kpi, chart or table over one or more datasets; `compare` names the current and previous dataset ids, one id or a list each; tables take `highlight` rules with a numeric `value` or an `ofTotal` multiple on a metric, or a text `value` on a groupBy column), the dashboard-level `lowerIsBetter` and `neutral` metric lists, and the dashboard tab |
| `run_dashboard` | Fetch every dataset and atomically rebuild all tabs, cards, charts and tables; return scorecard values, the `highlights` sentences, a short preview of each tile and tab links |
| `list_reports` | List private saved reports (drafts included) with their revisions |
| `save_report` | Save one report query with a name, tab and optional schedule through `dmvSaveReport`, run it once through the report runtime, and report where the card is listed |

Providers are adapted in `src/dmv_ai.js`: Anthropic Messages API, OpenAI Chat Completions
and Gemini `generateContent`, each with its own tool-call format, normalized to one shape for
the loop in `src/dmv_chat.js`. Tool implementations live in `src/dmv_chat_tools.js`, `src/dmv_chat_sheets.js`,
`src/dmv_chat_pivots.js`, `src/dmv_chat_dashboards.js` and `src/dmv_chat_reports.js`. The capability
description the model answers "what can you do?" from is `dmvChatCapabilities_` in `src/dmv_chat.js`;
keep it in step with this document and the README. Saved dashboard plans execute in
`src/dmv_dashboards.js`, which lays out the dashboard tab and builds its charts itself.

Offline tests (`tests/chat.test.mjs`) drive the loop with scripted provider replies through an
arbitrary test connector and assert that provider secrets and the AI key never appear in a
request body, that tool errors teach (unknown columns list the real ones), that `ask_user`
skips the rest of its round, and that the budget path disables tools for the final answer.
They do not certify any provider's live behavior or pricing.

### Multi-platform comparisons

Chat can use `combine_results` to append fetched reports with explicit matching column maps and a source label per platform/account, then `summarize` by week or campaign. It never invents rows or exchanges currencies. Currency is required for combined monetary results, and mixed currencies cannot be aggregated without grouping or filtering by currency. Weekly buckets start Monday and include only dates inside the requested range; the first and last buckets of a month may be partial weeks. Google Ads already includes YouTube campaigns, so a YouTube subset is not an additional platform total. GA4 acquisition metrics are not substituted for advertising clicks or spend. Full summaries support up to 30,000 groups within the shared row and size limits.
