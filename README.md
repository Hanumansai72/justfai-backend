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

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
