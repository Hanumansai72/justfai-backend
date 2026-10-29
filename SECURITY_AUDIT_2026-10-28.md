# JustRide backend security audit — 28 October 2026

CodeRabbit CLI 0.9.1 completed a deep review of 109 files from an isolated full-source snapshot. Backend HEAD at review: `6cf7dbbb08da04f7b45ee59570b05f69486acc08`. Current uncommitted source changes were included. Ignored environment secrets and installed dependencies were excluded. No backend fixes or credential use were performed.

CodeRabbit raised 58 issues: 2 critical, 17 major, 39 minor. These are raw tool counts, not a count of independently confirmed vulnerabilities. The output includes correctness and maintainability recommendations as well as security issues.

## Immediate priorities

1. Rotate the exposed R2 access credentials and remove hardcoded fallbacks. Removing values from the latest file does not invalidate keys or erase Git history.
2. Enforce Google token audience/issuer/expiry verification and verified email before account linking; reject failed verification.
3. Scope chat presence to authorized viewers and validate attachment ownership in all message entry points.
4. Bind support-ticket device actions to the current owner and fix session/logout revocation coverage.

## Additional validation observation (not raised by CodeRabbit)

`src/socket/index.js:73` verifies JWT signature and account status, but does not compare the admin credential_version checked by the HTTP middleware. Existing sockets also retain socket.user without revalidation. An old admin token can therefore still open a chat socket until JWT expiry after a password change, and an already connected socket can outlive that change. Share the session-version validator with Socket.IO and revoke/revalidate existing sockets on password changes or account status changes. This is a code-path observation; no live exploit was attempted.

## CodeRabbit issues

### CR-20 — CRITICAL: Remove the hardcoded R2 credentials and rotate them now.

Location: [src/services/cloudflareR2.service.js:11](C:/Hanumansai_Projects/Justride/Backend/src/services/cloudflareR2.service.js:11)

**Remove the hardcoded R2 credentials and rotate them now.**

The constructor falls back to a literal account ID, access key ID, and secret access key. It also falls back to a literal bucket name and public domain. These values are committed to the repository. Anyone with read access to the source can read and write the production bucket. Rotate these credentials immediately. Do not rely on removing them from the file alone, because they remain in git history.

The fallbacks also make `isConfigured` always true. After you remove them, the "mock" branches in `uploadFirmware` (lines 45-52) and `uploadApk` (lines 80-86) become reachable. They return a public URL without uploading anything. That publishes a release with a dead download link. Throw an error when R2 is not configured, as `getUploadPresignedUrl` already does.

Also applies to: 16-16

Suggested fix: Remove the hard-coded fallbacks for the R2 credentials, bucket name, and public domain in the service constructor so configuration comes only from environment variables. Update uploadFirmware and uploadApk to throw when R2 is not configured instead of returning a public URL without uploading; preserve the existing error behavior in getUploadPresignedUrl.

Validation: Verified: tracked source contains literal R2 credential fallbacks. No credential values are reproduced here. Whether the exposed keys are still active was not tested. Rotate/revoke them in Cloudflare, update deployment secrets, and remove hardcoded values and fake-success upload paths.

### CR-51 — CRITICAL: Remove the unverified Google fallbacks. They bypass the audience check.

Location: [src/controllers/userController.js:100](C:/Hanumansai_Projects/Justride/Backend/src/controllers/userController.js:100)

**Remove the unverified Google fallbacks. They bypass the audience check.**

If `verifyIdToken` fails for any reason, including a wrong `aud`, the code accepts `tokeninfo` output without checking `aud`, `iss`, or `exp`. It then tries the same string as an access token against `userinfo`. The `googleAccessToken` branch (Line 125-135) also accepts any Google access token, and it never checks which client the token was issued to. A third-party app that holds a user's Google token can therefore log in as that user here. There is a second problem. The code never checks `email_verified`, and Line 184-196 links an existing local account by email alone.

Fix:
- Accept only tokens that `verifyIdToken` validates with `allowedAudiences`. For access tokens, call `tokeninfo?access_token=` and require `aud`/`azp` to be in `allowedAudiences`.
- Require `payload.email_verified === true` before you look up or link the account by email.
- Move the hardcoded client ID on Line 92 into the environment configuration.

Suggested fix: In the Google authentication flow, remove the unverified ID-token fallbacks and accept ID tokens only when verifyIdToken validates them against allowedAudiences; validate access tokens through tokeninfo and require their aud or azp to match allowedAudiences. Require payload.email_verified to be true before looking up or linking an account by email, and move the hardcoded client ID into environment configuration.

Validation: Verified: failed Google ID-token verification falls back to tokeninfo/userinfo without enforcing the intended client audience. The access-token path also omits client binding, and email verification is not required before email-based account linking.

### CR-09 — MAJOR: Verify that a worker consumes `notification-queue` in every deployment where `ENABLEREDIS=true`.

Location: [src/queues/notification.queue.js:47](C:/Hanumansai_Projects/Justride/Backend/src/queues/notification.queue.js:47)

**Verify that a worker consumes `notification-queue` in every deployment where `ENABLE_REDIS=true`.**

`enqueueStaffNotification` writes directly to MongoDB. Its comment says the serverless app has no resident BullMQ worker. `enqueueNotification` still adds a job to Redis when Redis is connected. The `Notification` document is created only inside `startNotificationWorker`.

If the app runs on Vercel (see `vercel.json`) with `ENABLE_REDIS=true` and no separate worker process, customer notifications are queued and never persisted. `enqueueNotification` returns `{ queued: true }`, so callers see success. The direct fallback runs only when Redis is down.

Confirm where `startNotificationWorker` runs in production. If no worker is guaranteed, persist directly (as the staff path does) or gate queueing on an explicit worker-enabled flag.

Suggested fix: Verify that startNotificationWorker runs in every production deployment that can call enqueueNotification with Redis enabled; if it is not guaranteed, gate queueing on an explicit worker-enabled setting or persist notifications directly instead of returning queued success for jobs no worker will consume.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-13 — MAJOR: Verify that a body parser handles the unsubscribe form POST.

Location: [src/routes/interestPreferencesRoutes.js:20](C:/Hanumansai_Projects/Justride/Backend/src/routes/interestPreferencesRoutes.js:20)

**Verify that a body parser handles the unsubscribe form POST.**

The form on Line 9 posts `application/x-www-form-urlencoded` data. The handler reads `req.body?.token`. If `src/app.js` mounts only `express.json()`, `req.body` has no `token`. Every unsubscribe submission then returns the "invalid link" page, and consent is never revoked.

Check that `src/app.js` applies `express.urlencoded()` before this router. Also check that the sanitize middleware does not strip the token field. Also confirm that this router is mounted under `/api/early-interest`, because the form action uses that path.

Suggested fix: Ensure the unsubscribe POST handled by verifyUnsubscribe receives its form-encoded token: configure express.urlencoded() before mounting interestPreferencesRoutes, preserve the token field through sanitization, and keep the router mounted under /api/early-interest to match the form action.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-16 — MAJOR: Fix the unique index on `version`. It conflicts with the per-platform duplicate check in the controller.

Location: [src/models/AppRelease.model.js:9](C:/Hanumansai_Projects/Justride/Backend/src/models/AppRelease.model.js:9)

**Fix the unique index on `version`. It conflicts with the per-platform duplicate check in the controller.**

`version` has a global `unique: true` index. `createAppRelease` in `src/controllers/admin/appRelease.controller.js` only rejects duplicates for the same `version` and `platform`. Both `android` and `ios` are valid platforms. If an admin publishes the same version for a second platform, the controller check passes. The insert then fails with an E11000 duplicate key error. The upload to R2 has already happened by then. The client gets an unhandled 500-class error instead of a clean response.

Replace the single-field unique index with a compound unique index on `platform` and `version`. In deployed databases, drop the existing `version_1` index first.

Suggested fix: Remove the global unique constraint from the version field and add a compound unique index on platform and version in appReleaseSchema, so versions remain unique per platform. Ensure deployed databases drop the existing version_1 index before creating the compound index.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-21 — MAJOR: Narrow the `Device.updateMany` filter to the devices that the release applies to.

