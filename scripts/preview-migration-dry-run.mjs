#!/usr/bin/env node

import fs from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const readJson = path => {
  if (!path) return null;
  const raw = fs.readFileSync(path, "utf8");
  return JSON.parse(raw);
};

const unwrapRows = value => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.rows)) return value.rows;
  return [];
};

const unwrapState = value => {
  const state = value?.state && typeof value.state === "object" ? value.state : value;
  return {
    cands: Array.isArray(state?.cands) ? state.cands : [],
    deletedCandidateIds: Array.isArray(state?.deletedCandidateIds) ? state.deletedCandidateIds : [],
  };
};

const statePath = args.get("--state");
const previewsPath = args.get("--previews");
const assetsPath = args.get("--assets");
const refsPath = args.get("--refs");

if (!statePath || !previewsPath) {
  console.error("Usage: node scripts/preview-migration-dry-run.mjs --state state.json --previews previews.json [--assets assets.json] [--refs refs.json]");
  process.exit(2);
}

const state = unwrapState(readJson(statePath));
const previews = unwrapRows(readJson(previewsPath));
const assets = unwrapRows(readJson(assetsPath));
const refs = unwrapRows(readJson(refsPath));

const deletedSet = new Set(state.deletedCandidateIds.map(id => String(id)));
const candidates = state.cands.filter(candidate => candidate?.id && !deletedSet.has(String(candidate.id)));
const candidateIds = new Set(candidates.map(candidate => String(candidate.id)));
const previewIds = new Set(previews.map(row => String(row.candidate_id ?? row.candidateId ?? "")).filter(Boolean));
const refIds = new Set(refs.map(row => String(row.candidate_id ?? row.candidateId ?? "")).filter(Boolean));
const assetCandidateIds = new Set(assets.map(row => String(row.candidate_id ?? row.candidateId ?? "")).filter(Boolean));

const ready = candidates.filter(candidate => refIds.has(String(candidate.id)));
const legacyOnly = candidates.filter(candidate => !refIds.has(String(candidate.id)) && previewIds.has(String(candidate.id)));
const missing = candidates.filter(candidate => !refIds.has(String(candidate.id)) && !previewIds.has(String(candidate.id)));
const orphanedPreviews = previews.filter(row => !candidateIds.has(String(row.candidate_id ?? row.candidateId ?? "")));
const orphanedAssets = assets.filter(row => !candidateIds.has(String(row.candidate_id ?? row.candidateId ?? "")));
const possibleIdDrift = previews
  .filter(row => !candidateIds.has(String(row.candidate_id ?? row.candidateId ?? "")))
  .map(row => String(row.candidate_id ?? row.candidateId ?? ""))
  .filter(id => {
    const normalized = id.replace(/\D+/g, "");
    return normalized && candidates.some(candidate => String(candidate.id).replace(/\D+/g, "") === normalized);
  });

console.log(JSON.stringify({
  mode: "dry-run",
  counts: {
    candidates: state.cands.length,
    activeCandidates: candidates.length,
    legacyPreviews: previews.length,
    r2Assets: assets.length,
    activeRefs: refs.length,
    ready: ready.length,
    legacyOnly: legacyOnly.length,
    missing: missing.length,
    orphanedPreviews: orphanedPreviews.length,
    orphanedAssets: orphanedAssets.length,
    possibleIdDrift: possibleIdDrift.length,
    deleted: deletedSet.size,
  },
  legacyOnly: legacyOnly.map(candidate => ({ candidateId: candidate.id, name: candidate.name || "", fileName: candidate.resumeFileName || "" })),
  missing: missing.map(candidate => ({ candidateId: candidate.id, name: candidate.name || "", fileName: candidate.resumeFileName || "" })),
  orphanedPreviews: orphanedPreviews.map(row => ({ candidateId: row.candidate_id ?? row.candidateId ?? "" })),
  orphanedAssets: orphanedAssets.map(row => ({ candidateId: row.candidate_id ?? row.candidateId ?? "", assetId: row.asset_id ?? row.assetId ?? "" })),
  possibleIdDrift,
  assetCandidateIds: [...assetCandidateIds],
}, null, 2));
