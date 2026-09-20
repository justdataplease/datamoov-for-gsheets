# Marketing connector contract

All requests originate in Apps Script; there is no DataMoov backend. Tests use offline provider-shaped fixtures, not live accounts.

## Included reports

| Connector / report              | Default fields                                                                                          | Customization                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google_ads / campaign_daily`   | Date, account ID, currency, campaign ID/name, spend, impressions, clicks, conversions, conversion value | A curated campaign-compatible field list, checked against Google Ads field metadata; optional device/network segmentation, status, account metadata and additional metrics |
| `facebook_ads / campaign_daily` | Date, account ID, currency, campaign ID/name, spend, impressions, clicks, purchases, purchase value     | Supported report fields plus one explicitly selected purchase action type; field discovery returns this curated list                                                       |
| `facebook_ads / insights`       | Date, currency, campaign, spend, impressions, clicks, link clicks, purchases, purchase value           | Level, period and breakdowns follow the selected columns; delivery, reach, video and action metrics; field discovery adds the account's own action types and custom conversions |
| `ga4 / acquisition_daily`       | Date, session source/medium/campaign, sessions, active users, page views, key events, revenue           | Property metadata includes custom dimensions/metrics; selected fields must pass GA4 compatibility checks                                                                   |
| `google_ads / youtube_campaign_daily` | Date, account, currency, campaign, spend, impressions, video views, view rate, average CPV, clicks, conversions, conversion value | Video (YouTube) campaigns only; optional quartile completion rates, subtype, status, CTR and CPM                                                                  |
| `linkedin_ads / campaign_daily` | Date, campaign ID/name, impressions, clicks, spend, conversions                                          | Optional landing-page clicks, conversion value, lead-form leads, likes, comments, shares, follows, engagements, video views and completions (at most 18 metrics)           |
| `microsoft_ads / campaign_daily` | Date, account ID, currency, campaign ID/name, spend, impressions, clicks, conversions, revenue          | Optional account name, status, CTR, average CPC and return on ad spend                                                                                                     |
| `search_console / search_performance` | Date, query, clicks, impressions, CTR, position                                                    | Optional page, country and device dimensions; selected dimensions define the grouping                                                                                      |

### Microsoft Ads report levels

Beside the daily campaign report there is one report per Microsoft Advertising report type:
account, campaign, ad group, ad, keyword, search term, geography, user location, age and gender,
professional demographics, audience, landing page, Shopping product, Performance Max asset
group, conversions by goal, goals and funnels, keyword impression share and website placements.

- **Period:** Date, Week (from Monday), Month, Day of week or Hour of day; only one. With none,
  rows are totals for the date range, ranked by spend, and the row limit keeps the top of the
  ranking. Microsoft reports whole weeks and months, so the first and last period can include
  days outside the range; the report notes say so.
- **Columns:** each level starts with its usual dimensions and metrics. **Load columns** reads
  the report type's column list from the service's own schema (its public WSDL), so every column
  Microsoft defines is offered. Columns are typed by name: money, rates, counts, scores, text.
- **Restrictions:** impression share and top impression rate columns cannot be combined with
  match type (bid), device OS, goal, top vs. other or budget columns. Microsoft refuses the
  request and the message says which side to remove.
- **Find accounts** lists the accounts the signed-in user can reach and fills the account ID and
  customer ID. An app registered for one organisation only needs its **Tenant ID**.
- Reports are downloaded from `bingadsappsstorageprod.blob.core.windows.net`, the storage
  account Microsoft's download URLs point to (checked against the live API), beside the two
  documented download hosts.

### LinkedIn Ads Analytics

The **Analytics (any level and audience)** report takes its grouping from the selected columns:
campaign group, campaign or creative, and the audience columns (company, company size,
industry, seniority, job title, job function, country, region, placement, device). LinkedIn
groups by at most three. Date gives daily rows, Month monthly rows; with neither, rows are totals
ranked by spend. CTR, CPC and CPM are computed from the counts LinkedIn returns.

- Campaign and campaign group names come from the account; audience values arrive as URNs and
  are named through `adTargetingEntities`. A value LinkedIn does not name keeps its id.
- Audience rows are approximate, need at least 3 events, keep the top 100 values per creative
  per day, lag up to a day and reach back two years. Conversion value and reach are not
  available by audience.
- A request holds at most 18 metrics and LinkedIn returns at most 15,000 rows without paging; a
  report that hits the ceiling fails instead of being cut. There is no weekly grain in the API.

### Facebook Ads Insights

The **Insights (any level and breakdown)** report returns one row per combination of the
dimensions selected, so the columns decide the request:

- **Level:** Ad or Ad ID asks Meta for ad rows; otherwise Ad set, then Campaign (or Objective,
  Buying type); with none of them the rows are account totals.
- **Period:** Date gives daily rows, Month calendar months, Week calendar weeks from Monday cut
  to the requested dates (the same rule as the chat's weekly buckets; at most 60 weeks). With
  none, each row covers the whole date range. Only one of the three can be selected. Reach,
  frequency and unique clicks come from Meta at the selected period, which is why Week and
  Month are requested from Meta instead of being added up from days.
- **Breakdowns:** Age, Gender, Country, Region, DMA region, Platform, Placement, Impression
  device, Device platform and Hour of day are sent as `breakdowns`. Meta supports only some
  combinations (age with gender; platform with placement and impression device); a refused
  combination is reported in Meta's words. Hourly rows have no reach or frequency.
- **Actions:** Leads, landing page views, adds to cart, checkouts, registrations, app installs,
  messaging conversations, post engagement and video plays are listed. Any other action type is
  a column named `actions:<type>`, `action_values:<type>` or `cost_per_action_type:<type>`.
  **Load columns** reads the action types the account reported in the last 90 days and lists
  them, custom conversions under their own names. An action that did not happen is 0; a cost
  per action that Meta did not report stays empty.

Purchases, purchase value and ROAS keep using the one purchase action type set on the report.
Reach, frequency, unique clicks, rates and costs per result are marked as not additive, so Chat
and dashboards never sum them. The daily campaign report is unchanged.

### Google Ads report levels

Beside the daily campaign report, the report builder lists one report per Google Ads level:
account, campaign, ad group, ad, keyword, search term, negative keywords (campaign and ad group),
conversion action, geography, age, gender, audience, landing page, placement, Performance Max
asset group and Shopping product. Each level starts with its usual dimensions and the core
metrics selected. **Load columns** asks `GoogleAdsFieldService` for every attribute, segment and
metric compatible with that level's resource and appends them unselected; the search box above
the list finds a field by label or GAQL name. The builder keeps choices already made when columns
are loaded again.

- Levels are built on the custom query path, so typing, micros conversion, currency and the date
  range behave the same way. Rows without impressions are left out.
- Choosing **Date** (or week, month) makes the report a trend, ordered by date; it must fit the
  row limit. Without a date column the report is a ranking ordered by spend, and the row limit
  keeps the top rows ("Top 10,000 rows by spend" appears in the report notes).
- Negative keyword levels have no metrics or period; their notes say "No date range".
- A few metrics are not offered at levels where Google rejects them (for example average CPM on
  Shopping products). These were found by running every curated field against the live API.
- The levels are for the manual builder. Chat uses the custom query instead, which can express
  any of them.

One request returns at most the row limit plus one row: Google Ads pages hold 10,000 rows
whatever the client asks, and a response is capped at 8 MB, so the query carries a `LIMIT`
rather than downloading a report that would be refused anyway.

YouTube Ads has no API of its own: video campaigns are bought and reported through Google Ads, so the YouTube report uses the Google Ads connection and adds `campaign.advertising_channel_type = 'VIDEO'` to the same daily campaign query. View rate and quartile rates are ratios; CPV is converted from micros.


**LinkedIn Ads** uses `adAnalytics` (`q=analytics`, `pivot=CAMPAIGN`, `timeGranularity=DAILY`) with the versioned REST API (`Linkedin-Version` `202606`) and the Rest.li 2.0 protocol header, requesting only the selected metrics plus `dateRange` and `pivotValues`. LinkedIn returns at most 15,000 elements without pagination; the report fails if that ceiling is reached. Campaign names come from the account's campaign search, paged by `pageToken`, and the currency from the ad account. Supply the numeric sponsored account ID and either an access token with `r_ads` and `r_ads_reporting` (the account and campaign-name lookups need `r_ads`; 60-day lifetime) or your own client ID, client secret and refresh token; the refresh exchange uses LinkedIn's fixed token endpoint and the replacement refresh token LinkedIn issues is stored on the connection. [Ads reporting](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting)

**Microsoft Ads (Bing)** uses the Reporting API v13 REST endpoints: `GenerateReport/Submit` with a `CampaignPerformanceReportRequest` (daily aggregation, CSV format version 2.0, account scope, custom date range), `GenerateReport/Poll` every three seconds while pending, then a download of the zipped CSV within Microsoft's five-minute window. The download URL must be on a known Microsoft download host; anything else is refused before the request is made. Cells are parsed from text: thousands separators and percent signs are removed, percentages become ratios, and dates accept both `YYYY-MM-DD` and `M/D/YYYY`. Supply the numeric account ID, customer ID, developer token, and either an access token (one-off previews) or a Microsoft app's client ID, client secret and refresh token granted with `https://ads.microsoft.com/msads.manage offline_access`; Microsoft rotates refresh tokens on every use and the replacement is stored on the connection, so scheduled reports keep working past the original token's lifetime. The connection test submits a one-day, one-column report request (never downloaded) so a wrong developer token or account ID fails at save time. The report time zone is the account default. [Request and download a report](https://learn.microsoft.com/en-us/advertising/guides/request-download-report?view=bingads-13)

