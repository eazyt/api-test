// app.js
const express = require('express');
const axios   = require('axios');
const net     = require('net');
const os      = require('os');
const path    = require('path');
const { createLogger, format, transports } = require('winston');

const app  = express();
const port = 3300;

// ─── Logger ───────────────────────────────────────────────────────────────────
const HOSTNAME    = os.hostname();
const SERVICE     = 'nodejs-crontab';
const ENVIRONMENT = process.env.NODE_ENV || 'DEV';
const LOG_FILE    = path.join(__dirname, 'server.log');

/** Format a date as ISO-8601 with GMT+2 offset (e.g. 2026-06-09T14:00:00.000+02:00) */
function timestampGMT2() {
  const now        = new Date();
  const offsetMs   = 2 * 60 * 60 * 1000;                  // GMT+2 in ms
  const local      = new Date(now.getTime() + offsetMs);   // shift to +02:00
  return local.toISOString().replace('Z', '+02:00');
}

const customFormat = format.printf(({ level, message, timestamp }) =>
  `${HOSTNAME} ${SERVICE} ${ENVIRONMENT} ${timestamp} ${level.toUpperCase()} ${message}`
);

const logger = createLogger({
  level: 'debug',
  format: format.combine(
    format.timestamp({ format: timestampGMT2 }),
    customFormat
  ),
  transports: [
    new transports.File({ filename: LOG_FILE }),
    new transports.Console()
  ]
});

process.on('uncaughtException',  (err) => logger.error(`UncaughtException ${err.stack || err.message}`));
process.on('unhandledRejection', (err) => logger.error(`UnhandledRejection ${err && (err.stack || err.message)}`));

// ─── Check targets ────────────────────────────────────────────────────────────
const CHECK_URLS = [
  'https://www.google.com',
  'https://www.github.com',
  'https://www.cloudflare.com',
  'https://www.amazon.com',
  'https://www.microsoft.com',
  'https://www.apple.com',
  'https://www.wikipedia.org',
  'https://www.stackoverflow.com',
  'https://www.reddit.com',
  'https://www.npmjs.com',
  'https://httpbin.org/get',
  'https://www.youtube.com',
];

const NC_TARGETS = [
  // Loopback — these respond instantly (open or refused)
  { host: '127.0.0.1', port: 3000 },
  { host: '127.0.0.1', port: 80   },
  { host: '127.0.0.1', port: 443  },
  { host: '127.0.0.1', port: 22   },
  { host: '127.0.0.1', port: 5432 },
  { host: '127.0.0.1', port: 3306 },
  { host: '127.0.0.1', port: 6379 },
  { host: '127.0.0.1', port: 8080 },
  // Common LAN gateways — may timeout if not present, capped at NC_TIMEOUT_MS
  { host: '192.168.1.1',   port: 80  },
  { host: '192.168.1.1',   port: 443 },
  { host: '10.0.0.1',      port: 80  },
  { host: '172.16.0.1',    port: 80  },
];

const URL_TIMEOUT_MS = 4000;
const NC_TIMEOUT_MS  = 1000;  // 1s — TCP SYN either gets a RST/ACK quickly or it doesn't

// ─── State ────────────────────────────────────────────────────────────────────
let lastUrlResults = { timestamp: null, results: [] };   // URL check cache
let lastNcResults  = { timestamp: null, results: [] };   // NC probe cache (memory only)
let checksRunning  = false;
let nextRunTimer   = null;

// SSE clients — only URL check events are streamed (NC goes to cache)
const sseClients = new Set();

/** Send a named SSE event to all connected clients */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
      if (typeof client.flush === 'function') client.flush(); // force through any compression middleware
    } catch (_) { sseClients.delete(client); }
  }
}

// ─── TCP probe ────────────────────────────────────────────────────────────────
// Uses a hard wall-clock timeout via Promise.race so DNS stalls can't block us
function tcpProbe(host, targetPort) {
  const start = Date.now();

  const attempt = new Promise((resolve) => {
    const socket = new net.Socket();

    const done = (open) => {
      socket.removeAllListeners();
      try { socket.destroy(); } catch (_) { /* ignore */ }
      resolve({ open, durationMs: Date.now() - start });
    };

    socket.once('connect', () => done(true));
    socket.once('error',   () => done(false));
    socket.connect({ port: targetPort, host, family: 4 }); // family:4 skips IPv6 DNS lookup
  });

  const deadline = new Promise((resolve) =>
    setTimeout(() => resolve({ open: false, durationMs: NC_TIMEOUT_MS }), NC_TIMEOUT_MS)
  );

  return Promise.race([attempt, deadline]);
}

