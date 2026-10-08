# Profile API



All endpoints need login (Authorization: Bearer token). Base path: /api/profile



## Profile object



{ id, email, phone, name, firstName, lastName, emailVerified, phoneVerified, avatarUrl, dateOfBirth, gender, nationality, pushNotificationsEnabled, emailNotificationsEnabled }



dateOfBirth is a date like 2000-05-31.



## GET /api/profile



- 200 { profile: profile object }

- 401 { error: "User account not found." }



## PATCH /api/profile



Send only the fields you want to change. All fields are optional:



- firstName: text, 1 to 80 characters

- lastName: text, up to 80 characters, or null

- dateOfBirth: date like 2000-05-31, not in the future, year 1900 or later, or null

- gender: male, female or other, or null

- nationality: text, 1 to 80 characters, or null

- avatarUrl: a link starting with https://, up to 500 characters, or null

- pushNotificationsEnabled: true or false

- emailNotificationsEnabled: true or false



Email and phone cannot be changed here, because they need re-verification. Any unknown field (including email and phone) is rejected.



- 200 { profile: profile object }

- 400 { error: "Invalid profile details.", issues }: wrong values or unknown fields.

- 400 { error: "Nothing to update." }: empty body.

- 401 { error: "User account not found." }



## POST /api/profile/password



Body: { "currentPassword": "optional", "newPassword": "min 8, max 128 characters" }



- 200 { success: true, otherSessionsLoggedOut: n }: password changed, the user's other sessions are signed out.

- 400 { error: "Invalid password details.", issues }

- 400 { error: "Current password is incorrect." }

- 400 { error: "New password must be different from the current password." }

- 401 { error: "User account not found." }

- 429 { error: "Too many password attempts. Try again later." }


Note for POST /api/profile/password: if the account already has a password, currentPassword is required. If the account has no password yet (for example it was created with Google or phone), currentPassword is not needed and the new password is set directly.
