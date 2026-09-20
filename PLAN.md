# DataMoov for Google Sheets — Chat with your data, new ad sources, speed pass

Working plan, 2026-09-20. Kept at the repo root while the work is in progress; the durable
documentation lands in `README.md`, `docs/code-layout.md`, `docs/connector-contract.md` and
`docs/chat.md` as each phase finishes.

## Status (2026-09-20)

| Phase | State | Verified by |
| --- | --- | --- |
| 2 AI settings + adapters (`dmv_ai.js`) | done | `tests/chat.test.mjs`: key hygiene, three provider shapes, error redaction |
| 3 Chat engine + tools (`dmv_chat.js`, `dmv_chat_tools.js`) | done | full turn run → summarize → write → chart; ask_user terminal; budget path; expired result; teaching errors; read_sheet; charts |
| 4 Sidebar Chat tab + settings card (`dmv_client_chat.html`) | done | `tests/sidebar.test.mjs`, Playwright at 300 and 460 px (`data/screenshots/chat-*.png`) |
| 5 Sources: YouTube (Google Ads report), TikTok, LinkedIn, Microsoft Ads, Search Console | done | `tests/ad-connectors.test.mjs` with provider-shaped fixtures, including the zipped-CSV path |
| 6 Speed: writer grid sizes in one API call; GitHub 10 repositories per chunk | done | existing writer and GitHub tests updated |
| 7 Docs | done | README, docs/chat.md, code-layout, connector-contract, marketing-connectors, AGENTS.md |
| 8 Least authorization: no Google API scopes in the manifest; service account / OAuth client / token only; Find accounts in every mode; per-source credential guides | done | `tests/app.test.mjs` (manifest and guides), account-discovery, manual-oauth, transport, google-oauth, Playwright |
| 9 Chat: standing instructions in settings; `describe_database` with per-connection schema/dataset scope for PostgreSQL and BigQuery | done | `tests/chat.test.mjs`, database-research, business-connectors, Playwright |
| 11 Settings tab with saved credentials (types derived from connectors, one shared Google type, dropdown + inline add in the connection form, delete refused while in use, rotated secrets land on the credential) and the AI provider card; four tabs with the report and connection editors as screens behind + buttons; larger-window mode | done | `tests/credentials.test.mjs`, sidebar, Playwright (38) |
| 10 Review fixes (`.local/latest-changes-review.md`): one deadline per chat turn; additive metadata; partial-failure reporting; result ids replayed; last-week preset; whole cell text; search-before-cap discovery on one query path; rotated refresh tokens persisted; LinkedIn `r_ads`; Microsoft probe test; New chat race | done | `tests/date-range.test.mjs`, chat, google-oauth, manual-oauth, ad-connectors, database-research, business-connectors, Playwright |

Offline suite: 190 tests green; browser suite: 38 green. Still needs live verification in a
real spreadsheet, as with every source: an AI key per provider (the Anthropic path is the
one documented from the current API reference; OpenAI and Gemini shapes were checked against
their current docs), a TikTok, LinkedIn and Microsoft account (Microsoft's report download
host is allowlisted from documentation, not observed; a mismatch fails with the host named so
it can be added). The manifest now carries only the four Sheets essentials (spreadsheets,
external requests, triggers, sidebar), so the next production release *removes* the Ads,
Analytics, BigQuery and Search Console scopes from the consent screen and Marketplace SDK
rather than adding one. Development publishing: `npm run push:dev`.

Decisions taken during implementation, beyond the plan below:

- Date presets grew to yesterday, last7, last14, last30, last90, lastWeek (Mon–Sun),
  thisMonth, lastMonth, thisYear, lastYear, so both the form and the chat cover common asks
  without custom dates; the prompt also carries today's date for the rest.
- Transport: `responseType:'blob'` for downloads; provider `errorMessage` hooks now apply
  to every 4xx, so bad model names and rejected requests surface the provider's own text.
- `dmvGoogleOAuthToken_` became a thin wrapper over `dmvOAuthRefreshToken_`, shared with
  LinkedIn and Microsoft.