// ─── URL check ────────────────────────────────────────────────────────────────
async function checkUrl(url) {
  const start = Date.now();
  try {
    // HEAD first — no body transfer, fastest possible signal
    const res = await axios.head(url, { timeout: URL_TIMEOUT_MS, maxRedirects: 3 });
    return { url, ok: true, status: res.status, ms: Date.now() - start };
  } catch (headErr) {
    // Some servers reject HEAD — fall back to GET with stream immediately destroyed
    try {
      const res = await axios.get(url, { timeout: URL_TIMEOUT_MS, maxRedirects: 3, responseType: 'stream' });
      res.data.destroy();
      return { url, ok: true, status: res.status, ms: Date.now() - start };
    } catch (getErr) {
      return {
        url,
        ok:     false,
        status: getErr.response ? getErr.response.status : 'N/A',
        error:  getErr.message || 'unknown error',
        ms:     Date.now() - start,
      };
    }
  }
}

// ─── Core check runner ────────────────────────────────────────────────────────
async function runChecks(triggeredBy = 'scheduler') {
  if (checksRunning) {
    logger.warn(`Check already in progress — skipping trigger source=${triggeredBy}`);
    return;
  }

  checksRunning = true;
  if (nextRunTimer) { clearTimeout(nextRunTimer); nextRunTimer = null; }

  logger.info(`Starting checks trigger=${triggeredBy}`);
  broadcast('start', { triggeredBy, ts: new Date().toISOString() });

  const urlResults = [];
  const ncResults  = [];

  // ── URL checks: fire all in parallel, broadcast each result immediately ──
  const urlPromises = CHECK_URLS.map(async (url) => {
    const entry = await checkUrl(url);
    urlResults.push(entry);
    broadcast('url', entry);  // pushed to SSE the instant this check resolves
    if (entry.ok) logger.info(`URL OK ${url} status=${entry.status} ms=${entry.ms}`);
    else          logger.error(`URL FAIL ${url} status=${entry.status} error="${entry.error}"`);
    return entry;
  });

  // ── NC probes: fire all in parallel, store to cache only — no SSE ──
  const ncPromises = NC_TARGETS.map(async ({ host, port: targetPort }) => {
    const { open, durationMs } = await tcpProbe(host, targetPort);
    const entry = { target: `${host}:${targetPort}`, open, durationMs };
    ncResults.push(entry);
    if (open) logger.info(`NC OK ${entry.target} ms=${durationMs}`);
    else      logger.error(`NC FAIL ${entry.target} ms=${durationMs}`);
    return entry;
  });

  // Both batches run concurrently — total wall time = slowest single check
  await Promise.all([Promise.all(urlPromises), Promise.all(ncPromises)]);

  const ts = new Date().toISOString();
  lastUrlResults = { timestamp: ts, results: urlResults };
  lastNcResults  = { timestamp: ts, results: ncResults  };
  checksRunning  = false;

  broadcast('done', { timestamp: ts });
  logger.info('Checks complete');
  scheduleNextRun();
}

function scheduleNextRun() {
  const minutes = Math.floor(Math.random() * 10) + 1;
  logger.debug(`Next run in ${minutes} minute${minutes > 1 ? 's' : ''}`);
  nextRunTimer = setTimeout(() => runChecks('scheduler'), minutes * 60 * 1000);
}

// ─── Page template (non-curls pages) ─────────────────────────────────────────
function pageTemplate(title, content, refreshPath = null) {
  const buttons = refreshPath
    ? `<div class="mt-4">
         <a href="/" class="btn btn-primary me-2">Home</a>
         <a href="${refreshPath}" class="btn btn-secondary">Refresh</a>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="d-flex flex-column min-vh-100">
  <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
    <div class="container-fluid">
      <a class="navbar-brand" href="/">Random API</a>
      <div class="collapse navbar-collapse">
        <ul class="navbar-nav me-auto">
          <li class="nav-item"><a class="nav-link" href="/random">Numbers</a></li>
          <li class="nav-item"><a class="nav-link" href="/names">Names</a></li>
          <li class="nav-item"><a class="nav-link" href="/details">Details</a></li>
          <li class="nav-item"><a class="nav-link" href="/curls">Curls</a></li>
        </ul>
      </div>
    </div>
  </nav>
  <main class="flex-grow-1 d-flex justify-content-center align-items-center">
    <div class="container py-4 text-center">
      ${content}
      ${buttons}
    </div>
  </main>
  <footer class="bg-dark text-light text-center py-2 mt-auto">
    eat, sleep, automate — by eazyt
  </footer>
</body>
</html>`;
}