Location: [src/services/releaseNotification.service.js:68](C:/Hanumansai_Projects/Justride/Backend/src/services/releaseNotification.service.js:68)

**Narrow the `Device.updateMany` filter to the devices that the release applies to.**

The filter matches every paired device. It ignores `is_blocked`, the notified user set, and the device's current `firmware_version`. A device already on `release.version` is marked `firmware_update_available: true`. `latest_firmware` is also overwritten for every device, including on beta or lower-priority publications. The notification targets are narrower: unblocked devices owned by active `USER` accounts.

Match the same owners and exclude devices already on this version. If `Device` has a `device_type` field and `release.device_type` is set, filter on it too.

Suggested fix: Update the Device.updateMany filter to target only unblocked devices linked to the same active USER owners as the notifications, and exclude devices whose firmware_version already equals release.version. When release.device_type is set and Device supports device_type, also filter by that type; preserve the existing update fields.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-24 — MAJOR: Send the OTP to the account's own email address, not a hard-coded personal address.

Location: [src/controllers/admin/password.controller.js:35](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/password.controller.js:35)

**Send the OTP to the account's own email address, not a hard-coded personal address.**

Line 35 sends every admin password-change code to `hanumansai72@gmail.com`. The code does not use `account.email`. The owner of that mailbox receives the second factor for every admin account. The real admin of any other account cannot finish the flow. Line 43 also shows this personal address to every caller.

Load `email` in `verifyPassword` and send the code to that address. Mask the address in the response.

Also applies to: 43-43

Suggested fix: Update verifyPassword to load the accountâ€™s email alongside its password, send the OTP to account.email instead of a hard-coded address, and replace the responseâ€™s exposed personal email with a generic account-email message.

Validation: Not a defect for this deployment: the user explicitly requires all admin password OTPs to go only to hanumansai72@gmail.com. Do not apply CodeRabbit's proposed recipient change. Revisit only if the product later supports multiple independently owned admin accounts.

### CR-27 — MAJOR: Exclude `devicesecret` and `devicehash` from staff device responses.

Location: [src/controllers/admin/devices.controller.js:17](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/devices.controller.js:17)

**Exclude `device_secret` and `device_hash` from staff device responses.**

`DEVICE_PROJECTION` excludes only `pairing_code`, `unlink_otp`, and `__v`. `getDevices` and `getDeviceById` are open to HELPER and use this projection. `registerDevice` stores a per-device `device_secret`. Unless the schema in `src/models/device.model.js` declares `device_secret` and `device_hash` with `select: false`, every helper can read every device's secret from the device list. A device secret lets a caller act as that device during pairing. Add explicit exclusions so the projection does not depend on schema defaults.

Suggested fix: Update DEVICE_PROJECTION to explicitly exclude device_secret and device_hash from staff device responses, so getDevices and getDeviceById do not rely on schema defaults to protect those fields.

Validation: Partially verified: device_hash is selected in staff device responses; device_secret already has select:false in the schema. The claim that every helper can currently read the raw device_secret is not supported. Explicitly excluding both fields is useful hardening, but treat the reported severity as conditional.

### CR-32 — MAJOR: Add `assignedto` to the update projection.

Location: [src/services/chat.service.js:83](C:/Hanumansai_Projects/Justride/Backend/src/services/chat.service.js:83)

**Add `assigned_to` to the update projection.**

The `select` projection includes only `messages` (sliced), `user_id`, `ticket_number`, and `subject`. So `updatedTicket.assigned_to` is always `undefined`. For every customer message, `recipientUserId` is `null`, and the assigned staff member's unread counter never increments. `notifyTicketReply` also receives a ticket without `assigned_to`, so it cannot target the assigned helper.

Also applies to: 95-97

Suggested fix: Add assigned_to to the select projection in the ticket update query so updatedTicket.assigned_to is available for recipient selection and notifyTicketReply. Keep the existing projection fields and message slicing unchanged.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-33 — MAJOR: Restrict `/presence/:userId` to staff or to ticket participants.

Location: [src/routes/chatRoutes.js:24](C:/Hanumansai_Projects/Justride/Backend/src/routes/chatRoutes.js:24)

**Restrict `/presence/:userId` to staff or to ticket participants.**

Any authenticated customer can query the online status and `lastSeen` timestamp of any user ID, including other customers. This exposes activity data across accounts. Limit the route to staff with `authorize(...)`. Or require a shared ticket between the requester and the target user.

Suggested fix: Restrict the `/presence/:userId` route before it reaches `getUserPresence`: require staff authorization with `authorize(...)`, or enforce that the requester and target user share a ticket. Ensure unrelated authenticated customers cannot retrieve another userâ€™s presence or last-seen data.

Validation: Verified: the presence route requires authentication but does not restrict the requested user to staff or shared-ticket participants.

### CR-36 — MAJOR: Do not broadcast presence to every connected socket.

Location: [src/socket/chat.socket.js:30](C:/Hanumansai_Projects/Justride/Backend/src/socket/chat.socket.js:30)

**Do not broadcast presence to every connected socket.**

`io.emit("presence_update", ...)` sends every user's ID and online/offline transitions to all connected clients, including all customers. Any customer can track other users' activity. Emit only to rooms where the status is relevant, for example a staff room or the user's ticket rooms.

Also applies to: 212-212

Suggested fix: Replace the global presence broadcasts in the chat socket handlers with emissions limited to rooms where the status is relevant, such as staff or the userâ€™s ticket rooms; preserve the existing presence payload and online/offline transitions.

Validation: Verified: io.emit sends presence changes to every connected client, including unrelated customers.

### CR-37 — MAJOR: Confirm the device still belongs to the ticket owner before you block or unlink it.

Location: [src/controllers/admin/support.controller.js:193](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/support.controller.js:193)

**Confirm the device still belongs to the ticket owner before you block or unlink it.**

`ticket.device_id` is set once, when the ticket is created. After that, the customer can unlink the device, and a different account can pair it. `blockDeviceFromTicket` and `forceUnlinkDeviceFromTicket` act on `ticket.device_id` and do not check `linked_to`. Staff can therefore block a device that now belongs to another user, or clear that user's pairing (`linked_to: null`, `device_hash` removed), from an old ticket. The customer notification also goes to the wrong person.

Filter both writes on `linked_to: ticket.user_id`. If no device matches, return 409.

Also applies to: 264-274

Suggested fix: In blockDeviceFromTicket and forceUnlinkDeviceFromTicket, constrain each device write to the target device being linked to ticket.user_id; if either operation finds no matching device, return HTTP 409 without blocking or unlinking it. Ensure the unlink flow only notifies the ticket customer when the ownership-checked update succeeds.

Validation: Verified: the ticket-based block/unlink writes use the stored device ID without an ownership predicate tied to ticket.user_id.

### CR-38 — MAJOR: Make notification failures non-blocking after the ticket or message is saved.

Location: [src/controllers/support.controller.js:64](C:/Hanumansai_Projects/Justride/Backend/src/controllers/support.controller.js:64)

**Make notification failures non-blocking after the ticket or message is saved.**

These handlers `await` `sendNotification` / `notifyNewTicket` / `notifyTicketReply` after the write is committed. If Redis or the queue is unavailable, the handler goes to `next(error)` and the client receives an error for a ticket that was saved. The client then resubmits and creates duplicate tickets or messages. `help.controller.createTicket` handles this case correctly: it wraps the dispatch in `waitUntil(...).catch(...)` for this reason. Use the same pattern here.

Also applies to: 116-116, 157-157, 198-198, 296-300

Suggested fix: Update the post-save notification dispatches in the support ticket and reply handlers, including sendNotification, notifyNewTicket, and notifyTicketReply, to use the same waitUntil-based non-blocking pattern as help.controller.createTicket. Handle dispatch failures without passing them to the request error path, so a saved ticket or message still returns successfully.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-40 — MAJOR: Validate `attachments` and `priority` with the same rules as `help.controller.createTicket`.

Location: [src/controllers/support.controller.js:23](C:/Hanumansai_Projects/Justride/Backend/src/controllers/support.controller.js:23)

