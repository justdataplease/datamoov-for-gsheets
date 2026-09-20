# Chunk continuation

Saved GA4 and GitHub reports can fetch their results across several Apps Script executions. Each execution saves complete provider pages privately and returns **Paused** when more pages remain. The output tab changes only after the whole report has been fetched, validated and written with the existing atomic Sheets batch.

Google Ads, Facebook Ads, HubSpot, Zendesk, PostgreSQL and BigQuery still fetch each report within one execution. Previews also fetch the complete report within one execution for every source, then show up to 20 rows; they do not create resumable work.

## Running and resuming

Choose **Run** on a saved report. If it pauses, the card shows the number of rows fetched and a **Resume** button. Those rows are staged data, not rows written to the sheet: the previous successful update time, row count and output remain unchanged. Choose **Resume** to continue immediately, or leave it for the hourly scheduler. Refresh the report list to see progress made while the sidebar was closed.

The user's hourly trigger handles their approved schedules and unfinished continuations, including reports configured as **On demand**. Recovery is armed before fetching starts. A paused report is eligible on the next hourly tick; exact execution times are not guaranteed, and other due reports or quotas can delay it. Once the report finishes or fails, its normal schedule applies again. Sharing or copying the definition does not enroll another user in that schedule or continuation. Unrelated triggers are preserved. Google allows add-on time-driven triggers at most once per hour; see [installable trigger restrictions](https://developers.google.com/apps-script/guides/triggers/installable#time-driven_triggers), checked September 18, 2026.

## Bounds and storage

Continuation provides more fetch time, not unlimited report size. These deliberate limits keep staging inside private Apps Script `UserProperties`, without a new Drive permission or partial output writes. The hidden `DataMoovReports` tab stores shared definitions only; it never stores staged rows or provider cursors.

| Limit | Behavior |
| --- | --- |
| Work per execution | At most 10 chunks, with a 45-second soft stop checked between chunks. A chunk is a complete provider page and cannot be split mid-request. A GitHub repository list reads up to 10 repositories per chunk, each behind the deadline check. |
| Request deadline | The existing 240-second context deadline remains, with a 10-second safety margin in deadline checks. A slow page can exceed the 45-second target; continuation cannot extend a single blocking provider call. |
| Work per report | At most 100 chunks across all executions. |
| Snapshot lifetime | 24 hours from the first fetch, checked when resuming. Resuming does not extend this lifetime. |
| Report size | Default 1,000 rows; maximum 20,000 rows and 80 columns. The existing `maxBytes` guard allows at most 8,000,000 characters in the serialized typed matrix. |
| Snapshot size | At most 180,000 encoded bytes after gzip compression and base64 encoding. Each property holds at most 7,500 base64 characters. |
| Property-store staging | At most 450,000 bytes budgeted for existing property keys and values, the new snapshot and its keys, plus an 8,000-byte reserve. The previous committed generation stays counted until replacement is safe. |

The staging budget includes credentials, connections, private report bindings and runtime state, output receipts and other paused reports in the same user's property store. Highly varied or long text can reach the snapshot limit well below 20,000 rows. Exceeding any bound fails explicitly and keeps the output unchanged; narrow the report or finish/remove other paused reports before retrying. No rows are silently dropped. Google's documented limits are 9 KB per property value and 500 KB per property store; see [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas), checked September 18, 2026.

Each snapshot contains accumulated rows, stable column descriptors, completion metadata, the provider cursor, fixed date bounds, and report/connection revision identifiers. It contains no authentication material. Each execution loads the current connection and obtains authorization as needed. Relative dates such as last 30 days are resolved once for that report attempt. This fixes the requested period but does not freeze changing source data between provider requests.

After each unfinished page, DataMoov writes a new generation of snapshot pieces, then commits the report's reference and digest, then removes the old pieces. This ordering retains the last committed checkpoint if execution stops during a save. Snapshots and provider cursors remain in the current user's private properties. Local development credentials and verification records belong only in ignored `.local/` or `data/` files and must never be committed.

## Failure and cancellation

A handled provider, validation, storage or write error discards the continuation, reports the error and preserves existing output. The next **Run** starts a fresh report attempt. Missing, damaged or expired snapshots also fail explicitly; the following **Run** restarts instead of presenting an incomplete result.

Older checkpoints recorded only a numeric connection revision. They can resume when the connection still embeds its credentials and that revision matches. A checkpoint made with a separate saved credential cannot prove which credential revision fetched its staged pages, so DataMoov reports that a restart is required and preserves the existing output. New checkpoints track both connection and credential revisions.

If Apps Script terminates abruptly before normal error handling, a subsequent run can resume the last committed checkpoint after the existing active-run lock expires. A page fetched after that checkpoint may be fetched again. The final writer still verifies ownership, overlap and literal cell values before making one atomic update.

Saving an edited report or deleting it cancels its continuation without clearing its existing output. Editing or deleting a report that is actively fetching is blocked by the existing run lock. Changing its connection revision invalidates a saved continuation: the next resume reports that change and a subsequent run starts with the new connection settings.

Direct changes to a shared definition also invalidate the user's approval. Review it with **Edit** and **Save** in the sidebar before running again; a changed definition cannot reuse a checkpoint from the old recipe. A copied spreadsheet receives definitions and visible output, but no private checkpoints or output receipts. Choose your own connection and an empty output area or new tab. Existing legacy reports that are active or paused keep their private definition until that work finishes; migration does not rewrite an in-progress checkpoint. See [report storage](report-storage.md).

## Connector extension

The runtime opts in by detecting a report's `fetchChunk` function; it never switches on a provider name. A connector supplies `fetchChunk(ctx, state)`, starting with `state === null`, and returns:

```js
{
  columns: [/* the same selected descriptors on every chunk */],
  rows: [/* all rows in this complete provider page */],
  nextState: { /* JSON-serializable provider cursor; no credentials */ },
  metadata: { complete: false }
}
```

The final chunk must set `nextState: null` and `metadata.complete: true`. Both fields are required and must agree. Keep column descriptors identical across chunks, enforce stable provider paging, validate resumed state, and respect `ctx.checkDeadline()`, allowed hosts and the total row budget. Throw for incomplete or truncated provider responses. The shared merger validates every page and the aggregate and enforces the total chunk count.

Keep `fetch(ctx)` as the complete-report interface, implemented with `dmvFetchChunks_(ctx, fetchChunk)` for chunk-capable reports. That wrapper exhausts all chunks in one execution for previews and direct adapter calls. See [the connector contract](connector-contract.md) and [code layout](code-layout.md). Offline continuation tests verify checkpoint recovery, bounds, state validation and protected output; they do not certify live provider access or Google trigger delivery.
