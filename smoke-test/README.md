# Smoke tests

A small, dependency-free Node.js smoke-test runner for this service, run against a live server (local or
staging). The unit and flow tests in `test/` use a mocked Planning Center; these call the real one. It tests documented HTTP routes and deliberately avoids provider writes, OAuth connect/disconnect, approval actions, or destructive operations.

## Requirements

- Node.js 22 or newer
- The integrations backend running locally or deployed to a test environment
- Its internal API key, supplied locally (never commit it)

## Running it

From the repository root, against a local server (`npm run dev` in another terminal):

```bash
npm run smoke
```

`npm run smoke` reads `INTERNAL_API_KEY` from the root `.env`, so nothing else is needed locally.
To add the optional checks, or to target another server, copy `smoke-test/.env.test.example` to
`smoke-test/.env.test` and fill it in; its values override `.env`. `.env.test` is git-ignored.

```bash
cp smoke-test/.env.test.example smoke-test/.env.test
```

To run it without npm, export the variables yourself and run `node smoke-test/test.mjs`. On Windows
PowerShell:

```powershell
Get-Content smoke-test/.env.test | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
  }
}
node smoke-test/test.mjs
```

Requires Node.js 22 or newer, and the service's API key. Never commit a real key.

## What it checks

Always (needs only `INTERNAL_API_KEY`):

- Unauthenticated access to the status route is rejected (401/403).
- The status route responds, and exposes no credential fields or secret-looking values.
  (Fields such as `accessTokenExpiresAt` that only hold dates are not credentials.)
- Service types read returns 200, or 409 if the integration is not connected / needs reauthorization.
- Non-numeric person and service type IDs, and an out-of-range attendance window, are rejected with 400
  before any Planning Center call.
- Change-flow guards, checked by **status and error code**, all refused before anything is read or stored:
  - a change request without `X-Actor` → 400 `actor_required`
  - a delete operation → 400 `invalid_request`
  - a field outside the approved list (e.g. `birthdate`) → 400 `invalid_request`
  - a malformed change request ID → 400, an unknown one → 404 `not_found`

Optional, when configured:

| Setting | Adds |
|---|---|
| `TEST_PERSON_ID` | Profile, Services schedule, Groups attendance (30-day window) and change-request history reads |
| `TEST_SERVICE_TYPE_ID` | Upcoming plans, and assignments for the first upcoming plan (if any) |
| `ENABLE_PCO_SELF_TEST=true` | Read of the connected Planning Center user's own profile |

Pick a `TEST_SERVICE_TYPE_ID` that has upcoming plans, or the assignments check is skipped.
The attendance check makes one Planning Center request per group event in the window; repeat runs within
6 hours are served from the service's cache.

The script writes `smoke-test/ministrytask-test-report.json` (git-ignored). It prints counts and status
codes only, never response bodies, which may contain personal contact data.

## Important safety notes

- Start with a local or staging backend, not production.
- Use a test Planning Center record and only IDs you are authorized to access.
- `TEST_PERSON_ID` profile responses may contain personal contact data; the test runner does not save or print those response bodies.
- `ENABLE_PCO_SELF_TEST=true` opts into a read of the connected Planning Center user's own profile.
- No test in this package creates, edits, approves, rejects, or deletes provider records, and none creates a
  change request: every change-flow request it sends is refused by the service's guards first.
- This is a smoke-test starter, not a security audit or full automated test suite.
- Keep `INTERNAL_API_KEY`, OAuth secrets, and encryption keys server-side. Never put them in browser code or a public Git repository.

## Scope based on the repository README

The service exposes Planning Center OAuth status/test routes, People, Services and Groups read routes, and
previewed, approved profile change routes. This kit tests the reads and the change-flow guards, but never a
real preview, approval or write: those need a test record and a person's go-ahead. ClickUp, Google Calendar,
webhooks and production deployment are not implemented in the service, so they are not tested here.
