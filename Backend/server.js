require("dotenv").config();

const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");

const WinGoResult = require("./models/wingoResult");
const Prediction = require("./models/Prediction");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use(express.static(path.join(__dirname, "..")));

const PORT = process.env.PORT || 3000;

const HISTORY_LIMIT = 100;
const MIN_HISTORY = 20;

/* =========================================================
   ADAPTIVE CACHE
========================================================= */

let adaptiveCache = {
  weights: null,
  performance: null,
  createdAt: 0
};

const ADAPTIVE_CACHE_TTL = 60 * 1000;

/* =========================================================
   SOURCE INGEST STATUS
========================================================= */

let lastIngestAt = null;
let lastIngestCount = 0;
let lastSourceError = null;
let lastSourceErrorTime = null;

/* =========================================================
   BASIC HELPERS
========================================================= */

function normalizeResult(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim().toUpperCase();

  if (text === "BIG" || text === "B") {
    return "BIG";
  }

  if (text === "SMALL" || text === "S") {
    return "SMALL";
  }

  const number = Number(value);

  if (Number.isNaN(number)) {
    return null;
  }

  return number >= 5 ? "BIG" : "SMALL";
}

function toTarget(number) {
  const value = Number(number);

  if (Number.isNaN(value)) {
    return null;
  }

  return value >= 5 ? "BIG" : "SMALL";
}

function incrementIssueNumber(issueNumber) {
  try {
    return (BigInt(String(issueNumber)) + 1n).toString();
  } catch (error) {
    return null;
  }
}

function sortByIssue(results, descending = true) {
  return [...results].sort((a, b) => {
    try {
      const aIssue = BigInt(String(a.issueNumber));
      const bIssue = BigInt(String(b.issueNumber));

      if (aIssue === bIssue) {
        return 0;
      }

      if (descending) {
        return aIssue > bIssue ? -1 : 1;
      }

      return aIssue < bIssue ? -1 : 1;
    } catch (error) {
      return 0;
    }
  });
}

/* =========================================================
   DATABASE CLEANUP
========================================================= */

async function trimResultsToLimit() {
  const results = await WinGoResult.find({})
    .select("_id issueNumber")
    .lean();

  if (results.length <= HISTORY_LIMIT) {
    return;
  }

  const sorted = sortByIssue(results, true);

  const deleteIds = sorted
    .slice(HISTORY_LIMIT)
    .map(item => item._id);

  if (deleteIds.length > 0) {
    await WinGoResult.deleteMany({
      _id: { $in: deleteIds }
    });
  }
}

async function trimPredictionsToLimit() {
  const predictions = await Prediction.find({})
    .select("_id issueNumber")
    .lean();

  if (predictions.length <= HISTORY_LIMIT) {
    return;
  }

  const sorted = sortByIssue(predictions, true);

  const deleteIds = sorted
    .slice(HISTORY_LIMIT)
    .map(item => item._id);

  if (deleteIds.length > 0) {
    await Prediction.deleteMany({
      _id: { $in: deleteIds }
    });
  }
}

/* =========================================================
   GET LAST 100 ACTUAL RESULTS
========================================================= */

async function getLast100Results() {
  const results = await WinGoResult.find({})
    .lean();

  return sortByIssue(results, true)
    .slice(0, HISTORY_LIMIT);
}

/* =========================================================
   SEQUENCE SIGNAL
========================================================= */

function getSequenceSignal(history) {
  const targets = history.map(item =>
    normalizeResult(item.result)
  );

  if (targets.length < 3) {
    return null;
  }

  let bestPrediction = null;
  let bestCount = 0;
  let bestPatternLength = 0;

  for (let length = 2; length <= 5; length++) {
    if (targets.length <= length) {
      continue;
    }

    const recentPattern = targets
      .slice(-length)
      .join(",");

    const following = {
      BIG: 0,
      SMALL: 0
    };

    for (
      let i = 0;
      i + length < targets.length;
      i++
    ) {
      const pattern = targets
        .slice(i, i + length)
        .join(",");

      if (pattern === recentPattern) {
        const next = targets[i + length];

        if (next === "BIG" || next === "SMALL") {
          following[next]++;
        }
      }
    }

    const total =
      following.BIG +
      following.SMALL;

    if (total === 0) {
      continue;
    }

    const prediction =
      following.BIG >= following.SMALL
        ? "BIG"
        : "SMALL";

    const count =
      Math.max(
        following.BIG,
        following.SMALL
      );

    if (count > bestCount) {
      bestCount = count;
      bestPrediction = prediction;
      bestPatternLength = length;
    }
  }

  if (!bestPrediction) {
    return null;
  }

  const total =
    targets.length > 0
      ? bestCount
      : 0;

  const strength =
    total > 0
      ? Math.min(
          1,
          bestCount /
            Math.max(1, total)
        )
      : 0;

  return {
    prediction: bestPrediction,
    strength,
    patternLength: bestPatternLength,
    count: bestCount
  };
}

