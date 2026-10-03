import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { onRequest as upload } from "../functions/api/resume-assets.js";
import { onRequest as preview } from "../functions/api/preview.js";
import { onRequest as audit } from "../functions/api/preview-audit.js";
import { onRequest as state } from "../functions/api/state.js";

const sample = { src: "data:image/png;base64,aGlzdG9yaWNhbA==", name: "sample.png" };
const token = "test-only-token";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../d1/schema.sql", import.meta.url), "utf8"));
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { return sqlite.prepare(sql).run(...args); },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const objects = new Map();
  const bucket = {
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async head(key) { return objects.has(key) ? { key } : null; },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { async json() { return JSON.parse(new TextDecoder().decode(bytes)); } } : null;
    },
    async delete() { throw new Error("Resume objects must not be deleted"); },
  };
  const env = { DB: db, RESUME_ASSETS: bucket, HR_PROXY_TOKEN: token };
  const legacy = (id = "candidate-1") => sqlite.prepare("INSERT INTO hr_resume_previews VALUES (?, ?, ?)").run(id, JSON.stringify(sample), "2026-01-01");
  const ref = () => sqlite.prepare("SELECT * FROM hr_candidate_resume_refs WHERE candidate_id = ?").get("candidate-1");
  return { sqlite, env, objects, legacy, ref };
}

async function post(env, body, file = null) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (file) {
    payload = new FormData();
    for (const [key, value] of Object.entries(body)) payload.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    payload.append("file", file, "resume.pdf");
  } else {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return upload({ env, request: new Request("https://example.test/api/resume-assets", { method: "POST", headers, body: payload }) });
}

const replacement = (version = 0) => ({ candidateId: "candidate-1", expectedVersion: version, preview: { ...sample, name: "replacement.png" } });

test("legacy migration preserves bytes, backup and candidate ID", async () => {
  const f = fixture(); f.legacy();
  const response = await post(f.env, { candidateId: "candidate-1", expectedVersion: 0, migrateLegacy: true });
  assert.equal(response.status, 200);
  assert.equal(f.ref().active_version, 1);
  const fetched = await preview({ env: f.env, request: new Request("https://example.test/api/preview?id=candidate-1", { headers: { Authorization: `Bearer ${token}` } }) });
  const result = await fetched.json();
  assert.deepEqual(result.preview, sample);
  assert.equal(result.source, "r2");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM hr_resume_previews").get().n, 1);
  assert.equal((await post(f.env, { candidateId: "candidate-1", expectedVersion: 1, migrateLegacy: true })).status, 409);
  assert.equal(f.objects.size, 1);
});

test("replacement retains v1 and rejects stale or preview-only writes", async () => {
  const f = fixture();
  const file = new Blob(["synthetic PDF"], { type: "application/pdf" });
  assert.equal((await post(f.env, replacement(), file)).status, 200);
  const first = f.ref().active_asset_id;
  assert.equal((await post(f.env, replacement(1), file)).status, 200);
  assert.equal(f.ref().active_version, 2);
  assert.equal((await post(f.env, replacement(), file)).status, 409);
  assert.equal((await post(f.env, replacement(2))).status, 409);
  assert.equal(f.objects.size, 4);
  assert.equal(f.sqlite.prepare("SELECT status FROM hr_resume_assets WHERE asset_id = ?").get(first).status, "active");
});

test("concurrent first uploads select one version without overwriting its object", async () => {
  const f = fixture();
  const file = new Blob(["synthetic PDF"], { type: "application/pdf" });
  const responses = await Promise.all([post(f.env, replacement(), file), post(f.env, replacement(), file)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.ref().active_version, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM hr_resume_assets").get().n, 2);
  assert.equal(new Set(f.objects.keys()).size, f.objects.size);
});

test("audit identifies a missing R2 object without scheduling legacy overwrite", async () => {
  const f = fixture(); f.legacy();
  await post(f.env, { candidateId: "candidate-1", expectedVersion: 0, migrateLegacy: true });
  f.objects.clear();
  f.sqlite.prepare("INSERT INTO hr_state VALUES (?, ?, ?, ?, ?)").run("default", JSON.stringify({ cands: [{ id: "candidate-1" }] }), 1, "now", "now");
  const response = await audit({ env: f.env, request: new Request("https://example.test/api/preview-audit", { headers: { Authorization: `Bearer ${token}` } }) });
  const result = await response.json();
  assert.equal(result.counts.ready, 0);
  assert.equal(result.counts.missingObjects, 1);
  assert.equal(result.counts.legacyOnly, 0);
});

test("candidate deletion state sync retains legacy and R2 assets", async () => {
  const f = fixture(); f.legacy();
  await post(f.env, { candidateId: "candidate-1", expectedVersion: 0, migrateLegacy: true });
  const response = await state({ env: f.env, request: new Request("https://example.test/api/state", {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cands: [], deletedCandidateIds: ["candidate-1"] }),
  }) });
  assert.equal(response.status, 200);
  assert.equal(f.objects.size, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM hr_resume_previews").get().n, 1);
  assert.equal(f.ref().active_version, 1);
});

for (const megabytes of [10, 30]) {
  test(`${megabytes} MB originals use multipart upload without a 4 MB JSON limit`, async () => {
    const f = fixture();
    const file = new Blob([new Uint8Array(megabytes * 1024 * 1024)], { type: "application/pdf" });
    assert.equal((await post(f.env, replacement(), file)).status, 200);
    assert.equal(f.sqlite.prepare("SELECT size_bytes FROM hr_resume_assets WHERE asset_kind = 'original'").get().size_bytes, megabytes * 1024 * 1024);
  });
}

test("all resume endpoints require authentication", async () => {
  const f = fixture();
  for (const endpoint of [upload, preview, audit]) {
    const method = endpoint === upload ? "POST" : "GET";
    assert.equal((await endpoint({ env: f.env, request: new Request("https://example.test/api/preview?id=candidate-1", { method }) })).status, 401);
  }
});

test("legacy lookup failure prevents any R2 write", async () => {
  const f = fixture();
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    if (sql.includes("SELECT preview_payload")) {
      return { bind() { return this; }, async first() { throw new Error("D1 unavailable"); } };
    }
    return prepare(sql);
  };
  assert.equal((await post(f.env, replacement())).status, 500);
  assert.equal(f.objects.size, 0);
  assert.equal(f.ref(), undefined);
});

test("migration dry run reports ready, legacy, missing and orphan counts", () => {
  const directory = mkdtempSync(join(tmpdir(), "hr-migration-test-"));
  const inputs = {
    state: { cands: [{ id: "ready" }, { id: "legacy" }, { id: "missing" }] },
    previews: [{ candidate_id: "legacy" }, { candidate_id: "orphan" }],
    assets: [{ candidate_id: "ready", asset_id: "asset-1" }],
    refs: [{ candidate_id: "ready", active_asset_id: "asset-1" }],
  };
  const args = [];
  for (const [kind, value] of Object.entries(inputs)) {
    const path = join(directory, `${kind}.json`);
    writeFileSync(path, JSON.stringify(value));
    args.push(`--${kind}`, path);
  }
  const output = execFileSync(process.execPath, [new URL("./preview-migration-dry-run.mjs", import.meta.url).pathname, ...args], { encoding: "utf8", timeout: 5000 });
  const result = JSON.parse(output);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.counts.candidates, 3);
  assert.equal(result.counts.ready, 1);
  assert.equal(result.counts.legacyOnly, 1);
  assert.equal(result.counts.missing, 1);
  assert.equal(result.counts.orphanedPreviews, 1);
});