// ─── Middleware: access logging ───────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  const ip    = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  res.on('finish', () => {
    logger.info(`ACCESS ${req.method} ${req.path} ip=${ip} status=${res.statusCode} ms=${Date.now() - start}`);
  });
  next();
});

// ─── Sample data ──────────────────────────────────────────────────────────────
const loremNames = ['Lorem', 'Ipsum', 'Dolor', 'Sit', 'Amet', 'Consectetur', 'Adipiscing', 'Elit'];
const bios = [
  'A creative thinker with a passion for design.',
  'An experienced developer who loves solving problems.',
  'A storyteller with a knack for engaging audiences.',
  'A strategist focused on building scalable solutions.',
  'An innovator constantly exploring new ideas.',
];

// ─── Standard routes ──────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  logger.debug('ROUTE GET / serving homepage');
  res.send(pageTemplate('Home', `
    <h1>Welcome to the Random API</h1>
    <p>Select an option from the header above.</p>
  `));
});

app.get('/random', (_req, res) => {
  const n = Math.floor(Math.random() * 1000);
  logger.debug(`ROUTE GET /random generated number=${n}`);
  res.send(pageTemplate('Random Number', `<h2>Random Number: ${n}</h2>`, '/random'));
});

app.get('/names', (_req, res) => {
  const name = loremNames[Math.floor(Math.random() * loremNames.length)];
  logger.debug(`ROUTE GET /names generated name="${name}"`);
  res.send(pageTemplate('Random Name', `<h2>Random Name: ${name}</h2>`, '/names'));
});

app.get('/details', (_req, res) => {
  const firstName = loremNames[Math.floor(Math.random() * loremNames.length)];
  const lastName  = loremNames[Math.floor(Math.random() * loremNames.length)];
  const bio       = bios[Math.floor(Math.random() * bios.length)];
  logger.debug(`ROUTE GET /details generated name="${firstName} ${lastName}"`);
  res.send(pageTemplate('Details', `<h2>${firstName} ${lastName}</h2><p>${bio}</p>`, '/details'));
});

// ─── SSE stream: /api/curls/events ───────────────────────────────────────────
// Client opens this once; server pushes each result as it arrives
app.get('/api/curls/events', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache, no-transform');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Snapshot of last completed URL run — page is never blank on connect
  const snapshot = {
    running:    checksRunning,
    timestamp:  lastUrlResults.timestamp,
    urlResults: lastUrlResults.results,
    // NC summary counts for the badge only
    ncOk:   lastNcResults.results.filter(r => r.open).length,
    ncFail: lastNcResults.results.filter(r => !r.open).length,
    ncTs:   lastNcResults.timestamp,
  };
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  if (typeof res.flush === 'function') res.flush();

  sseClients.add(res);
  logger.debug(`SSE client connected total=${sseClients.size}`);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); if (typeof res.flush === 'function') res.flush(); }
    catch (_) { /* swallow */ }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    logger.debug(`SSE client disconnected total=${sseClients.size}`);
  });
});

