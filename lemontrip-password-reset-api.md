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



Frontend setting: PASSWORD_RESET_URL is the page that receives ?token=... and calls reset-password.

