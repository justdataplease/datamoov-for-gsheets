# DataMoov for Google Sheets

A free (for personal and noncommercial use) alternative to Supermetrics that runs entirely inside your Google Sheet, with the source available here. Pull Google Ads (including YouTube), Facebook Ads, TikTok Ads, LinkedIn Ads, Microsoft Ads, GA4, Search Console, HubSpot, Zendesk, PostgreSQL, BigQuery and GitHub data into a tab, keep it fresh on a schedule, or ask for it in plain language and let the chat write the table and the chart. Never send a byte of your data to anyone else.

Created with ♥ by [justdataplease.com](https://justdataplease.com).

## Why DataMoov

- **Your data stays yours.** There is no DataMoov server. Credentials are stored in your own Google account, reports are written into your own spreadsheet, and the only network requests go to the providers you configured.
- **Supermetrics-style workflow.** Pick a source, a connection, a report, a date range and the columns you want. Preview, choose an output cell, save, run, and optionally refresh hourly, daily or weekly.
- **Chat with your data.** Add your own Anthropic, OpenAI or Gemini API key and ask: "spend by campaign last month, in a new tab with a chart". The chat runs the same connections through the same runtime, aggregates on the server side, writes only into empty cells and adds native Sheets charts. See [docs/chat.md](docs/chat.md).
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
| GitHub              | Repository overview                                | Stars, forks, issues and activity for a search or a list of repositories                                                 |

Reports default to 1,000 rows and support up to 20,000 within the provider and storage limits. Saved GA4 and GitHub reports can fetch across multiple executions: choose **Resume** when paused, or let the hourly scheduler continue, even for on-demand reports. Other sources and all previews fetch within one execution. The sheet is updated only when the complete report is ready. See [chunk continuation](docs/chunk-continuation.md) for limits and recovery. Numbers are written as numbers, IDs as text, and dates in ISO format.

## Chat

The **Chat** tab needs an API key from Anthropic, OpenAI or Google Gemini, stored in your private script properties like any other credential. Ask a question; the model chooses the connection and report, the DataMoov runtime fetches and validates the data, `summarize` aggregates it without sending rows to the model, `write_to_sheet` writes through the protected writer, and `create_chart` adds a native Sheets chart. When a request is ambiguous the chat asks and shows the options as buttons. Column names, row samples and aggregates are sent to the AI provider you chose; credentials and full result sets are not. Details, guarantees and the tool list are in [docs/chat.md](docs/chat.md).

## Credentials without an OAuth server

The add-on asks Google for four permissions only: your spreadsheets, outbound requests, triggers for schedules, and the sidebar. It never asks for Google Ads, Analytics, BigQuery or Search Console access of its own. Google sources (Google Ads, GA4, BigQuery, Search Console) take a **service account key** (the default: paste the JSON file and grant that account access in the product), **OAuth client credentials**, or a pasted access token. Every connection form has a **How to get these credentials** guide with the exact console steps for that source, and Google Ads, GA4 and Search Console can **Find accounts** the entered credentials can reach and fill in the ID. LinkedIn Ads and Microsoft Ads accept a pasted access token or their own OAuth client credentials with a refresh token you obtained; TikTok Ads takes a long-lived access token. The OAuth client credentials mode accepts your client ID, client secret and an already-authorized refresh token, then obtains fresh access tokens automatically. Every other source takes a token or database credentials typed into the sidebar. Secrets are never displayed again after saving.

In the **Connection** dialog, select the Google source and a mode, enter the credential, then supply the advertising customer ID (and optional manager ID) for Ads or the numeric property ID for GA4, or use **Find accounts**. BigQuery keeps its query project, location and SQL in report settings. **Save connection** checks new or changed credentials with the provider before storing them; **Preview** verifies the access needed by your report. When editing the same saved credentials, blank secret fields retain their stored values; enter a replacement to rotate a secret. Supply a matching secret and refresh token if you change OAuth clients.

A client ID and secret alone do not grant account access: the refresh token must have been issued for that same client, with the required API scopes and an identity allowed to read the account. DataMoov does not provide an OAuth callback server or a flow to issue the initial refresh token. See Google's [offline-access setup](https://developers.google.com/identity/protocols/oauth2/web-server#offline). Your own credentials do not change the add-on's four Sheets permissions.

You remain responsible for the OAuth client's Cloud project and API access. Google Ads needs production API access (Explorer or higher) approved for that project, plus advertising-account permission for the authorized identity. A legacy developer token is optional. Enable the relevant GA4, BigQuery or Search Console APIs in the credentials' Cloud project. Microsoft Ads needs a developer token and a Microsoft OAuth app with the `msads.manage` scope. PostgreSQL needs a trusted TLS certificate, a read-only role, and network access from Google's IP ranges. See [marketing setup](docs/marketing-connectors.md) and [business connectors](docs/business-connectors.md).

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

Offline tests cover pagination, empty results, zero and false values, row and time limits, unsafe next-page links, custom fields, read-only SQL guards, output protection, continuation checkpoints and scheduling. They do not certify live provider permissions or Google authorization, which you verify in your own spreadsheet.

## Privacy

DataMoov has no backend, no telemetry and no exception upload. Provider credentials and the optional AI key live in the Google user's private script properties, saved report definitions live there too, and report output is written only into the user's spreadsheet. Unfinished continuation rows and provider cursors are staged in that same user's private properties, without authentication material in the snapshot; chat results are staged in the user's private cache for one hour. The transport refuses any host other than the configured providers. Sanitized error messages are stored with the report so you can read them in the sidebar, and nowhere else. Removing a connection or report deletes its stored record; removing a report also clears its continuation. The chat sends column names, row samples and aggregates to the AI provider you chose, and nothing else.

Anyone who can edit the bound Apps Script project can read its code and change it, so share the script only with people you trust.

## License

[PolyForm Strict 1.0.0](LICENSE). Free for personal and noncommercial use. Commercial use, modifications, derivative works and redistribution need written permission from JustDataPlease; ask at [justdataplease.com](https://justdataplease.com). Copyright stays with JustDataPlease.

AKfycbx7ygQ6GBCRt0-KoMdDcMzsY8cVpbsvw5FFmSpZvADYSv9mI2CM60kLLIRvkJNy5k3_hQ
