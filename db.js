// db.js — MongoDB connection and schemas
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI
  || 'mongodb://root:example@localhost:27017/api-test?authSource=admin';

// ─── Schemas ──────────────────────────────────────────────────────────────────

// One document per check run
const runSchema = new mongoose.Schema({
  triggeredBy: { type: String, required: true },        // 'startup' | 'scheduler' | 'manual'
  startedAt:   { type: Date,   required: true },
  completedAt: { type: Date,   default: null  },
  durationMs:  { type: Number, default: null  },
});

// One document per URL checked in a run
const urlResultSchema = new mongoose.Schema({
  runId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Run', required: true, index: true },
  url:        { type: String,  required: true },
  ok:         { type: Boolean, required: true },
  status:     { type: mongoose.Schema.Types.Mixed },   // Number or 'N/A'
  ms:         { type: Number },
  error:      { type: String },
  checkedAt:  { type: Date, default: Date.now },
});

// One document per NC probe in a run
const ncResultSchema = new mongoose.Schema({
  runId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Run', required: true, index: true },
  target:     { type: String,  required: true },
  open:       { type: Boolean, required: true },
  durationMs: { type: Number  },
  checkedAt:  { type: Date, default: Date.now },
});

// ─── Models ───────────────────────────────────────────────────────────────────
const Run       = mongoose.model('Run',       runSchema);
const UrlResult = mongoose.model('UrlResult', urlResultSchema);
const NcResult  = mongoose.model('NcResult',  ncResultSchema);

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connect(logger) {
  try {
    await mongoose.connect(MONGO_URI);
    logger.info(`MongoDB connected uri=${MONGO_URI.replace(/:[^:@]+@/, ':***@')}`);
  } catch (err) {
    // Non-fatal — app works without DB, just logs the error
    logger.error(`MongoDB connection failed: ${err.message}`);
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** Create a run document and return its _id */
async function startRun(triggeredBy) {
  const run = await Run.create({ triggeredBy, startedAt: new Date() });
  return run._id;
}

/** Finalise a run, bulk-insert URL and NC results */
async function finishRun(runId, urlResults, ncResults, durationMs) {
  const completedAt = new Date();

  await Promise.all([
    Run.findByIdAndUpdate(runId, { completedAt, durationMs }),

    urlResults.length
      ? UrlResult.insertMany(urlResults.map(r => ({ ...r, runId, checkedAt: completedAt })))
      : Promise.resolve(),

    ncResults.length
      ? NcResult.insertMany(ncResults.map(r => ({ ...r, runId, checkedAt: completedAt })))
      : Promise.resolve(),
  ]);
}

/** Return the last N completed runs (summary only) */
async function getRecentRuns(limit = 20) {
  return Run.find({ completedAt: { $ne: null } })
    .sort({ startedAt: -1 })
    .limit(limit)
    .lean();
}

/** Return URL + NC results for a single run */
async function getRunResults(runId) {
  const [run, urlResults, ncResults] = await Promise.all([
    Run.findById(runId).lean(),
    UrlResult.find({ runId }).lean(),
    NcResult.find({ runId }).lean(),
  ]);
  return { run, urlResults, ncResults };
}

/** Return whether mongoose is currently connected */
function isConnected() {
  return mongoose.connection.readyState === 1;
}

module.exports = { connect, startRun, finishRun, getRecentRuns, getRunResults, isConnected };
