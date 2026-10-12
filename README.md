# NodeJS Crontab Monitor

A lightweight Node.js monitoring application that performs scheduled URL availability checks and TCP port connectivity tests, displaying results in real time through a web dashboard using Server-Sent Events (SSE).

## Features
- URL health checks using Axios
- TCP port monitoring using Node.js net sockets
- Real-time updates with Server-Sent Events (SSE)
- Automatic scheduled monitoring (1-10 minute intervals)
- Manual monitoring execution
- Bootstrap-based web UI
- Winston logging
- In-memory result caching

## Endpoints
- `/` Home page
- `/random` Random number generator
- `/names` Random name generator
- `/details` Random user details
- `/curls` URL monitoring dashboard
- `/curls/netcat` TCP probe results
- `/api/curls/events` SSE stream
- `/api/nc/summary` Netcat summary API
- `POST /curls/run` Trigger checks manually

## Installation
```bash
npm install express axios winston
node app.js
```

Application runs on:
```text
http://localhost:3300
```

## Logging
Logs are written to:
```text
server.log
```

## Author
Eat, Sleep, Automate - by eazyt
