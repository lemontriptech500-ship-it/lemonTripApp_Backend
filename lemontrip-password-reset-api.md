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



App reset emails use `PUBLIC_API_URL/app/reset-password?token=...`, currently
`https://lemontripapp-backend.onrender.com/app/reset-password?token=...`. Set
`PUBLIC_API_URL=https://lemontripapp-backend.onrender.com` on the app backend.
`APP_PASSWORD_RESET_URL` is an optional override. Existing `lemontrip.in` settings
for either `/reset-password` or `/app/reset-password` automatically switch to the
app backend reset page. Deploy the app backend; this flow needs no website deployment.

The email link displays a browser form for a new password and confirmation. It
submits `{ token, newPassword }` to `/api/auth/reset-password` on the same backend.
It does not automatically open a custom app URL, so localhost web previews and
Expo Go users can reset their passwords without installing a native build.
Visiting the page does not consume the token or change the password. The page
uses no-store caching and does not load external assets or analytics.

An optional “Reset inside the app instead” section contains the native app link
and reset code. Custom app links require an installed native build. After resetting
in the browser, return to your localhost preview, Expo Go, or native app and log in
with the new password. Local testing should set `PUBLIC_API_URL` to the reachable
local backend URL (by default `http://localhost:4000`); the preview must use that
same backend. Existing links to this backend page show the updated form after
deployment, provided their tokens have not expired. Website password reset is unchanged.

App recovery now uses `app_password_reset_tokens`, separate from website recovery.
Run the new `013_app_password_reset_tokens.sql` through the normal reviewed migration
process before deploying these handlers. It supports both fresh databases and
installations where 011/012 are already recorded, and preserves consumption in an
existing app-only table. Existing links whose tokens were stored in the former
shared table need to be requested again; website tokens are not copied into the
app namespace. No live migration is run as part of resolving this PR.

Migration `012_password_reset_compatibility.sql` adds the legacy handler's `used_at`
column if absent and preserves consumed tokens from older mobile schemas. Include
it in the normal reviewed migration deployment; the migration runner's existing
shared-schema approval requirements still apply. No live database changes are
performed by this implementation.

