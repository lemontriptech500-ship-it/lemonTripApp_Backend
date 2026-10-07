# Notifications API



This is an in-app inbox: notifications are saved in the database and the app can show them on a screen. Real push sending (FCM) is not built yet. Device tokens are saved so push can be added later.



All endpoints need login (Authorization: Bearer token). Base path: /api/notifications



## Notification object



{ id, type, title, body, data, read, readAt, createdAt }



## POST /api/notifications/devices



Body: { "token": "device token, 10 to 500 characters", "platform": "android | ios | web", "deviceId": "optional, max 200 characters" }



- 201 { ok: true }: device saved.

- 400 { error: "Invalid device details.", issues }: wrong body.



## DELETE /api/notifications/devices



Body: { "token": "device token" }



- 200 { ok: true }

- 400 { error: "Invalid device details.", issues }



## GET /api/notifications



Query (all optional): limit (1 to 50, default 20), unread ("true" or "false").



- 200 { notifications: [ notification object, ... ] }

- 400 { error: "Invalid query.", issues }



## GET /api/notifications/unread-count



- 200 { unread: number }



## POST /api/notifications/read-all



No body.



- 200 { updated: number }: how many were marked as read.



## PATCH /api/notifications/:id/read



No body. The id must be a UUID.



- 200 { notification: notification object }

- 400 { error: "Invalid notification id." }

- 404 { error: "Notification not found." }



Not logged in: 401.


Note for GET /api/notifications: unread=true returns only unread notifications. If unread is missing or false, all notifications are returned.
