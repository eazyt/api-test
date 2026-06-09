# api-test

A Node.js/Express web application that serves random data endpoints, performs periodic HTTP reachability checks and TCP port probes, streams live results to the browser via Server-Sent Events (SSE), and persists all run history to MongoDB.

---

## Features

- Random number, name, and profile generator endpoints
- Scheduled URL health checks (HEAD/GET) against a list of public URLs, running at random intervals between 1 and 10 minutes
- Parallel TCP port probes (netcat-style) against loopback and common LAN gateway targets
- Live result streaming to `/curls` via SSE — rows appear in the browser the moment each check resolves, no page reload required
- Netcat results cached in memory and served instantly from `/curls/netcat`
- Full run history stored in MongoDB — browse past runs and drill into individual results
- Structured logging to `server.log` in GMT+2 format: `hostname service environment timestamp level message`
- Graceful degradation — if MongoDB is unavailable the app runs normally, history pages show a friendly message

---

## Requirements

| Dependency | Version |
|---|---|
| Node.js | 18+ |
| MongoDB | 4.4+ (via Docker) |

---

## Getting Started

### 1. Start MongoDB

The app expects MongoDB running on `localhost:27017` with the credentials from your `docker-compose.yaml`:

```yaml
environment:
  MONGO_INITDB_ROOT_USERNAME: root
  MONGO_INITDB_ROOT_PASSWORD: example
```

```bash
docker-compose up -d mongo
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run the app

**Development** (auto-restarts on file changes via nodemon):
```bash
npm run dev
```

**Production:**
```bash
npm start
```

The server starts on **http://localhost:3000**

### 4. Configuration

All configuration lives in **`application.properties`** in the project root. The file is loaded automatically every time the app starts — no environment variables need to be set manually.

```properties
# HTTP port the server listens on
PORT=3000

# Environment label used in every log line (e.g. DEV, QA, PROD)
NODE_ENV=DEV

