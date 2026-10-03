# Architecture

## Runtime Shape

`hr-assistant-web` is a Vite + React single-page app deployed on Cloudflare Pages. Pages Functions provide the server-side API layer. Cloudflare D1 stores structured state and asset indexes, while Cloudflare R2 stores resume files and preview objects.

```text
Browser React app
  ├─ /api/ai             -> model proxy
  ├─ /api/state          -> main app state snapshot
  ├─ /api/resume-assets  -> resume original/preview asset writes
  ├─ /api/preview        -> resume visual preview reads
  ├─ /api/preview-audit  -> resume asset diagnostics
  ├─ /api/knowledge      -> learning samples and versions
  ├─ /api/model-status   -> provider configuration status
  └─ /api/transcribe     -> uploaded interview note/audio extraction

Cloudflare D1
  ├─ hr_state
  ├─ hr_resume_previews
  ├─ hr_resume_assets
  ├─ hr_candidate_resume_refs
  ├─ hr_resume_asset_events
  ├─ learning_samples
  ├─ rubric_versions
  └─ question_bank_versions

Cloudflare R2
  └─ RESUME_ASSETS
      └─ resumes/<candidateId>/v<version>/
          ├─ original-<fileName>
          └─ preview.json
```

## Frontend State

The frontend keeps an in-memory React state and a browser `localStorage` cache. Cloud state is fetched from `/api/state` and merged into the local state. Local cache is a fallback, not the source of truth.

Important state categories:

- Jobs and scoring standards.
- Candidates and screening results.
- Interview schedule, notes, assessments and final verdicts.
- Model settings and usage counters.
- Learning metadata and question bank versions.

## D1 Storage

`hr_state` stores the main state as one JSON snapshot. Candidate fields such as `scheduledAt`, `interviewLocation`, `interviewLink`, `interviewNotes`, and `extractedQA` live inside that JSON payload.

R2 `RESUME_ASSETS` stores candidate resume originals and visual previews. D1 `hr_resume_assets` stores immutable object metadata, `hr_candidate_resume_refs` stores the active version for each candidate, and `hr_resume_asset_events` records append-only upload/replace/reject events.

`hr_resume_previews` is a legacy table used only as a read fallback and migration source. New writes must not store preview blobs there.

Learning tables store durable feedback:

- `learning_samples`: screening, interview QA and final human verdict.
- `rubric_versions`: generated scoring standard versions.
- `question_bank_versions`: generated interview question bank versions.

## Resume Preview Flow

The resume preview flow is intentionally split:

1. Candidate data and recognized text are saved to `hr_state.payload`.
2. Large visual snapshots are stripped from `/api/state` payloads.
3. The frontend uploads the original file and compressed preview to `/api/resume-assets`.
4. `/api/resume-assets` stores binary/JSON objects in R2, then writes D1 asset metadata and the active candidate ref.
5. Candidate detail pages fetch the preview on demand by candidate id through `/api/preview`.
6. `/api/preview` reads R2 first and falls back to legacy `hr_resume_previews` only when no active asset exists.

Writes include `expectedVersion`. If the active D1 ref has a higher version, the server rejects the write and records `stale_write_rejected`; this prevents old browsers from overwriting a newer resume snapshot.

If R2 and `hr_resume_previews` both have no row for a candidate and the browser cache has no local image, the UI can only show recognized text. The original PDF or image must be uploaded again to reconstruct the visual layout.

## Model Flow

The server proxy in `functions/api/ai.js` owns provider defaults and API key lookup. The frontend model panel mirrors the provider list and lets the user select a configured model. `functions/api/model-status.js` reports which server-side provider keys are present.

DeepSeek V4 model ids used by this project:

- `deepseek-v4-flash`
- `deepseek-v4-pro`

## Learning Flow

Learning is not model fine-tuning. It is a retrieval and versioning loop:

1. Interview assessment extracts `extractedQA` from notes.
2. Final human verdict creates a `learning_samples` entry.
3. The knowledge API synthesizes revised rubric and question bank versions.
4. Later screening and question generation read those versions as context.

The human final verdict remains the hiring decision. AI output is advisory.