/* =========================================================
   TRANSITION SIGNAL
========================================================= */

function getTransitionSignal(history) {
  const targets = history.map(item =>
    normalizeResult(item.result)
  );

  if (targets.length < 2) {
    return null;
  }

  const current =
    targets[targets.length - 1];

  if (!current) {
    return null;
  }

  const transitions = {
    BIG: {
      BIG: 0,
      SMALL: 0
    },
    SMALL: {
      BIG: 0,
      SMALL: 0
    }
  };

  for (let i = 0; i < targets.length - 1; i++) {
    const from = targets[i];
    const to = targets[i + 1];

    if (
      transitions[from] &&
      transitions[from][to] !== undefined
    ) {
      transitions[from][to]++;
    }
  }

  const bigCount =
    transitions[current].BIG;

  const smallCount =
    transitions[current].SMALL;

  const total =
    bigCount + smallCount;

  if (total === 0) {
    return null;
  }

  const prediction =
    bigCount >= smallCount
      ? "BIG"
      : "SMALL";

  const strength =
    Math.max(
      bigCount,
      smallCount
    ) / total;

  return {
    prediction,
    strength,
    current,
    bigCount,
    smallCount
  };
}

/* =========================================================
   STREAK SIGNAL
========================================================= */

function getStreakSignal(history) {
  const targets = history.map(item =>
    normalizeResult(item.result)
  );

  if (targets.length === 0) {
    return null;
  }

  const current =
    targets[targets.length - 1];

  if (!current) {
    return null;
  }

  let streak = 0;

  for (
    let i = targets.length - 1;
    i >= 0;
    i--
  ) {
    if (targets[i] === current) {
      streak++;
    } else {
      break;
    }
  }

  if (streak < 3) {
    return {
      prediction: current,
      strength: 0.25,
      streak
    };
  }

  const prediction =
    current === "BIG"
      ? "SMALL"
      : "BIG";

  const strength =
    Math.min(
      1,
      0.5 + streak * 0.1
    );

  return {
    prediction,
    strength,
    streak
  };
}

/* =========================================================
   NUMBER SIGNAL
========================================================= */

function getNumberSignal(history) {
  const numbers = history
    .map(item => Number(item.number))
    .filter(number =>
      Number.isInteger(number) &&
      number >= 0 &&
      number <= 9
    );

  if (numbers.length < 2) {
    return null;
  }

  const latestNumber =
    numbers[numbers.length - 1];

  const following = {
    BIG: 0,
    SMALL: 0
  };

  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i] === latestNumber) {
      const nextNumber =
        numbers[i + 1];

      const target =
        toTarget(nextNumber);

      if (target) {
        following[target]++;
      }
    }
  }

  const total =
    following.BIG +
    following.SMALL;

  if (total === 0) {
    return null;
  }

  const prediction =
    following.BIG >= following.SMALL
      ? "BIG"
      : "SMALL";

  const strength =
    Math.max(
      following.BIG,
      following.SMALL
    ) / total;

  return {
    prediction,
    strength,
    latestNumber,
    bigCount: following.BIG,
    smallCount: following.SMALL
  };
}

/* =========================================================
   STRUCTURE SIGNAL
========================================================= */

