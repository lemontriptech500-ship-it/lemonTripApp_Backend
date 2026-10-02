# LemonTrip API

Local Node, Express, and PostgreSQL backend foundation for the LemonTrip mobile app.

## Setup

1. Create a PostgreSQL database named `lemontrip`.
2. Copy `.env.example` to `.env` in this backend directory and set `DATABASE_URL`, `JWT_SECRET` (at least 32 characters), and a valid `GROQ_API_KEY` from Groq. The example key is a placeholder; the AI chat returns a configuration error until it is replaced. Keep the real key only in `.env`, never in `.env.example` or source control. `CORS_ORIGIN` accepts a comma-separated list of exact frontend origins (the defaults allow Expo web on ports 8081 and 8082). The backend loads `.env` even when started from another working directory. You can also provide these values as environment variables.
3. Install dependencies with `npm install`.
4. Run migrations with `npm run migrate`.
5. Start development with `npm run dev`.

The API listens on `http://localhost:4000` by default.

## Endpoints

- `GET /health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/bookings`
- `POST /api/bookings`
- `GET /api/bookings/:id`

Protected endpoints require `Authorization: Bearer <token>`.
