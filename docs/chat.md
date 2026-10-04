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
   from 1 to 100,000 rows (initially 10,000). The model can request fewer rows; it cannot exceed
   your setting. A report Chat saves or writes to a sheet keeps at most 30,000 rows: it is
   written in one Sheets request, where a dashboard writes its data tabs in several. Increase it
   if a complete report reaches the limit. A long list still keeps its top rows (see
   [Action lists](#action-lists-the-top-rows-labelled)): rows nobody acts on only slow a refresh
   down.
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
- **Work in your sheets like an analyst**: "Clean this export: trim, dedupe on email, split name
  and add a status dropdown", lookups across tabs, pivots and conditional formats. Destructive
  changes ask first and recent edits can be undone; see [Editing existing sheets](#editing-existing-sheets).
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

### Calculated metrics

Ask for maths over totals and the chat plans it as a formula that the runtime computes exactly:
**"Profit by week across Google Ads and Meta minus Shopify costs"**, **"net ROAS after 5% VAT"**
or **"margin by campaign"**. The model writes the expression; it never computes the numbers.

- `profit = revenue - spend`, `net_roas = revenue / 1.05 / spend`,
  `cost_share = spend / (spend + other_spend)`, `margin = (revenue - cost) / revenue` (as a
  percent), or `blended_cpa = spend / conversions` after `combine_results`.
- A formula is evaluated per group after aggregation, like a ratio: each column it names is that
  column's sum over the group, so only summable columns qualify (not rates, averages, reach or
  text). It may also name a ratio key or an earlier formula of the same request, so
  `margin = profit / revenue` follows `profit`. Without groupBy the result is the true total,
  computed from the overall sums, never a sum of per-row results.
- The language is numbers, column keys (dotted keys such as `metrics.cost` included), `+ - * /`,
  unary minus, parentheses, `abs(x)`, `min(a, b, ...)`, `max(a, b, ...)` and `round(x)` or
  `round(x, digits)` with 0 to 6 digits. Nothing else is accepted, and nothing in an expression
  is ever run as code.
- At most 10 formulas per request, 300 characters, 60 numbers, names and symbols, and 12 levels
  of parentheses or functions each. Errors name the problem and its position, for example
  `Formula "profit": unknown column "revenu" at position 1; summable columns are spend, revenue.`
- Division by zero and any blank sum give a blank, never an error value. A group with spend but
  no revenue gets a blank profit rather than a misleading negative.
- Units follow the operands: money plus or minus money, and money multiplied or divided by a
  number, stay money; money divided by money (ROAS) is a number. Multiplying two amounts of
  money, or adding money to a non-money column, is refused, and a money result cannot be a
  percent. Plain numbers adopt the unit of the other side.
- Money in different currencies is never combined: a formula over money splits or filters by
  currency exactly like a money metric. There are no joins on differing names (combine first,
  with shared column names), no currency conversion and no statistics beyond these functions.
- `combine_results` appends rows and needs the same columns from every source. For profit across
  ad platforms and a shop, map ad spend and shop costs to one `cost` key and conversion value to
  `revenue`; a warehouse query for the shop can select `NULL AS revenue` so its rows fit. A
  source that cannot supply a shared column cannot be combined with the others.
- Dashboard tiles take the same `formulas`, checked when the dashboard is saved and computed
  again on every refresh without AI. The save applies the refresh's rules to every column the
  reports declare: fields a connector marks as not additive, names in any case, and a ratio key
  that is also a column. A column a report only discovers when it runs, such as a warehouse
  query's, is checked on refresh, and the error names the tile. A scorecard and a table's total
  row evaluate the formula over the overall sums; a table row, a chart bucket and a compared
  chart's previous-period line over their own sums. A formula key is named like a ratio key in
  `orderBy` (where a key wins over another column's label), `secondaryAxis`, highlight rules
  (`value` or `ofTotal`), `lowerIsBetter` and `neutral`; its table column gets a Δ % column
  when compared and the heat shading of a rate. Values are recomputed from the
  summed parts at 12 significant digits, so changes and thresholds are not rounded first. A
  scorecard reads only the columns, ratios and earlier formulas its formula needs, so a
  conversion rate is not split by currency because another value is money.

## Editing existing sheets

Ask directly, for example: "Make the header bold, format column C as percentages and freeze the
first row", "Sort A1:F100 by spend descending", "Put =SUM(B2:B20) in B21", or a whole job such
as "Clean this export: trim, dedupe on email, split name, add a status dropdown, pivot spend by
campaign and month on a new tab, colour CPA > 50 red". Chat works like an analyst: it finds data
with `search_sheets`, inspects a range, then edits it with `edit_sheet`, `create_pivot` or
`conditional_format`, and can undo its recent edits with `undo_sheet_edit`.

### Reading before writing

Chat lists tabs, inspects a range and only then edits it. Each range edit is limited to an
explicit range of at most 1,000 cells, 200 rows and 30 columns. A private token binds the edit to
the exact user, spreadsheet, tab, range and inspected contents/formatting for five minutes. The
tool checks again under the shared write lock and applies one atomic batch. An edit may act on
the inspected range or a part of it (the whole inspected range must be unchanged). Each token
acts once; an edit returns a fresh one for the whole inspected range as the edit left it, so the
next edits there need no new inspection. A refused edit changes nothing and spends no token, so
its error says the token still holds for that range. If the sheet changed, chat must inspect it
again. A range may name its own tab (`Sales!A1:F20` with `sheetName` Sales), as models often write
it; one naming another tab is refused. Actions on whole rows, columns or tabs name the tab (and a
start and count) instead of an inspected range.

`search_sheets` changes nothing. In `find` mode it looks for text, a number (also matched by its
value) or a regular expression in values or formulas, with match case and whole cell, across the
visible tabs, chosen tabs (a hidden tab only when named) or one range. It returns up to 200
matches as `Tab!cell` with value and formula, the total and counts per tab, and scans at most
200,000 cells per call; tabs that would go over are skipped and named, with a hint to narrow the
search. A regular expression that repeats a group holding a repeat or alternatives, such as
(a+)+ or (a|b)+, is refused, because it can run for minutes; cells longer than 5,000 characters
are left out of a regular-expression search and counted. In `duplicates` mode it reports the
duplicate rows of one range by key columns (groups, counts and up to 10 row numbers each),
ignoring case and surrounding spaces unless asked.

### Edit actions

`edit_sheet` keeps its original actions and adds the analyst ones:

| Action | What it does | Limits |
| --- | --- | --- |
| `set_values` | Literal values; text beginning with = stays text | Inspected range |
| `set_formulas` | Formulas (see [Formulas](#formulas)); cells without = are written as values (labels beside KPI formulas), and text Sheets would read as a formula (+B1, -SUM(…)) is refused | Inspected range, 8,000 characters each |
| `format`, `sort`, `filter`, `freeze` | Number format (currency shows a code only when given one, such as EUR), bold, colours, alignment and wrap; sort by columns; a basic filter, which without a range is a tab action over the tab's data (from A1 to its last row and column, however large); frozen rows and columns, a tab action that takes only the tab | Inspected range; `filter` without a range the tab's data; `freeze` the tab's grid |
| `create_sheet`, `rename_sheet` | A new tab (with `count` rows, default 1,000, at most 200,000, for a helper tab of formulas over a large source), whose result carries an `editToken` for its empty first block (A1:Z38), so the edits that fill it need no inspection; or a new name for one | A tab a saved report or dashboard uses must have its destination updated before it is renamed |
| `copy_range`, `move_range` | Copy or move the inspected range to a top-left cell on this tab or another; a copy pastes all, values, formats or formulas, while a move always takes everything, because Sheets empties the whole source, and takes the formulas that point at it along; a move always asks first, and its question names the formulas that refer by address to cells it pastes over (checked across the spreadsheet's formulas, up to 200,000 cells, or says when that check cannot finish), since Sheets turns those references into #REF!; values pasted onto the range itself freeze its formulas without asking, and an array formula in its first cell (a generated table) is frozen whole, as the sheet shows it, however little of its result the range covers, unless that area holds another entry outside the range, which is refused; the freeze keeps the date, time and percent formats the formulas only showed (read from each column's last row), which pasted values would otherwise lose, so dates never read as serial numbers | Inspected range |
| `insert_rows`, `insert_columns` | Insert before a 1-based `start`; always asks first | 500 per call |
| `delete_rows`, `delete_columns` | Delete from `start`; always asks first, naming the pivot tables anchored there, and refuses to delete every row or column that is not frozen, as Sheets does | 500 per call |
| `group_rows`, `group_columns`, `ungroup_rows`, `ungroup_columns` | Outline groups, at most 8 levels; ungroup only where every row or column is grouped; always asks first | The tab's grid |
| `find_replace` | Text or a regular expression, match case and whole cell, in the inspected range or the whole tab's data; never touches formulas and never makes one; dates and numbers are checked both by their number and by what they show (3/15/2023), so the count and the checks never undercount what Sheets changes; a regular expression uses only syntax that Java (which Sheets follows), RE2 and JavaScript read alike: classes, `(?:)` groups, repeats, `\d \w \s \b` and their capitals, `\t \n \r \f` and escaped punctuation; a range holding line breaks, unusual spaces or letters beyond A to Z is refused when the expression uses `.`, `$`, `\s` or `\b`, which differ there, and letters beyond A to Z in the expression need match case; a regular-expression replacement refers to groups as $1 to $9 and has no backslashes or other $ signs, so the text checked is the text Sheets writes; a result is refused when it starts with = or with a + or - that starts an expression, while a lone dash and plain signed numbers (-5, -5%, -$3) are fine | 50,000 cells; the whole tab or more than 200 changed cells asks first |
| `remove_duplicates` | Keep the first or last row of each key (`keyColumns`), below `headerRows`; always asks first; with `wholeSheet` it compares every row of the tab's data (key columns counted from A) after reading only the key columns, and the kept rows close up for the whole table, so a large export is never deduped range by range | Inspected range, or the whole tab's data up to 50,000 cells (what undo keeps; a larger tab is refused) |
| `highlight_duplicates` | One live conditional-format rule that colours repeated keys; an error cell (#N/A) counts as no match, so it never turns the rule off for every row; with `wholeSheet` the rule covers every data row of the tab and compares each key with the whole column | Inspected range, or the whole tab's data up to 50,000 cells |
| `trim_whitespace` | Trims spaces in text cells | Inspected range |
| `split_columns` | Splits one column to the right by comma, semicolon, period, space, a custom separator or auto, which takes the first of comma, semicolon, tab, pipe and space that any cell holds and sends that separator, so the split checked is the split made; dates and numbers split by what they show; asks before writing over filled cells, and refuses a piece by the same rule as a `find_replace` result | Inspected range |
| `data_validation` | Dropdown from a list (up to 500 values) or a range of this spreadsheet (which may run to the last row, as `A2:A`, or be whole columns), checkbox, number or date conditions, strict or not; `clear` removes it; rows a filter hides are included | Inspected range |
| `set_notes`, `set_links` | Notes, or rich-text links on literal text (https only; an empty URL removes the link) | Inspected range |
| `named_range` | Add, update (rename or move) or delete a named range, bounded or open (`C2:C`, `C:C`) | One name per call |
| `duplicate_sheet`, `delete_sheet`, `hide_sheet`, `show_sheet` | Tab operations; duplicate and delete always ask, and delete never removes a tab a saved report or dashboard uses or the last visible tab | One tab per call |

`create_pivot` makes a real Sheets pivot, by default in a new tab (see
[Native pivot tables](#native-pivot-tables)). `conditional_format` adds, lists and deletes
conditional-format rules on a cell, a range, a column to its last row (`D2:D`) or whole columns
(`D:F`): number comparisons (greater, less, equal, between and their opposites), text contains,
does not contain, starts with, ends with or equals (text starting with = or + is refused, since Sheets reads it as a formula; pivot filters follow the same rule), dates before, after, on or between (as YYYY-MM-DD or relative
dates), blank or not blank, a custom formula under the same rules as `set_formulas` but on cells of its own tab only (Sheets does not allow other tabs there), and 2- or 3-point colour scales by min, max, number, percent or percentile. Thresholds that are not whole numbers go as formulas (`=1.5`), as dates go as `DATE()`, so they read the same in every spreadsheet locale. Data validation and basic filters send numbers that are not whole as formulas the same way, and data validation sends its date bounds as `DATE()`. A rule sets a
background colour, text colour, bold, italic or strikethrough. A new rule goes after the
existing ones, as in the Sheets editor, and the result says when an earlier rule covers the same
cells. `list` returns each rule with a `ruleId`; `delete` removes the rule with that id.

### Protected output

Report output continues to use its existing protected writer. Chat refuses to change the values,
formulas, order or structure of saved report and dashboard output (and anything on a
dashboard's page or chart data tab): set values, formulas, sorting, copy or move onto it,
inserting or deleting rows and columns through it, find and replace, deduplicating, trimming,
splitting, validation, notes or links on it, deleting its tab, or placing a pivot or an array
result of known size over it. The error names the report or dashboard to change
instead. This holds for every collaborator's reports and dashboards, not only your own: each
refresh records where its output lies as developer metadata on the output tab, visible only to
DataMoov, so a colleague's chat refuses the same edits (and renaming the tab) and says another
collaborator saved the output, without naming it. Removing the report or dashboard, or the
dataset, removes the record; output written before records existed gets one at its next
refresh. Renaming a tab is refused while report or dashboard output lies on it, or while one of
your reports or dashboards names it as a destination in any capitals; a rename that only
changes capitals is allowed. Formatting, conditional formats, filters and frozen panes stay
allowed, because a refresh keeps them, and report output may be the source of a pivot. Tables chat wrote with
write_to_sheet remain yours to edit. Editing report values by hand still makes the next refresh
stop until the report is moved to a fresh output area.

### Confirmation

Destructive or wide changes return a question instead of acting, for example replacing more than 200
non-empty cells (counting values a spilled array formula or a pivot table shows, and adding up
the edits of one request, so an overwrite split into smaller calls still asks; a yes to that
question covers every cell replaced so far, so the count starts again after it), deleting rows, columns or a tab, removing duplicates, find and replace over a
whole tab or more than 200 cells, and anything that cannot be undone here, which includes
inserting, deleting, grouping and ungrouping rows or columns, `move_range`, `duplicate_sheet` and
`delete_sheet`. The tool answers
`{needsConfirmation, confirmToken, summary}` and changes nothing; chat asks you, and the sidebar
shows **Yes** and **No** under the question, above them DataMoov's own summary of each change
Yes approves (not the model's wording). The change happens only when your next message is
a yes, typed or sent with the Yes button (which carries the offered token, so only that change
is approved), for that exact change, once, within that request. If the cells it would change
are no longer as they were when chat asked, the yes does not cover it and chat asks again. A token the model passes on its
own, for other input, a second time or after 30 minutes is refused. A typed yes approves every
change offered in the previous answer, and only a plain one counts: yes, ok, sure, confirm, go
ahead or similar, with at most please or "go ahead and delete it" after it; "ok, now chart
revenue" is a new request, not a yes. Any other answer, or pressing No, drops the question. A
question belongs to its conversation: a message in another sidebar, or after **New chat**, neither
answers nor drops it. The approval matches the call however the model spells out a default
(such as `keep: first`) or orders `keyColumns`; a different call is told which call was approved,
so the model can repeat it exactly.

### Undo

Chat keeps what each cell edit replaced (values with formulas as formulas, formats, notes,
validation, rich text and smart chips) in your private cache for six hours, the last ten edits per spreadsheet (and every
edit of the current request, however many it makes). Ask "undo
that" and `undo_sheet_edit` restores the latest edit, or one named from its list, in one batch;
it refuses when those cells changed since, naming the range, and when rows or columns of their tab
were inserted or deleted since, since the cells are then no longer where they were. Undoing a
named range edit is refused once the name was changed since. A copy's conditional formats and
merges are removed and the merges it pasted over come back; validation, notes, links, named
ranges, conditional-format rules, hidden tabs and a pivot placed on an existing tab are put back.
Undoing a copy that puts conditional-format rules back, or a conditional-format change, is refused
once the tab's rules changed since, because a rule is found by its position. Undoing `format` is
allowed over report output, like the edit.
Row, column, move and tab edits (insert, delete, group and ungroup rows or columns, `move_range`,
`duplicate_sheet` and `delete_sheet`) are not undone by chat: each asks first, saying so, and
undo answers that File > Version history can restore it, rather than undo an older edit instead.
Creating or renaming a tab, a pivot on a new tab and a chart neither ask nor are undone: they are
listed without data, and undo right after one answers how to reverse it (delete the tab or chart,
or rename the tab back) rather than undo the chat edit before it.
Each undo entry keeps its cells and checks under cache keys of its own, so the list of entries
stays well under the 100 KB a cache value holds: past about 30,000 characters its oldest entries
are dropped, but never those of the current request, whose ids chat already gave out. Should a
request make so many edits that their list no longer fits, its next edit stands without an undo
entry, and the earlier ones stay undoable. A snapshot too large to keep
(over 50,000 cells or about 900,000 characters packed) is not undoable here, so chat asks first and says so;
Sheets version history can still restore it. Undo does not restore row heights, other merges,
basic filters or in-cell images, and a pivot on a new tab is removed by deleting its tab. Of smart
chips, Sheets lets chat write back people and Drive files only; links to YouTube, Maps or Calendar
come back as @ text, and the undo result says how many cells held them.

### Formulas

`set_formulas` accepts every Google Sheets built-in function except a short denylist: nesting,
LET and LAMBDA with MAP, BYROW, BYCOL, REDUCE, SCAN and MAKEARRAY, XLOOKUP, QUERY (its query
string is data), FILTER, SORT, UNIQUE, ARRAYFORMULA, REGEX functions, SUMPRODUCT, array literals
such as {1,2;3,4}, references to other tabs ('Tab name'!A:C), whole and open ranges (A:A, 2:2,
A2:A) and named ranges of this spreadsheet, up to 8,000 characters per formula. Refused anywhere
outside quoted text: IMPORTRANGE, IMPORTDATA, IMPORTHTML, IMPORTXML, IMPORTFEED, IMAGE,
GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE, INDIRECT and AI, which fetch from or send data
outside the spreadsheet or hide what a formula reads. A function that is not a Sheets built-in
(custom, Apps Script and named functions) is refused by name, as are unknown names and tabs. A
LET name counts as defined only after its value, so `LET(F, F(A1), F)` calls the global `F` and is
refused like it. A LET or LAMBDA name is never called (`LET(f, LAMBDA(x, x*2), f(A1))` is
refused), since whether Sheets then runs the name or a custom function of that name is not
documented; a named LAMBDA can still be handed to MAP, BYROW, REDUCE and the like, as in
`LET(f, LAMBDA(x, x*2), MAP(A1:A9, f))`.
HYPERLINK takes a literal https address. The built-in list is kept in
`src/dmv_chat_sheet_formulas.js`.

When the size of an array result follows from the formula (bounded ranges, SEQUENCE or
MAKEARRAY with literal sizes, array literals of them side by side or stacked, such as a
header row above MAKEARRAY(1000, 9, …), and LET names bound to them) and it fills at most
50,000 cells, its spill area must be empty and off protected output, and it is kept for undo. Such a result running past the end
of the tab adds the rows or columns it needs in the same edit (Sheets would show #REF!); undo
leaves them, empty. Larger results, like those below, never grow the tab. Other
array results (FILTER, QUERY, and lookups or conditional counts such as VLOOKUP, MATCH or
COUNTIF over a range of keys inside ARRAYFORMULA) are left to Sheets, which never writes over
data and shows #REF! instead. After writing, chat reads the cells back and returns each error with its cell and Sheets' message (#REF!, #N/A, #VALUE!,
#DIV/0!, #NAME?, #ERROR!), a sample of the results and where arrays spilled, so it can fix the
formula in the same turn. Nothing written is rolled back automatically, but undo is available.
A bracket closed out of order is reported with the call left open (`MAKEARRAY( from character
14 is still open at this "}"`), and a matrix of the wrong shape with the shape its range takes.
Literal values beginning with = stay text. Internal report settings remain excluded.

### Native pivot tables

Ask, for example: "Create a pivot of Marketing data with campaign as rows and summed clicks as values."
Chat creates a real Sheets pivot in a new tab, using an explicit source range with headers (a whole
tab or a formula's result) of any length and up to 80 columns; its checks read only the columns
they need, at most the first 100,000 data rows. Each column the pivot uses needs a header of its own; other
columns in the range may have any header or none, and a number or date header counts as its text. It validates the requested fields and numeric aggregates first.
The range may include future blank rows within the existing sheet grid, so later values inside
that range participate automatically. Data outside it requires a larger source range.
Native date grouping requires actual Sheets date cells; ISO dates written as text cannot be
passed as native date groups. An already prepared month column can be an ordinary pivot group.

Pivots also take MEDIAN, values shown as a percent of the row, column or grand total, quarter
buckets, a sort per group (by its labels or by a value), up to 6 filters (chosen text values, or a
condition that shows every value meeting it; number and date columns take a condition, since a
pivot lists their values as it displays them), totals, and a `targetCell` on an existing tab whose cells the pivot could fill are
empty and not report output (at most 50,000 cells; undo removes it). A source without a
currency-code column holds one currency; money beside one must be grouped by it, every numeric row needs a code there, and with several currencies, totals that would add them up are left out (the
result says which) and percentages that would mix them are refused. A pivot with one row group and
no column groups or filters returns `chartRange`: its header row and one row per group, above any
grand total, so `create_chart` can chart it without an inspection. Its groups are counted on every
source row, so past the first 30,000 rows that one column is read whole, as are the currency
column and the numeric columns for the currency checks. Calls with only the original
options run the original path unchanged.

## Dashboards

A report imports one source into a table. A **dashboard** is what you ask Chat for when you want
to *see* performance: it fetches 1 to 8 datasets, writes each to its own tab, and builds one
**Dashboard** tab laid out as a page of cards. The numbers behind the charts go to a hidden
**(chart data)** tab. You do not create reports first; the dashboard carries its own queries.
Every number on the Dashboard tab (scorecards, their change lines, table cells and totals) and
every point behind the charts is a formula over the data tabs, so it updates as soon as a data tab
changes; which rows rank, how many rows and points show, the colours and the highlight sentences
are set at each refresh. Where SUMIFS and the other IFS functions cannot say a number exactly
(date groups of a column of timestamps, groups of true and false, names that differ only in case
or that Sheets would read as numbers, dates, errors or operators such as "2026-09", "50%", "#N/A"
or "<5", a `contains` filter on a number column, a column of mixed types such as "n/a" among
numbers or numbers among text, a distinct count over several tabs), the formula is a SUMPRODUCT
or FILTER over the same ranges that compares cells exactly as the refresh did, a number, a text
and a boolean apart, and counts distinct values by the text they print. Two differences remain:
a formula reads only numbers in a number column, so text there that looks like a number ("12")
counts at the refresh but not in the formula, and a boolean there (TRUE) the refresh counts as 1
where the formula skips it; connectors write numbers as numbers. A value that
was blank at refresh (a sum without any values) is a formula that stays blank until its data tab
has values, where SUMIFS would read 0. Change lines print their numbers in the spreadsheet's
locale, like the cells around them.
A dashboard over data already in a tab (a pasted sales table, say) is not a saved dashboard: Chat
builds a new tab in several small steps, with KPI formulas over your tab, a native pivot table and
charts over its summary, then formats it in a call or two, so the build finishes before the polish.
These recalculate with the sheet and have no **Refresh dashboard** card.

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
top rows**, query conditions or aggregation, or fewer dimensions; raising **Maximum rows
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
- A dataset holds up to 100,000 rows, and the datasets together at most 3,000,000 cells (rows
  times columns). The whole refresh is one roughly 200-second run; there is no continuation for
  dashboards. The page, its chart data and as many data rows as fit go in one all-or-nothing
  Sheets request of at most 8,000,000 bytes, and the remaining data rows follow in further
  requests of that size. If one of those later requests fails, the page is already written and
  its numbers read the rows written so far until the next refresh; the error says so. Keep
  datasets lean: a dataset without a date column (a custom query without `segments.date`)
  returns totals for the period instead of one row per day, and a list keeps its top rows.
- Datasets past the cell budget stop the refresh before anything is written, named with their
  size, for example "The dashboard datasets exceed 3,000,000 cells together (Google Ads assets
  98,412 rows x 21 columns, ...)", with how to keep only the rows worth acting on in them. Chat
  narrows the dataset named first (its top rows, fewer fields, no date column) and runs the
  dashboard again. A page too large for one request ("This dashboard is too large for one Sheets
  write") asks for shorter tables instead.
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
  or an occupied destination leaves all previous tabs and charts unchanged. The rows of a large
  data tab that do not fit the first Sheets write follow in further writes; if one of those fails,
  the tabs stay partly updated and the refresh says so, and the next refresh writes them again.
- A dashboard writes to tabs of its own. A tab name that already holds content is refused when
  the plan is saved, before anything is fetched, and the message names the tab and suggests a
  free name.
- Money in different currencies is never added: KPI cards, totals and chart series split by
  currency. Rates and averages cannot be summed.
- The tabs belong to the dashboard. Editing values or formulas inside its cards and tables, or
  typing into the rows the charts sit on, stops the next refresh until the edit is undone; put your
  own notes on another tab. A formula only pointed at other cells or tabs does not count: Sheets
  moves references itself when tabs are renamed or rows move, so the refresh writes its own
  references back. A data tab is written again on every refresh, edits included, and until then
  the page's numbers follow what it holds. Formatting and layout changes on the
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
- The tab you have open when you send a message: its name, its used range (for example A1:I50,
  with row and column counts) and its header row, the first non-empty row of the top 10 as the
  sheet displays it: at most 30 cells of at most 40 characters each and 800 characters in all,
  marked as spreadsheet data rather than instructions. With
  Anthropic this section comes after the prompt's cache point, so switching tabs keeps the rest
  of the prompt cached.
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
  at most 100,000), column caps, deadline and host allowlists. Reports fail instead
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
- Sheet edits are typed, bounded requests built by the add-on, never raw API requests. They
  never change the values, order or structure of saved report or dashboard output (formatting,
  conditional formats, filters and frozen panes there are fine), ask before destructive changes, and keep undo
  snapshots only in your private cache for six hours.
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
- A tool call the provider cannot use (Gemini's `MALFORMED_FUNCTION_CALL`, `MALFORMED_RESPONSE`,
  `UNEXPECTED_TOOL_CALL` or `TOO_MANY_TOOL_CALLS`) never runs. Chat tells the model, with only that reason code, to call
  again in smaller steps, at most twice per request (across its executions); a third such reply
  ends the request as a failed answer that lists any steps already completed.
- A reply with no answer and no tool call is a failed answer, naming the provider's reason code
  when it gives one (for example `OTHER`), never the provider's message.
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
| `summarize` | Group, filter, aggregate and sort a result server-side; ratios (CPC, CTR, CPA, ROAS) divide two per-group sums; formulas (profit, net ROAS, margin) do arithmetic over per-group sums, ratios and earlier formulas; rankWithin and limitPerGroup select top rows separately per month or other group; rates and averages cannot be summed |
| `write_to_sheet` | Write a result as a formatted table through the protected writer |
| `read_sheet` | Read a tab into a result |
| `create_chart` | Add a line, column, bar, area, scatter or pie chart over a written table |
| `ask_user` | Ask one clarifying question with up to six options; ends the turn |
| `list_sheets` | List ordinary tabs and grid sizes |
| `inspect_sheet` | Inspect a bounded range and issue a private, short-lived edit token |
| `search_sheets` | Read-only: find text, numbers or a regex across tabs (up to 200 matches, 200,000 cells scanned), or report duplicate rows of a range by key columns |
| `edit_sheet` | Apply validated values, formulas (any built-in except the denylist), formatting, sorting, filters, freeze panes, tab creation/rename, and the analyst actions: copy/move, insert/delete/group rows and columns, find and replace, duplicates, trim, split, validation, notes, links, named ranges and tab duplicate/delete/hide/show; all through the output guard, confirmation and undo |
| `undo_sheet_edit` | List or undo recent chat sheet edits of this spreadsheet (last 10, six hours) |
| `create_pivot` | Create a native pivot on a new tab (or at a cell of an existing tab) from a validated source range, with filters, totals, per-group sort, percentages, MEDIAN and quarters |
| `conditional_format` | Add, list or delete conditional-format rules: number, text, date, blank, custom formula and colour scales |
| `list_dashboards` | List private saved dashboards for this spreadsheet |
| `save_dashboard` | Save a plan: up to 8 datasets (a query, a tab and optional shared column names each), tiles (kpi, chart or table over one or more datasets; `compare` names the current and previous dataset ids, one id or a list each; tables take `highlight` rules with a numeric `value` or an `ofTotal` multiple on a metric, ratio or formula, or a text `value` on a groupBy column; any tile takes `formulas`, calculated metrics whose keys charts, tables, scorecards, rules and polarity lists name like ratio keys), the dashboard-level `lowerIsBetter` and `neutral` metric lists, and the dashboard tab |
| `run_dashboard` | Fetch every dataset and atomically rebuild all tabs, cards, charts and tables; return scorecard values, the `highlights` sentences, a short preview of each tile and tab links |
| `list_reports` | List private saved reports (drafts included) with their revisions |
| `save_report` | Save one report query with a name, tab and optional schedule through `dmvSaveReport`, run it once through the report runtime, and report where the card is listed |

Providers are adapted in `src/dmv_ai.js`: Anthropic Messages API, OpenAI Chat Completions
and Gemini `generateContent`, each with its own tool-call format, normalized to one shape for
the loop in `src/dmv_chat.js`. Tool implementations live in `src/dmv_chat_tools.js`, `src/dmv_chat_sheets.js`,
`src/dmv_chat_sheet_safety.js`, `src/dmv_chat_sheet_actions.js`, `src/dmv_chat_sheet_conditions.js`, `src/dmv_chat_sheet_formulas.js`, `src/dmv_chat_pivots.js`, `src/dmv_chat_dashboards.js` and `src/dmv_chat_reports.js`. The capability
description the model answers "what can you do?" from is `dmvChatCapabilities_` in `src/dmv_chat.js`;
keep it in step with this document and the README. Saved dashboard plans execute in
`src/dmv_dashboard_run.js`, which lays out the dashboard tab (`src/dmv_dashboard_page.js`) and builds its
charts (`src/dmv_dashboard_charts.js`) itself.

Offline tests (`tests/chat.test.mjs`) drive the loop with scripted provider replies through an
arbitrary test connector and assert that provider secrets and the AI key never appear in a
request body, that tool errors teach (unknown columns list the real ones), that `ask_user`
skips the rest of its round, and that the budget path disables tools for the final answer.
They do not certify any provider's live behavior or pricing.

### Multi-platform comparisons

Chat can use `combine_results` to append fetched reports with explicit matching column maps and a source label per platform/account, then `summarize` by week or campaign. It never invents rows or exchanges currencies. Currency is required for combined monetary results, and mixed currencies cannot be aggregated without grouping or filtering by currency. Weekly buckets start Monday and include only dates inside the requested range; the first and last buckets of a month may be partial weeks. Google Ads already includes YouTube campaigns, so a YouTube subset is not an additional platform total. GA4 acquisition metrics are not substituted for advertising clicks or spend. A summary counts every group and keeps up to 30,000 of them, ranked, within the shared row and size limits.
