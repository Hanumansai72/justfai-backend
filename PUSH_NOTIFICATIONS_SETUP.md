# JustRide Android release push notifications

The app receives Android notification-bar messages through Firebase Cloud Messaging (FCM). The existing notification inbox is still saved in MongoDB. Firebase is not configured yet, so live push delivery is disabled until these steps are complete.

## 1. Create the Firebase project and Android app

In [Firebase Console](https://console.firebase.google.com/), create a JustRide project. Add an **Android app** with this exact package name:

`com.example.justride_ui`

Download `google-services.json` and place it at:

`C:\Hanumansai_Projects\MobileApp-main\MobileApp-main\android\app\google-services.json`

That file is ignored by Git. The Google Services Gradle plugin is applied only when the file exists; an unconfigured build can still run but cannot receive pushes.

## 2. Configure the backend secret

Enable the **Firebase Cloud Messaging API (HTTP v1)** in the same Google Cloud project. Create a service account with permission to send FCM messages (Firebase Cloud Messaging API Admin), and download its JSON credentials.

Set **FIREBASE_SERVICE_ACCOUNT_JSON** to that complete JSON object in:

- Local: `C:\Hanumansai_Projects\Justride\Backend\.env` (one-line JSON).
- Production: the environment variables for the `backend.justride.cc` deployment, then redeploy.

The Android JSON and backend service account must belong to the same Firebase project. Keep the private service-account JSON out of Git and chat.

## 3. Install and register

Rebuild and install the Android app after adding the Android configuration. Sign in and allow Android notifications. Registration is synchronized on sign-in and resume, using the Firebase Installation ID (FID). Logout disables local delivery immediately and removes the server registration on a best-effort basis; account deletion removes registrations in the database.

## 4. Publish from admin

Open **App APKs > Publish New APK** or **Firmware > Publish Release**. Publishing automatically saves inbox notifications and sends the short update reminder to registered phones. There is no manual send panel. Featuring an existing release does not resend notifications.

- Use the version and build number actually embedded in the APK. Android build numbers must increase.
- Select **Require update before app use** for a mandatory APK release. The app checks at startup and resume, opens a dedicated update screen when a notification is tapped, and blocks normal pages until the installed build meets the requirement. Opening the download does not unlock it. Android still requires the user to confirm APK installation.
- A known mandatory release is cached so a failed check does not bypass the requirement. On a cold start the Android app waits for a successful release check; if unavailable it offers retry instead of normal app access.
- The latest stable published build is the update target. An older featured release cannot hide a newer mandatory update.
- Notifications show only a short reminder; release notes, version numbers, build numbers, and download URLs are not displayed in notification text.
- Firmware recipients are active users owning paired, unblocked devices. APK recipients are active app users with enabled registrations. Firmware notification taps open Device Settings once connected.
- Provider acceptance is not confirmation of Android display. Permission is required, and force-stopped apps receive again only after reopening.

## Implementation locations

- Backend: `src/services/pushNotification.service.js`, `src/services/releaseNotification.service.js`, `src/controllers/pushNotification.controller.js`, `src/models/PushInstallation.model.js`.
- App: `lib/core/services/push_notification_service.dart`, `android/app/src/main/kotlin/com/example/justride_ui/JustRidePushService.kt`.
- Admin: `src/pages/admin/NewAppRelease.jsx` and `src/pages/admin/NewFirmwareRelease.jsx`; notifications run from backend publication handlers.

Release publication uses Vercel `waitUntil` to keep dispatch work alive after the HTTP response, within the deployment's execution limit. Large broadcasts require a durable worker; this implementation reports bounded batches of 10 concurrent FCM requests and does not claim queued delivery.

Official setup references: [Android setup](https://firebase.google.com/docs/android/setup), [FCM Android registration](https://firebase.google.com/docs/cloud-messaging/android/get-started), [HTTP v1 sending](https://firebase.google.com/docs/cloud-messaging/send/v1-api).
