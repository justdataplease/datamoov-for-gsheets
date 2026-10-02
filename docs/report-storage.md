# Report storage

Saved reports and saved dashboards are stored the same way: as private records in the owner's
Apps Script `UserProperties`, scoped to the spreadsheet where they were created. The spreadsheet
itself holds only their output.

| Stored privately per user | Stored in the spreadsheet |
| --- | --- |
| Report settings (source, connection, fields, options, dates, row limit, destination, schedule, draft state and origin) | Report output tables |
| Dashboard plans (datasets, tiles, chart ids; stored compressed) | Dataset tabs with their provenance rows, the dashboard tab, its charts |
| Credentials, connections, AI key and instructions | |
| Run state, continuation checkpoints, output receipts | Output records: developer metadata on each output tab, visible only to DataMoov |

Consequences:

- Collaborators see the output, not the report settings, SQL, connections or schedules.
- Each refresh also records where its output lies (the report or dashboard id, report or
  dashboard, and the area; no names or settings) as project-visible developer metadata on the
  output tab, so every collaborator's chat refuses to change that output. Removing the report,
  the dashboard or a dataset removes its record; deleting the tab removes it too. A record names
  its spreadsheet, so in a copy it protects nothing.
- A copied spreadsheet contains the output but no saved reports or dashboards. Create them again
  in the copy, writing to an empty area or a new tab; output receipts are private and are not
  copied, so existing output cannot be adopted.
- Each user keeps at most 30 reports and 30 dashboards.

Earlier versions kept single-source report settings in a hidden `DataMoovReports` tab. That tab
is no longer read or written. Every report that was connected to your account already has its
complete settings in your private record and keeps working; the old tab can be deleted.