- Chat writes carry ownership receipts keyed by target cell, pruned to the 20 most recent per
  user, so re-asking into the same tab replaces the chat's own table but never a user edit.
- Model output limit is 4,000 tokens per call to stay well inside Apps Script's fetch timeout;
  a faster model is the documented remedy for slow providers.
- Least authorization (2026-09-20, second pass): the "Google account" mode and the four Google
  API scopes were removed; users bring a service-account key (default), their own OAuth client
  with a refresh token, or a token. Existing connections saved in the old mode fail with a
  message that names the three choices. "Find accounts" became an optional helper that works
  with any credential and fills an editable ID, which deleted the readonly/hidden/must-select
  state from the sidebar. Every save with new or changed credentials is checked with the
  provider (any connector with a test or Google scopes) and the notice says so.
- Every connector declares a `guide` (steps, console links, per-mode steps for Google)
  rendered as a collapsible "How to get these credentials" panel; AI providers link to their
  key pages.
- Chat: settings gained free-text instructions (≤ 4,000 characters) added to the system prompt
  as a distinct section; PostgreSQL and BigQuery connections gained "Schemas for chat" /
  "Datasets for chat" and a `describeTables` hook behind the new `describe_database` tool, so
  SQL plans start from real table and column names instead of guesses.

## 0. What exists and what changes

The add-on already has one feature: **scheduled reports**. A connector declares credentials,
allowed hosts, reports, fields and `fetch(ctx)`; the shared runtime validates, fetches the
complete result, normalizes it into a typed matrix and writes it in one atomic Sheets batch
with an ownership receipt. Connections and reports are private per Google user
(`UserProperties`); one hourly trigger per user and spreadsheet refreshes them. PostgreSQL is
already a first-class source (JDBC, read-only transaction, shared SQL guard), so
"support Postgres" means exposing it to the chat, not adding it.

This plan adds a second feature on top of the same connections: **Chat**. The user stores an
Anthropic, OpenAI or Gemini API key, then asks questions in plain language. The model plans
which saved connection and report answer the question, runs it through the *existing*
connector and validation path, analyses the rows server-side, writes tables to the sheet and
adds native Sheets charts. It also adds four ad sources (Microsoft/Bing Ads, LinkedIn Ads,
TikTok Ads, YouTube via Google Ads), Search Console as a secondary item, and a speed and
simplification pass over the current implementation.

Non-negotiables carried over from the product direction:

- No backend, no telemetry, no host other than the providers the user configured. The only
  new hosts are the three AI APIs and the new ad providers.
- Credentials never reach the browser, the model, logs or cells. The model refers to
  connections by id; the executor resolves secrets.
- Read-only everywhere: the chat can fetch, aggregate, write *new* cells and add charts; it
  cannot mutate provider accounts or overwrite cells it does not own.
- Marketplace-safe: per-user locks and properties, `createAddonMenu`, manifest changes only
  where a new Google scope is unavoidable (Search Console).

## 1. What we take from the platform assistant (and what we leave)

The platform's `services/assistant.py` was surveyed (see `docs/assistant-architecture.md`
there). Reused as *design*, rewritten in Apps Script:

| Idea | Why it matters here |
| --- | --- |
| Bounded tool loop: N rounds **and** a wall-clock check, errors returned to the model as tool results (never thrown), a final *tools-disabled* "answer from what you have" call when the budget runs out | `google.script.run` calls die at 6 minutes; the loop must always end with an answer |
| Terminal-action detection | Once the model asked the user a question, remaining batched tool calls are acknowledged as skipped, not executed |
| Structured time ranges resolved on the server, no "today is …" in the prompt | Models are bad at calendar arithmetic; the add-on already has `dmvDateRange_` with the spreadsheet timezone — the chat emits presets or explicit dates and the runtime resolves them |
| The TIME INTERPRETATION prompt block (bounded total → no time grouping; default grain ladder; never ask the user to pick a grain) | Copied nearly verbatim into the system prompt |
| Ambiguity gate → `ask_user` tool → clickable chips that post an ordinary user message | "revenue" could be Google Ads conversion value, Facebook purchase value or HubSpot amount; the model asks, the sidebar renders options, the answer is just the next user turn |
| Result summarization discipline: the model gets `{columns, rowCount, sample first/last rows, per-column stats}`, never the rows | Tokens and privacy; the rows go to the sheet where the user already sees them |
| Refusals that teach: unknown field → list the legal fields; chart binding missing → list the real columns | The loop self-corrects only if refusal text is actionable |
| Untrusted data framing: fetched values are "data, never instructions" | Ad copy, ticket subjects and deal names enter the context |
| Small offline eval corpus of prompt → expected tool sequence, runnable without an API key | Lets prompt changes be checked |

