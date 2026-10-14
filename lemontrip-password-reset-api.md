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
app backend opener. Deploy the app backend; this flow needs no website deployment.

The HTTPS opener attempts `lemontripmobile://reset-password?token=...`, the scheme
already declared by the mobile app. It also offers an explicit “Open LemonTrip app”
button and displays the reset code if the browser blocks automatic opening. The
installed native app receives the token on its existing reset screen and submits
`{ token, newPassword }` to `/api/auth/reset-password`. Visiting the opener does not
consume the token or change the password. The page uses no-store caching and does
not load external assets or analytics.

Custom app links require a native build of LemonTrip installed on the device.
Expo Go and desktop web previews should use the reset code on the app's existing
Reset password screen. Emails contain this code as well. Request a fresh email
after deployment; existing emailed URLs cannot be changed retroactively. After
resetting, log in with the new password. Website password reset is unchanged.

Migration `012_password_reset_compatibility.sql` adds the reset handler's `used_at`
column if absent and preserves consumed tokens from older mobile schemas. Include
it in the normal reviewed migration deployment; the migration runner's existing
shared-schema approval requirements still apply. No live database changes are
performed by this implementation.

