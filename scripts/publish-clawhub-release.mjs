// Publish an already-tested release archive, never rebuild it from the workflow commit.
// Uses the pinned official ClawHub schema/transport, with zero retries on package POST.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const registry = 'https://clawhub.ai';
const release = JSON.parse(await readFile('.github/clawhub-release.json', 'utf8'));
const toolRoot = path.resolve(process.env.CLAWHUB_TOOL_ROOT ?? 'node_modules/clawhub/dist');
const loadTool = (file) => import(pathToFileURL(path.join(toolRoot, file)).href);
const [http, schema, { parseClawPack }] = await Promise.all([
  loadTool('http.js'), loadTool('schema/index.js'), loadTool('clawpack.js'),
]);
const receipt = { version: release.version, started_at: new Date().toISOString(), package_post_count: 0 };
const out = '.clawhub-publication';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, code) => { if (!condition) throw new Error(code); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let token;
const secrets = [process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN].filter(Boolean);
await mkdir(out, { recursive: true });
async function record(phase, details = {}) {
  Object.assign(receipt, details, { phase, updated_at: new Date().toISOString() });
  await writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ phase, ...details }));
}
// Preserve a bounded diagnostic without exposing credentials from remote errors.
function failure(error) {
  let detail = String(error?.message ?? '');
  for (const secret of secrets) detail = detail.split(secret).join('[redacted]');
  detail = detail.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/https?:\/\/\S+/g, '[url]').slice(0, 1200);
  return { error_type: error?.name ?? 'Error', http_status: http.getHttpErrorStatus(error) ?? null, error_detail: detail };
}
async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  requireThat(response.ok, `artifact_http_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
async function mintToken() {
  requireThat(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'manual_actions_run_required');
  requireThat(process.env.GITHUB_REPOSITORY === release.repository && process.env.GITHUB_REF === 'refs/heads/main', 'unexpected_workflow_source');
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', 'clawhub');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  requireThat(response.ok, 'github_oidc_request_failed');
  const oidc = await response.json();
  requireThat(typeof oidc.value === 'string' && oidc.value.length > 0, 'github_oidc_missing');
  secrets.push(oidc.value);
  console.log(`::add-mask::${oidc.value}`);
  const minted = await http.apiRequest(registry, {
    method: 'POST', path: schema.ApiRoutes.publishTokenMint, retryCount: 0,
    body: { packageName: release.name, version: release.version, githubOidcToken: oidc.value },
  }, schema.ApiV1PublishTokenMintResponseSchema);
  token = minted.token;
  secrets.push(token);
  console.log(`::add-mask::${token}`);
}
const packagePath = `/api/v1/packages/${encodeURIComponent(release.name)}`;
const versionPath = `${packagePath}/versions/${encodeURIComponent(release.version)}`;
async function readPublication() {
  // AKK already has a public package; this endpoint includes pending exact versions.
  const value = await http.apiRequest(registry, {
    method: 'GET', path: `${versionPath}/publication`, retryCount: 0,
  });
  requireThat(value?.name === release.name && value?.version === release.version &&
    ['absent', 'pending', 'published', 'failed'].includes(value.state), 'unknown_publication_schema');
  if (value.state === 'pending') requireThat(['staging', 'checks', 'finalization'].includes(value.stage), 'unknown_publication_stage');
  return Object.fromEntries(['name', 'version', 'state', 'stage', 'attemptId', 'recoverable']
    .filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}
async function verifyPublicArtifact() {
  // Deliberately unauthenticated: an accepted upload is not proof of public availability.
  const result = await http.apiRequest(registry, {
    method: 'GET', path: `${versionPath}/artifact`, retryCount: 0,
  }, schema.ApiV1PackageArtifactResponseSchema);
  requireThat(result.package.name === release.name && result.version === release.version, 'public_identity_mismatch');
  const bytes = await fetchBytes(result.artifact.downloadUrl);
  requireThat(sha256(bytes) === release.sha256 && bytes.length === release.bytes, 'public_artifact_mismatch');
  const detail = await http.apiRequest(registry, {
    method: 'GET', path: packagePath, retryCount: 0,
  }, schema.ApiV1PackageResponseSchema);
  requireThat(detail.package?.latestVersion === release.version && detail.package?.tags?.latest === release.version, 'public_latest_mismatch');
  requireThat(detail.package?.scanStatus === 'clean' && detail.package?.topics?.includes('herdr'), 'public_scan_or_topic_not_verified');
  await record('published_verified', { public_version: result.version, public_sha256: sha256(bytes), latest: release.version, scan_status: detail.package.scanStatus, herdr_topic: true });
}
async function main() {
  requireThat(release.name === '@scotthuang/agent-knock-knock' && release.repository === 'scotthuang/agent-knock-knock', 'unexpected_package');
  requireThat(/^\d+\.\d+\.\d+$/.test(release.version) && /^[a-f0-9]{40}$/.test(release.commit) && /^[a-f0-9]{64}$/.test(release.sha256), 'invalid_release_manifest');
  requireThat(release.asset === `scotthuang-agent-knock-knock-${release.version}.tgz`, 'invalid_asset_name');
  const tag = `v${release.version}`;
  const refs = execFileSync('git', ['ls-remote', `https://github.com/${release.repository}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf8', timeout: 60_000 });
  const lines = refs.trim().split('\n');
  const taggedCommit = (lines.find((line) => line.endsWith('^{}')) ?? lines[0]).split(/\s+/)[0];
  requireThat(taggedCommit === release.commit, 'release_tag_commit_mismatch');
  const sourceCommit = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireThat(/^[a-f0-9]{40}$/.test(sourceCommit), 'invalid_publisher_commit');
  execFileSync('git', ['merge-base', '--is-ancestor', release.commit, sourceCommit]);
  const changed = execFileSync('git', ['diff', '--name-only', release.commit, sourceCommit], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const publishingFiles = new Set(['.github/clawhub-release.json', '.github/workflows/clawhub-publish.yml', '.github/README.md', 'scripts/publish-clawhub-release.mjs']);
  requireThat(changed.every((file) => publishingFiles.has(file)), 'product_changed_since_tested_release');
  const archive = await fetchBytes(`https://github.com/${release.repository}/releases/download/${tag}/${release.asset}`);
  requireThat(archive.length === release.bytes && sha256(archive) === release.sha256, 'release_archive_mismatch');
  const parsed = parseClawPack(archive);
  requireThat(parsed.packageName === release.name && parsed.packageVersion === release.version, 'archive_identity_mismatch');
  const paths = parsed.entries.map((entry) => entry.path);
  for (const required of ['package.json', 'openclaw.plugin.json', 'dist/src/openclaw-plugin.js', 'templates/openclaw-skills/agent-knock-knock/SKILL.md']) {
    requireThat(paths.includes(required), 'incomplete_plugin_archive');
  }
  const validated = schema.validateOpenClawExternalCodePluginPackageContents(parsed.packageJson, paths);
  requireThat(validated.issues.length === 0, 'official_package_validation_failed');
  const payload = {
    // Ownership comes from the existing OIDC binding; an ownerHandle override is rejected.
    name: release.name, displayName: 'Agent Knock Knock', family: 'code-plugin',
    version: release.version, changelog: release.changelog, tags: ['latest'],
    topics: ['tmux', 'herdr', 'codex', 'claude-code', 'agent-orchestration'],
    // ClawHub requires source SHA/ref to match the OIDC job. The allowlisted diff
    // above proves this commit contains the same product source as the artifact tag.
    source: { kind: 'github', repo: release.repository, commit: sourceCommit, ref: process.env.GITHUB_REF ?? 'refs/heads/main', path: '.', url: `https://github.com/${release.repository}`, importedAt: Date.now() },
  };
  schema.parseArk(schema.PackagePublishMetadataSchema, payload, 'publish metadata');
  const estimated = schema.estimatePackageMultipartUploadBytes({ payloadJson: JSON.stringify(payload), fileFieldName: 'clawpack', files: [{ name: release.asset, size: archive.length, type: 'application/octet-stream' }] });
  requireThat(estimated <= Math.min(schema.MAX_PACKAGE_MULTIPART_BYTES, 4 * 1024 * 1024), 'multipart_budget_exceeded');
  await record('artifact_validated', { artifact_commit: release.commit, artifact_tag: tag, publisher_commit: sourceCommit, product_unchanged: true, sha256: sha256(archive), bytes: archive.length, files: paths.length });
  if (process.env.CLAWHUB_PUBLISH !== 'true') return record('dry_run_complete');
  const before = await readPublication();
  await record('publication_checked', { publication: before });
  if (before.state === 'published') return verifyPublicArtifact();
  requireThat(before.state === 'absent' || before.state === 'pending', 'existing_failed_publication_requires_review');
  let rejectedStatus;
  if (before.state === 'absent') {
    requireThat(process.env.GITHUB_RUN_ATTEMPT === '1', 'rerun_is_read_only_dispatch_after_reconciliation');
    await mintToken();
    const form = new FormData();
    form.set('payload', JSON.stringify(payload));
    form.set('clawpack', new Blob([archive], { type: 'application/octet-stream' }), release.asset);
    await record('upload_dispatched', { package_post_count: 1 });
    try {
      const accepted = await http.apiRequestForm(registry, { method: 'POST', path: schema.ApiRoutes.packages, token, form, retryCount: 0 }, schema.ApiV1PackagePublishResponseSchema);
      await record('upload_acknowledged', { attempt_id: accepted.attemptId ?? null, acknowledged_publication: accepted.publicationStatus ?? null });
    } catch (error) {
      const status = http.getHttpErrorStatus(error);
      if (status >= 400 && status < 500) rejectedStatus = status;
      await record(status ? 'upload_http_error_no_replay' : 'upload_outcome_unknown_no_replay', { upload_failure: failure(error) });
    }
  }
  // Read-only reconciliation after any POST outcome; never post again in this run.
  const deadline = Date.now() + 30 * 60_000;
  let previous;
  while (Date.now() < deadline) {
    let publication;
    try { publication = await readPublication(); }
    catch (error) { await record('publication_read_failed_no_replay', failure(error)); await sleep(15_000); continue; }
    if (JSON.stringify(publication) !== previous) {
      await record('publication_observed', { publication });
      previous = JSON.stringify(publication);
    }
    if (publication.state === 'published') return verifyPublicArtifact();
    requireThat(!(publication.state === 'absent' && rejectedStatus), `upload_rejected_http_${rejectedStatus}`);
    requireThat(publication.state !== 'failed', 'publication_failed_requires_review');
    await sleep(15_000);
  }
  throw new Error('publication_not_confirmed_no_replay');
}
try { await main(); }
catch (error) {
  // Only our fixed error codes are safe; never print a raw remote response or token.
  const code = /^[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'publication_step_failed';
  await record('failed', { failure_code: code, ...failure(error) });
  process.exitCode = 1;
}