**Validate `attachments` and `priority` with the same rules as `help.controller.createTicket`.**

`help.controller.js` uses `ownedAttachments()` to accept only HTTPS Cloudinary URLs under `justride/users//support/`. These endpoints skip that check. `reportDeviceProblem` and `addTicketMessage` save any client array as `attachments`. A customer can send arbitrary external URLs, such as phishing or tracking links, to staff, and staff see them in the ticket thread. `reportDeviceProblem` also accepts any client `priority`, so a customer can open `critical` tickets. An invalid priority value fails the Mongoose enum check and returns an error status that is not a 400.

Reuse one shared attachment validator for these endpoints. Ignore or allow-list the client `priority` on customer endpoints.

Also applies to: 52-52, 265-265, 279-279

Suggested fix: Update the customer ticket handlers, including reportDeviceProblem and addTicketMessage, to use a shared ownedAttachments validator for submitted attachments and return 400 for invalid input. In reportDeviceProblem, ignore client-supplied priority and use the customer endpointâ€™s permitted priority.

Validation: Verified: the legacy support entry point accepts client attachments and priority without the ownership validator used in the newer help controller.

### CR-41 — MAJOR: Validate chat `attachments` against owned Cloudinary uploads.

Location: [src/services/chat.service.js:68](C:/Hanumansai_Projects/Justride/Backend/src/services/chat.service.js:68)

**Validate chat `attachments` against owned Cloudinary uploads.**

`saveMessage` saves any array that the REST or socket client sends. A customer can put arbitrary external URLs into the staff-facing thread. That bypasses the `ownedAttachments` rule that `help.controller.createTicket` enforces. Apply the same validator here, and reject the message with 400 if the check fails.

Suggested fix: Update saveMessage to validate supplied attachments with the same owned Cloudinary upload rule used by help.controller.createTicket; reject the message with HTTP 400 when validation fails, while preserving the empty-array behavior for absent or non-array attachments.

Validation: Verified: saveMessage accepts arbitrary attachment arrays; ticket access checks do not validate attachment provenance.

### CR-48 — MAJOR: Check the `insertMany` and `bulkWrite` pre-hook signatures against the installed Mongoose major version.

Location: [src/models/User.js:116](C:/Hanumansai_Projects/Justride/Backend/src/models/User.js:116)

**Check the `insertMany` and `bulkWrite` pre-hook signatures against the installed Mongoose major version.**

Both hooks treat the first argument as the operations array. Mongoose 8 passes `next` first and the documents or ops second, as in `schema.pre('bulkWrite', function (next, ops) â€¦)`. Mongoose 9 removed `next`. On Mongoose 8, `documents.some` and `operations.some` throw a `TypeError`. That error makes every `User.insertMany` and `User.bulkWrite` fail, including `bulkSave`. The other hooks in this file use the no-`next` style, which suggests Mongoose 9. `package.json` is not in this review cohort, so confirm the version there.

Confirm that `package.json` pins `mongoose` to `^9`. On `^8`, change the signatures to `function (next, documents)` and `function (next, operations)`.

Suggested fix: Update the insertMany and bulkWrite pre-hook signatures to match the installed Mongoose major version: use next before documents and operations on Mongoose 8, or retain the current signatures on Mongoose 9. Confirm the pinned version before changing either hook so their array arguments are read correctly.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-49 — MAJOR: Confirm that an omitted `phonenumber` does not match every phoneless account.

Location: [src/controllers/userController.js:230](C:/Hanumansai_Projects/Justride/Backend/src/controllers/userController.js:230)

**Confirm that an omitted `phonenumber` does not match every phoneless account.**

If `phonenumber` is absent, `normalizePhone` returns `undefined`, and the filter becomes `{ phonenumber: undefined }`. With the driver default `ignoreUndefined: false`, the driver serializes that value as `null`, and `null` matches every document without the field. Google sign-ups never store a phone number. After the first Google sign-up, every email-only registration would then get 409 "Email or phone number already in use".

Check whether `validate.register` requires `phonenumber`. If it does not, add the phone condition only when the field is present.

[Code sample omitted.]

Suggested fix: Update the duplicate-check logic around User.exists so an omitted phonenumber is excluded from the query; always check email and add the phone condition only when phonenumber is present. Confirm whether validate.register requires phonenumber, and preserve the current conflict response when either supplied value matches an account.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-50 — MAJOR: `logoutAll` never revokes other sessions, but the response reports success.

Location: [src/controllers/userController.js:414](C:/Hanumansai_Projects/Justride/Backend/src/controllers/userController.js:414)

**`logoutAll` never revokes other sessions, but the response reports success.**

`/logout` is mounted without `protect` (`userRoutes.js` Line 29), so `req.user` is always undefined in this handler. Both `logoutAll && req.user?._id` branches are therefore unreachable. The handler removes only the presented token, but it still replies "Logged out from all devices successfully". A user who tries to cut off a stolen session keeps that session active.

Derive the user from the verified refresh token instead.

Suggested fix: Update the logout handler so `logoutAll` derives the user identity by verifying the presented refresh token instead of relying on `req.user`; clear that userâ€™s sessions only when the token is valid and belongs to an active session. Report logout from all devices only when the bulk revocation matches a user, and otherwise preserve the single-token logout behavior.

Validation: Verified: the public logout route does not populate req.user, so the logoutAll branches depending on req.user are unreachable.

### CR-52 — MAJOR: Do not build a regex from the raw `devicetype` query value.

Location: [src/controllers/device/firmware.controller.js:43](C:/Hanumansai_Projects/Justride/Backend/src/controllers/device/firmware.controller.js:43)

**Do not build a regex from the raw `device_type` query value.**

Any authenticated user controls `device_type`, and the code passes it to `new RegExp` without escaping.
- A malformed pattern such as `(` throws, and the request fails with a 500.
- A catastrophic pattern runs on the MongoDB server for each uncached key. Each new value is a new cache key, so the cache does not prevent this.
- If the query string sends an array (`device_type[]=x`), `.trim()` throws.
- The unanchored match is also wrong. `X1` matches `JustRide-X10`.

Use an exact, case-normalized string match.

Suggested fix: Update the `device_type` handling in the latest-release query to accept only string query values, trim and case-normalize them, and match `device_type` by exact equality using the same normalization. Remove the user-controlled regular expression so malformed, array-valued, and partial-match inputs cannot reach the query.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-01 — MINOR: Inserted rides do not get `createdAt` or `updatedAt`.

Location: [src/controllers/ride.controller.js:33](C:/Hanumansai_Projects/Justride/Backend/src/controllers/ride.controller.js:33)

**Inserted rides do not get `createdAt` or `updatedAt`.**

The `Ride` schema sets `timestamps: true`. The upsert passes `timestamps: false` to `findOneAndUpdate`. Mongoose then skips timestamp handling for the whole operation, including the insert. New ride documents are stored without `createdAt` and `updatedAt`. Clients and admin tools that read these fields get `undefined`.

The option avoids bumping `updatedAt` on retries, which is correct. Set both fields explicitly in `$setOnInsert` instead.

Suggested fix: Update the upsert in the ride creation flow to set createdAt and updatedAt within $setOnInsert while keeping timestamps disabled, so inserted rides receive both timestamps and retries do not change them.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-02 — MINOR: Validate coordinate range and type in `parseCoordinates`.

Location: [src/controllers/savedAddressController.js:17](C:/Hanumansai_Projects/Justride/Backend/src/controllers/savedAddressController.js:17)

**Validate coordinate range and type in `parseCoordinates`.**

The function does not validate the coordinates it accepts. This causes two problems.

- The GeoJSON branch (Line 18) returns client input unchanged. It does not check array length, element types, or ranges.
- The other branches use `Number(...)`. `Number("")`, `Number(null)` and `Number(false)` return `0`. A body like `{ "coords": ["", ""] }` silently saves the point `[0, 0]`.
- No branch checks range (longitude Â±180, latitude Â±90). The `2dsphere` index on `coords` rejects out-of-range values with a MongoDB geo-key error. The request then fails with a 500 through `next(error)` instead of a 400.