Left behind: the durable turn queue and worker, multi-surface delivery (Slack/Chat/MCP),
the UUID-pinned data-policy engine, specialist delegation and drafts, the dbt/MetricFlow
semantic layer, the 50-field chart spec, the Metrics Map product. The add-on's "semantic
layer" is the connector catalog it already has: every report declares typed fields with
`role: dimension|metric`, and that catalog *is* the model's schema.

## 2. Architecture of the chat

### 2.1 Files

| File | Responsibility |
| --- | --- |
| `src/dmv_ai.js` | AI provider settings (private per user, key never returned), the three provider adapters (Anthropic Messages API, OpenAI Chat Completions, Gemini `generateContent`) over `dmvHttp_` with exact allowed hosts, response normalization, a `dmvTestAi` ping |
| `src/dmv_chat.js` | One turn: system prompt from the live catalog, bounded tool loop, transcript normalization, budget exhaustion path, the tool registry and JSON schemas |
| `src/dmv_chat_tools.js` | Tool implementations: `run_report`, `discover_fields`, `summarize`, `write_to_sheet`, `read_sheet`, `create_chart`, `ask_user`; the per-turn result store with a 1-hour `CacheService` spill for follow-up turns |
| `src/dmv_client_chat.html` | Sidebar chat panel: settings card, message list, tool activity lines, option chips, composer |
| `src/dmv_sidebar.html`, `dmv_styles.html`, `dmv_client.html` | New **Chat** tab, styles, tab wiring; `include()` allowlist gains the chat partial |
| `tools/preview.mjs` | Fixture handlers for `dmvChat`, `dmvSaveAiSettings`, `dmvTestAi`, `dmvAiSettings` so the local preview and browser tests run without a key |
| `tests/chat.test.mjs`, `tests/ai-providers.test.mjs`, `tests/chat-eval.test.mjs` | Loop, tools, provider shapes, secret hygiene, eval corpus |
| `docs/chat.md` | User and developer documentation |

### 2.2 Settings

`dmv:v1:ai:settings` in `UserProperties`: `{ provider: 'anthropic'|'openai'|'gemini', model, apiKey, revision }`.
The sidebar receives `{ provider, model, configured: true }` only. Blank key on edit keeps the
stored key (same rule as connection secrets). Defaults per provider are prefilled but
editable; the model field is free text so new models need no release. `dmvTestAi` sends a
one-line prompt and reports the model's reply, so a wrong key or model name fails at setup,
not mid-question.

Allowed hosts: `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`.
Nothing else, and the AI adapter never receives a URL from the model.

The settings card states plainly: *"Column names, row samples and aggregates from reports
you run in chat are sent to the AI provider you chose. Credentials and full result sets are
not."*

### 2.3 One turn (`dmvChat(input)`)

Input: `{ text, transcript }` where `transcript` is the client's bounded normalized history
(last 20 turns; assistant turns carry text plus compact tool summaries, never rows).

1. Load settings and the catalog. Build the system prompt: identity and rules; the user's
   **connections** with their reports, config fields, date-range support and typed fields
   (`key`, `label`, `type`, `role`); the spreadsheet's tab names; the spreadsheet timezone;
   the TIME INTERPRETATION and METRIC RESOLUTION blocks; output formatting rules.
   Static text first, catalog second (Anthropic gets a `cache_control` breakpoint after the
   static block).
2. Loop, at most **8 tool rounds** and while elapsed < **200 s** (context deadline stays 240 s):
   call the provider; if the reply has no tool calls, finish; else execute each tool call
   in order, append the results, continue. `ask_user` is terminal: later calls in the same
   round are returned as `skipped`.
