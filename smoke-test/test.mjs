import { writeFile } from 'node:fs/promises';

const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const key = process.env.INTERNAL_API_KEY || '';
const actor = process.env.ACTOR_EMAIL || 'test-staff@example.invalid';
const personId = process.env.TEST_PERSON_ID || '';
const serviceTypeId = process.env.TEST_SERVICE_TYPE_ID || '';
const enableSelfTest = process.env.ENABLE_PCO_SELF_TEST === 'true';
const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const results = [];

function add(name, status, detail) { results.push({ name, status, detail }); }
function headers({ auth = true, withActor = false } = {}) {
  const h = { accept: 'application/json' };
  if (auth && key) h['x-api-key'] = key;
  if (withActor) h['x-actor'] = actor;
  return h;
}
async function request(name, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { response, body, text };
  } catch (error) {
    add(name, 'FAIL', error.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : error.message);
    return null;
  } finally { clearTimeout(timer); }
}
/** Expects an error status AND the service's error code, so a 400 from the wrong cause doesn't pass. */
function expectError(name, res, status, code) {
  const actualCode = res.body?.error;
  const ok = res.response.status === status && actualCode === code;
  add(name, ok ? 'PASS' : 'FAIL', `HTTP ${res.response.status} ${actualCode ?? '(no error code)'}; expected ${status} ${code}`);
}
function safeStatus(name, actual, expected, detail = '') {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  add(name, ok ? 'PASS' : 'FAIL', `HTTP ${actual}; expected ${Array.isArray(expected) ? expected.join(' or ') : expected}${detail ? `; ${detail}` : ''}`);
}

/**
 * Returns the paths of fields that hold credentials. A field is flagged when its NAME is a
 * credential (access_token, refreshToken, client_secret, authorization, password, ...) or its
 * VALUE looks like one (Bearer header, JWT, or a long opaque string). Metadata such as
 * `accessTokenExpiresAt` holding a date is not a credential. Values are never reported.
 */
