# Business connector reference

These are standalone Apps Script connectors. Tests use offline provider-shaped
responses. Credentials are entered in the sidebar and kept in the Google user's
private script properties.

## HubSpot

Use a private-app access token with deals read access. The Deals report includes
deal ID/name, pipeline/stage IDs, owner ID, amount/currency, and create/close/update
dates. The field picker can discover additional non-sensitive deal properties.

The date filter can use created, modified, or close date and is inclusive in UTC.
Reports return current property values, not historical pipeline snapshots. Paging
continues to completion; a row-budget overflow or inconsistent result total
fails before the sheet is replaced. HubSpot search itself has an indexing delay.
See the official [deals search](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/search/search-deals)
and [property catalog](https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide).

## Zendesk

Use the account subdomain, an agent email, and an API token. The Tickets report
uses cursor-based search export with an inclusive created/updated date range in
UTC. It supports account-specific custom ticket fields. Search indexing can lag
recent changes, and deleted tickets are excluded. See
[search export](https://developer.zendesk.com/api-reference/ticketing/ticket-management/search/)
and [ticket fields](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_fields/).

Ticket metrics is a separate snapshot report for replies, reopens, and first
reply/full resolution times. It pages the bulk endpoint and makes no per-ticket
requests. The provider excludes archived tickets from this endpoint; the report
is labelled accordingly. Calendar and business-minute fields remain separate.
See [ticket metrics](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_metrics/).

## BigQuery

Use a **service account key** (the default), **OAuth client credentials**, or
an access token; the add-on has no BigQuery permission of its own.
The principal needs BigQuery Job User on the query project and Data Viewer on
the queried datasets. The connector requests the `bigquery.readonly` OAuth
scope for its own tokens, which the [queries endpoint](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query)
supports separately from IAM permissions. **Datasets for chat** (optional,
comma-separated `project.dataset`) tells the chat which datasets it may
explore with `describe_database`; reports are not limited by it.

For **OAuth client credentials**, open the **Connection** dialog and enter your
client ID, client secret and an already-authorized refresh token issued for that
same client with `https://www.googleapis.com/auth/bigquery.readonly` access.
The client ID and secret alone do not grant dataset or project access. Enable
the BigQuery API in your credentials' Cloud project and grant the authorized
identity the required IAM permissions. DataMoov obtains access tokens
automatically from the refresh token; it does not provide an OAuth callback
server or issue the initial refresh token. See Google's
[offline-access setup](https://developers.google.com/identity/protocols/oauth2/web-server#offline).

Choose **Save connection**, then configure a report and **Preview** it. Saving
new or changed OAuth credentials verifies the token exchange only, not
BigQuery project or dataset permissions. **Query project ID**, **Location**,
**Read-only SQL** and **Maximum bytes billed** remain report settings, unchanged
by the authentication mode. Use an actual preview to check access to the
selected query project and data.

When editing the same saved OAuth credentials, blank secret fields retain the
stored values; enter replacements to rotate them. A different client ID needs
its matching secret and refresh token. Keep different clients separate with a
new connection where appropriate. Custom OAuth does not bypass the add-on's
existing Apps Script/Sheets permission grant; the manifest scopes are unchanged.
Native authorization, refresh-token OAuth and service accounts can support
scheduled refreshes; pasted expiring access tokens need manual replacement.

The connector accepts one SELECT or WITH query. A shared conservative scanner
rejects write keywords, scripts, wrapper escapes, and incomplete syntax. Raw,
bytes, triple-quoted, backslash-escaped, and dollar-quoted literals are currently
unsupported. The query is wrapped as a SELECT subquery with `LIMIT maxRows + 1`;
the identical wrapped statement is dry-run validated and then executed.
Field discovery reads the dry-run schema. There is no write job, dataset
mutation, or destination-table parameter.

Queries use a default 1 GiB maximum bytes billed, configurable up to 10 GiB.
Dry-run estimates are checked before execution, and the execution request also
enforces the maximum bytes billed. The connector polls unfinished jobs and
reads every result page within the execution/row budget. Incomplete or
oversized results fail instead of silently truncating. Job timeout is requested
at 45 seconds; the provider documents timeout cancellation as best effort.
See [query request limits](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query).

Large integers and NUMERIC/BIGNUMERIC values preserve their exact text. Nested
and repeated values become JSON text cells. Nulls become empty cells; zero and
false remain distinct values. Harmless schema descriptions/default modes do
not invalidate a report, but changed columns/types require field refresh.

## Verification

Run `node --test tests/business-connectors.test.mjs tests/sql.test.mjs` and
`npm run check`. Coverage includes pagination, date boundaries, zero/false
values, custom fields, row-budget failure, blocked credential forwarding,
read-only SQL boundaries, dry-run scan caps, async jobs, result completeness,
and precise numeric/nested value handling.

DataMoov