3. If the budget is exhausted, one more call with tools disabled: *"Answer from what you
   have; say what is still missing."* If that fails, a fixed message.
4. Return `{ text, events, options, transcriptAppend }`. `events` are the activity lines the
   sidebar shows ("Ran Google Ads · Daily campaign performance · 248 rows",
   "Wrote 248 rows to Campaigns!A1", "Added a line chart"), `options` are chips when the
   model asked a question, `transcriptAppend` is the normalized assistant turn to keep.

Provider messages inside a turn keep the provider's raw assistant content (Anthropic thinking
blocks must be echoed back unchanged during a tool loop). Across turns only normalized text
and tool summaries are replayed.

### 2.4 Tools

All tool inputs are validated with the same functions the sidebar uses
(`dmvValidateReport_`-style validation without a target, `dmvFieldsInput_`, `dmvReadOnlySql_`
for SQL sources, `dmvCell_`, sheet name rules). Errors become `{ error }` tool results.

| Tool | Input | Returns to the model |
| --- | --- | --- |
| `run_report` | `connectionId`, `reportType`, `fields?`, `config?`, `dateRange?` (`{preset}` or `{preset:'custom', startDate, endDate}`), `maxRows?` (≤ 20,000) | `resultId`, `columns`, `rowCount`, `sample` (first 5 + last 3 rows), `stats` (sum/min/max/distinct per column, additive metrics only summed), provider `metadata` (currency, timezone, notes) |
| `discover_fields` | `connectionId`, `reportType`, `config?` | Field descriptors — needed for GA4 custom fields, HubSpot/Zendesk custom properties, and the columns of a Postgres/BigQuery SQL |
| `summarize` | `resultId`, `groupBy?[]`, `metrics[{field, agg: sum|avg|min|max|count|count_distinct}]`, `filters?[{field, op, value}]`, `orderBy?`, `limit?` | A new `resultId` plus up to 50 aggregated rows. This is the in-memory query planner: "which campaign spent most", "total by month", "top 10 queries" never send rows to the model |
| `write_to_sheet` | `resultId`, `sheetName`, `startCell?`, `title?` | Written range in A1 and the `sheetId`; goes through `dmvWriteReport_` so existing cells are never overwritten, header/number formats apply, and the write is one batch |
| `read_sheet` | `sheetName`, `range?` | Up to 500 rows × 30 columns of the user's own tab as a `resultId` plus sample; lets the chat analyse data already in the spreadsheet |
| `create_chart` | `sheetName`, `range` (A1 of a written table) or `resultId` written earlier, `chartType: line|column|bar|pie|area|scatter`, `title`, `xColumn`, `seriesColumns[]`, `anchorCell?` | Chart id; uses the Sheets API `addChart` request (basicChart / pieChart) anchored beside the table |
| `ask_user` | `question`, `options?[]` (≤ 6 short labels) | Terminal; the sidebar renders chips; a click posts `Use <label>.` as the next user message |

Results live in an in-execution map during the turn and are spilled to the user's
`CacheService` (gzip + base64, chunks ≤ 90 KB, 1 hour) so follow-up turns can summarize,
write or chart them. An expired result returns a teaching error: *"Result expired; run the
report again."*

Row caps, column caps, the 8,000,000-character matrix guard and per-report page budgets
all still apply because the chat calls the same runtime.

### 2.5 Provider adapters

One normalized shape: `messages[]` with `content[]` blocks of `text | tool_use | tool_result`;
`tools[]` as `{ name, description, input_schema }`; response `{ text, toolCalls[{id,name,input}], stop, raw }`.

- **Anthropic** — `POST /v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`;
  tools pass through unchanged; `system` as blocks with a cache breakpoint; assistant
  content echoed raw within the turn; `max_tokens` 8,000; no `thinking` parameter (adaptive
  by default on current models); `output_config.effort: 'medium'` for sidebar latency.
- **OpenAI** — `POST /v1/chat/completions`, `Authorization: Bearer`; tools wrapped as
  `{type:'function', function:{name, description, parameters}}`; assistant `tool_calls`
  with JSON-string arguments; results as `{role:'tool', tool_call_id, content}`.
