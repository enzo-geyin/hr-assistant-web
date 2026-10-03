# Runbook

## Local Development

```bash
npm install
npm run dev
```

Optional local Node proxy:

```bash
PORT=8787 ANTHROPIC_API_KEY=your_key npm run proxy
```

## Cloudflare Pages Deploy

Use these Pages settings:

- Build command: `npm run build`
- Build output directory: `dist`
- D1 binding name: `DB`
- R2 binding name: `RESUME_ASSETS`
- R2 bucket name: `hr-resume-assets`

Required server-side configuration:

- At least one model key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or `KIMI_API_KEY`
- Required for deployed Pages Functions: `HR_PROXY_TOKEN`

Required frontend configuration:

- `VITE_HR_PROXY_TOKEN` with the same value as `HR_PROXY_TOKEN`

## D1 Verification

Check main state:

```sql
SELECT state_key, length(payload), updated_at FROM hr_state;
```

Check resume assets:

```sql
SELECT candidate_id, active_asset_id, active_version, updated_at
FROM hr_candidate_resume_refs
ORDER BY updated_at DESC
LIMIT 20;

SELECT candidate_id, asset_kind, r2_key, size_bytes, version_no, status, updated_at
FROM hr_resume_assets
ORDER BY updated_at DESC
LIMIT 20;
```

Check legacy resume previews:

```sql
SELECT candidate_id, length(preview_payload), updated_at
FROM hr_resume_previews;
```

Check learning samples:

```sql
SELECT job_id, candidate_id, created_at FROM learning_samples ORDER BY created_at DESC LIMIT 20;
```

## Common Failures

### Cloud sync shows service token error

Cause: `HR_PROXY_TOKEN` is missing, empty, or different from `VITE_HR_PROXY_TOKEN`.

Fix:

1. Set `HR_PROXY_TOKEN` as a Cloudflare Secret.
2. Set `VITE_HR_PROXY_TOKEN` as a Cloudflare build variable.
3. Redeploy Pages so the frontend bundle contains the token.

### Connected model count is 0

Cause: no server-side model API Key is configured, or Pages Functions are not running the expected deployment.

Fix:

1. Add at least one provider key such as `DEEPSEEK_API_KEY`.
2. Open the app settings page and run model diagnostics.
3. Confirm `/api/model-status` returns the configured provider when called with the same Bearer token.

### Resume preview falls back to text

Cause options:

- R2 `RESUME_ASSETS` has no active preview object for that candidate.
- `hr_candidate_resume_refs` has no active ref, or points to a missing asset row.
- Legacy `hr_resume_previews` has no row for that candidate.
- `/api/preview?id=<candidateId>` failed.
- Browser local cache has no image snapshot.

Fix:

1. Call `/api/preview-audit` with the same Bearer token and check `ready`, `legacyOnly`, `missing`, `orphanedLegacy`, and `orphanedAssets`.
2. If the candidate is `legacyOnly`, use Settings -> `检查并迁移旧快照` to copy the existing D1 preview into R2. This does not require a browser-local copy.
3. If the candidate is `missing` and local cache has no image, re-upload the original PDF or image.
4. If `missingObjects` is nonzero, the active D1 reference points to an absent R2 object. Migrate the legacy preview if present, otherwise re-upload the original resume. If `unverified` is nonzero, fix R2 binding or read access before trusting ready counts.
5. If upload fails, check the R2 binding name `RESUME_ASSETS`, `HR_PROXY_TOKEN`, and stale write errors from `/api/resume-assets`.

### Stale resume asset write is rejected

Cause: an old browser or old deployment tried to write a preview with a lower `expectedVersion` than the current D1 active ref.

Fix:

1. Refresh the browser to load the latest app.
2. Open the candidate detail once so `/api/preview` can refresh local `resumeAssetVersion`.
3. Retry upload or replacement.

### D1 Add button is disabled in Cloudflare UI

Cause: this project's bindings are managed by the repository's `wrangler.jsonc`. The dashboard tooltip says bindings are managed through Wrangler configuration; dashboard Add/Edit controls are disabled.

Fix:

1. Confirm the existing `d1_databases` entry for `DB` and its database identity.
2. Create the private R2 bucket `hr-resume-assets` in the dashboard.
3. Confirm the `r2_buckets` entry in `wrangler.jsonc` uses binding `RESUME_ASSETS` and bucket name `hr-resume-assets`.
4. Deploy the checked repository version.
5. Read back both bindings in the production dashboard and check `/api/preview-audit` before migration.

## Resume Preview Migration Dry Run

Use exported JSON files to inspect migration status without writing production data:

```bash
npm run preview:migration:dry-run -- --state state.json --previews previews.json --assets assets.json --refs refs.json
```

For live diagnostics after deployment, call:

```bash
curl -H "Authorization: Bearer $HR_PROXY_TOKEN" "$APP_URL/api/preview-audit"
```

Production order: confirm the existing `DB` binding and database identity, create the private `hr-resume-assets` bucket, bind it as `RESUME_ASSETS` in Pages, deploy the checked build, record the first audit counts, run Settings -> `检查并迁移旧快照`, and record the final audit counts. Keep `hr_resume_previews` as the legacy backup. The migration reads old D1 previews on the server and can be rerun; only audit entries still in `legacyOnly` are processed. Re-upload original files only for entries that remain `missing`.

## Verification Checklist

After a deploy or API change:

```bash
npm run build
```

Then verify in the browser:

- Settings page shows cloud sync healthy.
- Model panel shows at least one connected provider.
- Candidate list loads from D1 after refresh.
- Candidate detail can load resume preview from R2 or legacy fallback, or shows a clear reason why it cannot.
- `/api/preview-audit` reports expected ready / legacyOnly / missing counts.
- Interview record upload or text entry can run AI assessment.
