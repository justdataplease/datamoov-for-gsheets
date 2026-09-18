# DataMoov for Google Sheets

A free (for personal and noncommercial use) alternative to Supermetrics that runs entirely inside your Google Sheet, with the source available here. Pull Google Ads, Facebook Ads, GA4, HubSpot, Zendesk, PostgreSQL, BigQuery and GitHub data into a tab, keep it fresh on a schedule, and never send a byte of your data to anyone else.

Created with ♥ by [justdataplease.com](https://justdataplease.com).

## Why DataMoov

- **Your data stays yours.** There is no DataMoov server. Credentials are stored in your own Google account, reports are written into your own spreadsheet, and the only network requests go to the provider you configured.
- **Supermetrics-style workflow.** Pick a source, a connection, a report, a date range and the columns you want. Preview, choose an output cell, save, run, and optionally refresh hourly, daily or weekly.
- **Focused reports, honest results.** Each source ships with the reports people actually use. A report either completes in full or fails with a clear message. Nothing is silently truncated, and a failed refresh never touches your previous output.
- **Protected output.** DataMoov remembers the exact cells it wrote. If you edit or move them, the next refresh stops instead of overwriting your work.

## Sources and reports

| Source | Report | Highlights |
| --- | --- | --- |
| Google Ads | Daily campaign performance | Spend, impressions, clicks, conversions, conversion value, optional segments; field availability checked against the API |
| Facebook Ads | Daily campaign performance | Core delivery metrics plus one explicit purchase action type; unified attribution requested |
| Google Analytics 4 | Daily acquisition | Sessions, users, page views, key events, revenue; discovers custom dimensions and metrics and checks compatibility |
| HubSpot | Deals | Standard deal properties plus discovered custom properties, filtered by created, updated or close date |
| Zendesk | Tickets, ticket metrics | Ticket fields with custom fields, and a separate first-reply and resolution-time snapshot |
| PostgreSQL | SQL report | Read-only SELECT or WITH query over TLS, with column discovery |
| BigQuery | SQL query | Read-only query with a dry-run schema check and a scan-size cap |
| GitHub | Repository overview | Stars, forks, issues and activity for a search or a list of repositories |

Reports default to 1,000 rows and support up to 5,000. Numbers are written as numbers, IDs as text, and dates in ISO format.

## Credentials without an OAuth server

Google sources (Google Ads, GA4, BigQuery) use Google's own authorization screen inside Sheets, or a pasted access token, or a service-account JSON key for unattended refreshes. Every other source takes a token or database credentials typed into the sidebar. Secrets are never displayed again after saving.

Credentials do not grant access by themselves. Google Ads needs a developer token and account access. GA4 and BigQuery need their APIs enabled in the Cloud project associated with the script. PostgreSQL needs a trusted TLS certificate, a read-only role, and network access from Google's IP ranges. See [marketing setup](docs/marketing-connectors.md) and [business connectors](docs/business-connectors.md).

## Install in your spreadsheet

1. Open the spreadsheet you want to report into and choose **Extensions → Apps Script**.
2. Copy every file under `src/` into the project, keeping the same names. Files under `src/connectors/` become `connectors/<name>`. Replace the manifest with `src/appsscript.json` (enable **Show "appsscript.json" manifest file** in project settings).
3. Turn on the **Google Sheets API** advanced service if the editor asks for it, then reload the spreadsheet.
4. Choose **DataMoov → Open DataMoov**, grant the requested permissions, add a connection, and build your first report.

Developers can instead push with [clasp](https://github.com/google/clasp): run `npm ci --ignore-scripts`, `npm run login`, then `DATAMOOV_DEV_SPREADSHEET_ID=<your spreadsheet id> node tools/create-dev.mjs` once and `npm run push:dev` for each release. For a production spreadsheet, record it in `data/production-project.json` with `"production": true` and run `npm run push:prod` with `DATAMOOV_CONFIRM=<scriptId>`.

## Add a source

One file under `src/connectors/` declares a source: its credential fields, allowed hosts, reports, fields, optional field discovery and a `fetch(ctx)` that returns complete rows. The sidebar, storage, transport, scheduler and Sheets writer are provider-independent. Read [the connector contract](docs/connector-contract.md) and [code layout](docs/code-layout.md).

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

Offline tests cover pagination, empty results, zero and false values, row and time limits, unsafe next-page links, custom fields, read-only SQL guards, output protection and scheduling. They do not certify live provider permissions or Google authorization, which you verify in your own spreadsheet.

## Privacy

DataMoov has no backend, no telemetry and no exception upload. Provider credentials live in the Google user's private script properties, saved report definitions live there too, and report output is written only into the user's spreadsheet. The transport refuses any host other than the configured provider. Sanitized error messages are stored with the report so you can read them in the sidebar, and nowhere else. Removing a connection or report deletes its stored record.

Anyone who can edit the bound Apps Script project can read its code and change it, so share the script only with people you trust.

## License

[PolyForm Strict 1.0.0](LICENSE). Free for personal and noncommercial use. Commercial use, modifications, derivative works and redistribution need written permission from JustDataPlease; ask at [justdataplease.com](https://justdataplease.com). Copyright stays with JustDataPlease.
