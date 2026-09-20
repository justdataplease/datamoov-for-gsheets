# DataMoov for Google Sheets

**Privacy first.** DataMoov has no backend that collects or stores data from your connected accounts. Report output lives in your spreadsheet; credentials and temporary processing state are stored in your own Google account. Requests go to your configured source providers, and optional AI chat sends selected data and context to the AI provider you choose.

A free (for personal and noncommercial use) alternative to Supermetrics that runs in Google Apps Script, with the source available here. Pull Google Ads (including YouTube), Facebook Ads, TikTok Ads, LinkedIn Ads, Microsoft Ads, GA4, Search Console, HubSpot, Zendesk, PostgreSQL, BigQuery, Snowflake and GitHub data into a tab, keep it fresh on a schedule, or ask for it in plain language and let the chat write the table and the chart.

Created with ♥ by [justdataplease.com](https://justdataplease.com).

## Google Workspace Marketplace overview

**Short description:** Privacy-first Google Sheets connectors and AI reporting. Free for personal and noncommercial use.

DataMoov puts privacy first: no DataMoov server collects or stores data from your connected accounts. Reports live in your spreadsheet, while credentials and temporary results stay in your own Google storage. Build reports in the sidebar, preview your data, choose an output tab and refresh on demand or on an hourly, daily or weekly schedule.

- **Connect your sources:** Google Ads (including YouTube campaigns), Facebook Ads, TikTok Ads, LinkedIn Ads, Microsoft Ads, Google Analytics 4, Search Console, HubSpot, Zendesk, PostgreSQL, BigQuery, Snowflake and GitHub.
- **Choose the report you need:** Select accounts, dates and columns, discover supported custom fields, or use read-only SQL for PostgreSQL, BigQuery and Snowflake.
- **Protect your spreadsheet:** DataMoov validates the complete report before updating output and stops if someone edited or moved its previous results. Reports support up to 20,000 rows within provider and Apps Script limits.
- **Share report setups:** Definitions travel with the spreadsheet, including SQL and other report settings. Each collaborator supplies their own connection and approves their own schedules; credentials and refresh state remain private.
- **Ask questions and create charts:** Optional chat uses your own Anthropic, OpenAI or Google Gemini API key to summarize data, combine platform reports, write tables and add native Sheets charts. Ask for last month's spend, clicks and impressions by week or campaign across your connected advertising accounts. Currency totals remain separate.
- **Build refreshable dashboards in Chat:** Ask for a report combining multiple sources. Chat saves the setup, writes combined data and a summary to two tabs, and adds suitable charts unless you ask for tables only. Ask for additional formatting or native pivots when needed. Refresh both tables later from the sidebar without another AI call. Live actions, source names and output tabs make each step visible.

DataMoov runs in Google Apps Script with no telemetry. It uses your own Google storage for private credentials, cached results and continuation checkpoints. Bring your own provider token, service account or OAuth credentials; setup guides are included. Chat sends your prompts, relevant connection and report metadata, column names, statistics, row samples and aggregates to your chosen AI provider. Results of 20 rows or fewer may be sent whole. Provider credentials are not included in model messages.

The add-on requests spreadsheet access to read and write reports, external requests to contact configured providers, trigger access for schedules, and permission to display its sidebar. Provider access and configuration are required; refresh times depend on Google triggers and quotas. AI and source-provider charges may apply. Free for personal and noncommercial use; commercial use requires permission.

## Why DataMoov

- **Privacy first.** No DataMoov server collects or stores your connected-account data. Credentials and temporary processing state are stored privately in your Google account, and reports are written into your spreadsheet. Provider requests go to the services you configure; optional chat sends selected data and context to your chosen AI provider.
- **Supermetrics-style workflow.** Pick a source, a connection, a report, a date range and the columns you want. Preview, choose an output cell, save, run, and optionally refresh hourly, daily or weekly.
- **Chat with your data.** Add your own Anthropic, OpenAI or Gemini API key and ask: "spend by campaign last month, in a new tab with a chart". The chat runs the same connections through the same runtime, aggregates on the server side, uses protected report output and adds native Sheets charts. See [docs/chat.md](docs/chat.md).
- **Focused reports, honest results.** Each source ships with the reports people actually use. Output changes only after a complete report succeeds. GA4 and GitHub reports can pause and resume fetching; nothing is silently truncated, and a paused or failed refresh keeps your previous output.
- **Protected output.** DataMoov remembers the exact cells it wrote. If you edit or move them, the next refresh stops instead of overwriting your work.

## Sources and reports

| Source              | Report                                             | Highlights                                                                                                               |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Google Ads          | Daily campaign performance, YouTube video campaigns | Spend, impressions, clicks, conversions, conversion value, optional segments; video views, view rate, CPV and quartiles; field availability checked against the API |
| Facebook Ads        | Daily campaign performance                         | Core delivery metrics plus one explicit purchase action type; unified attribution requested                              |
| TikTok Ads          | Daily campaign performance                         | Spend, delivery, conversions and engagement per auction campaign; account currency from the advertiser profile          |
| LinkedIn Ads        | Daily campaign performance                         | Impressions, clicks, spend, conversions, leads and engagement per campaign, resolved to campaign names                   |
| Microsoft Ads (Bing) | Daily campaign performance                        | Asynchronous Reporting API report: spend, impressions, clicks, conversions, revenue                                       |
| Google Analytics 4  | Daily acquisition                                  | Sessions, users, page views, key events, revenue; discovers custom dimensions and metrics and checks compatibility       |
| Search Console      | Search performance                                 | Clicks, impressions, CTR and position by date, query, page, country or device, with property discovery                   |
| HubSpot             | Deals                                              | Standard deal properties plus discovered custom properties, filtered by created, updated or close date                   |
| Zendesk             | Tickets, ticket metrics                            | Ticket fields with custom fields, and a separate first-reply and resolution-time snapshot                                |
| PostgreSQL          | SQL report                                         | Read-only SELECT or WITH query over TLS, with column discovery                                                           |
| BigQuery            | SQL query                                          | Read-only query with a dry-run schema check and a scan-size cap                                                          |
| Snowflake           | SQL report                                         | Programmatic access token or OAuth, read-only SQL, complete partition retrieval and scoped table discovery for AI chat |
| GitHub              | Repository overview                                | Stars, forks, issues and activity for a search or a list of repositories                                                 |

Reports default to 1,000 rows and support up to 20,000 within the provider and storage limits. Saved GA4 and GitHub reports can fetch across multiple executions: choose **Resume** when paused, or let the hourly scheduler continue, even for on-demand reports. Other sources and all previews fetch within one execution. The sheet is updated only when the complete report is ready. See [chunk continuation](docs/chunk-continuation.md) for limits and recovery. Numbers are written as numbers, IDs as text, and dates in ISO format. Snowflake exact decimals and integers wider than 15 digits remain text to preserve precision.

Saved report definitions live in the spreadsheet's hidden **DataMoovReports** tab, so collaborators and copies of the spreadsheet retain the report setup. Use **Reports > Manage report definitions** in the sidebar to show it. Report settings, including SQL, are visible to spreadsheet collaborators; credentials stay private. Each user chooses their own connection and explicitly enables their own schedule. After a definition changes directly in the sheet, open **Edit** and **Save** in the sidebar to review and approve it before running. A copied spreadsheet needs an empty output area or new tab because output ownership receipts are private and are not copied. See [report storage](docs/report-storage.md).

## Chat

The **Chat** tab needs an API key from Anthropic, OpenAI or Google Gemini, saved under **Settings → AI provider** in your private script properties like any other credential; the card collapses once a key is saved. Ask a question; the model chooses the connection and report, the DataMoov runtime fetches and validates the data, `summarize` computes aggregates in Apps Script, `write_to_sheet` writes through the protected writer, and `create_chart` adds a native Sheets chart. When a request is ambiguous the chat asks and shows the options as buttons. Chat sends prompts and conversation context, relevant connection and report metadata, column names, statistics, row samples and aggregates to your chosen AI provider. Results of 20 rows or fewer may be sent whole. Provider credentials and AI keys are not included in model messages. Details, guarantees and the tool list are in [docs/chat.md](docs/chat.md).

Chat shows live actions while it works and formats answers with bold text, lists and tables. **Show completed actions (debug)** is on by default and keeps the action history below each answer; switch it off in Settings to hide successful histories. Errors and completed sheet updates remain visible. Use the **+** button for a new conversation. Under **Settings > AI provider**, edit **Maximum rows per chat report** (1 to 20,000) and general instructions. For account-specific rules, open **Connections > Edit > Chat instructions** and save them for that connection. All instructions share a 100,000-character limit; existing source rules remain available until you customize each connection. Ask, for example: "Create a new tab with the highest-spend campaign in each month, including spend, clicks and impressions." Chat aggregates first, ranks within each month and keeps currencies separate.

Repeated identical report queries within one chat turn reuse complete results and show **Reused** in Actions. A dashboard refresh always fetches fresh source data.

Chat can also edit existing cells when asked: enter common scalar formulas, format ranges, sort, add filters, freeze rows or columns, and create or rename tabs. It inspects the target first and rejects stale edits. Each edit supports up to 1,000 cells; formulas use supported built-ins and same-tab references. See [chat capabilities and limits](docs/chat.md).

### Reports and dashboards: how they fit together

**Reports** are single-source data tables built in the sidebar. **Dashboards** combine multiple source queries into a refreshable report, created directly in Chat. Both use the same connections, validation and protected writing system. You do not need to create separate saved reports first.

1. Ask Chat: **"Create a monthly performance dashboard combining Google Ads and Facebook, with spend, clicks and impressions by campaign. Put the source data in Marketing data and the report with a chart in Marketing dashboard."**
2. Chat saves the source queries and report rules, fetches every source, then writes the combined data and summary to two tabs and adds suitable charts. Ask for tables only to omit charts. The answer shows what was saved or updated and links to both tabs.
3. Open **Reports > Dashboards** to see the sources, links to both output tabs, row counts, last refresh and any error. Click **Refresh dashboard** to fetch fresh data and rebuild both outputs without asking AI again. Live status explains which source or step is running.

A request such as **"Create a marketing performance week vs previous period"** also creates a saved dashboard once you choose the accounts. By default it compares the last completed Monday-to-Sunday week with the week before. Three accounts use six source queries, one per account per week; refreshing advances both periods together. A question such as "How much did we spend?" returns an analysis without creating a dashboard.

A saved dashboard supports 2 to 8 source queries, up to 20,000 combined rows, and on-demand refresh. Relative dates such as last month are resolved again on refresh; fixed dates stay fixed. Both outputs are validated before one atomic write, so a failed source or blocked destination leaves the previous tables intact. Dashboard plans remain private to their creator in this spreadsheet; unlike shared report definitions, they do not travel with a copied spreadsheet. Remove deletes the setup and keeps the existing tabs. Charts can include future rows; pivots use their selected source range. See [dashboard details and limits](docs/chat.md#saved-multi-source-dashboards).

## Credentials without an OAuth server

The add-on asks Google for four permissions only: your spreadsheets, outbound requests, triggers for schedules, and the sidebar. It never asks for Google Ads, Analytics, BigQuery or Search Console access of its own. Google sources (Google Ads, GA4, BigQuery, Search Console) take a **service account key** (the default: paste the JSON file and grant that account access in the product), **OAuth client credentials**, or a pasted access token. Credentials are saved once under **Settings → Credentials** and reused: a Google credential can serve Google Ads, GA4, BigQuery and Search Console when its identity and grants cover those sources; one Meta system-user token serves every ad account. A connection is a credential picked from a dropdown (or added inline) plus the account, property or database it points at. Every form has a **How to get these credentials** guide with the exact console steps, and Google Ads, GA4 and Search Console can **Find accounts** the credential can reach and fill in the ID. LinkedIn Ads and Microsoft Ads accept a pasted access token or their own OAuth client credentials with a refresh token you obtained; TikTok Ads takes a long-lived access token. The OAuth client credentials mode accepts your client ID, client secret and an already-authorized refresh token, then obtains fresh access tokens automatically. Every other source takes a token or database credentials typed into the sidebar. Secrets are never displayed again after saving.

In the **Connection** dialog, select the Google source and a mode, enter the credential, then supply the advertising customer ID (and optional manager ID) for Ads or the numeric property ID for GA4, or use **Find accounts**. BigQuery keeps its query project, location and SQL in report settings. **Save connection** checks new or changed credentials when the connector declares a connectivity test or Google token support; HubSpot and Zendesk currently require **Preview** to verify access. Editing a saved credential also checks its existing connections where those checks are available. **Preview** verifies the access needed by your report. When editing the same saved credentials, blank secret fields retain their stored values; enter a replacement to rotate a secret. Supply a matching secret and refresh token if you change OAuth clients.

For a prepared credentials bundle, use **Settings > Credentials > Import from file** and choose a local DataMoov JSON file. The file is read in your browser and saved through the signed-in add-on into your private Google properties. Exact matches are reused; different existing credentials are not overwritten. Each new connection is checked before saving, and a rejected connection is reported separately while successful items remain saved. Treat the file like a password and keep it out of shared folders or source control. See [credential import](docs/credential-import.md).

A client ID and secret alone do not grant account access: the refresh token must have been issued for that same client, with the required API scopes and an identity allowed to read the account. DataMoov does not provide an OAuth callback server or a flow to issue the initial refresh token. See Google's [offline-access setup](https://developers.google.com/identity/protocols/oauth2/web-server#offline). Your own credentials do not change the add-on's four Sheets permissions.

You remain responsible for the OAuth client's Cloud project and API access. Google Ads needs production API access (Explorer or higher) approved for that project, plus advertising-account permission for the authorized identity. A legacy developer token is optional. Enable the relevant GA4, BigQuery or Search Console APIs in the credentials' Cloud project. Microsoft Ads needs a developer token and a Microsoft OAuth app with the `msads.manage` scope. PostgreSQL needs a trusted TLS certificate, a read-only role, and network access from Google's IP ranges. Snowflake uses your account hostname, a role limited to reading the required tables, and a programmatic access token or a pasted OAuth token; its network policy must permit Apps Script requests. See [marketing setup](docs/marketing-connectors.md) and [business connectors](docs/business-connectors.md).

The sidebar has four tabs: **Reports** (the list, with the builder behind the + button), **Chat**, **Connections** (the list, with the editor behind +) and **Settings** (AI provider and credentials). Google Sheets sidebars are 300 px wide; **Extensions → DataMoov → Open DataMoov in a window** (or the ⤡ button in the header) opens the same UI in a larger window that leaves the sheet usable.

## Install in your spreadsheet

1. Open the spreadsheet you want to report into and choose **Extensions → Apps Script**. Name the project **DataMoov**: the project name is what appears in the Extensions menu.
2. Copy every file under `src/` into the project, keeping the same names. Files under `src/connectors/` become `connectors/<name>`. Replace the manifest with `src/appsscript.json` (enable **Show "appsscript.json" manifest file** in project settings).
3. Turn on the **Google Sheets API** advanced service if the editor asks for it, then reload the spreadsheet.
4. Choose **Extensions → DataMoov → Open DataMoov**, grant the requested permissions, add a connection, and build your first report.

Developers can instead push with [clasp](https://github.com/google/clasp): run `npm ci --ignore-scripts`, `npm run login`, then `DATAMOOV_DEV_SPREADSHEET_ID=<your spreadsheet id> node tools/create-dev.mjs` once and `npm run push:dev` for each release. For a production spreadsheet, record it in `data/production-project.json` with `"production": true` and run `npm run push:prod` with `DATAMOOV_CONFIRM=<scriptId>`.

## Add a source

One file under `src/connectors/` declares a source: its credential fields, allowed hosts, reports, fields, optional field discovery and a `fetch(ctx)` that returns complete rows. Reports may also supply `fetchChunk(ctx, state)` for saved-report continuation. The sidebar, storage, transport, scheduler and Sheets writer are provider-independent. Read [the connector contract](docs/connector-contract.md) and [code layout](docs/code-layout.md).

## Develop and test

Requires Node.js 22 or newer.

```
npm ci --ignore-scripts
npm run check          # Apps Script sources compile individually and as one bundle
npm test               # offline tests with provider-shaped fixtures
npm run test:browser   # sidebar tests in Chrome against a local preview
npm run preview        # http://127.0.0.1:8891 with sample data, no Google calls
npm run format         # Prettier
```

The optional `tools/live-check.mjs` harness runs the production adapters and chat loop with real provider HTTP while keeping Sheets, properties, cache and triggers in memory. Live credentials must stay in ignored local files, and output should contain only sanitized verification results. This harness does not certify execution inside Apps Script or real spreadsheet writes.

Offline tests cover pagination, empty results, zero and false values, row and time limits, unsafe next-page links, custom fields, read-only SQL guards, output protection, continuation checkpoints and scheduling. They do not certify live provider permissions or Google authorization, which you verify in your own spreadsheet.

## Privacy

DataMoov has no backend that collects or stores data from connected accounts, no telemetry and no exception upload. Report definitions and output live in your spreadsheet; the hidden **DataMoovReports** tab contains configuration, including SQL, that spreadsheet collaborators can read. Hiding that tab does not make it private. Provider credentials, connections, the optional AI key, each user's report approvals and schedules, saved dashboard plans, run state and output receipts stay in that Google user's private script properties. Unfinished continuation rows and provider cursors are staged in those same private properties, without authentication material in the snapshot; chat results are staged in the user's private cache for one hour. The transport refuses any host other than the configured providers. Sanitized errors stay in private run state for the sidebar. Chat sends prompts and conversation context, relevant connection and report metadata, column names, statistics, row samples and aggregates to your chosen AI provider. Results of 20 rows or fewer may be sent whole. Provider credentials and AI keys are not included in model messages.

Anyone who can edit the bound Apps Script project can read its code and change it, so share the script only with people you trust.

## License

[PolyForm Strict 1.0.0](LICENSE). Free for personal and noncommercial use. Commercial use, modifications, derivative works and redistribution need written permission from JustDataPlease; ask at [justdataplease.com](https://justdataplease.com). Copyright stays with JustDataPlease.
