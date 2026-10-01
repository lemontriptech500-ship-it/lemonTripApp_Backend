# LemonTrip API

Local Node, Express, and PostgreSQL backend foundation for the LemonTrip mobile app.

## Setup

1. Create a PostgreSQL database named `lemontrip`.
2. Copy `.env.example` to `.env` and update `DATABASE_URL` and `JWT_SECRET`.
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