function getStructureSignal(history) {
  const targets = history
    .map(item =>
      normalizeResult(item.result)
    )
    .filter(Boolean);

  const recent =
    targets.slice(-10);

  if (recent.length < 4) {
    return null;
  }

  let alternations = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i] !== recent[i - 1]) {
      alternations++;
    }
  }

  const alternationRatio =
    alternations /
    (recent.length - 1);

  if (alternationRatio >= 0.65) {
    const current =
      recent[recent.length - 1];

    return {
      prediction:
        current === "BIG"
          ? "SMALL"
          : "BIG",
      strength:
        Math.min(
          1,
          alternationRatio
        ),
      alternationRatio
    };
  }

  const big =
    recent.filter(
      x => x === "BIG"
    ).length;

  const small =
    recent.filter(
      x => x === "SMALL"
    ).length;

  const prediction =
    big >= small
      ? "BIG"
      : "SMALL";

  const strength =
    Math.max(big, small) /
    recent.length;

  return {
    prediction,
    strength,
    alternationRatio
  };
}

/* =========================================================
   RECENT SIGNAL
========================================================= */

function getRecentSignal(history, count) {
  const targets = history
    .map(item =>
      normalizeResult(item.result)
    )
    .filter(Boolean);

  const recent =
    targets.slice(-count);

  if (recent.length === 0) {
    return null;
  }

  const big =
    recent.filter(
      x => x === "BIG"
    ).length;

  const small =
    recent.filter(
      x => x === "SMALL"
    ).length;

  const prediction =
    big >= small
      ? "BIG"
      : "SMALL";

  const strength =
    Math.max(big, small) /
    recent.length;

  return {
    prediction,
    strength,
    count: recent.length,
    big,
    small
  };
}

/* =========================================================
   BASE WEIGHTS
========================================================= */

const BASE_WEIGHTS = {
  pattern2: 1.0,
  pattern3: 1.5,
  pattern4: 2.0,
  pattern5: 2.5,
  transition: 1.5,
  streak: 1.3,
  number: 1.2,
  structure: 1.0,
  recent5: 0.35,
  recent10: 0.25
};

/* =========================================================
   CALCULATE SIGNALS
========================================================= */

function calculateSignals(history) {
  const sequence =
    getSequenceSignal(history);

  const transition =
    getTransitionSignal(history);

  const streak =
    getStreakSignal(history);

  const number =
    getNumberSignal(history);

  const structure =
    getStructureSignal(history);

  const recent5 =
    getRecentSignal(history, 5);

  const recent10 =
    getRecentSignal(history, 10);

  return {
    sequence,
    transition,
    streak,
    number,
    structure,
    recent5,
    recent10
  };
}

/* =========================================================
   SIGNAL PROBABILITY
========================================================= */

function signalProbability(
  prediction,
  strength = 1
) {
  if (!prediction) {
    return 0.5;
  }

  const safeStrength =
    Math.max(
      0,
      Math.min(1, strength)
    );

  const probability =
    0.5 +
    0.4 * safeStrength;

  return prediction === "BIG"
    ? probability
    : 1 - probability;
}

/* =========================================================
   PREDICT FROM HISTORY
========================================================= */

function predictFromHistory(
  history,
  weights = BASE_WEIGHTS
) {
  if (history.length < MIN_HISTORY) {
    throw new Error(
      `At least ${MIN_HISTORY} results are required`
    );
  }

  const signals =
    calculateSignals(history);

  let bigScore = 0;
  let smallScore = 0;
  let totalWeight = 0;

  function addSignal(
    prediction,
    strength,
    weight
  ) {
    if (!prediction || !weight) {
      return;
    }

    const probability =
      signalProbability(
        prediction,
        strength
      );

    bigScore +=
      probability * weight;

    smallScore +=
      (1 - probability) * weight;

    totalWeight += weight;
  }

  if (signals.sequence) {
    const length =
      signals.sequence.patternLength;

    const weight =
      weights[
        `pattern${length}`
      ] || 0;

    addSignal(
      signals.sequence.prediction,
      signals.sequence.strength,
      weight
    );
  }

  if (signals.transition) {
    addSignal(
      signals.transition.prediction,
      signals.transition.strength,
      weights.transition
    );
  }

  if (signals.streak) {
    addSignal(
      signals.streak.prediction,
      signals.streak.strength,
      weights.streak
    );
  }

  if (signals.number) {
    addSignal(
      signals.number.prediction,
      signals.number.strength,
      weights.number
    );
  }

  if (signals.structure) {
    addSignal(
      signals.structure.prediction,
      signals.structure.strength,
      weights.structure
    );
  }

  if (signals.recent5) {
    addSignal(
      signals.recent5.prediction,
      signals.recent5.strength,
      weights.recent5
    );
  }

  if (signals.recent10) {
    addSignal(
      signals.recent10.prediction,
      signals.recent10.strength,
      weights.recent10
    );
  }

  if (totalWeight === 0) {
    return {
      prediction: "BIG",
      confidence: 50,
      bigProbability: 50,
      smallProbability: 50,
      historyUsed: history.length,
      patternInfo: null,
      signals
    };
  }

  let bigProbability =
    (bigScore / totalWeight) * 100;

  let smallProbability =
    (smallScore / totalWeight) * 100;

  bigProbability =
    Math.max(
      10,
      Math.min(90, bigProbability)
    );

  smallProbability =
    Math.max(
      10,
      Math.min(90, smallProbability)
    );

  const total =
    bigProbability +
    smallProbability;

  bigProbability =
    (bigProbability / total) * 100;

  smallProbability =
    (smallProbability / total) * 100;

  const prediction =
    bigProbability >= smallProbability
      ? "BIG"
      : "SMALL";

  const confidence =
    Number(
      Math.max(
        bigProbability,
        smallProbability
      ).toFixed(2)
    );

  return {
    prediction,
    confidence,
    bigProbability:
      Number(bigProbability.toFixed(2)),
    smallProbability:
      Number(smallProbability.toFixed(2)),
    historyUsed: history.length,
    patternInfo:
      signals.sequence || null,
    signals
  };
}