Convert only finite numbers, check ranges, and fall through to the next format when a check fails.

Suggested fix: Update parseCoordinates to accept only finite numeric values (rejecting blank strings and other values that coerce to zero), validate that coordinates contain exactly two elements, and enforce longitude within Â±180 and latitude within Â±90. Apply these checks to every supported input format, including GeoJSON, and fall through to the next format when a candidate is invalid.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-03 — MINOR: Confirm that staff tokens cannot reach these routes.

Location: [src/routes/savedAddressRoutes.js:14](C:/Hanumansai_Projects/Justride/Backend/src/routes/savedAddressRoutes.js:14)

**Confirm that staff tokens cannot reach these routes.**

`rideRoutes.js` uses `protect, authorize('USER')`. This router uses only `protect`. The `user_id` field on the model references `User`. If `protect` also accepts staff or admin tokens, a staff account can create and read saved addresses keyed by its own `_id`. These records do not match the `User` reference.

Verify that `protect` only authenticates `User` accounts. If it does not, add `authorize('USER')` as in `rideRoutes.js`.

Suggested fix: Update the middleware chain in savedAddressRoutes to require the USER role after protect, importing authorize from authMiddleware if needed, so staff and admin tokens cannot access these routes.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-04 — MINOR: Denied requests can pass the budget check when `resetMs` is 0 or not a number.

Location: [src/services/staticMap.js:50](C:/Hanumansai_Projects/Justride/Backend/src/services/staticMap.js:50)

**Denied requests can pass the budget check when `resetMs` is 0 or not a number.**

The callers use `if (retryAfter)` to detect a denied reservation. `Math.ceil(result.resetMs / 1000)` returns `0` when `resetMs` is `0`. It returns `NaN` when `resetMs` is `undefined`. Both values are falsy. The function then continues to the next window and can return `0`, so a request that the store denied reaches the paid provider.

Always return a positive value for a denied result. Also confirm that `store.consume` in `src/security/rateLimitStore.js` always returns a numeric `resetMs`.

Suggested fix: Update the denied-result branch guarded by result.allowed so it always returns a positive retry delay, including when resetMs is zero, missing, or nonnumeric. Also ensure store.consume consistently provides a numeric resetMs without relying on that alone to make the denied result truthy.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-05 — MINOR: Add a route for `PATCH /read-all`.

Location: [src/routes/notificationRoutes.js:19](C:/Hanumansai_Projects/Justride/Backend/src/routes/notificationRoutes.js:19)

**Add a route for `PATCH /read-all`.**

`markAsRead` handles `id === "read-all"`. Its doc comment lists `PATCH /api/notifications/read-all`. The only route is `/:id/read`, so `PATCH /api/notifications/read-all` returns 404. Only `/read-all/read` reaches the bulk branch. A client that follows the documented path cannot mark all notifications as read.

Register an explicit route before `/:id/read`.

Suggested fix: Add an explicit PATCH /read-all route in the notification router before the parameterized route, and delegate it to markAsRead with the parameter value needed to reach its bulk-read behavior. Keep the existing PATCH /:id/read route unchanged.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-06 — MINOR: Make the Android package restriction configurable and avoid sending `"undefined"`.

Location: [src/services/pushNotification.service.js:36](C:/Hanumansai_Projects/Justride/Backend/src/services/pushNotification.service.js:36)

**Make the Android package restriction configurable and avoid sending `"undefined"`.**

`restricted_package_name` is hardcoded to `com.example.justride_ui`, which looks like a Flutter placeholder. FCM delivers only to a matching package. If the production application ID differs, every push is silently dropped. Read the value from configuration, for example `process.env.FCM_ANDROID_PACKAGE`.

`release_id: String(releaseId)` sends the literal string `"undefined"` when `releaseId` is not passed. Send an empty string or omit the key in that case.

Suggested fix: Update the notification payload in the push notification sending method to read android.restricted_package_name from FCM_ANDROID_PACKAGE instead of hardcoding the package. Also prevent data.release_id from becoming the literal "undefined" when releaseId is absent by sending an empty string or omitting the key; preserve string conversion for provided IDs.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-07 — MINOR: Clamp `limit` to a minimum of 1.

Location: [src/controllers/notification.controller.js:20](C:/Hanumansai_Projects/Justride/Backend/src/controllers/notification.controller.js:20)

**Clamp `limit` to a minimum of 1.**

A request with `?limit=-5` gives `Math.min(50, -5)`, which is `-5`. Mongo treats a negative `.limit()` as its absolute value, so the query returns 5 documents. `skip` becomes `(page - 1) * -5`, which is negative or zero. `pages` is computed as `Math.ceil(total / limit)`, which is negative. The staff controller already clamps `limit` correctly. Use the same clamp here.

Suggested fix: Update the notification controllerâ€™s limit calculation to clamp the parsed request limit to a minimum of 1 while preserving the existing default of 20 and maximum of 50.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-08 — MINOR: Guard `messageText` and add the ellipsis only when truncated.

Location: [src/queues/notification.queue.js:159](C:/Hanumansai_Projects/Justride/Backend/src/queues/notification.queue.js:159)

**Guard `messageText` and add the ellipsis only when truncated.**

`messageText.slice(...)` throws a `TypeError` if `messageText` is `undefined` or `null`, for example for an attachment-only reply. The message also always ends with `...`, even for short replies. Normalize the input and append the ellipsis only when the text is cut.

Suggested fix: Update notifyTicketReply to normalize missing or null messageText before creating the preview, and append an ellipsis only when the text exceeds the preview limit. Preserve a clear preview for attachment-only replies.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-10 — MINOR: Resolve the task on `close`, not only on `finish`.

Location: [src/queues/interestEmail.queue.js:39](C:/Hanumansai_Projects/Justride/Backend/src/queues/interestEmail.queue.js:39)

**Resolve the task on `close`, not only on `finish`.**

`res.once('finish')` does not fire when the client disconnects before the response ends. The promise then never settles. `waitUntil(task)` keeps the Vercel invocation alive until the platform timeout. Queued emails are also not drained for that request.

`close` fires after `finish` and after an abort. Listen for `close`.

Suggested fix: Update the task promise in the queue request flow to resolve on the responseâ€™s close event instead of only on finish, so it settles after either a completed response or a client disconnect. Keep the existing waitUntil(task) behavior unchanged.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-11 — MINOR: Handle a `getOutgoingQuota` failure so the record does not stay in `sending`.

Location: [src/queues/interestEmail.queue.js:24](C:/Hanumansai_Projects/Justride/Backend/src/queues/interestEmail.queue.js:24)

**Handle a `getOutgoingQuota` failure so the record does not stay in `sending`.**

At this point `sendEmail` returned `DAILY_LIMIT`, so the email was not sent. If `getOutgoingQuota()` throws (for example, on a transient MongoDB error), the exception leaves `drainInterestEmails`. The record stays in `sending`. The code never reclaims `sending`, so the confirmation email is lost permanently.

Catch the error and use the default delay.

Suggested fix: In the `drainInterestEmails` flow, catch failures from `getOutgoingQuota` and preserve the default delay so the unsent email continues through the existing retry path instead of remaining in `sending`.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-12 — MINOR: Move the hardcoded alert recipient to configuration.

Location: [src/services/adminLoginAlert.service.js:18](C:/Hanumansai_Projects/Justride/Backend/src/services/adminLoginAlert.service.js:18)

**Move the hardcoded alert recipient to configuration.**

A personal Gmail address is committed in source. Every admin login alert sends the admin email and IP address to this address. Changing the recipient needs a code deploy. The address is also in repository history.

Read the recipient from an environment variable, for example `ADMIN_ALERT_EMAIL`. Skip the alert and log a code if the variable is not set.

Suggested fix: Update the admin login alert flow around sendEmail and adminSignIn to read the recipient from the ADMIN_ALERT_EMAIL environment variable instead of a hardcoded address. If it is unset, skip sending the alert and report the NOT_CONFIGURED code using the serviceâ€™s existing result or logging convention.

