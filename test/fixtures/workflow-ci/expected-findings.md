# Expected findings — workflow-ci fixture (eval record; no live model call)

Invented PR touching only `.github/workflows/inventory-scan.yml` (see `inventory-scan.base.yml` +
`inventory-scan.patch`): the unique-per-run concurrency group becomes a fixed group, and an
`upload-artifact` step is inserted before the compare step. A review that follows `WORKFLOW_RULES`
should surface these three themes:

1. **Concurrency/queue** — group `inventory-scan` with `cancel-in-progress: false` still lets a newer
   pending run replace an older pending one. If the intent is to serialize and keep pending runs, the
   concrete fix is `queue: max` in that group.
2. **Step failure propagation** — `Upload detailed report` (`upload-artifact` with
   `if-no-files-found: error`, no `continue-on-error`) fails job `scan`; the later `Compare with
   previous` and `Summary` steps then skip under the default `success()` condition, and job
   `publish` skips via `needs: scan` + `if: success()`. `Compare with previous` reads the local
   `report.txt`, not the artifact, so it does not actually depend on the upload: fix with
   `continue-on-error: true` on the upload and/or `if: always()` on the independent follow-up, while
   keeping `publish` on its success-requiring `needs` condition.
3. **Stale message** — the unchanged `Summary` step's `GITHUB_STEP_SUMMARY` line "Detailed inventory
   publication is disabled." is now wrong because this PR uploads the detailed report. The finding is
   anchored on a changed line that caused the staleness (an added upload-step line, quoted verbatim),
   and the message names the stale text and its location; no quote is invented from outside the diff.