- **Gemini** — `POST /v1beta/models/{model}:generateContent`, header `x-goog-api-key`;
  `systemInstruction`; `contents` with `user`/`model` roles and `functionCall` /
  `functionResponse` parts; `tools:[{functionDeclarations}]`.

Default model ids are verified against the providers' current documentation at
implementation time and kept in one table in `dmv_ai.js`.

### 2.6 Sidebar

Tabs: **Reports · New report · Chat · Connections** (four fit at 300 px). Connections stay
the shared surface: a saved connection is usable by both saved reports and the chat.

Chat panel states:

- **Not configured** — a settings card: provider, API key, model, the data-sharing note,
  *Save* and *Test*. A gear button in the panel heading reopens it later.
- **Ready** — suggestion chips built from the user's connections ("Last 30 days of Google
  Ads spend by campaign in a new tab, with a chart"), the message list, and a composer.
  Each assistant message shows its activity lines under the text and any option chips.
  A *New chat* link clears the transcript (kept in memory only; nothing is stored).
- **Working** — composer disabled with "Working with your data… this can take a minute".

No polling timers, no `innerHTML`, same accessibility rules as the rest of the sidebar.

## 3. New sources

All follow the connector contract: one file, declared hosts, typed fields, complete fetch
or fail, tests with provider-shaped fixtures. The chat picks them up from the catalog.

| Source | API | Auth | Report(s) | Notes |
| --- | --- | --- | --- | --- |
| **YouTube Ads** | Google Ads API (video campaigns *are* Google Ads) | existing Google Ads connection | new report on `google_ads`: *YouTube video campaigns* — GAQL over `campaign` with `advertising_channel_type = 'VIDEO'`, fields: date, campaign, spend, impressions, views, view rate, average CPV, clicks, conversions, quartile completion rates | no new credentials, account discovery reused |
| **TikTok Ads** | `business-api.tiktok.com/open_api/v1.3/report/integrated/get/` | long-lived access token + advertiser id | *Daily campaign performance*: spend, impressions, clicks, CTR, CPC, CPM, conversions, cost per conversion, campaign name/id, date | JSON, paged (`page_size` 1000), currency from `/advertiser/info/` |
| **LinkedIn Ads** | `api.linkedin.com/rest/adAnalytics` (pivot CAMPAIGN, DAILY) + `adCampaigns` for names | access token (60-day) or client id/secret/refresh token | *Daily campaign performance*: impressions, clicks, spend, conversions, conversion value, landing-page clicks, engagement metrics | `LinkedIn-Version` and Rest.li 2.0 headers; ≤ 20 fields per request |
| **Microsoft (Bing) Ads** | Bing Ads API v13 Reporting REST (`GenerateReport/Submit`, `/Poll`, zipped CSV download) | developer token + customer id + account id + Microsoft OAuth (client id/secret/refresh token) | *Daily campaign performance*: spend, impressions, clicks, CTR, average CPC, conversions, revenue, campaign name/id, date | asynchronous: submit → poll (bounded) → download → `Utilities.unzip` → `Utilities.parseCsv`; needs a transport option to return bytes and the download host allowlisted; the one most in need of live verification |
| **Search Console** (secondary) | `searchconsole.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query` + `/sites` for discovery | own service account / OAuth client / token (no manifest scope) | *Search performance*: clicks, impressions, CTR, position by date/query/page/country/device | the new scope changes the manifest → consent screen and Marketplace scope update before a production release |

Shared change for LinkedIn and Microsoft: generalize the Google refresh-token exchange into
`dmvOAuthRefresh_(endpoint, credentials, extraParams)` so the Google, Microsoft and LinkedIn
token endpoints share one cached, validated implementation.

## 4. Speed and simplification review of the current implementation

Findings, ordered by user-visible impact. **Bold** items are implemented in this pass; the
rest are proposals with the reason they were deferred.

