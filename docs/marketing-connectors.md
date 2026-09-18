# Marketing connector contract

All requests originate in Apps Script; there is no DataMoov backend. Tests use offline provider-shaped fixtures, not live accounts.

## Included reports

| Connector / report | Default fields | Customization |
| --- | --- | --- |
| `google_ads / campaign_daily` | Date, account ID, currency, campaign ID/name, spend, impressions, clicks, conversions, conversion value | A curated campaign-compatible field list, checked against Google Ads field metadata; optional device/network segmentation, status, account metadata and additional metrics |
| `facebook_ads / campaign_daily` | Date, account ID, currency, campaign ID/name, spend, impressions, clicks, purchases, purchase value | Supported report fields plus one explicitly selected purchase action type; field discovery returns this curated list |
| `ga4 / acquisition_daily` | Date, session source/medium/campaign, sessions, active users, page views, key events, revenue | Property metadata includes custom dimensions/metrics; selected fields must pass GA4 compatibility checks |

The Google Ads report retains daily campaign grain when output columns are deselected. Optional segments add to that grain. Facebook Ads remains daily campaign grain. In GA4, selected dimensions define grouping; removing the date dimension requests a period aggregate directly from GA4.

## Authentication and setup

Google Ads and GA4 support the native Google account authorization screen, a manually supplied access token, or a service-account JSON key. The shared Apps Script runtime obtains Google access tokens; the adapters declare the scopes they require. Tokens and keys are never report output fields. Native authorization uses the account running the report or owning its refresh trigger.

- **Google Ads:** enable Google Ads API for the script's associated Google Cloud project, supply a developer token and advertising customer ID, and optionally a manager customer ID. The Google identity must have access to that account. For service accounts, add the service-account email in Google Ads **Admin → Access and security**. The required scope is `https://www.googleapis.com/auth/adwords`; Google does not provide a reporting-only scope for this API, but this connector calls only search/metadata methods. [Google Ads service accounts](https://developers.google.com/google-ads/api/docs/oauth/service-accounts)
- **GA4:** enable Google Analytics Data API for the associated Cloud project and enter the numeric property ID. Grant the Google identity or service-account email access to that property. The required scope is `https://www.googleapis.com/auth/analytics.readonly`. [Data API quickstart](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart-client-libraries)
- **Facebook Ads:** supply an ad account ID and access token with `ads_read` access to that account. Field customization does not require access to campaign mutation APIs. The adapter uses Marketing API `v26.0`, matching the current version in Meta's own SDK configuration. [Meta SDK API configuration](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/apiconfig.py)

Manually supplied Google access tokens expire and must be replaced. Native account or service-account authorization is preferable for scheduled refreshes. Provider-side API activation, permissions, developer-token approval, and account access still require live verification.

## Data semantics

Google Ads uses REST `v25` search with complete page-token traversal. Spend, average CPC, and average CPM are converted from micros to major account-currency units. Conversion counts remain fractional. Optional provider CTR is already a ratio. The release and request versions were checked against Google's current documentation. [Google Ads releases](https://developers.google.com/google-ads/api/docs/release-notes), [REST search](https://developers.google.com/google-ads/api/rest/common/search)

Google field discovery queries the selected curated names through `GoogleAdsFieldService` and excludes fields that are unavailable or repeated. It does not advertise access to every resource or all GAQL combinations. The provider rejects incompatible combinations during report execution before any sheet write. [Google field metadata](https://developers.google.com/google-ads/api/docs/concepts/field-service)

Facebook Insights money is already in major currency units. Purchase counts and value come from exactly one action type (default `omni_purchase`) across `actions` and `action_values`; overlapping action types are never summed. Missing purchase entries become zero. A malformed metric fails the report. Optional CTR is divided by 100 to produce a Sheets percentage ratio. ROAS is purchase value divided by spend and is blank at zero spend.

Meta unified attribution is explicitly requested. The output metadata states that attribution and action-report timing are governed by the provider's ad-set/reporting settings. DataMoov offers no unsupported promise to override those settings. The optional `attribution_setting` field exposes the provider's row value. These supported field/parameter names were checked in Meta's maintained SDK; the direct Meta documentation pages were unavailable to the documentation browser. [Meta Insights fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py), [Meta account Insights parameters](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py)

GA4 uses REST `v1beta`. It retrieves property metadata, excludes metrics blocked for the current identity, separates dimensions from metrics, and validates compatibility before running a report. It follows offsets to the reported row count and rejects changed/incomplete page totals. Sampling, thresholding, and data loss through the `(other)` row cause a visible error rather than a report presented as complete. Active users are per-row values; no total is manufactured by adding users across dates or acquisition groups. [Metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/getMetadata), [metric restrictions](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricMetadata), [compatibility](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/checkCompatibility), [report response metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData)

All reports retain source currency/time-zone metadata, preserve string IDs, zero and missing values, and reject invalid dates/fields. They refresh the full selected range, allowing late attribution changes to replace prior values. Reports have strict row/request/time budgets. Hitting a budget fails the run; a partial result is never accepted as complete. The shared runtime fetches and validates before writing a sheet.

## Verification

`node --test tests/marketing-connectors.test.mjs` covers provider payload mapping, zeros/false/fractional values, complete paging, empty results, bad fields and dates, row/time limits, unsafe or repeated cursors, GA4 custom fields/blocked metrics/compatibility, and incomplete or lossy GA4 responses. `npm run check` validates Apps Script source syntax. These are offline checks with fake transports. They do not certify actual account permissions, provider response availability, Google authorization screens, or live Sheets writes.
