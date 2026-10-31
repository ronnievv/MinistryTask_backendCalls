# ministrytask integrations service

A small backend API that the ministrytask app calls over HTTPS. It holds all provider
credentials and makes every privileged call to Planning Center (and later ClickUp and
Google Calendar). The ministrytask front end never sees a provider token.

**Current phase: 2 (connection foundation), Planning Center only.**

| Status | What |
|---|---|
| Implemented, tested with mocks and live | OAuth 2.0 + PKCE connect, single-use state, encrypted token storage, refresh with rotation and a per-connection lock, connection status, one read-only test (`/people/v2/me`), disconnect with revocation, `needs_reauth` when access is removed, audit log. Live checklist (section 4) passed against City Hope Church on 31 Oct 2026. |
| Implemented, tested with mocks only | Rate-limit/backoff handling, pagination helper, automatic refresh after the 2-hour access token expiry |
| Not implemented | People reads and the approved profile writes (Phase 3), Services plan reads, Groups attendance, webhooks, ClickUp, Google Calendar, deployment |

Stack: Node 22+, TypeScript, Fastify, Kysely, SQLite (development). Kysely keeps a move to Postgres
at deploy time to a dialect change.

---

## 1. Register the Planning Center OAuth app (one time, Organization Administrator)

1. Sign in at <https://api.planningcenteronline.com> with your City Hope admin account.
2. Open **OAuth applications** and choose **New application**. Create only **one** app.
3. Name it `ministrytask` and set the **Redirect URI** to:
   - Local: `http://localhost:3000/v1/integrations/planning-center/callback`
   - Production (later): `https://<your-integration-domain>/v1/integrations/planning-center/callback`

   > Planning Center accepts the `http://localhost` redirect URI (confirmed 31 Oct 2026).
4. Copy the **Client ID** and **Secret** straight into your local `.env` (next step).
   Do not paste them into chat, email, ClickUp or Git.

The app requests the scopes `openid people services groups`. `openid` is used only to read which
Planning Center organization and user approved the connection.

## 2. Run locally

```bash
npm install
cp .env.example .env          # .env is git-ignored
npm run gen:key               # paste the output into TOKEN_ENCRYPTION_KEY
openssl rand -base64 48       # paste the output into INTERNAL_API_KEY
# Then put PCO_CLIENT_ID and PCO_CLIENT_SECRET into .env yourself.
npm run migrate
npm run dev
```

## 3. API

Every endpoint except `callback` requires the `X-Api-Key: <INTERNAL_API_KEY>` header.
`X-Actor: <email>` is optional and gets recorded in the audit log.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/integrations/planning-center/connect` | Returns `{ authorizeUrl }`. Open it in a browser as a Planning Center admin. Expires after 10 minutes and can be used once. |
| GET | `/v1/integrations/planning-center/callback` | Planning Center redirects here. Protected by state and PKCE. |
| GET | `/v1/integrations/planning-center/status` | Connection state, Planning Center organization, granted scopes, expiry dates. Never returns tokens. |
| POST | `/v1/integrations/planning-center/test-read` | Reads only the connected user's own profile (id and name). |
| POST | `/v1/integrations/planning-center/disconnect` | Revokes at Planning Center, then wipes the stored credentials. |

```bash
KEY=...   # from your .env
curl -s -X POST localhost:3000/v1/integrations/planning-center/connect -H "x-api-key: $KEY"
```

> The ministrytask front end must **not** hold `INTERNAL_API_KEY`. That needs either a server-side
> part of ministrytask or user sign-in in this service. This is still an open decision.

## 4. Manual test checklist (live)

Last run: 31 Oct 2026, City Hope Church (Planning Center organization 9203). All items passed.

- [x] `POST /connect`, open the URL, approve, and see "Planning Center connected to City Hope Church"
- [x] `GET /status` shows `connected`, the organization id, `missingScopes: []`, and no tokens
- [x] Put the organization id from status into `PCO_EXPECTED_ORGANIZATION_ID` and restart
- [x] `POST /test-read` returns your own Planning Center person id and name
- [x] Reloading the old callback URL shows "invalid or was already used"
- [x] `POST /disconnect` returns `revokedAtProvider: true`, and `test-read` then returns `not_connected`
- [x] Reconnect works
- [x] In Planning Center, removing the app's access makes `test-read` return 409 and status show `needs_reauth`
- [x] Clicking **Deny** at Planning Center shows "cancelled or denied" (run this after removing access; see below)
- [x] `sqlite3 data/integrations.db "select access_token_enc from integration_connections"` shows only `v1:k1:...` ciphertext

What the live run showed:

- Planning Center remembers an approval. While the app is authorized for your account, a new connect link
  goes straight to "connected" with no Allow/Deny screen, even after `/disconnect` revokes the tokens.
  The Allow/Deny screen only appears again after you remove the app under **Authorized applications** at
  <https://api.planningcenteronline.com/oauth/applications>.
- When access is removed, Planning Center answers with a plain 401 and no documented error hint. The
  service now refreshes once on any 401, and marks the connection `needs_reauth` when the refresh is refused.
- Connect links expire after 10 minutes. An expired link shows "This connection link expired. Start again."

## 5. Security notes

- Tokens use AES-256-GCM, bound to their row and column. The key lives in the environment, never in the database.
  To rotate: move the current key to `TOKEN_ENCRYPTION_KEY_PREVIOUS`, set a new key and ID, then reconnect or re-encrypt.
- Logs redact authorization headers, tokens, codes, emails and phone numbers, and drop query strings.
- The organization comes from the API credential, never from request input.
- Writes to a provider are never retried automatically. Only GET requests and documented-idempotent calls (token revocation) are.
- Planning Center refresh tokens expire after 90 days without use. `status.refreshTokenMustBeUsedBy` shows the deadline.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Startup error "still has its placeholder value" | `.env` wasn't filled in |
| Callback shows "invalid or was already used" | The link is older than 10 minutes, or was reloaded. Run `/connect` again. |
| `token_exchange_failed` | The redirect URI in Planning Center doesn't exactly match `PUBLIC_BASE_URL` + the callback path, or the client secret is wrong |
| `wrong_organization` | You signed in to a different Planning Center account than the locked one |
| 403 from Planning Center on every call | Missing or generic `PCO_USER_AGENT` |
| `needs_reauth` | Refresh token expired (90 days) or was revoked, or access was removed in Planning Center. Reconnect. |
| 429 with `retryAfterSeconds` | Planning Center rate limit (about 100 requests per 20 seconds per user) |

## 7. Tests

```bash
npm test        # mocked Planning Center: no network, no credentials
npm run typecheck
```