Validation: Not a defect for the current requirement: the fixed admin security-email recipient is intentional. Configuration may be useful later but must preserve the mandated recipient.

### CR-14 — MINOR: Skip or restrict notifications for non-stable app releases.

Location: [src/services/releaseNotification.service.js:98](C:/Hanumansai_Projects/Justride/Backend/src/services/releaseNotification.service.js:98)

**Skip or restrict notifications for non-stable app releases.**

`notifyAppRelease` notifies every active user of any release, including `beta` and `alpha`. `getLatestAppUpdate` defaults to the `stable` channel. Users get an "update available" notification for a build that the default update check never offers.

Notify only when `release.channel === "stable"`, or define a separate audience for pre-release channels.

Suggested fix: Update notifyAppRelease to send notifications only when release.channel is "stable", consistent with the default channel in getLatestAppUpdate; leave the existing active-user selection unchanged for stable releases.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-15 — MINOR: Do not return a fabricated firmware version when no release exists.

Location: [src/controllers/admin/firmware.controller.js:272](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/firmware.controller.js:272)

**Do not return a fabricated firmware version when no release exists.**

If no active release exists, the public endpoint returns a hardcoded version `2.5.4` with no `file_url` or `checksum`. `getLatestAppUpdate` returns an explicit "none available" response in the same case. Clients can read this placeholder as a real release. Return an empty or explicit "no release" payload instead.

Suggested fix: Update the no-release branch in the firmware controller so it does not present the hardcoded version as an available release. Return an empty or explicit no-release payload, matching the none-available behavior of getLatestAppUpdate; preserve the existing response for an actual latest release.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-17 — MINOR: Sanitize `version` and `devicetype` before building the R2 object key.

Location: [src/controllers/admin/firmware.controller.js:50](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/firmware.controller.js:50)

**Sanitize `version` and `device_type` before building the R2 object key.**

`cleanVersion` and `device_type` come from `req.body`. The code only trims `cleanVersion`, and it only lowercases `device_type` and replaces whitespace in it. Characters such as `/` and `..` pass through into the key, so an admin can write to unintended paths in the bucket. `device_type` may also be a non-string, which throws a `TypeError`.

Restrict both values to a safe character set before building the key. `createAppRelease` has the same problem with `channel` and `build_number` (`appRelease.controller.js` line 167). It builds the key before the schema validates `channel`.

Suggested fix: Sanitize `cleanVersion` and `device_type` in the firmware key-building flow before composing `fileName`, handling non-string inputs safely and restricting output to safe characters so path separators cannot pass through. Apply the same validation-before-key-construction to `channel` and `build_number` in `createAppRelease`.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-18 — MINOR: Escape `devicetype` before building the `RegExp`.

Location: [src/controllers/admin/firmware.controller.js:107](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/firmware.controller.js:107)

**Escape `device_type` before building the `RegExp`.**

`req.query.device_type` goes straight into `new RegExp(...)`. A malformed pattern such as `(` throws, and the request returns a 500. A pattern with catastrophic backtracking can block the event loop. Escape the value first.

Suggested fix: Escape regex metacharacters in the trimmed req.query.device_type value before constructing filter.device_type, so input is treated as a literal search string and cannot cause invalid patterns or catastrophic backtracking; preserve case-insensitive matching.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-19 — MINOR: Tighten the file filter. Any file with MIME type `application/octet-stream` passes.

Location: [src/middlewares/apkUpload.js:15](C:/Hanumansai_Projects/Justride/Backend/src/middlewares/apkUpload.js:15)

**Tighten the file filter. Any file with MIME type `application/octet-stream` passes.**

The `||` chain accepts any file whose MIME type is `application/octet-stream`. Browsers send that MIME type for most unknown binaries, so the extension check has no effect. The extension check is also case-sensitive, so `APP.APK` fails it.

Require an allowed extension after lowercasing the name. Use the MIME type only as an additional allowance.

Suggested fix: Update the isApk check to lowercase file.originalname and require an .apk or .aab extension; use the MIME type only as an additional condition, so application/octet-stream alone cannot pass.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-22 — MINOR: Verify the `populate` field list for `releasedby`.

Location: [src/controllers/admin/appRelease.controller.js:270](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/appRelease.controller.js:270)

**Verify the `populate` field list for `released_by`.**

This call populates `"full_name email"`. The equivalent firmware list in `firmware.controller.js` (line 112) populates `"name email"`. Both reference the same `User` model. One of them returns an empty author object. Confirm the real field name on `User` and use it in both places.

Suggested fix: Verify the author field defined on the shared User model, then update the released_by populate projection and the equivalent firmware populate projection to use that field alongside email, so both return the author name consistently.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-23 — MINOR: Escape `search` before you build the `RegExp`.

Location: [src/controllers/admin/users.controller.js:32](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/users.controller.js:32)

**Escape `search` before you build the `RegExp`.**

An invalid pattern, for example `[`, throws a `SyntaxError` and returns 500. A catastrophic pattern can make MongoDB regex evaluation slow. Escape the input and cap its length the same way as `audit.controller.js` line 89.

Suggested fix: Update the search handling in the user-list controller to accept only non-empty string queries, trim and cap the input at 200 characters, and escape regex metacharacters before constructing the case-insensitive RegExp. Keep the existing name and email search fields.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-25 — MINOR: Escape `search` before you build the `RegExp`.

Location: [src/controllers/admin/auth.controller.js:412](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/auth.controller.js:412)

**Escape `search` before you build the `RegExp`.**

`new RegExp(req.query.search.trim(), "i")` uses raw input as a regular expression. An invalid pattern, for example `(`, throws a `SyntaxError` and the request returns 500. A catastrophic pattern can tie up MongoDB regex evaluation. If `search` arrives as an array, `.trim()` throws. `audit.controller.js` line 89 already escapes and caps the input. Use the same approach here.

Suggested fix: Update the search handling in the visible filter-building code to accept only a non-empty string, trim and cap the input at 200 characters, and escape regex metacharacters before constructing the case-insensitive RegExp. Preserve the existing fields searched by filter.$or.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-26 — MINOR: Generate `employeeid` from a value that does not repeat after a deletion.

Location: [src/controllers/admin/auth.controller.js:349](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/auth.controller.js:349)

**Generate `employee_id` from a value that does not repeat after a deletion.**

The code builds `EMP-${count + 1001}` from `countDocuments()`. `deleteHelperUser` hard-deletes Helper documents. After one deletion, the count drops, and the next generated ID can match an existing Helper. The duplicate check then returns 409. Auto-generated provisioning keeps failing until an admin supplies `employee_id` by hand. Two concurrent create requests can also generate the same ID.

Use a counter document with atomic `$inc`, or use a random or ObjectId-based suffix. Rely on a unique index on `employee_id` to catch collisions.

Suggested fix: Replace the count-based employee ID generation after Helper.countDocuments() with a collision-resistant approach, such as an atomic counter increment or a random/ObjectId-based suffix, and rely on a unique index on employee_id to reject any collision.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-28 — MINOR: Do not unblock retired devices.

Location: [src/controllers/admin/devices.controller.js:252](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/devices.controller.js:252)

**Do not unblock retired devices.**

`retireDevice` sets `is_blocked: true` and `is_active: false` as a permanent end-of-life state. `unblockDevice` has no `is_retired` guard, so an ADMIN or HELPER can set a retired device back to `is_blocked: false, is_active: true`. The record is then inconsistent. The dashboard `blocked` count drops. Any code that checks only `is_blocked` treats the device as usable again.

If the device is retired, return 404 or 409 with a message that says so.

Suggested fix: Update unblockDevice to exclude records with is_retired: true from its update filter, using a conditional find-and-update so retired devices cannot be reactivated. When no eligible device is updated, return a 404 or 409 response indicating that the device is retired.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-29 — MINOR: Escape `search` before you build the `RegExp`.

Location: [src/controllers/admin/devices.controller.js:92](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/devices.controller.js:92)

**Escape `search` before you build the `RegExp`.**

This raw `RegExp` has the same problem as in the users and helpers controllers. Invalid input returns 500, and a catastrophic pattern can make MongoDB regex evaluation slow. Escape the input and cap its length the same way as `audit.controller.js` line 89.