# MongoDB connection string
MONGO_URI=mongodb://root:example@localhost:27017/api-test?authSource=admin
```

Edit `application.properties` to change any value. The app reads it fresh on each startup.

---

## Project Structure

```
api-test/
├── app.js                   # Express app, routes, SSE, check runner
├── db.js                    # Mongoose connection, schemas, and DB helpers
├── application.properties   # Configuration (port, env, MongoDB URI)
├── server.log               # Structured log output (created at runtime)
├── package.json
└── README.md
```

---

## Routes

### General

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Homepage — welcome page with navigation |
| `GET` | `/random` | Returns a randomly generated number between 0 and 999 |
| `GET` | `/names` | Returns a randomly picked lorem ipsum name |
| `GET` | `/details` | Returns a randomly generated full name and bio |

---

### Curls — URL Health Checks

| Method | Path | Description |
|---|---|---|
| `GET` | `/curls` | Live URL check dashboard. Renders instantly; results stream in row-by-row via SSE as each check completes. Includes a netcat summary badge with a link to the NC results page. |
| `POST` | `/curls/run` | Force-triggers a new check run immediately, cancelling the pending scheduled run. Returns `{ triggered: true }` as JSON. Returns HTTP 409 if a run is already in progress. |
| `GET` | `/api/curls/events` | SSE endpoint. Keeps a persistent connection open and pushes named events: `snapshot` (current state on connect), `start` (new run beginning), `url` (individual URL result), `done` (run complete). Used internally by `/curls`. |

---

### Netcat — TCP Port Probes

| Method | Path | Description |
|---|---|---|
| `GET` | `/curls/netcat` | Shows the last cached netcat probe results. Always instant — reads from in-memory cache, no waiting. Includes open/fail counts per target and duration. |
| `GET` | `/api/nc/summary` | Lightweight JSON endpoint returning `{ timestamp, ok, fail }` counts for the last NC run. Used by the `/curls` page to update the NC badge after a run completes. |

---

### History — MongoDB Run Records

| Method | Path | Description |
|---|---|---|
| `GET` | `/curls/history` | Lists the last 30 completed runs stored in MongoDB. Shows start time, trigger source (startup / scheduler / manual), and total duration. Each row links to its full detail page. |
| `GET` | `/curls/history/:runId` | Full result detail for a specific historical run. Displays the complete URL check table and netcat probe table with all statuses, HTTP codes, and durations. |

---

## Logging

All activity is written to `server.log` in the workspace root and also printed to the console.

**Format:**
```
hostname  service  environment  timestamp  LEVEL  message
```

**Example lines:**
```
dev-machine nodejs-crontab DEV 2026-06-09T14:00:00.000+02:00 INFO  Application started
dev-machine nodejs-crontab DEV 2026-06-09T14:00:01.000+02:00 INFO  Starting checks trigger=startup
dev-machine nodejs-crontab DEV 2026-06-09T14:00:02.000+02:00 INFO  URL OK https://www.google.com status=200 ms=143
dev-machine nodejs-crontab DEV 2026-06-09T14:00:02.100+02:00 ERROR URL FAIL https://httpbin.org/get status=N/A error="timeout"
dev-machine nodejs-crontab DEV 2026-06-09T14:00:02.200+02:00 INFO  NC OK 127.0.0.1:3000 ms=2
dev-machine nodejs-crontab DEV 2026-06-09T14:00:02.300+02:00 ERROR NC FAIL 192.168.1.1:80 ms=1000
dev-machine nodejs-crontab DEV 2026-06-09T14:00:02.500+02:00 INFO  ACCESS GET /curls ip=::1 status=200 ms=4
dev-machine nodejs-crontab DEV 2026-06-09T14:00:03.000+02:00 DEBUG Next run in 7 minutes
```

Timestamps are always in **GMT+2**.

---

## MongoDB Collections

| Collection | Contents |
|---|---|
| `runs` | One document per check run — trigger source, start time, completion time, total duration |
| `urlresults` | One document per URL checked — references `runId`, stores url, ok, status, ms, error |
| `ncresults` | One document per TCP probe — references `runId`, stores target, open, durationMs |

### Verifying Data is Stored

**Option 1 — Your browser (no extra tools needed)**

Open the history page while the app is running:
```
http://localhost:3000/curls/history
```
If you see a list of runs with timestamps, data is reaching MongoDB. If you see "MongoDB is not connected", check the container is up and the credentials match.

---

**Option 2 — Check `server.log`**

On startup you should see a successful connection line:
```
INFO  MongoDB connected uri=mongodb://root:example@localhost:27017/api-test?authSource=admin
```
If you see this instead, the container is unreachable or credentials are wrong:
```
ERROR MongoDB connection failed: ...
```

---

**Option 3 — mongosh inside the container**

```bash
docker exec -it infra-mongodb mongosh -u root -p example --authenticationDatabase admin
```

Then inside the shell:
```js
use api-test

// Browse documents
db.runs.find().pretty()
db.urlresults.find().limit(5).pretty()
db.ncresults.find().limit(5).pretty()

// Check record counts
db.runs.countDocuments()
db.urlresults.countDocuments()
db.ncresults.countDocuments()
```

---

**Option 4 — MongoDB Compass (GUI)**

Download from [mongodb.com/products/compass](https://www.mongodb.com/products/compass) and connect with:
```
mongodb://root:example@localhost:27017/?authSource=admin
```
Navigate to the `api-test` database to browse `runs`, `urlresults`, and `ncresults` collections visually with filtering and sorting.

---

## How the Live Streaming Works

1. Browser opens `/curls` — page renders instantly (static HTML shell)
2. Browser opens an `EventSource` connection to `/api/curls/events`
3. Server immediately sends a `snapshot` event with the last completed run's data
4. When checks are running, the server fires a `url` SSE event the moment each individual check resolves
5. Browser appends the row to the table with a fade-in animation — no polling, no page reload
6. On `done` event, the browser fetches `/api/nc/summary` to refresh the netcat badge

---

*eat, sleep, automate — by eazyt*
