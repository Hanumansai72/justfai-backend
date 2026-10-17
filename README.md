# JustRide Backend API

> Scalable IoT Telemetry, Device Fleet Management, OTA Firmware, and Administration Engine for JustRide Smart Mobility Platform.

[![Node.js Version](https://img.shields.io/badge/node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org)
[![Express Version](https://img.shields.io/badge/express-5.x-blue.svg)](https://expressjs.com)
[![MongoDB](https://img.shields.io/badge/database-MongoDB%20Mongoose-brightgreen.svg)](https://mongoosejs.com)
[![License](https://img.shields.io/badge/license-MIT-purple.svg)](LICENSE)

---

## 📖 Overview

> 💡 **New to the project?** Check out the comprehensive [Developer Guide & Architecture Reference](DEVELOPER_GUIDE.md) for a detailed file-by-file breakdown, system diagrams, and step-by-step instructions on building new features.

The **JustRide Backend** is a production-grade, modular Node.js/Express server providing enterprise REST APIs for:
- **Rider Authentication & OAuth Lifecycle**: JWT Access (15m) & Refresh token rotation with bcrypt password hashing.
- **BLE Hardware Telemetry & Pairing**: Device state tracking, battery telemetry, signal RSSI monitoring, and remote force-unlinking.
- **OTA Firmware Deployment**: Semantic versioning, staged rollout channels (Stable/Beta/Canary), and OTA binary delivery.
- **Enterprise Staff & Helper Hierarchy**: Employee provisioning, workload balancing, and support ticket resolution.
- **Audit & Security Compliance**: Immutable 24h event logs, actor tracing, severity classification, and forensic diff tracking.
- **Support Ticketing System**: Multi-actor threads, diagnostics note logging, and device remote action triggers.

---

## 🛠️ Tech Stack & Architecture

- **Runtime**: Node.js (ES Modules / CommonJS architecture)
- **Framework**: Express.js 5.x with async router wrappers
- **Database**: MongoDB with Mongoose ODM
- **Caching & Rate Limiting**: Redis with graceful in-memory fallback
- **Authentication**: Dual-Token JWT (Access + Rotating Refresh Tokens in HTTP-only cookies)
- **File Uploads**: Multer with cloud/local disk storage engine & wildcard preview streams
- **Validation**: Joi / express-validator schema sanitation

---

## 📂 Project Structure

```bash
Backend/
├── src/
│   ├── config/             # DB connection, Redis, environment configs
│   ├── controllers/        # Domain controllers (auth, devices, support, audit, etc.)
│   │   ├── admin/          # Admin & staff controllers (audit, stats, users)
│   │   ├── auth/           # Rider authentication
│   │   ├── device/         # BLE hardware fleet & telemetry
│   │   ├── firmware/       # OTA binary distribution & channels
│   │   ├── helper/         # Support staff operations
│   │   └── support/        # Ticket queue & messaging
│   ├── middleware/         # Auth guards, role authorization, rate limiters, uploaders
│   ├── models/             # Mongoose schemas & compound indexes
│   ├── routes/             # Express 5 endpoint routers
│   ├── services/           # Business logic & telemetry aggregators
│   ├── utils/              # Token generators, loggers, response formatters
│   ├── app.js              # Express application configuration
│   └── server.js           # HTTP listener & lifecycle management
├── .env.example            # Sample configuration keys
├── .gitignore              # Git ignore rules
├── package.json            # Node.js dependencies & scripts
└── README.md               # Documentation
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: `v18.0.0` or higher
- **MongoDB**: `v6.0` or higher (Local or MongoDB Atlas)
- **Redis** *(optional)*: For distributed caching & rate limiting

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/Mainorg2026/Justride_Backend.git
cd Justride_Backend

# Install dependencies
npm install
```

### 3. Environment Configuration
Create a `.env` file in the root directory:
```env
PORT=5000
NODE_ENV=development

# Database
MONGO_URI=mongodb://localhost:27017/justride

# Redis Cache (Optional)
REDIS_URL=redis://127.0.0.1:6379

# JWT Secrets
JWT_ACCESS_SECRET=your_super_secret_access_jwt_key
JWT_REFRESH_SECRET=your_super_secret_refresh_jwt_key
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# File Storage
UPLOAD_PATH=./uploads
```

### 4. Running the Server
```bash
# Start development server with auto-reload
npm run dev

# Start production server
npm start
```

---

## 📡 API Endpoints Reference

### 🔐 Authentication & Session
| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Register new rider account | Public |
| `POST` | `/api/auth/login` | Login rider & issue JWT tokens | Public |
| `POST` | `/api/admin/login` | Login admin / helper employee | Public |
| `GET` | `/api/admin/me` | Fetch authenticated session profile | Authenticated |
| `POST` | `/api/auth/refresh-token`| Rotate JWT access token | Public (Cookie) |
| `POST` | `/api/auth/logout` | Invalidate refresh token session | Authenticated |

### 👥 Users & Staff Management
| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/users` | List riders with search, pagination & status filter | Admin |
| `POST` | `/api/admin/users` | Register new rider account | Admin |
| `GET` | `/api/admin/users/:id` | Get rider details, paired devices & addresses | Admin |
| `PATCH`| `/api/admin/users/:id/status`| Suspend or activate rider account | Admin |
| `GET` | `/api/admin/users/:id/activity`| Get user-specific audit timeline | Admin |
| `GET` | `/api/admin/helpers` | List staff members with active ticket counters | Admin |
| `POST` | `/api/admin/helpers` | Provision new employee ID & credentials | Admin |
| `GET` | `/api/admin/helpers/:id` | View staff member metrics & workload | Admin |

### 🏍️ BLE Devices & Hardware Fleet
| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/devices` | Query fleet with pairing & status filters | Admin / Staff |
| `GET` | `/api/admin/devices/:id` | Get telemetry, BLE specs, battery & RSSI | Admin / Staff |
| `POST` | `/api/admin/devices/register` | Register new hardware unit to catalog | Admin |
| `POST` | `/api/admin/devices/:id/block` | Security block device (theft/tamper) | Admin / Staff |
| `POST` | `/api/admin/devices/:id/unblock`| Unblock device and restore access | Admin / Staff |
| `POST` | `/api/admin/devices/:id/force-unlink`| Force disconnect paired rider | Admin / Staff |

### 💾 OTA Firmware Releases
| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/firmware` | List OTA releases and rollout statistics | Admin / Staff |
| `POST` | `/api/admin/firmware` | Publish new signed OTA firmware binary | Admin |
| `DELETE`| `/api/admin/firmware/:id` | Deprecate / remove firmware release | Admin |

### 🛡️ Audit Logs & System Health
| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/stats` | Live platform KPIs & device breakdown | Admin / Staff |
| `GET` | `/api/admin/health` | Service latency, DB status & uptime | Admin / Staff |
| `GET` | `/api/admin/audit-logs` | Query system audit records with diffs | Admin |
| `GET` | `/api/admin/audit-logs/stats`| 24-hour event aggregation & alert counters | Admin |

### 🎫 Support Tickets
| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/support/tickets` | Query support queue with priority filters | Admin / Staff |
| `GET` | `/api/support/tickets/:id` | Get ticket thread & customer diagnostics | Admin / Staff |
| `PATCH`| `/api/support/tickets/:id` | Post staff reply or update status | Admin / Staff |

---

## 🔒 Security Practices

- **Password Hashing**: Salted bcrypt (12 rounds).
- **JWT Protection**: Short-lived tokens with cryptographic signing.
- **CORS & Headers**: Strict CORS origin whitelisting & Helmet HTTP security headers.
- **Audit Logging**: Immutable operational action logging with actor traceability.

---

## Customer ride history

- `POST /api/rides` saves an ended navigation summary; `GET /api/rides?page=1&limit=10` returns only the authenticated customer's rides, sorted by `endTime` and ID descending. `limit=1` supplies the home screen's latest ride. The maximum page size is 10.
- Both routes require an active `USER` account and existing per-user read/write rate limits. The backend derives `user_id` from authentication; request bodies cannot select another account. Responses use `Cache-Control: private, no-store`.
- A unique `{ user_id, sessionId }` index makes uploads idempotent. Repeated uploads return the first saved summary without modifying it. Ensure the Ride model indexes are created when deploying (Mongoose's normal index creation applies).
- Summaries contain start/end places and times, measured distance/duration/speeds, and `completed` or `stopped` status. They do not contain the continuous GPS trace. Values are client-reported ride telemetry.
- Self-service and admin account deletion also remove the user's rides. Deploy this backend before using the updated app's history screens; older releases only logged ride summaries, so their past rides cannot be recovered.

## Account deletion

- `GET /api/users/deletion-status` returns the signed-in customer's linked device, masked email, and whether their current password is required. It is never cached.
- A linked device must first be released through the existing email unlink OTP endpoints. The app prompts for this step from both Profile deletion and Device Settings. Unlinking clears ownership and device credentials so another account can pair the device.
- `POST /api/users/delete-account/otp` requires the current password for local accounts and sends a separate deletion OTP to the registered email. Codes expire after 10 minutes, allow five attempts, and have a 60-second resend cooldown plus the existing OTP/email rate limits. Only an HMAC digest is stored; failed delivery leaves no usable challenge. Hostinger SMTP through Nodemailer sends these security emails independently of marketing consent.
- `DELETE /api/users/delete-account` (also `DELETE /api/users/me`) requires that deletion OTP and the local account password. No linked device is allowed, even if its pairing flag is inconsistent. A transaction removes saved places, rides, support tickets and notifications, anonymizes firmware initiation records, revokes credentials/sessions and marks the account `deleted`.
- OTP inputs must be six-digit strings. Verification uses the authenticated account and database challenge; client `success`/`verified` flags, expiry, attempt counts and account IDs do not authorize deletion. Device unlinking rechecks the stored OTP hash and expiry during its final atomic update, so a concurrent resend or expiry cannot authorize release with a stale code. Changing a received response can affect the client's display but cannot authorize a database mutation.
- A minimal account reservation retains email, normalized phone, deletion timestamp and security/audit references. Existing unique indexes prevent reuse through registration or profile changes; deleted accounts cannot log in, use Google sign-in, or be reactivated by the admin status endpoint. Admin deletion also reserves identities and refuses linked devices.
- Phone numbers normalize to international format; a local 10-digit number is treated as Indian (`+91`). Existing phone formats normalize when deleted. If legacy duplicate formats collide with an existing unique reservation, deletion rolls back for operator resolution rather than freeing either identity.
- Deletion and pairing use MongoDB transactions and coordinate through the same user document, then invalidate admin caches after commit. Deploy on a replica set such as the configured MongoDB Atlas cluster. Standalone MongoDB without transaction support is not supported for these operations.
- Deploy this backend before installing the updated APK. The old password-only deletion path is intentionally rejected. Tests use mocked HTTP/mail and database fixtures; live deletion and SMTP delivery have not been exercised against a real account.

## Help Center and support tickets

- Website product FAQs live in the customer repository. The APK has a separate 24-article troubleshooting library in `assets/help/app_faqs.json`, available without internet. Unconfirmed touchscreen, glove, water resistance, charging, mounting, price, warranty, returns and delivery claims are excluded.
- `POST /api/support/tickets` accepts a category, subject, description, optional help-article ID and up to three account-owned screenshot URLs. Authentication determines the ticket owner and message sender; client role, status, priority and user ID do not override these. Device ownership is checked on the server. Existing ticket history, details and reply endpoints continue to serve the app and admin portal.
- `POST /api/support/attachments` accepts an authenticated customer's JPEG, PNG or WebP image up to 5 MB. It uses the existing Cloudinary configuration and preserves aspect ratio up to 1600px. Images upload only after the app user selects them and agrees to share; these Cloudinary URLs can be viewed by anyone with the link. Uploaded assets follow the existing Cloudinary retention model and are not automatically purged with MongoDB ticket deletion. Do not include private information in screenshots.
- Diagnostic fields are optional and require `diagnostics_consent: true`. Only app version, cached firmware version, phone model, platform, OS version and an entered error code are accepted, with a server consent timestamp. The app collects these only after opting in, offers preview/copy, and excludes location, account details, passwords, OTPs, device secrets and notification content. Android phone/OS data comes from the native platform; it is unavailable on web. Customer-supplied diagnostics are labelled as such in admin.
- `POST /api/support/help-feedback` keeps one current helpful/not helpful vote per customer/article. `GET /api/admin/support/help-feedback?page=1` aggregates counts for ADMIN/HELPER, caps pages at 10 articles, and shows the most not-helpful feedback first. Existing Redis support-cache invalidation applies. Account deletion removes that customer's votes.
- The backend article catalog contains only IDs and question labels. Keep it aligned with the APK bundle when changing articles. Check with `node scripts/check-help-center.cjs` (optionally pass the APK JSON path). Checks use isolated fixtures; no real storage uploads, tickets, or emails are created.
- Deploy the backend before the APK/admin update. Cloudinary environment variables must also exist in the deployed backend. Ticket references now use random unique IDs instead of row counts; existing references still work. Ticket saving completes before staff notifications run through the existing background mechanism.

## Admin list pagination

Admin list endpoints default to 10 records and cap requested page sizes at 10. Lists use newest-first ordering with an ID tie-breaker; pairing history uses the pairing date. Interested Users also returns 10 per page. Staff totals cover the full filtered directory, and notification categories are filtered before pagination.

## Admin Redis cache

- Uses the existing Redis TCP configuration (`ENABLE_REDIS=true`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, and `REDIS_TLS`). No frontend Redis credentials are needed.
- Dashboard statistics and admin lists for users, staff, devices, pairing, firmware, app releases, support, notifications, and Interested Users cache successful responses for 30 seconds. List keys include the authenticated staff ID, role, path, and all query filters/pages; authentication, authorization, and rate limits run before cache access.
- Model hooks invalidate affected cache groups after creates, updates, deletes, and bulk writes, including writes from customer/mobile APIs and workers. User/device changes also invalidate related populated lists and dashboard statistics. Partial batch failures invalidate too; empty queue polls do not.
- Invalidation rotates a shared Redis revision. The next fetch rebuilds the response from MongoDB, including totals and newest-first pagination. Atomic revision checks prevent an older in-flight database read from caching stale data after a write. The portal updates on its next fetch; this does not add a live push channel.
- List responses report `X-Cache: HIT`, `MISS`, or `BYPASS` and use `Cache-Control: private, no-store` so browsers/proxies cannot retain outdated responses. Authentication/session data, individual detail endpoints, health checks, and audit logs are not cached. Audit logging and Interested Users email queue scheduling still run on cache hits.
- Cache Redis commands and cold-start invalidation waits are bounded at 750 ms; unavailable Redis falls back to MongoDB without failing business writes. Failed invalidations are retried before this process reads that cache group again. If invalidation cannot reach Redis, another process can retain its previous admin snapshot until the 30-second TTL expires. Direct database edits outside these model hooks also rely on TTL expiry.
- Public device firmware retains its existing 600-second TTL and now shares firmware write invalidation. Cache keys use a new namespace; older cache entries expire naturally.

## Admin audit trail

- Records staff login success/failure, blocked login, authenticated admin API reads and changes, and explicit logout. Controller events are kept once per request; uncovered operations receive an HTTP action record.
- `POST /api/admin/logout` records the staff identity before the browser clears its session and clears backend authentication cookies. The current refresh token is removed if supplied.
- `POST /api/admin/activity` accepts only page-view and audit-export events for known portal paths. These events are marked as client-reported; the actor comes from verified authentication.
- `GET /api/admin/audit-logs?scope=admin` and `/api/admin/audit-logs/stats?scope=admin` show admin activity. Omit `scope` for all activity. Search includes staff name/email, employee ID, action, IP, and the hashed session reference.
- Records save directly to MongoDB with Vercel `waitUntil`; no Redis worker is needed for new records. The legacy audit worker can still drain old jobs on a persistent server. Failures are reported as `[Audit] PERSIST_FAILED` in server logs.
- Passwords, raw tokens, request bodies, and query values are not added by automatic request auditing. Actor snapshots retain staff identity even when a Helper cannot be populated from the User collection.
- Deploy both backend and admin changes. Activity never saved by older versions cannot be reconstructed. Closing a browser tab does not send a logout event.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


### Single administrator

`Admin.model.js` manages the existing administrator in the `users` collection; `Helper.model.js` manages helper staff. Existing administrator credentials and IDs are preserved. There is no admin signup, promotion endpoint, default password or startup seeder. Only helpers can be provisioned by the existing admin.

Database initialization verifies exactly one `ADMIN` and installs the `single_admin` partial unique index. It never creates an account, resets credentials or deletes duplicate accounts. If the database has zero or multiple admins, initialization fails for explicit operator resolution. Customer account deletion and customer-management actions cannot remove the admin.

Run the isolated account regression checks with `node --test test/single-admin.test.js`.

Local validation: the staff-model/login checks and admin UI production build pass. Live database verification could not run because the configured MongoDB SRV DNS lookup returned `ECONNREFUSED`; the existing database account count and installation of `single_admin` remain unverified. Once database DNS access works, normal database initialization performs the check and creates the index without changing credentials.