Suggested fix: Update the search handling in the device-list controller to escape the trimmed `req.query.search` value and cap its length before constructing the case-insensitive `RegExp`, following the existing approach in `audit.controller.js`; preserve the current matching fields.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-30 — MINOR: Revoke existing Helper sessions after a password change.

Location: [src/controllers/admin/auth.controller.js:295](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/auth.controller.js:295)

**Revoke existing Helper sessions after a password change.**

A Helper can set `newPassword` through this endpoint. The code saves the new hash, but it keeps `refresh_tokens` and does not change any credential version. A session that was stolen before the change stays valid after the change. The Admin OTP flow in `password.controller.js` clears `refresh_tokens` and increments `credential_version` (lines 64-65). The Helper path needs the same revocation.

This path also accepts a 6-character minimum. The Admin flow requires at least 8 characters and at most 72 bytes.

Suggested fix: Update the `newPassword` handling in the Helper endpoint to require a string of at least 8 characters and no more than 72 UTF-8 bytes. When saving a changed password, clear `account.refresh_tokens` and increment `account.credential_version` so existing Helper sessions are revoked.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-31 — MINOR: Check that `deviceid` is a string before you call `.match()` and build the query.

Location: [src/controllers/support.controller.js:32](C:/Hanumansai_Projects/Justride/Backend/src/controllers/support.controller.js:32)

**Check that `device_id` is a string before you call `.match()` and build the query.**

If the JSON body has `device_id` as a number or an object, `device_id.match` throws a TypeError, and the request returns a 500 error. An object value also goes into the `{ device_id }` clause as a query operator. Reject values that are not strings with a 400 response.

Suggested fix: Validate device_id in the support controller before calling match or building the Device.findOne query; for any provided non-string value, return a 400 response, while preserving the existing behavior for absent or empty values.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-34 — MINOR: Join the `splat` segments before you pass them as `publicid`.

Location: [src/routes/uploadRoutes.js:52](C:/Hanumansai_Projects/Justride/Backend/src/routes/uploadRoutes.js:52)

**Join the `splat` segments before you pass them as `public_id`.**

The `*splat` syntax is the Express 5 (path-to-regexp v8) wildcard form. In Express 5, `req.params.splat` is an array of path segments, not a string. Every public ID this service creates is nested, for example `justride/users//display/`. So `publicId` becomes an array, and the URL builder converts it to `justride,users,...`. The endpoint then returns a broken preview URL.

Suggested fix: Update the wildcard handling in the `/preview/*splat` route so Express 5â€™s `req.params.splat` array is joined with `/` before assigning it to `req.params.public_id`. Preserve the `req.params[0]` fallback for non-array wildcard values.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-35 — MINOR: Fix overlapping pages when `skip + limit` exceeds the message count.

Location: [src/services/chat.service.js:146](C:/Hanumansai_Projects/Justride/Backend/src/services/chat.service.js:146)

**Fix overlapping pages when `skip + limit` exceeds the message count.**

`$slice: [-(skip + limit), limit]` starts at index 0 when `skip + limit > messages.length`, and it still returns up to `limit` items. Example: 60 messages, `skip=40`, `limit=50`. The query returns messages 0â€“49. The correct result is messages 0â€“19, so messages 10â€“49 duplicate the first page. Clients that load older history show repeated messages.

Compute the window from `$size` in an aggregation. Or fetch the count first, and set `n = min(limit, max(len - skip, 0))`.

Suggested fix: Update the message pagination around SupportTicket.findById to avoid overlapping pages when skip + limit exceeds the message count: compute the available window from the message count, limiting the returned items to max(messageCount - parsedSkip, 0) and parsedLimit. Preserve the existing behavior for pages within the message range.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-39 — MINOR: Escape `search` before you build the `RegExp`.

Location: [src/controllers/admin/support.controller.js:33](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/support.controller.js:33)

**Escape `search` before you build the `RegExp`.**

`new RegExp(req.query.search.trim(), "i")` compiles raw input. An input such as `(` throws a SyntaxError and returns a 500 error. A crafted pattern can cause catastrophic backtracking in MongoDB. If the client sends `search` as an array (`?search=a&search=b`), `.trim` throws.

Suggested fix: Update the search handling that builds rx: process req.query.search only when it is a string with non-empty trimmed content, escape regex metacharacters before constructing the RegExp, and bound the input length to prevent oversized searches. Keep the resulting case-insensitive literal search for subject and ticket_number.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-42 — MINOR: Call `refreshHeartbeat`, or remove the TTL on the presence set.

Location: [src/services/presence.service.js:16](C:/Hanumansai_Projects/Justride/Backend/src/services/presence.service.js:16)

**Call `refreshHeartbeat`, or remove the TTL on the presence set.**

`setUserOnline` sets a 5-minute TTL on `chat:presence:`. None of the reviewed socket handlers call `refreshHeartbeat`. When Redis is enabled, a user who stays connected for more than 5 minutes shows as offline in `getUserStatus`. Refresh the TTL on a socket heartbeat or on each event. Alternatively, call it on an interval for each connected socket.

Also applies to: 86-95

Suggested fix: Refresh the presence TTL through refreshHeartbeat for connected users, invoking it on socket heartbeats or events (or periodically per connected socket), so setUserOnlineâ€™s five-minute TTL does not expire during an active connection and getUserStatus continues to report the user online.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-43 — MINOR: Require ticket-room membership before you relay `typing`, `markasread`, and `leaveticket` events.

Location: [src/socket/chat.socket.js:73](C:/Hanumansai_Projects/Justride/Backend/src/socket/chat.socket.js:73)

**Require ticket-room membership before you relay `typing_*`, `mark_as_read`, and `leave_ticket` events.**

`socket.to(room)` delivers to room members even when the sender is not a member. These handlers do not call `verifyTicketAccess` and do not check `socket.rooms`. Any authenticated user can send fake typing indicators, read receipts, and leave events to any ticket by ID. Those events include the sender's name.

Check `socket.rooms.has(\`ticket:${ticketId}\`)` before you emit. `join_ticket` already verifies access before it adds the socket to the room.

Also applies to: 159-179, 184-195

Suggested fix: Require the socket to belong to the corresponding ticket room before relaying events from the typing_start, typing_stop, mark_as_read, and leave_ticket handlers. Apply the membership check before each event is emitted, while preserving the existing event payloads and behavior for authorized room members.

Validation: Verified: socket event forwarding does not require membership in the target ticket room for the reported handlers.

### CR-44 — MINOR: Add an audit log to the soft-delete branch and fix the response message.

Location: [src/controllers/admin/firmware.controller.js:193](C:/Hanumansai_Projects/Justride/Backend/src/controllers/admin/firmware.controller.js:193)

**Add an audit log to the soft-delete branch and fix the response message.**

The deprecate path updates the release and returns without calling `audit.log`. The hard-delete path is audited. A deprecation therefore leaves no audit record. The template `${deviceOnVersion._id ? "..." : ""}` is always truthy here, because `exists()` returns a document only when a match exists. Use a static message.

Suggested fix: In the `deviceOnVersion` soft-delete branch, add a successful `audit.log` entry for the firmware release deprecation, including the request, release identifier, and deprecation action. Replace the conditional response-message suffix with a static message stating that devices remain on this version.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-45 — MINOR: Select `devicename` and `deviceid` for the notification text.

Location: [src/controllers/device/pairing.controller.js:284](C:/Hanumansai_Projects/Justride/Backend/src/controllers/device/pairing.controller.js:284)

**Select `devicename` and `device_id` for the notification text.**

The projection is inclusion-only (`linked_to unlink_otp unlink_otp_expires`), so `device.devicename` and `device.device_id` are always undefined. The security alert on Line 312 therefore always says "Ride Device", and `data.device_id` is undefined.

[Code sample omitted.]

Suggested fix: Update the projection passed to findDeviceByIdentifier in the device unlink flow to include devicename and device_id, so the security alert can use the device name and ID. Preserve the linked_to field required by the flow.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-46 — MINOR: Recheck the one-device-per-user rule inside the transaction.