**Search Console** uses the Search Analytics `query` method for web search with the selected dimensions and one request of up to `maxRows + 1` rows (the API allows 25,000). Its own tokens carry the `https://www.googleapis.com/auth/webmasters.readonly` scope; the add-on manifest declares no Search Console scope. **Find accounts** lists the properties the entered credentials can read, or enter `sc-domain:example.com` or `https://example.com/` yourself. Search Console reports in Pacific time and omits anonymized queries. [Search Analytics](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)

The Google Ads report retains daily campaign grain when output columns are deselected. Optional segments add to that grain. The Facebook Ads daily campaign report remains daily campaign grain; its Insights report takes the grain from the selected columns. In GA4, selected dimensions define grouping; removing the date dimension requests a period aggregate directly from GA4.

## Authentication and setup

The add-on never asks Google for Ads, Analytics, BigQuery or Search Console permissions; its manifest carries only the spreadsheet, outbound request, trigger and sidebar scopes. Google Ads, GA4 and Search Console take a **service account key** (the default), **OAuth client credentials**, or a manually supplied access token. The shared Apps Script runtime mints or refreshes Google access tokens from those credentials; the adapters declare the scopes they require. Tokens and keys are never report output fields. Each connection form opens a **How to get these credentials** guide with the Cloud Console steps for the chosen mode and the product-specific grant (for example Google Ads → Admin → Access and security for the service account email).