// ─── /curls — URL checks only, live SSE stream ───────────────────────────────
app.get('/curls', (_req, res) => {
  logger.debug('ROUTE GET /curls serving shell page');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Curls — URL Checks</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    .row-enter { animation: fadeIn 0.3s ease; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
  </style>
</head>
<body class="d-flex flex-column min-vh-100">
  <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
    <div class="container-fluid">
      <a class="navbar-brand" href="/">Random API</a>
      <div class="collapse navbar-collapse">
        <ul class="navbar-nav me-auto">
          <li class="nav-item"><a class="nav-link" href="/random">Numbers</a></li>
          <li class="nav-item"><a class="nav-link" href="/names">Names</a></li>
          <li class="nav-item"><a class="nav-link" href="/details">Details</a></li>
          <li class="nav-item"><a class="nav-link active" href="/curls">Curls</a></li>
        </ul>
      </div>
    </div>
  </nav>

  <main class="flex-grow-1 d-flex justify-content-center align-items-start">
    <div class="container py-4">
      <div class="text-center mb-3">
        <h2 class="mb-1">URL Checks</h2>
        <small id="last-run" class="text-muted d-block mb-2">Connecting&hellip;</small>

        <div class="mb-2">
          <span id="badge-ok"   class="badge bg-secondary me-1">OK: —</span>
          <span id="badge-fail" class="badge bg-secondary me-2">FAIL: —</span>
          <span id="nc-summary" class="text-muted small"></span>
        </div>

        <div id="running-banner" class="alert alert-info py-2 d-none" role="alert">
          <span class="spinner-border spinner-border-sm me-2" role="status"></span>
          Checks running — rows stream in as each result arrives&hellip;
        </div>

        <div class="mb-3">
          <a href="/" class="btn btn-primary me-2">Home</a>
          <button id="btn-run" class="btn btn-warning me-2">Run Now</button>
          <a href="/curls/netcat" class="btn btn-outline-secondary">View Netcat Results</a>
        </div>
      </div>

      <table class="table table-sm table-bordered table-hover">
        <thead class="table-dark">
          <tr><th style="width:80px">Status</th><th>URL</th><th>Detail</th></tr>
        </thead>
        <tbody id="url-tbody">
          <tr id="url-placeholder"><td colspan="3" class="text-muted text-center">Connecting&hellip;</td></tr>
        </tbody>
      </table>
    </div>
  </main>

  <footer class="bg-dark text-light text-center py-2 mt-auto">
    eat, sleep, automate — by eazyt
  </footer>

<script>
  let okCount = 0, failCount = 0;

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function updateBadges() {
    const ok   = document.getElementById('badge-ok');
    const fail = document.getElementById('badge-fail');
    ok.className   = 'badge bg-' + (okCount   > 0 ? 'success' : 'secondary') + ' me-1';
    ok.textContent = 'OK: ' + okCount;
    fail.className   = 'badge bg-' + (failCount > 0 ? 'danger'  : 'secondary') + ' me-2';
    fail.textContent = 'FAIL: ' + failCount;
  }

  function appendRow(r, animate) {
    const ph = document.getElementById('url-placeholder');
    if (ph) ph.remove();
    const badge  = r.ok ? 'success' : 'danger';
    const label  = r.ok ? 'OK'      : 'FAIL';
    const detail = r.ok
      ? 'HTTP ' + r.status + ' &mdash; ' + r.ms + ' ms'
      : 'HTTP ' + r.status + ' &mdash; ' + esc(r.error || '');
    const tr = document.createElement('tr');
    if (animate) tr.className = 'row-enter';
    tr.innerHTML =
      '<td><span class="badge bg-' + badge + '">' + label + '</span></td>' +
      '<td><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.url) + '</a></td>' +
      '<td>' + detail + '</td>';
    document.getElementById('url-tbody').appendChild(tr);
    if (r.ok) okCount++; else failCount++;
    updateBadges();
  }

  function setRunning(on) {
    document.getElementById('running-banner').classList.toggle('d-none', !on);
    document.getElementById('btn-run').disabled = on;
  }

  function setNcSummary(ok, fail, ts) {
    const el = document.getElementById('nc-summary');
    if (ts) {
      el.innerHTML = 'Netcat: <span class="badge bg-success me-1">Open: ' + ok + '</span>'
        + '<span class="badge bg-danger me-1">Fail: ' + fail + '</span>'
        + '<a href="/curls/netcat" class="ms-1">view details</a>';
    }
  }

  const es = new EventSource('/api/curls/events');

  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    setRunning(d.running);
    document.getElementById('last-run').textContent = d.timestamp
      ? 'Last run: ' + d.timestamp
      : (d.running ? 'Checks running\u2026' : 'No results yet');
    d.urlResults.forEach(r => appendRow(r, false));
    setNcSummary(d.ncOk, d.ncFail, d.ncTs);
  });

  es.addEventListener('start', () => {
    okCount = 0; failCount = 0;
    document.getElementById('url-tbody').innerHTML =
      '<tr id="url-placeholder"><td colspan="3" class="text-muted text-center">Running\u2026</td></tr>';
    document.getElementById('last-run').textContent = 'Checks running\u2026';
    updateBadges();
    setRunning(true);
  });

  es.addEventListener('url',  (e) => appendRow(JSON.parse(e.data), true));

  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data);
    document.getElementById('last-run').textContent = 'Last run: ' + d.timestamp;
    setRunning(false);
    // Refresh the NC summary counts after a completed run
    fetch('/api/nc/summary').then(r => r.json()).then(d => setNcSummary(d.ok, d.fail, d.timestamp));
  });

  es.onerror = () => {
    document.getElementById('last-run').textContent = 'Connection lost \u2014 reload to reconnect';
    setRunning(false);
  };

  document.getElementById('btn-run').addEventListener('click', () => {
    fetch('/curls/run', { method: 'POST' });
  });