/* =========================================================
   ADAPTIVE PERFORMANCE
========================================================= */

function calculateAdaptivePerformance(history) {
  if (history.length < MIN_HISTORY + 1) {
    return {
      modelAccuracy: 0,
      signalAccuracy: {},
      weights: {
        ...BASE_WEIGHTS
      }
    };
  }

  let modelCorrect = 0;
  let modelTotal = 0;

  const signalStats = {};

  Object.keys(BASE_WEIGHTS).forEach(key => {
    signalStats[key] = {
      correct: 0,
      total: 0
    };
  });

  for (
    let i = MIN_HISTORY;
    i < history.length;
    i++
  ) {
    const trainingHistory =
      history.slice(0, i);

    const actual =
      normalizeResult(
        history[i].result
      );

    if (!actual) {
      continue;
    }

    let prediction;

    try {
      prediction =
        predictFromHistory(
          trainingHistory,
          BASE_WEIGHTS
        );
    } catch (error) {
      continue;
    }

    if (
      prediction.prediction === actual
    ) {
      modelCorrect++;
    }

    modelTotal++;

    const signals =
      prediction.signals;

    if (signals.sequence) {
      const length =
        signals.sequence.patternLength;

      const key =
        `pattern${length}`;

      if (signalStats[key]) {
        signalStats[key].total++;

        if (
          signals.sequence.prediction ===
          actual
        ) {
          signalStats[key].correct++;
        }
      }
    }

    if (signals.transition) {
      signalStats.transition.total++;

      if (
        signals.transition.prediction ===
        actual
      ) {
        signalStats.transition.correct++;
      }
    }

    if (signals.streak) {
      signalStats.streak.total++;

      if (
        signals.streak.prediction ===
        actual
      ) {
        signalStats.streak.correct++;
      }
    }

    if (signals.number) {
      signalStats.number.total++;

      if (
        signals.number.prediction ===
        actual
      ) {
        signalStats.number.correct++;
      }
    }

    if (signals.structure) {
      signalStats.structure.total++;

      if (
        signals.structure.prediction ===
        actual
      ) {
        signalStats.structure.correct++;
      }
    }

    if (signals.recent5) {
      signalStats.recent5.total++;

      if (
        signals.recent5.prediction ===
        actual
      ) {
        signalStats.recent5.correct++;
      }
    }

    if (signals.recent10) {
      signalStats.recent10.total++;

      if (
        signals.recent10.prediction ===
        actual
      ) {
        signalStats.recent10.correct++;
      }
    }
  }

  const modelAccuracy =
    modelTotal > 0
      ? modelCorrect / modelTotal
      : 0;

  const signalAccuracy = {};

  Object.keys(signalStats).forEach(key => {
    const item =
      signalStats[key];

    signalAccuracy[key] =
      item.total > 0
        ? item.correct / item.total
        : 0;
  });

  const weights = {
    ...BASE_WEIGHTS
  };

  Object.keys(weights).forEach(key => {
    const accuracy =
      signalAccuracy[key];

    if (
      accuracy !== undefined &&
      signalStats[key].total > 0
    ) {
      let multiplier =
        0.5 + accuracy;

      multiplier =
        Math.max(
          0.35,
          Math.min(1.65, multiplier)
        );

      weights[key] =
        BASE_WEIGHTS[key] *
        multiplier;
    }
  });

  return {
    modelAccuracy:
      Number(
        (modelAccuracy * 100)
          .toFixed(2)
      ),
    signalAccuracy,
    weights
  };
}