**Find accounts** is optional in every mode: it lists the accounts or properties the entered credentials can reach and fills in the ID field, which stays editable. Google Ads discovery includes enabled advertising accounts reached through accessible managers and selects the required manager context. GA4 discovery requires the **Google Analytics Admin API** enabled in the credentials' Cloud project. [Account summaries](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list)

New or changed credentials are checked with the provider before saving. A saved connection already used by a report cannot be reassigned to another account; create a new connection and report instead. Existing saved connections keep their IDs, and no report output or continuation state is reset by account discovery.

### Using your own OAuth client

1. In your own Google Cloud project, enable the required API and configure an OAuth client. Obtain an already-authorized refresh token for that same client and the required scope below, from a Google identity with access to the account or property. A client ID and secret alone are not account permission. Google's [offline-access instructions](https://developers.google.com/identity/protocols/oauth2/web-server#offline) explain the initial authorization; DataMoov does not supply a callback server or token-issuance flow.
2. Open the **Connection** dialog, select Google Ads or GA4, and choose **OAuth client credentials** under **Google authorization**. Enter **OAuth client ID**, **OAuth client secret** and **OAuth refresh token**.
3. For Ads, enter the advertising **Customer ID** and, if required for manager-mediated access, the **Manager customer ID**. The legacy developer token remains optional. For GA4, enter the numeric **Property ID**.
4. Choose **Save connection**, then **Test** or **Preview** a report. New or changed OAuth credentials are checked before saving; report preview verifies the requested fields and data access. A label-only edit does not repeat the authorization check. DataMoov refreshes access tokens automatically, including during scheduled runs, while the refresh token remains valid.

Stored client secrets and refresh tokens are never sent back to the form. When editing the same saved OAuth credentials, leave a secret field blank to retain its value, or enter a replacement to rotate it. If you change the client ID, supply the matching client secret and refresh token; a new connection is the clearest way to keep different clients or accounts separate. Revoked or expired refresh tokens require fresh authorization outside DataMoov.

This mode changes provider authentication only. It does not bypass the add-on's existing Apps Script/Sheets authorization, and it does not change the manifest scopes. You manage your OAuth project's consent configuration, API enablement, production-access approval and source-account permissions.

### Provider requirements