</script>
</body>
</html>`);
});

// ─── /api/nc/summary — lightweight JSON for the NC badge on /curls ────────────
app.get('/api/nc/summary', (_req, res) => {
  res.json({
    timestamp: lastNcResults.timestamp,
    ok:        lastNcResults.results.filter(r => r.open).length,
    fail:      lastNcResults.results.filter(r => !r.open).length,
  });
});

// ─── /curls/netcat — cached NC results, always instant ───────────────────────
app.get('/curls/netcat', (_req, res) => {
  logger.debug('ROUTE GET /curls/netcat serving cached NC results');

  const { timestamp, results } = lastNcResults;

  const buttons = `
    <div class="mt-4">
      <a href="/" class="btn btn-primary me-2">Home</a>
      <a href="/curls" class="btn btn-secondary me-2">Back to Curls</a>
      <a href="/curls/netcat" class="btn btn-outline-light">Refresh</a>
    </div>`;

  if (!timestamp) {
    return res.send(pageTemplate('Netcat Results', `
      <h2>No Netcat results yet</h2>
      <p class="text-muted">Results are stored after the first check run. Come back shortly.</p>
      ${buttons}
    `));
  }

  const ok   = results.filter(r => r.open).length;
  const fail = results.length - ok;

  const rows = results.map(r => {
    const badge = r.open ? 'success' : 'danger';
    const label = r.open ? 'OPEN'    : 'FAIL';
    return `<tr>
      <td><span class="badge bg-${badge}">${label}</span></td>
      <td>${r.target}</td>
      <td>${r.durationMs} ms</td>
    </tr>`;
  }).join('\n');

  res.send(pageTemplate('Netcat Results', `
    <h2>Netcat / Port Probe Results</h2>
    <p class="text-muted mb-2">Cached from: <strong>${timestamp}</strong></p>
    <p class="mb-3">
      <span class="badge bg-success me-1">Open: ${ok}</span>
      <span class="badge bg-danger">Fail: ${fail}</span>
    </p>
    <table class="table table-sm table-bordered table-hover text-start">
      <thead class="table-dark">
        <tr><th style="width:80px">Status</th><th>Target</th><th>Duration</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${buttons}
  `));
});

// POST /curls/run — force trigger
app.post('/curls/run', (req, res) => {
  if (checksRunning) {
    logger.warn('ROUTE POST /curls/run ignored — checks already in progress');
    res.status(409).json({ triggered: false, reason: 'already running' });
  } else {
    logger.info('ROUTE POST /curls/run manual trigger accepted');
    runChecks('manual').catch(err => logger.error(`runChecks error ${err.message}`));
    res.json({ triggered: true });
  }
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  logger.warn(`NOT FOUND ${req.method} ${req.path}`);
  res.status(404).send(pageTemplate('404', `
    <h2>404 &mdash; Page Not Found</h2>
    <p class="text-muted">${req.method} ${req.path} does not exist.</p>
  `));
});

// ─── Error handler ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error(`SERVER ERROR ${req.method} ${req.path} ${err.stack || err.message}`);
  res.status(500).send(pageTemplate('500', `
    <h2>500 &mdash; Internal Server Error</h2>
    <p class="text-muted">${err.message}</p>
  `));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  logger.info('Application started');
  logger.info(`Server running at http://localhost:${port}`);
  runChecks('startup');
});