/* =========================================================
   GET ADAPTIVE WEIGHTS
========================================================= */

async function getAdaptiveWeights(
  force = false
) {
  const now = Date.now();

  if (
    !force &&
    adaptiveCache.weights &&
    now - adaptiveCache.createdAt <
      ADAPTIVE_CACHE_TTL
  ) {
    return {
      weights: adaptiveCache.weights,
      performance:
        adaptiveCache.performance
    };
  }

  const history =
    await getLast100Results();

  const chronological =
    sortByIssue(
      history,
      false
    );

  const performance =
    calculateAdaptivePerformance(
      chronological
    );

  adaptiveCache = {
    weights:
      performance.weights,
    performance,
    createdAt: now
  };

  return {
    weights:
      performance.weights,
    performance
  };
}

/* =========================================================
   CALCULATE CURRENT PREDICTION
========================================================= */

async function calculatePrediction() {
  const history =
    await getLast100Results();

  if (history.length < MIN_HISTORY) {
    throw new Error(
      `Not enough history. Need at least ${MIN_HISTORY}, currently have ${history.length}.`
    );
  }

  const chronological =
    sortByIssue(
      history,
      false
    );

  const adaptive =
    await getAdaptiveWeights();

  const prediction =
    predictFromHistory(
      chronological,
      adaptive.weights
    );

  return {
    ...prediction,
    adaptive: {
      performance:
        adaptive.performance
    }
  };
}

/* =========================================================
   PROCESS SOURCE RESULTS
========================================================= */

async function processSourceResults(list) {
  if (!Array.isArray(list)) {
    throw new Error(
      "Source result list must be an array"
    );
  }

  const validResults = [];

  for (const item of list) {
    const issueNumber =
      item?.issueNumber ??
      item?.issue ??
      item?.period;

    const rawNumber =
      item?.number ??
      item?.result;

    if (
      issueNumber === undefined ||
      issueNumber === null
    ) {
      continue;
    }

    const number =
      Number(rawNumber);

    if (
      !Number.isInteger(number) ||
      number < 0 ||
      number > 9
    ) {
      continue;
    }

    const result =
      toTarget(number);

    if (!result) {
      continue;
    }

    validResults.push({
      issueNumber:
        String(issueNumber),
      number,
      result
    });
  }

  if (validResults.length === 0) {
    throw new Error(
      "No valid results received from source"
    );
  }

  /* =======================================================
     REMOVE DUPLICATE ISSUES FROM SOURCE LIST
  ======================================================= */

  const uniqueMap = new Map();

  for (const item of validResults) {
    uniqueMap.set(
      item.issueNumber,
      item
    );
  }

  const uniqueResults =
    Array.from(
      uniqueMap.values()
    );

  /* =======================================================
     UPSERT ACTUAL RESULTS
  ======================================================= */

  const operations =
    uniqueResults.map(item => ({
      updateOne: {
        filter: {
          issueNumber:
            item.issueNumber
        },
        update: {
          $set: {
            issueNumber:
              item.issueNumber,
            number:
              item.number,
            result:
              item.result
          }
        },
        upsert: true
      }
    }));

  const bulkResult =
    await WinGoResult.bulkWrite(
      operations,
      {
        ordered: false
      }
    );

  const newResults =
    bulkResult.upsertedCount || 0;

  /* =======================================================
     RESOLVE EXISTING PREDICTIONS
  ======================================================= */

  const issueNumbers =
    uniqueResults.map(
      item => item.issueNumber
    );

  const pendingPredictions =
    await Prediction.find({
      issueNumber: {
        $in: issueNumbers
      },
      status: "PENDING"
    });

  const resultMap = new Map();

  uniqueResults.forEach(item => {
    resultMap.set(
      item.issueNumber,
      item
    );
  });

  for (
    const prediction
    of pendingPredictions
  ) {
    const actual =
      resultMap.get(
        String(prediction.issueNumber)
      );

    if (!actual) {
      continue;
    }

    prediction.actual =
      actual.result;

    prediction.actualResult =
      actual.result;

    prediction.actualNumber =
      actual.number;

    prediction.status =
      prediction.prediction ===
      actual.result
        ? "WIN"
        : "LOSS";

    prediction.resolvedAt =
      new Date();

    await prediction.save();
  }

  /* =======================================================
     KEEP ONLY LAST 100 ACTUAL RESULTS
  ======================================================= */

  await trimResultsToLimit();

  if (newResults > 0) {
    adaptiveCache = {
      weights: null,
      performance: null,
      createdAt: 0
    };
  }

  /* =======================================================
     CREATE PREDICTION FOR NEXT ISSUE
  ======================================================= */

  const latestResults =
    await getLast100Results();

  if (
    latestResults.length >=
    MIN_HISTORY
  ) {
    const latest =
      latestResults[0];

    const nextIssue =
      incrementIssueNumber(
        latest.issueNumber
      );

    if (nextIssue) {
      await savePredictionForIssue(
        nextIssue
      );
    }
  }

  await trimPredictionsToLimit();

  lastIngestAt =
    new Date();

  lastIngestCount =
    uniqueResults.length;

  lastSourceError = null;
  lastSourceErrorTime = null;

  return {
    received:
      list.length,
    valid:
      uniqueResults.length,
    newResults,
    latest:
      sortByIssue(
        uniqueResults,
        true
      )[0] || null
  };
}

