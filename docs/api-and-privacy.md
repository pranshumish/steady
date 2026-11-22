# API and privacy contract

Base URL: `http://localhost:3000/api`. JSON requests and responses. Authentication routes return the user and CSRF token and set an `HttpOnly`, `SameSite=Strict` session cookie. Dashboard mutations require `X-CSRF-Token`, verified with constant-time UTF-8 buffer comparison (`safeEqual`). Extension routes use `Authorization: Bearer <pairing token>` and do not use dashboard cookies.

## Routes

| Method and path | Input / purpose |
|---|---|
| GET `/health` | PostgreSQL and MongoDB connectivity |
| POST `/auth/register` | email, password (10–128 chars, blocklist & personal-word checks), displayName, timezone |
| POST `/auth/login` | email, password; enforces per-account lockout after 5 failures in 15 min |
| POST `/auth/logout` | Revoke current login session and append `auth_events` audit entry |
| GET `/auth/events` | Latest 20 authentication events (`register`, `login_success`, `login_failure`, `login_locked`, `logout`) |
| DELETE `/account` | `password`, `confirmation: "DELETE"`; atomically erases PostgreSQL graph + MongoDB records |
| GET `/me` | User, preferences and current CSRF token |
| PATCH `/preferences` | `quiet_mode`, `reduced_motion` booleans |
| GET/POST `/projects` | List / create with name |
| GET/POST `/tasks` | List (joined with `v_task_continuity`) / create with title, optional `project_id`, `parent_task_id`, `estimated_minutes`, `due_at` |
| PATCH `/tasks/:id` | Required current `version`; optional `title`, `estimated_minutes`, `due_at`, `status` |
| GET `/tasks/:id/history` | Chronological union of `task_events` and `task_checkpoints` notes |
| POST `/tasks/:id/checkpoints` | `note`, maximum 2,000 characters |
| GET `/plans?date=YYYY-MM-DD` | Revisions for a local date |
| POST `/plans` | `date`, `taskIds` array; validates calendar date and creates a frozen revision |
| GET `/focus` | Latest 30 sessions with segment-derived `elapsed_seconds` |
| POST `/focus/start` | `taskId`, `minutes` (1–480), `requestKey` UUID |
| POST `/focus/:id/pause` | Close current work segment (`GREATEST(started_at, clock_timestamp())`) |
| POST `/focus/:id/resume` | Open new work segment |
| POST `/focus/:id/finish` | Close open segment and finish session |
| GET/POST `/checkins` | List / create optional `focus`, `stress`, `energy` (1–5); at least one required; optional `note` |
| DELETE `/checkins/:id` | Delete one owned check-in |
| GET/POST `/devices` | List / create with `label`; creation returns a one-time pairing token |
| POST `/devices/:id/revoke` | Revoke token and increment `consent_epoch` |
| GET `/extension/status` | Current device consent and epoch |
| POST `/extension/consent` | `enabled` boolean; advances consent epoch |
| POST `/extension/events` | `epoch` and `events` array (max 200), validated against strict polymorphic schema |
| DELETE `/activity` | Disable tracking on all devices and delete browser records |
| GET `/reports/daily?date=YYYY-MM-DD` | Combined SQL/MongoDB report (interval unions, category totals, workflow telemetry, epoch drift count) |
| GET `/export` | Owned records (including `auth_events` audit summary; excludes password/session/token secrets) |

Errors return `{ "error": "message" }` (and optional `"fields": { "<name>": "reason" }` for inline form feedback): `400` invalid input or invalid calendar date, `401` unauthenticated, `403` denied request/origin, `404` missing record, `409` conflicting version/session/overlap/immutability/consent, `422` report limit, `429` rate limit or per-account login lockout, or `500` unexpected failure.

## Observation example

Illustrative payload only; use current timestamps when testing:

```json
{
  "epoch": 1,
  "events": [{
    "eventId": "e570ab13-302f-4919-b6fd-a63e1539c610",
    "type": "interval",
    "at": "2026-11-01T08:00:30.000Z",
    "start": "2026-11-01T08:00:00.000Z",
    "end": "2026-11-01T08:00:30.000Z",
    "state": "active",
    "domain": "example.org",
    "category": "study"
  }]
}
```

For `idle` intervals, `domain` must be `null`. Allowed categories: `study`, `necessary`, `leisure`, `uncategorized`. A `tab_switch` contains only `eventId`, `type` and `at`. Successful uploads acknowledge accepted IDs. Retry the same validated events with unchanged IDs; discard queued events if consent changes.

## Collection boundaries

The extension requests optional `tabs`/`idle` permissions only when **Enable** is selected. It reads the active tab URL transiently to extract its hostname; full URLs are not queued or sent. It does not read page text, titles, forms, keystrokes, browser history or incognito tabs. There are no content scripts. `localhost` and `127.0.0.1` are excluded, as are user-selected domain exclusions and their subdomains.

The worker samples on a 30-second alarm and relevant tab/window/idle changes. It accepts normal focused windows and HTTP/HTTPS pages. Intervals longer than 60 seconds are dropped. Durations are approximations between observations, not continuous tracking. A switch count only compares two eligible active observations with different tab IDs; same-tab navigation is not a tab switch.

Queues contain at most 5,000 events and drop events older than seven days. A backend outage stops new observation until consent can be checked again; previously queued events can retry. Pause clears the queue locally, then attempts server revocation. If offline, pending revocation must run before later collection. Token revocation or epoch mismatch disables the worker and discards queued events.

## Security and retention

- **Credentials & tokens:** Passwords use salted `scrypt` (`N=16384, r=8, p=1`) hashes and follow NIST SP 800-63B length/blocklist/personal-word validation. Session cookies (`HttpOnly`, `SameSite=Strict`), CSRF tokens (`safeEqual`), and extension tokens (SHA-256 digests) are stored securely. Login sessions expire after 7 days and pairing tokens after 30 days.
- **Abuse & browser hardening:** Helmet sets `CSP` (`script-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`), `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. API routes enforce CORS origin allowlisting, IP rate limiting, and per-account failed-login throttling (5 attempts per 15 minutes recorded in `auth_events`).
- **SQL & MongoDB isolation:** Parameterized SQL queries, owner-scoped routes, composite `(user_id, id)` foreign keys, append-only triggers, `EXCLUDE USING gist` overlap prevention, and strict MongoDB `$jsonSchema` rules enforce integrity across both stores.
- **Retention & erasure:** Browser events expire automatically after 30 days (MongoDB TTL) and can be purged on demand via `DELETE /api/activity`. Full account erasure (`DELETE /api/account`, requiring current password and `"DELETE"` confirmation) permanently deletes all owned PostgreSQL rows (`ERASURE_ORDER` under `SET LOCAL steady.allow_erasure='on'`) and MongoDB documents.
- **Local scope boundaries:** Backups, email-based password recovery, TLS termination (HTTPS), PostgreSQL row-level security roles, and an independent security audit remain outside this local release.
