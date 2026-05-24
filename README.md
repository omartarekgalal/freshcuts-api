# freshcuts-api

Backend for the Fresh Cuts ambassador-invite frontend.

- Runtime: Node 22 + Hono + `pg`
- DB: shared-postgres on o2m8.me, database `freshcuts`
- Auth: bearer token (`ADMIN_TOKEN` for admin, `amb:<id>:<password>` for ambassadors)

## Env

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://freshcuts_user:<pw>@uic17zleyyhb7bmirjc48c5k:5432/freshcuts` |
| `ADMIN_TOKEN` | yes | Shared secret for admin; also used as the password to log in |
| `ALLOWED_ORIGINS` | no | Comma-separated origins for CORS. Default `*` |
| `PORT` | no | Default 3000 |

## Endpoints (summary)

- `POST /api/auth/admin` `{password}` → `{ok, token}`
- `POST /api/auth/ambassador` `{phone, password}` → `{ok, ambassador, token}`
- `GET/PUT /api/settings`
- `GET/POST/PUT/DELETE /api/ambassadors[/:id]` (admin)
- `GET/POST/PUT/DELETE /api/batches[/:id]` (GET scoped for ambassador)
- `GET /api/codes` (scoped), `POST /api/codes/bulk` (admin), `PUT /api/codes/:code` (admin or owning ambassador), `DELETE` (admin)
- `GET/POST/PUT/DELETE /api/designs[/:id]` (admin write, read for both)
- `POST /api/import` (admin) — one-shot bulk import for migrating from localStorage