/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePredictionForIssue(
  issueNumber
) {
  if (!issueNumber) {
    return null;
  }

  const existing =
    await Prediction.findOne({
      issueNumber:
        String(issueNumber)
    });

  if (existing) {
    return existing;
  }

  const prediction =
    await calculatePrediction();

  const doc =
    await Prediction.create({
      issueNumber:
        String(issueNumber),

      prediction:
        prediction.prediction,

      confidence:
        prediction.confidence,

      bigProbability:
        prediction.bigProbability,

      smallProbability:
        prediction.smallProbability,

      status:
        "PENDING",

      actual:
        null,

      actualResult:
        null,

      actualNumber:
        null
    });

  await trimPredictionsToLimit();

  return doc;
}

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message:
      "WinGo AI Predictor API is running",

    endpoints: [
      "/api/predict",
      "/api/predictions",
      "/api/results",
      "/api/results/history",
      "/api/ml-data",
      "/api/backtest",
      "/api/model-performance",
      "/api/model-refresh",
      "/api/source-status",
      "/api/source-results"
    ]
  });
});

/* =========================================================
   SOURCE STATUS
========================================================= */

app.get(
  "/api/source-status",
  (req, res) => {
    res.json({
      success: true,

      sourceBlocked: false,

      lastIngestAt,

      lastIngestCount,

      lastSourceError,

      lastSourceErrorTime
    });
  }
);

/* =========================================================
   SOURCE INGESTION
========================================================= */

/*
   IMPORTANT:

   Render ab WinGo API ko directly call nahi karega.

   Browser/Vercel WinGo se data fetch karega
   aur yahan POST karega.
*/

