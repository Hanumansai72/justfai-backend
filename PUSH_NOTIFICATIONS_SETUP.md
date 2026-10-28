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

## 4. Send from admin

Open the admin notification bell, then **View all notifications**. Administrators see **Release push notifications**, Firebase configuration status, and the number of enabled phone registrations.

- Select **Device firmware** or **Android APK**, choose an active release, and send.
- Publishing or featuring releases also triggers notifications automatically.
- Firmware recipients are active users owning paired, unblocked devices. Android APK recipients are active app users.
- Each manual send saves another inbox entry and sends again; it is intended for deliberate announcements/resends.

The result distinguishes Firebase acceptance from failures. Acceptance is not proof that Android displayed the message. Notifications require Android permission; force-stopped apps cannot receive until reopened. Tapping an update opens the device or notifications screen after sign-in and device connection, respecting the app's device gate.

## Implementation locations

- Backend: `src/services/pushNotification.service.js`, `src/services/releaseNotification.service.js`, `src/controllers/pushNotification.controller.js`, `src/models/PushInstallation.model.js`.
- App: `lib/core/services/push_notification_service.dart`, `android/app/src/main/kotlin/com/example/justride_ui/JustRidePushService.kt`.
- Admin: `src/components/common/ReleasePushComposer.jsx`, embedded in the Notifications page.

Release publication uses Vercel `waitUntil` to keep dispatch work alive after the HTTP response, within the deployment's execution limit. Large broadcasts require a durable worker; this implementation reports bounded batches of 10 concurrent FCM requests and does not claim queued delivery.

Official setup references: [Android setup](https://firebase.google.com/docs/android/setup), [FCM Android registration](https://firebase.google.com/docs/cloud-messaging/android/get-started), [HTTP v1 sending](https://firebase.google.com/docs/cloud-messaging/send/v1-api).