Location: [src/controllers/device/pairing.controller.js:202](C:/Hanumansai_Projects/Justride/Backend/src/controllers/device/pairing.controller.js:202)

**Recheck the one-device-per-user rule inside the transaction.**

The `userCurrentDevice` check (Line 144, Line 167) runs before the transaction. Suppose the same user sends two concurrent pair requests for two different devices. Both requests pass the check. Their `device_link_version` increments then conflict, and `connection.transaction` retries the losing callback. The retry does not recheck anything, so it pairs the second device too. The user ends up with two paired devices, and `getMyDevice` then returns only one of them.

Suggested fix: Recheck the one-device-per-user rule inside the transaction callback after confirming the account is active and before updating the device. Use the transaction session to query for another paired device linked to req.user._id, excluding device._id; if one exists, abort with the existing conflict response behavior.

Validation: Verified by source inspection: the one-device-per-user check runs before the transaction; the transaction retry does not repeat it.

### CR-47 — MINOR: Do not fail the request after the account already exists.

Location: [src/controllers/userController.js:235](C:/Hanumansai_Projects/Justride/Backend/src/controllers/userController.js:235)

**Do not fail the request after the account already exists.**

`forgotPassword` (Line 573-574) guards `sendEmail` because it can throw. Here the call is unguarded. If the confirmation email throws, `register` returns 500 after it has created the user and enqueued the notification. When the client retries, it gets 409 and has no tokens. Line 648 in `resetPassword` has the same pattern: the new password is saved, but the client receives 500.

Wrap both post-commit email calls in try/catch and log the failure.

Suggested fix: In register and resetPassword, guard the post-commit sendEmail calls with try/catch and log email failures so an email error does not turn a completed account creation or password reset into a failed request.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-53 — MINOR: Map upload errors to 4xx responses.

Location: [src/middlewares/errorHandler.js:5](C:/Hanumansai_Projects/Justride/Backend/src/middlewares/errorHandler.js:5)

**Map upload errors to 4xx responses.**

`errorHandler` reads only `err.statusCode` and `err.status`. These upload errors carry neither:
- `MulterError` (for example `LIMIT_FILE_SIZE`)
- the plain `Error` objects from the `fileFilter` in `src/middlewares/upload.middleware.js`
- the plain `Error` objects from the `fileFilter` in `src/middlewares/firmwareUpload.js`

All of them become status 500. In production the client sees "Internal Server Error". Each bad upload also writes a `SERVER_ERROR` audit record. A user error then looks like a server fault, and it pollutes the audit log. This assumes the upload routes do not handle these errors first. `src/routes/uploadRoutes.js` is not in this review set.

Suggested fix: Update errorHandler to map MulterError instances to 413 for LIMIT_FILE_SIZE and 400 for other Multer errors, while preserving existing status handling and the 500 fallback. Set status 400 on errors created by both upload fileFilter callbacks so they are handled as client errors rather than server errors.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-54 — MINOR: Ignore other env files and the `.vercel` directory.

Location: [.gitignore:1](C:/Hanumansai_Projects/Justride/Backend/.gitignore:1)

**Ignore other env files and the `.vercel` directory.**

Only `.env` is ignored. The repo deploys to Vercel (`vercel.json`). `vercel env pull` writes `.env.local` and `.vercel/.env.*.local`, which contain production secrets. `.vercel/project.json` also holds project IDs. A `git add .` would commit these files.

Suggested fix: Update the ignore patterns in the `.gitignore` diff to cover `.env.*` files and the `.vercel` directory, while adding an exception so `.env.example` remains trackable; preserve the existing `.env`, `node_modules/`, and `*.log` entries.

Validation: Exclude this issue as a snapshot artefact. The temporary review checkout used a minimal .gitignore; the actual repository already ignores .env and .env.* except .env.example. This audit does not establish a tracked .vercel secret leak.

### CR-55 — MINOR: Verify that the `accountIp` key uses the same field the login controller authenticates.

Location: [src/security/rateLimiter.js:13](C:/Hanumansai_Projects/Justride/Backend/src/security/rateLimiter.js:13)

**Verify that the `accountIp` key uses the same field the login controller authenticates.**

The key uses the first truthy value among `identifier`, `email`, `username`, and `employee_id`. If a login controller authenticates by `email` and ignores `identifier`, a client can send a changing decoy `identifier` with a fixed `email`. Each request then gets a new bucket. The 5-per-15-minute per-account limit is bypassed. Only the `authIp` limit (100 per 15 minutes) remains, and only if the route applies it.

Check the login and password-reset controllers. Make the limiter key use the field the controller reads, or reject requests that send conflicting identifier fields.

Suggested fix: Update the account key generation in the rate limiter so `accountIp` is based on the same identifier field the login and password-reset controllers authenticate, rather than a client-controlled higher-priority decoy field. Alternatively, reject requests with conflicting identifier fields before selecting the key; preserve the existing per-account limit.

Validation: Verified: limiter and admin login choose different precedence for identifier/email/username/employee_id, so a changing decoy field can split the intended account/IP quota.

### CR-56 — MINOR: Do not skip invalidation for `bulkWrite` inserts and deletes.

Location: [src/models/plugins/invalidateAdminCache.js:8](C:/Hanumansai_Projects/Justride/Backend/src/models/plugins/invalidateAdminCache.js:8)

**Do not skip invalidation for `bulkWrite` inserts and deletes.**

For a `bulkWrite` that only inserts or only deletes, the result has `modifiedCount === 0` and `upsertedCount === 0`. Line 8 then returns early, and `deletedCount` on line 9 is never checked for that case. The cache groups stay stale until the 30-second TTL expires. The `bulkWrite` hook is registered on line 13, so this path is reachable. Check `insertedCount` and `deletedCount` before skipping.

Suggested fix: Update the early-return checks in the cache invalidation logic so `bulkWrite` results with inserted or deleted documents proceed to invalidation, even when `modifiedCount` is zero. Use `insertedCount` and `deletedCount` when deciding whether the result represents a no-op, and ensure the later `deletedCount` check does not skip those bulk-write results.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-57 — MINOR: Verify that query and params sanitization takes effect on Express 5.

Location: [src/security/sanitize.js:45](C:/Hanumansai_Projects/Justride/Backend/src/security/sanitize.js:45)

**Verify that query and params sanitization takes effect on Express 5.**

In Express 5, `req.query` is a getter that parses the query string again on every access. Mutating the returned object in place changes only a temporary copy. Later reads in controllers see the original, unsanitized values.

`req.params` is set per matched route layer. At app level, `app.use(sanitizeMongo)` sees an empty `req.params`.

So these blocks likely do nothing, and only `req.body` is sanitized. The header comment says in-place mutation preserves the getters, which is not true for `query`. Mongo operator injection through the query string is partly limited by the default `simple` query parser. Reflected XSS payloads in query values and params are not sanitized.

Confirm with a small test: send `?q=` and log `req.query.q` in a handler. If confirmed, sanitize at the point of use, for example in route-level `router.param` or validators, or set `req.query` through a defined property.

Also applies to: 63-68

Suggested fix: Update the query and params handling in the sanitization middleware so downstream handlers receive sanitized values: avoid mutating the temporary object returned by Express 5â€™s req.query getter, and sanitize req.params only after route matching populates it. Preserve the existing sanitization behavior while applying it to the values handlers actually read.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

### CR-58 — MINOR: Disconnect when a post-connect check fails.

Location: [src/config/db.js:33](C:/Hanumansai_Projects/Justride/Backend/src/config/db.js:33)

**Disconnect when a post-connect check fails.**

`mongoose.connect` succeeds first. Then `verifyAdmin()` or `ensureAuditRetention()` can throw. The connection stays open and `cachedConnection` stays `null`. The middleware in `src/app.js` skips `connectDB()` when `mongoose.connection.readyState === 1`. In a warm serverless instance, only the first request fails. Later requests run with the single-admin invariant and the TTL index never enforced.

Close the connection before rethrowing so the next request retries the checks.

