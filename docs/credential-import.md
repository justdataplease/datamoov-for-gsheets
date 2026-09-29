# Export and import your settings

**Settings > Credentials** has three buttons:

- **Export to file** saves `datamoov-settings.json`: every saved credential with its secrets,
  every connection, and this spreadsheet's reports and dashboards, linked by refs. The sidebar
  asks for confirmation first because the file holds your tokens and keys in clear text. Keep it
  private, out of source control and delete it when it has served its purpose. Use it to back up
  your setup or to move it to another Google account or spreadsheet.
- **Import from file** reads such a file (version 2) or an older credentials-only file (version 1)
  into the account and spreadsheet where the add-on is open.
- **Download sample** saves `datamoov-credentials-sample.json`: one credential per type and one connection per source, generated from the app's own registry, with placeholder values throughout. Edit it locally and import it. Importing it unchanged fails the provider checks, which is the intended outcome.

Open the add-on in the intended Google account, then choose **Settings > Credentials > Import from file** and select your local DataMoov JSON bundle. The selected file is read in browser memory and sent through the sidebar's authenticated Apps Script call. Secrets are saved in that user's private properties for this script. The import does not store them in source code, spreadsheet cells or browser local storage.

Exact matching credentials and connections are reused. A label alone is not a match, and an import never overwrites a different existing credential or moves a report to another connection. Existing AI settings and schedules are unchanged. New Google OAuth credentials use the ordinary token check; each new connection uses the connector's normal connectivity check. An unused token can be saved without proving account access. Results distinguish saved, existing and failed items. A provider rejection leaves that connection unsaved; other successful items remain available.

Snowflake credentials can be stored even when its network policy prevents a connection. Fix the provider-side policy and import again: matching saved credentials are reused and the connection check is retried. There is no verification bypass.

Keep the local file private and out of source control. The file picker is cleared after each attempt. Invalid file structure is rejected before anything is saved.

## Bundle format

The top-level object uses version 1 with credential and connection arrays. Each credential has a unique local ref, a label, a registered family and that family's values. Each connection refers to a credential ref and includes only the connector's per-connection fields. Refs connect items inside the file; they are not saved object IDs. Connector and family names must come from the app's catalog.

A placeholder example (replace the token locally); **Download sample** produces the same shape for every installed source:

```json
{
  "version": 1,
  "credentials": [
    {
      "ref": "meta",
      "label": "Facebook reporting",
      "family": "facebook_ads",
      "values": { "accessToken": "REPLACE_LOCALLY" }
    }
  ],
  "connections": [
    {
      "label": "Facebook Ads",
      "connectorId": "facebook_ads",
      "credentialRef": "meta",
      "credentials": { "adAccountId": "act_1234567890" }
    }
  ]
}
```

A version 2 file adds `reports` and `dashboards` arrays. Each report carries a `connectionRef`
plus the fields of a saved report (`reportType`, `fields`, `config`, `dateRange`, `maxRows`,
`target`, `schedule`, `at`); each dashboard carries its `target`, `datasets` (each with a
`connectionRef`) and `tiles`. They are validated by the ordinary report and dashboard validators
once their connections are saved; nothing is fetched during import. A report that reads the same
query into the same tab, or a dashboard with the same name and dashboard tab, is reported as
existing and left untouched. A dashboard whose tab already holds content fails by name, like a
dashboard saved from chat. Imported reports and dashboards are saved, not drafts, and keep the
schedule in the file. Reports and dashboards belong to the spreadsheet where you import them.

Files are limited to 4 MB, with at most 40 credentials, 20 connections, 30 reports and 30 dashboards
in one file; the account's own caps (20 credentials, 20 connections, 30 reports, 30 dashboards)
still apply when saving. An export names anything it had to leave out (a source that is no longer
installed, a report whose connection is gone, a dashboard saved by an earlier version) in the
sidebar notice. A connection saved by an older version, which embeds its own credential, is
exported as a credential plus a connection; importing that file back into the same account links
the existing connection to the credential instead of duplicating it. Saving still follows the app's private-storage quotas, active-run locks and provider deadline. If an import runs out of time, import the same file again; exact matches are reused instead of duplicated.
