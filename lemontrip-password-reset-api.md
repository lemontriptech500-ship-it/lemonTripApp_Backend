# Password reset API



## POST /api/auth/forgot-password

Body: { "email": "user@example.com" }



Always answers 200 { success: true, message }, whether or not the email has an account. Only active accounts get a link. The link expires in 30 minutes. Limits: 10 requests per hour per IP, 3 per hour per email.



In development, when no email provider is set up, the link is printed in the server console. In production, an email provider is required.



## POST /api/auth/reset-password

Body: { "token": "<token from the link>", "newPassword": "min 8 characters" }



- 200 { success: true, sessionsLoggedOut: n }: password changed, all sessions of that user are signed out.

- 400: token is invalid, expired, or already used (a token works once).

- 429: too many attempts.



App email links use `https://lemontrip.in/app/reset-password?token=...`. Set
`APP_PASSWORD_RESET_URL=https://lemontrip.in/app/reset-password` on the app backend.
The legacy `PASSWORD_RESET_URL` remains supported; its `/reset-password` path is
automatically migrated to `/app/reset-password` so it cannot open the website form.

Deploy the website frontend as well as the app backend. The website's
`NEXT_PUBLIC_APP_API_URL` must be the app backend origin (no `/api` suffix), currently
`https://lemontripapp-backend.onrender.com`. The app reset page sends
`{ token, newPassword }` directly to that backend's `/api/auth/reset-password`.
The backend allows browser resets from `https://lemontrip.in` and
`https://www.lemontrip.in`; add local/preview origins to `CORS_ORIGIN` when testing
elsewhere. Website `/reset-password` and its `/api/v1` service are unchanged.

Emails also contain a reset code that can be pasted into the existing app reset
screen. Links issued before this deployment should be replaced by requesting a new
email from the app. After resetting, return to the app and log in with the new password.

Migration `012_password_reset_compatibility.sql` adds the reset handler's `used_at`
column if absent and preserves consumed tokens from older mobile schemas. Include
it in the normal reviewed migration deployment; the migration runner's existing
shared-schema approval requirements still apply. No live database changes are
performed by this implementation.

