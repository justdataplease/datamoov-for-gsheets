# Report storage

Saved reports and saved dashboards are stored the same way: as private records in the owner's
Apps Script `UserProperties`, scoped to the spreadsheet where they were created. The spreadsheet
itself holds only their output.

| Stored privately per user | Stored in the spreadsheet |
| --- | --- |
| Report settings (source, connection, fields, options, dates, row limit, destination, schedule) | Report output tables |
| Dashboard plans | Dashboard data and report tabs, charts, pivots |
| Credentials, connections, AI key and instructions | |
| Run state, continuation checkpoints, output receipts | |

Consequences:

- Collaborators see the output, not the report settings, SQL, connections or schedules.
- A copied spreadsheet contains the output but no saved reports or dashboards. Create them again
  in the copy, writing to an empty area or a new tab; output receipts are private and are not
  copied, so existing output cannot be adopted.
- Each user keeps at most 30 reports and 30 dashboards.

Earlier versions kept single-source report settings in a hidden `DataMoovReports` tab. That tab
is no longer read or written. Every report that was connected to your account already has its
complete settings in your private record and keeps working; the old tab can be deleted.