Suggested fix: In the post-connect checks in the connection setup, wrap the calls to verifyAdmin and auditRetention so any failure disconnects Mongoose before rethrowing the original error. Keep cachedConnection assignment after both checks succeed.

Validation: Reported by CodeRabbit; not independently reproduced in this audit.

## Limits

- Static source audit, not a penetration test or production infrastructure assessment.
- Exposed credentials were not used to access any storage service.
- No emails were sent, account passwords changed, or production data modified during this audit.
- The fixed admin OTP recipient remains as requested; recommendations to change it were not applied.
- Raw review counts include conditional or unconfirmed issues. The snapshot .gitignore issue is not an actual-repository finding.

## Remediation — 29 October 2026

The original 58 issues are retained above as the historical CodeRabbit report. CR-24 and the equivalent recipient recommendation CR-12 are intentional exceptions. CR-13 and CR-48 were verified against existing code/dependency versions. CR-20 code is fixed, but external key rotation is still pending owner confirmation.

| Issue | Resolution |
| --- | --- |
| CR-01 | Explicit insert timestamps for idempotent ride writes. |
| CR-02 | Reject invalid coordinate types, empty values and out-of-range coordinates. |
| CR-03 | Saved-address routes require customer role. |
| CR-04 | Denied map budgets always produce a positive retry delay. |
| CR-05 | Added explicit PATCH /read-all. |
| CR-06 | Configurable Android package, valid FCM token payload, omitted absent release ID. |
| CR-07 | Notification page size is positive and bounded. |
| CR-08 | Safe reply preview with ellipsis only when truncated. |
| CR-09 | Serverless notification writes bypass unconsumed BullMQ jobs; persistent servers retain workers. |
| CR-10 | Interest-email scheduling handles response close. |
| CR-11 | Quota lookup failure preserves a retryable queued status. |
| CR-12 | Preserved fixed admin security recipient per explicit owner requirement. |
| CR-13 | Verified existing express.urlencoded runs before unsubscribe routes; no change needed. |
| CR-14 | Automatic release broadcasts are restricted to stable channels. |
| CR-15 | Empty firmware catalog returns no release instead of a fabricated version. |
| CR-16 | Compound platform/version uniqueness; startup creates replacement before removing legacy version-only index. |
| CR-17 | Bounded firmware version/type and safe storage object keys. |
| CR-18 | Escaped admin firmware search. |
| CR-19 | APK extension and allowed MIME must both match. |
| CR-20 | Removed committed R2 credential fallbacks and fake successful uploads. Owner must still rotate/revoke exposed keys; acknowledgement is not rotation confirmation. |
| CR-21 | Firmware notifications target compatible active devices, active customers, newer versions, and guard metadata against concurrent changes. |
| CR-22 | Publisher population selects actual name/email fields. |
| CR-23 | Escaped user search. |
| CR-24 | EXCLUDED: admin OTP remains hanumansai72@gmail.com as explicitly requested. |
| CR-25 | Escaped helper search. |
| CR-26 | Random unique employee identifiers replace deletion-sensitive counts. |
| CR-27 | Staff projections explicitly exclude device secrets and hashes. |
| CR-28 | Retired devices cannot be unblocked. |
| CR-29 | Escaped device search. |
| CR-30 | Helper password changes revoke refresh/access/socket sessions. |
| CR-31 | Device identifiers must have valid string type/length. |
| CR-32 | Chat update projection retains assigned support member. |
| CR-33 | Presence queries require staff access or a shared support ticket. |
| CR-34 | Express wildcard segments join into one image identifier. |
| CR-35 | Older chat pages no longer overlap. |
| CR-36 | Presence broadcasts restricted to staff room. |
| CR-37 | Support device actions verify current ownership at the write. |
| CR-38 | Post-save notifications are best effort; failures do not reject saved tickets/messages. |
| CR-39 | Escaped support search. |
| CR-40 | Legacy support endpoints enforce owned attachments and server-selected priority. |
| CR-41 | Chat attachments require the sender-owned Cloudinary upload prefix. |
| CR-42 | Live socket heartbeat restores presence TTL. |
| CR-43 | Read/typing/leave events require authorized room membership. |
| CR-44 | Firmware soft deletion emits audit record and uses accurate response text. |
| CR-45 | Unlink alert selects devicename and device_id. |
| CR-46 | Pairing rechecks one-device rule inside transaction and rolls back failed writes; same-owner reconnect permitted. |
| CR-47 | Registration side effects no longer fail an already-created account response. |
| CR-48 | Verified installed Mongoose 9 async hook signatures; no next callback required. |
| CR-49 | Missing phone excluded from duplicate query; existing required-field validation retained. |
| CR-50 | Sign-out-all derives account from signed, stored refresh credential and revokes session version. |
| CR-51 | Removed unverified Google fallback; validate audience, expiry, verified email and subject binding. |
| CR-52 | Firmware type matching is literal and exact. |
| CR-53 | Upload and database validation errors map to appropriate 4xx statuses. |
| CR-54 | Existing .env.* ignore verified; .vercel/ added. |
| CR-55 | Account/IP limiter uses the login endpoint actual identifier precedence. |
| CR-56 | Bulk insert/delete counts trigger cache invalidation. |
| CR-57 | Sanitized Express 5 query persists and native router.param sanitizes matched parameters. |
| CR-58 | Failed startup verification disconnects MongoDB and does not expose an unverified connection. |

### Additional follow-up fixes

The full follow-up review raised 44 issues. Verified existing protections: per-user staff notification cache keys, parameter callbacks registered after routes, service-level chat pagination bounds, and global Multer error mapping. Early-interest duplicate emails intentionally remain blocked even after unsubscribe, per the owner's explicit instruction. The repeated fixed OTP recipient recommendation remains excluded.

Additional fixes cover customer-only password login, explicit rejection of automatic Google/local account linking, no unverified profile-email changes, immediate socket revocation after deletion, normalized helper authorization, revocation after helper status/role changes, fixed support priorities and input limits, bounded image previews, removed socket query-string credentials, accurate socket ACKs, current socket identity, hardware-specific firmware checks, retirement of the duplicate firmware publishing endpoint, firmware file validation, safe production database errors, preserving raw password input, fail-closed sanitization, proxy configuration parsing and bounded Redis readiness.

### Validation

- 107 JavaScript source files pass syntax checks.
- 52 focused security regression checks pass (temporary ignored validation script; no test files added to tracked source).
- npm production dependency audit: **0 vulnerabilities** after compatible patch updates and a Zod 4 override for Vercel CLI configuration.
- Final CodeRabbit follow-up: **1 issue** (potential missing waitUntil import in support.controller.js). Verified false positive: the import exists on line 2 and runtime notification-failure checks exercise the handlers successfully. The earlier full follow-up raised 44 issues; valid issues were addressed and existing/intentional protections are documented above.
- No real push notifications or transactional emails were sent during these checks. No customer records were changed by validation. Production deployment verification was not performed; publishing status is reported separately.
- Release index migration is installed in backend startup and tested for create-before-drop ordering; deployment must complete successfully before serving requests.
- This report is not a claim that the entire application is free of security issues. Cloudflare key rotation remains required.

## Admin session management — 29 October 2026

Admin Profile now lists signed-in admin browsers with current-session indicator, sign-in time, IP and location when trusted deployment headers provide it. Only ADMIN can call GET /api/admin/profile/sessions or DELETE /api/admin/profile/sessions/:sessionId. Responses never contain access tokens, refresh tokens or their hashes. Session identifiers are stable across refresh rotation; sign-in timestamps are preserved.

Each admin access and refresh credential is bound to its stored session. Removing that session revokes API access immediately and disconnects its Socket.IO room. Visible admin browser tabs recheck their session every 30 seconds and on focus without reloading the sidebar. Customer and helper sessions retain their existing behavior. Existing admin tokens lack a session binding and require one fresh sign-in after deployment. The existing five-session limit remains enforced.

Validation: 31 focused admin-session checks passed; backend syntax checks passed; admin Vite production build passed; lint has warnings but no errors. Temporary validation script removed. No real admin sessions were revoked during validation. Deployment must include both the backend and admin frontend.
