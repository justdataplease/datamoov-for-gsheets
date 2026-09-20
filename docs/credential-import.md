# Import credentials into your Google account

Open the add-on in the intended Google account, then choose **Settings > Credentials > Import from file** and select your local DataMoov JSON bundle. The selected file is read in browser memory and sent through the sidebar's authenticated Apps Script call. Secrets are saved in that user's private properties for this script. The import does not store them in source code, spreadsheet cells or browser local storage.

Exact matching credentials and connections are reused. A label alone is not a match, and an import never overwrites a different existing credential or moves a report to another connection. Existing AI settings and schedules are unchanged. New Google OAuth credentials use the ordinary token check; each new connection uses the connector's normal connectivity check. An unused token can be saved without proving account access. Results distinguish saved, existing and failed items. A provider rejection leaves that connection unsaved; other successful items remain available.

Snowflake credentials can be stored even when its network policy prevents a connection. Fix the provider-side policy and import again: matching saved credentials are reused and the connection check is retried. There is no verification bypass.

Keep the local file private and out of source control. The file picker is cleared after each attempt. Invalid file structure is rejected before anything is saved.

## Bundle format

The top-level object uses version 1 with credential and connection arrays. Each credential has a unique local ref, a label, a registered family and that family's values. Each connection refers to a credential ref and includes only the connector's per-connection fields. Refs connect items inside the file; they are not saved object IDs. Connector and family names must come from the app's catalog.

A placeholder example (replace the token locally):

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

Files are limited to 250 KB, with at most 20 credentials and 20 connections. Saving still follows the app's private-storage quotas, active-run locks and provider deadline. If an import runs out of time, import the same file again; exact matches are reused instead of duplicated.