1. **Writer cell-capacity check** (`dmv_writer.js`): `spreadsheet.getSheets()` plus
   `getMaxRows()`/`getMaxColumns()` per tab is 2×N round trips on every run. Replace with one
   Sheets API `spreadsheets.get?fields=sheets.properties(sheetId,gridProperties)` call.
   Saves seconds on spreadsheets with many tabs; same guarantee.
2. **GitHub repository lists fetch one repository per chunk**: 50 repositories = 50 chunks
   = 5 hourly executions. Fetch up to 10 per chunk within the same deadline checks. Tests
   updated to the new chunk size.
3. **Per-execution property snapshot**: `dmvList_`, the writer overlap scan and the
   continuation budget each call `getProperties()` and parse everything, including chunk
   pieces. A read-through snapshot per execution would remove repeated full reads.
   *Deferred*: the calls are cheap relative to provider fetches and the sandbox tests
   assert exact property behavior; revisit if a user reports slow sidebars.
4. **GA4 runs call `/metadata` and `:checkCompatibility` on every execution**: cache the
   metadata per property in the user cache for one hour. *Deferred*: discovery of new
   custom definitions would lag; keep exact behavior until asked.
5. **`dmvExecuteReport_` takes the user lock three times** and re-reads the report and
   connection each time. Correct and cheap; leave as is (the lock windows are tiny and the
   re-reads are the concurrency guard).
6. **Google Ads: two hidden fields are always added** (`customer.time_zone`,
   `customer.currency_code`) — needed for metadata; fine.
7. **Client**: `readFields` re-queries the DOM per field (O(n²) at n ≈ 10) and
   `renderReports` rebuilds the list. Negligible at the 30-report cap; leave.
8. **`dmvSave_` measures size with a Blob** on every save — fine.
9. **Sequential provider paging** is inherent (one execution thread); `UrlFetchApp.fetchAll`
   could parallelize GitHub list mode and Google Ads account discovery, but it would need a
   second transport path with the same host and size guards. *Deferred.*
10. **Simplification**: `dmvContext_` builds the same object for previews, tests, discovery
    and runs with ad-hoc `{ config: {}, fields: [], maxRows: 1 }` reports in four places;
    a `dmvProbeContext_(connector, credentials)` helper would remove the repetition. Done
    where the chat needs the same thing.

## 5. Phases and order

1. **Plan** (this file) — done.
2. **AI settings + provider adapters** (`dmv_ai.js`, tests with fixture responses in all
   three shapes, secret-hygiene assertions: no key in errors, bootstrap, summaries).
3. **Chat engine and tools** (`dmv_chat.js`, `dmv_chat_tools.js`; tests drive the loop with
   scripted provider replies through an arbitrary test connector: run → summarize → write →
   chart; ask_user terminal; budget exhaustion; expired result; unknown field refusal text).
4. **Sidebar** (Chat tab, settings card, preview fixtures, browser tests at 300 and 400 px).
5. **New sources**: YouTube report on Google Ads → TikTok → LinkedIn → Microsoft Ads
   (transport bytes option + unzip + shared OAuth refresh) → Search Console (secondary).
6. **Speed pass**: items 1 and 2 above.
7. **Docs and hygiene**: README (features, sources table, privacy paragraph for AI),
   `docs/chat.md`, `docs/code-layout.md`, `docs/connector-contract.md` (bytes transport,
   OAuth helper), AGENTS.md note; `npm run format`, `npm run check`, `npm test`,
   `npm run test:browser`.

Each phase ends with the full offline test suite green. Live verification (real API keys,
real ad accounts, the Marketplace scope update for Search Console) is the user's step, as
for every existing source.

## 6. Risks and open points

- **Cost and latency**: a turn can involve 3–6 model calls and a provider fetch. The sidebar
  says so; the loop caps rounds and time; `effort: medium` on Anthropic.
- **Model output drift**: tool inputs are validated with the same rules as the UI; bad
  inputs come back as teaching errors, never partial writes.
- **Microsoft Ads** cannot be verified offline beyond fixture shapes; it is the connector to
  test first with a real account.
- **Search Console scope** blocks a production release until the consent screen is updated;
  it ships behind the same manifest change, so it is last.
- **Default model ids** for OpenAI and Gemini change often; the field is editable and
  documented.
