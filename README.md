# LemonTrip API

Local Node, Express, and PostgreSQL backend foundation for the LemonTrip mobile app and website clients.

## Setup

1. Create a PostgreSQL database and set `DATABASE_URL` to its connection string. TLS is enabled automatically for non-local database hosts; set `DATABASE_SSL=false` only for a local database, or `DATABASE_SSL=true` to force TLS.
2. Copy `.env.example` to `.env` in this backend directory. Set `JWT_SECRET` and a separate random `JWT_REFRESH_SECRET` (both at least 32 characters). Keep real secrets in `.env` or the hosting provider's secret settings, never in source control.
3. Configure providers as needed: Google ID-token audiences in `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_IDS`; Twilio SMS using `OTP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `OTP_SENDER`; Resend email using `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, `EMAIL_FROM`, and a public `PUBLIC_API_URL`. The Google client secret is not used by this ID-token flow. OTP/email endpoints return a safe configuration error until their provider is configured.
4. Set `CORS_ORIGIN` to a comma-separated list of exact website origins. The defaults allow Expo web on ports 8081 and 8082. The backend loads `.env` even when started from another working directory. Environment variables may also be supplied by the hosting platform.
5. Install dependencies with `npm install`.
6. Run migrations with `npm run migrate`.
7. Start development with `npm run dev`.

The API listens on `http://localhost:4000` by default.

## Authentication API

- `POST /api/auth/signup` and backward-compatible `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/otp/send`
- `POST /api/auth/otp/verify`
- `POST /api/auth/email/send`
- `GET` or `POST /api/auth/email/verify`
- `POST /api/auth/google`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/auth/logout-all`
- `GET /api/auth/me`

Auth requests may include `platform: "app"` or `platform: "website"`; omitted values default to `app` for old clients, while unsupported values are rejected. Both platforms use the same `users` table. Access tokens expire after 15 minutes. Refresh tokens rotate and are stored only as hashes in `user_sessions`. Native Expo clients store refresh tokens with SecureStore. This workspace has no separate website frontend; website clients should use these same endpoints and protect refresh tokens with an HTTP-only Secure cookie when appropriate.

## Migrations

Numbered SQL migrations are recorded in `schema_migrations`, serialized with a PostgreSQL advisory lock, and applied transactionally. `002_shared_auth.sql` is additive and preserves existing users and bookings. It stops if existing phone numbers collide after digit normalization; review and resolve those rows before retrying. No historical platform is inferred or assigned.

Locally, from `LemonTrip_Mobile_app_backend`:

```sh
npm run migrate
```

For Render, set the build command to `npm ci && npm run build`, the pre-deploy command to `npm run migrate`, and the start command to `npm start`. Configure provider variables in Render first and take a database backup before deploying. The pre-deploy migration runs before the new service release. Do not run migrations from the mobile app.

## Mobile Client

Copy `LemonTrip_Mobile_app/.env.example` to the mobile app's `.env` and set `EXPO_PUBLIC_API_URL` to a reachable backend URL. Google client IDs are public OAuth identifiers and must match the backend's accepted audiences; never put the Google client secret in the mobile `.env`.

Protected endpoints require `Authorization: Bearer <accessToken>`. Run backend checks with `npm run typecheck`, `npm test`, and `npm run build`.
