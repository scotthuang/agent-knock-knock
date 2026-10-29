#!/usr/bin/env node
// Offline projection benchmark. Build first; no discovery, Host, network or task operation.
// An external raw snapshot stays in memory. Reports contain counts/hashes, never its rows.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const usage = `Usage: node scripts/measure-list-projection.js [--input RAW_LIST_JSON] [--out METRICS_JSON]
       [--synthetic-count 240] [--iterations 9]

Run after npm run build. Compares full v4/v5 pagination on the same raw snapshot,
plus deterministic anonymous CLI/Desktop fixtures. No model tokens or network latency
are measured. External input must be raw CLI List, not a compact Host response.`;

function options(argv) {
  const result = { syntheticCount: 240, iterations: 9 };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    assert.ok(["--input", "--out", "--synthetic-count", "--iterations"].includes(flag), "Unknown benchmark option");
    const value = argv[++index];
    assert.ok(value && !value.startsWith("--"), "Missing benchmark option value");
    const key = { "--input": "input", "--out": "out", "--synthetic-count": "syntheticCount", "--iterations": "iterations" }[flag];
    assert.ok(!Object.hasOwn(result, `seen_${key}`), "Repeated benchmark option");
    result[`seen_${key}`] = true;
    result[key] = ["syntheticCount", "iterations"].includes(key) ? Number(value) : value;
  }
  assert.ok(Number.isSafeInteger(result.syntheticCount) && result.syntheticCount >= 12 && result.syntheticCount <= 2_000,
    "synthetic-count must be 12..2000");
  assert.ok(Number.isSafeInteger(result.iterations) && result.iterations >= 3 && result.iterations <= 100,
    "iterations must be 3..100");
  return result;
}

const opts = options(process.argv.slice(2));
if (opts.help) { console.log(usage); process.exit(0); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectionPath = path.join(root, "dist/src/semantic-tool-list-projection.js");
assert.ok(fs.existsSync(projectionPath), "Build missing; run npm run build before this benchmark");
const { compactAkkListModelProjection } = await import(pathToFileURL(projectionPath).href);
const { HOST_LIST_MAX_BYTES, HOST_LIST_MAX_WEIGHTED_CHARS, hostListWeightedChars } =
  await import(pathToFileURL(path.join(root, "dist/src/semantic-tool-list-budget.js")).href);
const hash = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value);

function rawFixture(count, unicode = false) {
  const action = (name, id, extra = {}) => ({ tool: `agent_knock_knock_${name}`, arguments: { conversation_id: id }, ...extra });
  const rows = Array.from({ length: count }, (_, index) => {
    const desktop = index % 3 === 0, claude = !desktop && index % 3 === 1;
    const source = desktop ? "codex_desktop" : claude ? "claude_cli" : "codex_cli";
    const id = `${desktop ? "desktop" : claude ? "claude-cli" : "codex-cli"}:v1:benchmark-${index}`;
    const scenario = Math.floor(index / 3) % 8;
    const state = ["idle", "working", "awaiting_approval", "unknown", "idle", "idle", "awaiting_approval", "idle"][scenario];
    const send = scenario === 0 || scenario === 7;
    const actions = { status: action("status", id) };
    if (send) actions.send = action("send", id);
    if (scenario === 1) actions.watch = action("watch", id);
    if (scenario === 2) actions.approve = action("approve", id, { arguments: { conversation_id: id, request_id: `request-${index}` } });
    if (scenario === 6) actions.respond_interaction = action("respond_interaction", id,
      { arguments: { conversation_id: id, request_id: `question-${index}` } });
    if (scenario === 5) actions.reconcile_binding = action("reconcile_binding", id, { requires_user_intent: true });
    return {
      id, conversation_id: id, source, surface: desktop ? "desktop" : "cli", agent: claude ? "claude" : "codex",
      title: unicode ? `匿名会话🙂e\u0301-${index}-${"中文说明".repeat(16)}` : `Anonymous benchmark ${index}`,
      cwd: `/benchmark/project-${index}`, native_thread_id: `thread-${index}`, activity_state: state,
      connection_state: scenario === 3 ? "not_loaded" : desktop ? "live_owner_verified" : "loaded_backend_verified",
      ...(scenario === 1 ? { native_turn_id: `turn-${index}` } : {}),
      pending_interaction_count: [2, 6].includes(scenario) ? 1 : 0,
      interaction_requests_scanned: scenario !== 7, attention_required: [2, 3, 4, 5, 6].includes(scenario),
      ...(scenario === 7 ? { detail_scan: "deferred", send_preflight_required: true } : {}),
      ...(scenario === 2 ? { approval_state: { scanned: true, blocked: true, approvable: true, prompt_kind: "command" } } : {}),
      ...(scenario === 3 ? { observation_error: "No current owner verified", can_send_reason: "no_live_owner",
        manual_action: "Open the original conversation and refresh Status." } : {}),
      ...(scenario === 4 ? { send_blocked_reason: "terminal_identity_unresolved" } : {}),
      ...(scenario === 5 ? { management_state: "conflict", native_store_authority: { state: "conflict" } } : {}),
      capabilities: { status: true, send, watch: scenario === 1, approve: true, interaction_notify: true,
        interaction_respond: true, set_permissions: true, set_model: true, cancel: true },
      available_actions: actions,
      ...(desktop ? { catalog_membership: "sidebar", sidebar_section: "project", compatibility_policy: "capability_first",
        capability_verification: { send: "verified", approvals: "verified", blockingAnswers: "verified" } } : {})
    };
  });
  return { action_contracts: { version: 35 }, conversations: rows,
    conversation_presentation: { mode: "default", workspace_grouped_connections: 0 },
    codex_cli_scan: { status: "complete", returned: rows.filter(row => row.source === "codex_cli").length, complete: true },
    claude_cli_scan: { status: "complete", returned: rows.filter(row => row.source === "claude_cli").length, complete: true },
    desktop_scan: { view: "sidebar", returned: rows.filter(row => row.source === "codex_desktop").length, catalog_complete: true,
      limitations: ["Anonymous synthetic input; no real discovery or task interaction."] } };
}

function validateRaw(raw) {
  assert.ok(raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.conversations), "Expected raw List conversations");
  assert.ok(!raw.projection && !raw.output && raw.action_contracts, "Input must be raw CLI List, not a compact or Host result");
  assert.ok(raw.conversations.length > 0 && raw.conversations.length <= 2_000, "Expected 1..2000 raw conversations");
  const selectors = raw.conversations.map(row => row.conversation_id ?? row.id);
  assert.ok(selectors.every(value => typeof value === "string" && value.length), "Raw rows require exact selectors");
  assert.equal(new Set(selectors).size, selectors.length, "Raw selectors must already be distinct");
  return selectors;
}

function runPages(raw, version) {
  const expected = validateRaw(raw), seen = new Set(), pages = [];
  const serializedPages = createHash("sha256");
  let args = { listProjectionVersion: version, listLimit: 50 }, projectionMs = 0, serializationMs = 0;
  for (let index = 0; index <= expected.length; index++) {
    const start = performance.now();
    const page = compactAkkListModelProjection(raw, args);
    const projected = performance.now();
    const text = json(page);
    const serialized = performance.now();
    projectionMs += projected - start; serializationMs += serialized - projected;
    assert.equal(page.projection?.version, version, "Built projection version differs from benchmark request");
    const rows = page.conversations;
    assert.ok(Array.isArray(rows) && rows.length > 0, "Pagination returned an empty resource page");
    for (const row of rows) {
      const id = row.conversation_id ?? row.id;
      assert.ok(typeof id === "string" && expected.includes(id) && !seen.has(id), "Pagination lost, invented or duplicated a selector");
      seen.add(id);
    }
    const size = { utf8_bytes: Buffer.byteLength(text), utf16_units: text.length, weighted_chars: hostListWeightedChars(text) };
    serializedPages.update(text).update("\n");
    assert.ok(size.utf8_bytes <= HOST_LIST_MAX_BYTES && size.weighted_chars <= HOST_LIST_MAX_WEIGHTED_CHARS,
      "Complete serialized page exceeded the production budget");
    pages.push({ rows: rows.length, ...size, details_omitted: rows.filter(row => row.details_omitted === true).length });
    const next = page.pagination?.next_args;
    assert.equal(Boolean(next), page.pagination?.has_more === true, "Continuation contract is inconsistent");
    if (!next) { assert.equal(seen.size, expected.length, "Pagination omitted a raw selector"); break; }
    assert.equal(next.listProjectionVersion, version, "Cursor must retain explicit projection version");
    args = next;
  }
  assert.equal(seen.size, expected.length, "Pagination did not terminate");
  return { pages, serializedPagesSha256: serializedPages.digest("hex"), projectionMs, serializationMs };
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = value => Math.round(value * 1000) / 1000;
  return { min: round(sorted[0]), median: round(sorted[Math.floor(sorted.length / 2)]),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), samples: sorted.length };
}

function measure(name, raw, inputBytes) {
  const before = json(raw), selectors = validateRaw(raw);
  const outputs = {}, samples = { 4: [], 5: [] };
  for (let warmup = 0; warmup < 2; warmup++) for (const version of [4, 5]) runPages(raw, version);
  for (let iteration = 0; iteration < opts.iterations; iteration++) {
    for (const version of iteration % 2 ? [5, 4] : [4, 5]) {
      const value = runPages(raw, version);
      if (outputs[version]) {
        assert.deepEqual(value.pages, outputs[version].pages, "Same snapshot produced different response sizes");
        assert.equal(value.serializedPagesSha256, outputs[version].serializedPagesSha256, "Same snapshot changed projected content");
      } else outputs[version] = value;
      samples[version].push(value);
    }
  }
  assert.equal(json(raw), before, "Projection mutated its raw input");
  const versions = {};
  for (const version of [4, 5]) {
    const { pages, serializedPagesSha256 } = outputs[version], values = samples[version];
    versions[`v${version}`] = { page_count: pages.length, row_count: selectors.length, pages,
      serialized_pages_sha256: serializedPagesSha256,
      total: Object.fromEntries(["utf8_bytes", "utf16_units", "weighted_chars"].map(key => [key, pages.reduce((sum, page) => sum + page[key], 0)])),
      projection_ms: distribution(values.map(value => value.projectionMs)),
      serialization_ms: distribution(values.map(value => value.serializationMs)),
      projection_and_serialization_ms: distribution(values.map(value => value.projectionMs + value.serializationMs)) };
  }
  return { name, input_sha256: hash(inputBytes), input_bytes: Buffer.byteLength(inputBytes), rows: selectors.length,
    input_unchanged: true, all_selectors_retained_once: true, ...versions,
    saved_percent: Object.fromEntries(["utf8_bytes", "utf16_units", "weighted_chars"].map(key =>
      [key, Math.round((1 - versions.v5.total[key] / versions.v4.total[key]) * 10_000) / 100])) };
}

const cases = [];
if (opts.input) {
  const bytes = fs.readFileSync(opts.input), raw = JSON.parse(bytes.toString("utf8"));
  cases.push(measure("external-raw-snapshot", raw, bytes));
}
for (const [name, unicode] of [["anonymous-mixed", false], ["anonymous-unicode", true]]) {
  const raw = rawFixture(opts.syntheticCount, unicode);
  cases.push(measure(name, raw, json(raw)));
}
const result = { schema: "agent-knock-knock/list-projection-benchmark", version: 1,
  measured_at: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
  projection_build_sha256: hash(fs.readFileSync(projectionPath)), list_limit: 50, warmup_rounds: 2,
  cases, limits: ["Same frozen raw input for both versions; no production List or Host calls.",
    "Full JSON page envelopes and all continuation pages counted, not row-only estimates.",
    "Weighted chars use the production ASCII=1/non-ASCII-codepoint=16 policy; tokens are not measured.",
    "Timing covers local projection and JSON serialization only, excluding reads, model, IPC and network latency.",
    "Anonymous fixtures exercise data projection, not real approval, Send or callback execution.",
    "Report excludes raw rows, titles, paths and selectors; private input remains outside the repository."] };
const text = JSON.stringify(result, null, 2) + "\n";
if (opts.out) fs.writeFileSync(opts.out, text, { mode: 0o600 });
process.stdout.write(text);