app.post(
  "/api/source-results",
  async (req, res) => {
    try {
      const list =
        req.body?.list;

      if (!Array.isArray(list)) {
        return res.status(400).json({
          success: false,
          message:
            "Request body must contain an array named 'list'"
        });
      }

      const result =
        await processSourceResults(
          list
        );

      return res.json({
        success: true,
        message:
          "Source results processed successfully",
        ...result
      });

    } catch (error) {
      console.error(
        "SOURCE INGEST ERROR:",
        error
      );

      lastSourceError =
        error.message;

      lastSourceErrorTime =
        new Date();

      return res.status(500).json({
        success: false,
        message:
          "Failed to process source results",
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   RESULTS API
========================================================= */

app.get(
  "/api/results",
  async (req, res) => {
    try {
      const results =
        await getLast100Results();

      res.json({
        success: true,
        count:
          results.length,
        results
      });

    } catch (error) {
      console.error(
        "RESULTS ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   RESULTS HISTORY ASCENDING
========================================================= */

app.get(
  "/api/results/history",
  async (req, res) => {
    try {
      const results =
        await getLast100Results();

      const history =
        sortByIssue(
          results,
          false
        );

      res.json({
        success: true,
        count:
          history.length,
        results:
          history
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   ML DATA
========================================================= */

app.get(
  "/api/ml-data",
  async (req, res) => {
    try {
      const results =
        await getLast100Results();

      const history =
        sortByIssue(
          results,
          false
        );

      const data =
        history.map(item => ({
          issueNumber:
            item.issueNumber,

          number:
            item.number,

          result:
            item.result
        }));

      res.json({
        success: true,
        count:
          data.length,
        data
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   PREDICTION API
========================================================= */

app.get(
  "/api/predict",
  async (req, res) => {
    try {
      const prediction =
        await calculatePrediction();

      const latestResults =
        await getLast100Results();

      const latest =
        latestResults[0];

      let nextIssue =
        null;

      if (latest) {
        nextIssue =
          incrementIssueNumber(
            latest.issueNumber
          );
      }

      res.json({
        success: true,

        nextIssue,

        latestResult:
          latest || null,

        prediction:
          prediction.prediction,

        confidence:
          prediction.confidence,

        bigProbability:
          prediction.bigProbability,

        smallProbability:
          prediction.smallProbability,

        historyUsed:
          prediction.historyUsed,

        patternInfo:
          prediction.patternInfo,

        signals:
          prediction.signals,

        adaptive:
          prediction.adaptive
      });

    } catch (error) {
      console.error(
        "PREDICTION ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   LAST 10 PREDICTIONS
========================================================= */

app.get(
  "/api/predictions",
  async (req, res) => {
    try {
      const all =
        await Prediction.find({})
          .lean();

      const predictions =
        sortByIssue(
          all,
          true
        ).slice(0, 10);

      const wins =
        predictions.filter(
          item =>
            item.status === "WIN"
        ).length;

      const losses =
        predictions.filter(
          item =>
            item.status === "LOSS"
        ).length;

      const pending =
        predictions.filter(
          item =>
            item.status === "PENDING"
        ).length;

      const completed =
        wins + losses;

      const winRate =
        completed > 0
          ? Number(
              (
                (wins /
                  completed) *
                100
              ).toFixed(2)
            )
          : 0;

      res.json({
        success: true,

        predictions,

        stats: {
          wins,
          losses,
          pending,
          winRate
        }
      });

    } catch (error) {
      console.error(
        "PREDICTIONS ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   BACKTEST
========================================================= */

app.get(
  "/api/backtest",
  async (req, res) => {
    try {
      const results =
        await getLast100Results();

      const history =
        sortByIssue(
          results,
          false
        );

      const performance =
        calculateAdaptivePerformance(
          history
        );

      res.json({
        success: true,
        historyUsed:
          history.length,
        performance
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   MODEL PERFORMANCE
========================================================= */

app.get(
  "/api/model-performance",
  async (req, res) => {
    try {
      const adaptive =
        await getAdaptiveWeights();

      res.json({
        success: true,
        performance:
          adaptive.performance
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   MODEL REFRESH
========================================================= */

app.get(
  "/api/model-refresh",
  async (req, res) => {
    try {
      adaptiveCache = {
        weights: null,
        performance: null,
        createdAt: 0
      };

      const adaptive =
        await getAdaptiveWeights(
          true
        );

      res.json({
        success: true,
        message:
          "Model refreshed",
        performance:
          adaptive.performance
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

/* =========================================================
   DATABASE CONNECTION
========================================================= */

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log(
      "MongoDB connected successfully"
    );

    await trimResultsToLimit();

    await trimPredictionsToLimit();

    app.listen(
      PORT,
      () => {
        console.log(
          `Server running on port ${PORT}`
        );
      }
    );

    /*
      IMPORTANT:

      Yahan se old:

      collectResults()
      setInterval(collectResults, 10000)

      REMOVE kiya gaya hai.

      Render ab WinGo ko directly call nahi karega.
    */
  })
  .catch(error => {
    console.error(
      "MongoDB connection failed:",
      error
    );

    process.exit(1);
  });