- **Google Ads:** enable Google Ads API in the Cloud project that issues the credentials. Production advertising accounts require **Explorer or higher access** approved in that project's **Google Ads API Overview**; merely enabling the API is insufficient. Select an accessible account through **Find accounts**, or enter the customer and optional manager IDs. Account permission for the authorized identity is a separate requirement. The legacy developer token is optional: since September 9, 2026, Google bases API access on the OAuth credentials' Cloud project and ignores that token. [Google Ads access migration](https://developers.google.com/google-ads/api/docs/api-policy/developer-token) For service accounts, add the service-account email in Google Ads **Admin → Access and security**. The required scope is `https://www.googleapis.com/auth/adwords`; Google does not provide a reporting-only scope for this API, but this connector calls only search/metadata methods. [Google Ads service accounts](https://developers.google.com/google-ads/api/docs/oauth/service-accounts)
- **GA4:** enable the Google Analytics Data API (and the Admin API for **Find accounts**) in the credentials' Cloud project. Select a property with **Find accounts** or enter its numeric property ID. Grant the authorized Google identity or service-account email access to that property. The required scope is `https://www.googleapis.com/auth/analytics.readonly`. [Data API quickstart](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart-client-libraries)
- **Facebook Ads:** supply an ad account ID and access token with `ads_read` access to that account. Field customization does not require access to campaign mutation APIs. The adapter uses Marketing API `v26.0`, matching the current version in Meta's own SDK configuration. [Meta SDK API configuration](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/apiconfig.py)

Manually supplied Google access tokens expire and must be replaced. Service-account keys and OAuth client credentials with a valid refresh token support scheduled refreshes. Provider-side API activation, permissions, Cloud project production-access approval, and account access still require live verification.

## Data semantics

Google Ads uses REST `v25` search with complete page-token traversal. Spend, average CPC, and average CPM are converted from micros to major account-currency units. Conversion counts remain fractional. Optional provider CTR is already a ratio. The release and request versions were checked against Google's current documentation. [Google Ads releases](https://developers.google.com/google-ads/api/docs/release-notes), [REST search](https://developers.google.com/google-ads/api/rest/common/search)

Google field discovery queries the selected curated names through `GoogleAdsFieldService` and excludes fields that are unavailable or repeated. The curated reports do not advertise every resource; the **Custom query (GAQL)** report does: it sends one validated `SELECT ... FROM resource` statement to the same read-only search endpoint, adds the report date range when metrics or segments are selected (attribute-only resources such as negative keywords have no period), converts micros to account currency and types columns from their GAQL names. Its field discovery lists resources, or the attributes, metrics and segments one resource supports. The provider rejects incompatible combinations during report execution before any sheet write. [Google field metadata](https://developers.google.com/google-ads/api/docs/concepts/field-service)

Facebook Insights money is already in major currency units. Purchase counts and value come from exactly one action type (default `omni_purchase`) across `actions` and `action_values`; overlapping action types are never summed. Missing purchase entries become zero. A malformed metric fails the report. Optional CTR is divided by 100 to produce a Sheets percentage ratio. ROAS is purchase value divided by spend and is blank at zero spend.

Meta unified attribution is explicitly requested. The output metadata states that attribution and action-report timing are governed by the provider's ad-set/reporting settings. DataMoov offers no unsupported promise to override those settings. The optional `attribution_setting` field exposes the provider's row value. These supported field/parameter names were checked in Meta's maintained SDK; the direct Meta documentation pages were unavailable to the documentation browser. [Meta Insights fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py), [Meta account Insights parameters](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py)

GA4 uses REST `v1beta`. It retrieves property metadata, excludes metrics blocked for the current identity, separates dimensions from metrics, and validates compatibility before running a report. It follows offsets to the reported row count and rejects changed/incomplete page totals. Sampling, thresholding, and data loss through the `(other)` row cause a visible error rather than a report presented as complete. Active users are per-row values; no total is manufactured by adding users across dates or acquisition groups. [Metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/getMetadata), [metric restrictions](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricMetadata), [compatibility](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/checkCompatibility), [report response metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData)

All reports retain source currency/time-zone metadata, preserve string IDs, zero and missing values, and reject invalid dates/fields. They refresh the full selected range, allowing late attribution changes to replace prior values. Reports have strict row/request/time budgets. Hitting a budget fails the run; a partial result is never accepted as complete. The shared runtime fetches and validates before writing a sheet.

## Verification

`node --test tests/marketing-connectors.test.mjs tests/ad-connectors.test.mjs` covers provider payload mapping, the YouTube filter, LinkedIn request shape and name resolution, the Microsoft submit/poll/download/unzip path, Search Console discovery and overflow, zeros/false/fractional values, complete paging, empty results, bad fields and dates, row/time limits, unsafe or repeated cursors, GA4 custom fields/blocked metrics/compatibility, and incomplete or lossy GA4 responses. `npm run check` validates Apps Script source syntax. These are offline checks with fake transports. They do not certify actual account permissions, provider response availability, Google authorization screens, or live Sheets writes.