function findCredentialLike(value, path = '') {
  const credentialName = /^(access|refresh|id)[_-]?token$|^client[_-]?secret$|^authorization$|^password$|^api[_-]?key$|^secret$/i;
  const isoDate = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
  const credentialValue = (s) => !isoDate.test(s) && (/^Bearer\s+\S+/i.test(s) || /^eyJ[\w-]+\.[\w-]+\./.test(s) || /^[A-Za-z0-9_\-+/=.]{40,}$/.test(s));
  const found = [];
  if (Array.isArray(value)) value.forEach((v, i) => found.push(...findCredentialLike(v, `${path}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (credentialName.test(k) && v !== null && v !== '') found.push(p);
      else found.push(...findCredentialLike(v, p));
    }
  } else if (typeof value === 'string' && credentialValue(value)) found.push(path || '(root)');
  return found;
}

console.log(`MinistryTask backend smoke tests\nTarget: ${base}\n`);

// Connectivity probe: status route should exist and require the internal API key.
const unauth = await request('Unauthenticated access control', '/v1/integrations/planning-center/status', { headers: headers({ auth: false }) });
if (unauth) safeStatus('Unauthenticated access control', unauth.response.status, [401, 403]);

if (!key) {
  add('Authenticated API checks', 'SKIP', 'Set INTERNAL_API_KEY in your local environment to run authenticated checks.');
} else {
  const status = await request('Planning Center connection status', '/v1/integrations/planning-center/status', { headers: headers() });
  if (status) {
    safeStatus('Planning Center connection status', status.response.status, 200);
    if (status.response.ok) {
      const leaks = findCredentialLike(status.body ?? {});
      add('Status response does not expose credentials', leaks.length ? 'FAIL' : 'PASS', leaks.length ? `Credential-like field(s): ${leaks.join(', ')}; inspect response securely.` : 'No token or secret fields or values found.');
    }
  }

  const types = await request('Planning Center service types read', '/v1/planning-center/service-types', { headers: headers() });
  if (types) safeStatus('Planning Center service types read', types.response.status, [200, 409], types.response.status === 409 ? 'Connection may not be active or may need reauthorization.' : '');

  const invalid = await request('Reject non-numeric person ID', '/v1/planning-center/people/not-a-number', { headers: headers() });
  if (invalid) safeStatus('Reject non-numeric person ID', invalid.response.status, 400);

  if (personId) {
    const profile = await request('Optional authorized person profile read', `/v1/planning-center/people/${encodeURIComponent(personId)}`, { headers: headers() });
    if (profile) safeStatus('Optional authorized person profile read', profile.response.status, [200, 404, 409]);
  } else add('Optional authorized person profile read', 'SKIP', 'Set TEST_PERSON_ID to a known, authorized test record. Response may contain personal contact data.');

  if (serviceTypeId) {
    const plans = await request('Optional service-type plans read', `/v1/planning-center/service-types/${encodeURIComponent(serviceTypeId)}/plans?limit=5`, { headers: headers() });
    if (plans) safeStatus('Optional service-type plans read', plans.response.status, [200, 404, 409]);

    // Assignments for the first upcoming plan, if there is one. Response holds names; never printed.
    const planId = plans?.response.ok ? plans.body?.plans?.[0]?.id : undefined;
    if (planId) {
      const a = await request('Optional plan assignments read', `/v1/planning-center/service-types/${encodeURIComponent(serviceTypeId)}/plans/${encodeURIComponent(planId)}/assignments`, { headers: headers() });
      if (a) {
        const shapeOk = a.response.status !== 200 || (Array.isArray(a.body?.assignments) && a.body?.plan?.id === planId);
        safeStatus('Optional plan assignments read', a.response.status, [200, 409], shapeOk ? `${a.body?.assignments?.length ?? 0} assignment(s)` : 'unexpected response shape');
        if (!shapeOk) results.at(-1).status = 'FAIL';
      }
    } else add('Optional plan assignments read', 'SKIP', 'The service type has no upcoming plans (or the plans read failed).');
  } else {
    add('Optional service-type plans read', 'SKIP', 'Set TEST_SERVICE_TYPE_ID to enable.');
    add('Optional plan assignments read', 'SKIP', 'Set TEST_SERVICE_TYPE_ID to enable.');
  }

  const badType = await request('Reject non-numeric service type ID', '/v1/planning-center/service-types/not-a-number/plans', { headers: headers() });
  if (badType) safeStatus('Reject non-numeric service type ID', badType.response.status, 400);

  if (personId) {
    const sched = await request('Optional person schedule read', `/v1/planning-center/people/${encodeURIComponent(personId)}/schedule`, { headers: headers() });
    if (sched) safeStatus('Optional person schedule read', sched.response.status, [200, 404, 409], sched.response.ok ? `${sched.body?.items?.length ?? 0} upcoming item(s)` : '');

    // Groups attendance costs one Planning Center call per event, so use a short window.
    const att = await request('Optional Groups attendance read (30 days)', `/v1/planning-center/people/${encodeURIComponent(personId)}/group-attendance?days=30`, { headers: headers() });
    if (att) {
      const s = att.body?.summary;
      const shapeOk = att.response.status !== 200 || (s && ['events', 'attended', 'absent', 'notRecorded', 'canceled'].every((k) => Number.isInteger(s[k])));
      safeStatus('Optional Groups attendance read (30 days)', att.response.status, [200, 409], att.response.ok ? `events ${s?.events}, attended ${s?.attended}, absent ${s?.absent}, not recorded ${s?.notRecorded}; ${att.body?.fromCache ? 'from cache' : 'fresh'}` : '');
      if (!shapeOk) { results.at(-1).status = 'FAIL'; results.at(-1).detail += '; unexpected summary shape'; }
    }
  } else {
    add('Optional person schedule read', 'SKIP', 'Set TEST_PERSON_ID to enable.');
    add('Optional Groups attendance read (30 days)', 'SKIP', 'Set TEST_PERSON_ID to enable.');
  }

  const badDays = await request('Reject out-of-range attendance window', '/v1/planning-center/people/1/group-attendance?days=0', { headers: headers() });
  if (badDays) safeStatus('Reject out-of-range attendance window', badDays.response.status, 400);

  // ---------- change flow: guard checks only ----------
  // Every request below is refused by the service before it reads Planning Center or stores
  // anything: no preview is created, nothing is approved, rejected or written.
  const jsonHeaders = (withActor) => ({ ...headers({ withActor }), 'content-type': 'application/json' });
  const harmless = JSON.stringify({ operations: [{ op: 'update_phone', phoneId: '1', location: 'Home' }] });

  const noActor = await request('Change requests require X-Actor', '/v1/planning-center/people/1/changes', { method: 'POST', headers: jsonHeaders(false), body: harmless });
  if (noActor) expectError('Change requests require X-Actor', noActor, 400, 'actor_required');

  const delOp = await request('Delete operations are refused', '/v1/planning-center/people/1/changes', {
    method: 'POST', headers: jsonHeaders(true), body: JSON.stringify({ operations: [{ op: 'delete_email', emailId: '1' }] }),
  });
  if (delOp) expectError('Delete operations are refused', delOp, 400, 'invalid_request');

  const extraField = await request('Unapproved fields are refused', '/v1/planning-center/people/1/changes', {
    method: 'POST', headers: jsonHeaders(true), body: JSON.stringify({ operations: [{ op: 'update_name', firstName: 'Test', birthdate: '2000-01-01' }] }),
  });
  if (extraField) expectError('Unapproved fields are refused', extraField, 400, 'invalid_request');

  const badChange = await request('Reject malformed change request ID', '/v1/planning-center/changes/not-a-uuid', { headers: headers({ withActor: true }) });
  if (badChange) expectError('Reject malformed change request ID', badChange, 400, 'invalid_request');

  const unknownChange = await request('Unknown change request returns 404', '/v1/planning-center/changes/00000000-0000-4000-8000-000000000000', { headers: headers({ withActor: true }) });
  if (unknownChange) expectError('Unknown change request returns 404', unknownChange, 404, 'not_found');

  if (personId) {
    const list = await request('Optional change request history read', `/v1/planning-center/people/${encodeURIComponent(personId)}/changes`, { headers: headers({ withActor: true }) });
    if (list) safeStatus('Optional change request history read', list.response.status, 200, list.response.ok ? `${list.body?.changes?.length ?? 0} request(s) on record` : '');
  } else add('Optional change request history read', 'SKIP', 'Set TEST_PERSON_ID to enable.');

  if (enableSelfTest) {
    const self = await request('Optional Planning Center connected-user self-read', '/v1/integrations/planning-center/test-read', { method: 'POST', headers: headers() });
    if (self) safeStatus('Optional Planning Center connected-user self-read', self.response.status, [200, 409]);
  } else add('Optional Planning Center connected-user self-read', 'SKIP', 'Set ENABLE_PCO_SELF_TEST=true to opt in. This reads the connected account profile.');
}

const passed = results.filter(x => x.status === 'PASS').length;
const failed = results.filter(x => x.status === 'FAIL').length;
const skipped = results.filter(x => x.status === 'SKIP').length;
const report = { target: base, ranAt: new Date().toISOString(), summary: { passed, failed, skipped }, results };
// Written next to this script (git-ignored there), whichever directory it is run from.
const reportPath = new URL('./ministrytask-test-report.json', import.meta.url);
await writeFile(reportPath, JSON.stringify(report, null, 2));
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.name} — ${r.detail}`);
console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('Report: smoke-test/ministrytask-test-report.json');
if (failed) process.exitCode = 1;
