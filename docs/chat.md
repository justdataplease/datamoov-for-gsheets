# Chat with your data

The Chat tab answers questions in plain language by running the same saved connections and
reports that power scheduled refreshes. The model plans; the DataMoov runtime validates,
fetches, aggregates, writes and charts. There is still no DataMoov server: the only new
network destination is the AI provider you configure.

## Setup

1. Open **Extensions → DataMoov → Open DataMoov**, choose **Chat**.
2. Pick a provider (Anthropic, OpenAI or Google Gemini), paste an API key from your own
   account, keep or change the model name, then **Save** and **Test**. The key is stored in
   your private script properties and is never shown again; leave the field blank when
   editing to keep it. The **Create a key** link opens the provider's key page.
   **Instructions for the assistant** is optional standing context sent with every question:
   your business, currency, naming conventions, preferred tabs or chart styles (up to 4,000
   characters).
3. Add at least one connection in **Connections**. The chat uses connections; it never asks
   for provider credentials itself.

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
- **SQL sources**: for PostgreSQL and BigQuery the model first calls `describe_database`,
  which lists the tables and columns of the schemas or datasets you chose on the connection
  (**Schemas for chat**, default `public`; **Datasets for chat** as `project.dataset`), then
  writes one read-only SELECT against those names. The same SQL guard as saved reports
  applies, and the database role should be read-only. Keep the scope small to keep the
  model to the point.
- **Ask when unsure**: if "revenue" could mean three things, it asks and shows the choices
  as buttons.

Each answer lists what happened underneath: which report ran and how many rows, what was
summarized, what was written where, which chart was added.

## What the model sees

- The catalog: your connection labels and ids, non-secret connection values (account or
  property ids, chat schemas or datasets), the reports with their fields, the spreadsheet's
  tab names and timezone, and your saved instructions.
- Tool results: column descriptors, row counts, per-column statistics and a few sample rows
  (the first five and last three). Small results (20 rows or fewer) are returned whole.
  Aggregates from **summarize** are returned in full up to the requested limit.
- Data you read with **read_sheet** is sampled the same way.

The model never sees credentials, API keys, full result sets or anything outside the
spreadsheet it runs in. Values that come back from providers are framed as data, not
instructions.

## Guarantees

- Every fetch goes through the report runtime: the same row caps (default 1,000, maximum
  20,000), column caps, deadline and host allowlists as saved reports. Reports fail instead
  of truncating.
- Writes go through the report writer: only empty cells, or cells the chat wrote earlier at
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

## Tools (for developers)

| Tool | Purpose |
| --- | --- |
| `run_report` | Run a report of a saved connection; returns a `resultId`, columns, row count, statistics and samples |
| `discover_fields` | Account-specific fields (GA4 custom definitions, HubSpot/Zendesk properties, SQL result columns), with a `search` filter |
| `describe_database` | Tables and columns of the schemas/datasets a PostgreSQL or BigQuery connection scoped for chat, with a `search` filter on table names |
| `summarize` | Group, filter, aggregate, sort a result server-side; rates and averages cannot be summed |
| `write_to_sheet` | Write a result as a formatted table through the protected writer |
| `read_sheet` | Read a tab into a result |
| `create_chart` | Add a line, column, bar, area, scatter or pie chart over a written table |
| `ask_user` | Ask one clarifying question with up to six options; ends the turn |

Providers are adapted in `src/dmv_ai.js`: Anthropic Messages API, OpenAI Chat Completions
and Gemini `generateContent`, each with its own tool-call format, normalized to one shape for
the loop in `src/dmv_chat.js`. Tool implementations live in `src/dmv_chat_tools.js`.

Offline tests (`tests/chat.test.mjs`) drive the loop with scripted provider replies through an
arbitrary test connector and assert that provider secrets and the AI key never appear in a
request body, that tool errors teach (unknown columns list the real ones), that `ask_user`
skips the rest of its round, and that the budget path disables tools for the final answer.
They do not certify any provider's live behavior or pricing.
