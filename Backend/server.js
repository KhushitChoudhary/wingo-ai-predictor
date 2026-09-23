require("dotenv").config();

// DNS fix for MongoDB Atlas / Windows
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
app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

const PORT = process.env.PORT || 3000;

const SOURCE_API =
  "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

const HISTORY_LIMIT = 100;
const MIN_HISTORY = 20;

// ======================================================
// ADAPTIVE MODEL CACHE
// ======================================================

let adaptiveCache = {
  weights: null,
  performance: null,
  createdAt: 0
};

const ADAPTIVE_CACHE_TTL = 60 * 1000;

// ======================================================
// BASIC HELPERS
// ======================================================

function normalizeResult(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).toUpperCase().trim();

  if (text === "BIG") return "BIG";
  if (text === "SMALL") return "SMALL";

  const number = Number(value);

  if (!Number.isNaN(number)) {
    return number >= 5 ? "BIG" : "SMALL";
  }

  return null;
}

function toTarget(number) {
  const n = Number(number);

  if (Number.isNaN(n)) return null;

  return n >= 5 ? "BIG" : "SMALL";
}

function incrementIssueNumber(issueNumber) {
  try {
    return (BigInt(String(issueNumber)) + 1n).toString();
  } catch {
    return null;
  }
}

function sortByIssue(results, descending = true) {
  return [...results].sort((a, b) => {
    try {
      const A = BigInt(String(a.issueNumber));
      const B = BigInt(String(b.issueNumber));

      return descending
        ? Number(B - A)
        : Number(A - B);
    } catch {
      return descending
        ? String(b.issueNumber).localeCompare(String(a.issueNumber))
        : String(a.issueNumber).localeCompare(String(b.issueNumber));
    }
  });
}

// ======================================================
// DATABASE CLEANUP
// ======================================================

// Keep only latest 100 actual results
async function trimResultsToLimit() {
  const extraResults = await WinGoResult.find(
    {},
    { _id: 1 }
  )
    .sort({ createdAt: -1 })
    .skip(HISTORY_LIMIT)
    .lean();

  if (extraResults.length > 0) {
    const idsToDelete = extraResults.map((item) => item._id);

    await WinGoResult.deleteMany({
      _id: { $in: idsToDelete }
    });

    console.log(
      `Old results deleted: ${extraResults.length}`
    );
  }
}

// Keep only latest 100 predictions
async function trimPredictionsToLimit() {
  const extraPredictions = await Prediction.find(
    {},
    { _id: 1 }
  )
    .sort({ createdAt: -1 })
    .skip(HISTORY_LIMIT)
    .lean();

  if (extraPredictions.length > 0) {
    const idsToDelete = extraPredictions.map(
      (item) => item._id
    );

    await Prediction.deleteMany({
      _id: { $in: idsToDelete }
    });

    console.log(
      `Old predictions deleted: ${extraPredictions.length}`
    );
  }
}

// ======================================================
// API - GET LATEST RESULTS
// ======================================================

app.get("/api/results", async (req, res) => {
  try {
    const results = await WinGoResult.find({})
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean();

    res.json({
      success: true,
      count: results.length,
      results
    });
  } catch (error) {
    console.error("Results API error:", error.message);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ======================================================
// API - GET HISTORY OLDEST -> NEWEST
// ======================================================

app.get("/api/results/history", async (req, res) => {
  try {
    const results = await WinGoResult.find({})
      .sort({ createdAt: 1 })
      .limit(HISTORY_LIMIT)
      .lean();

    res.json({
      success: true,
      count: results.length,
      results
    });
  } catch (error) {
    console.error(
      "History API error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ======================================================
// API - ML DATA
// ======================================================

app.get("/api/ml-data", async (req, res) => {
  try {
    const results = await WinGoResult.find({})
      .sort({ createdAt: 1 })
      .limit(HISTORY_LIMIT)
      .lean();

    const data = results.map((item) => ({
      issueNumber: item.issueNumber,
      number: item.number,
      result: item.result
    }));

    res.json({
      success: true,
      count: data.length,
      data
    });
  } catch (error) {
    console.error(
      "ML data error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ======================================================
// SIGNAL 1 - SEQUENCE PATTERN
// ======================================================

function getSequenceSignal(history) {
  const targets = history.map((item) =>
    normalizeResult(item.result)
  );

  const signal = {
    name: "sequence",
    pattern2: null,
    pattern3: null,
    pattern4: null,
    pattern5: null
  };

  for (let length = 2; length <= 5; length++) {
    if (targets.length <= length) continue;

    const recentPattern = targets
      .slice(-length)
      .join(",");

    const matches = [];

    for (
      let i = 0;
      i <= targets.length - length - 1;
      i++
    ) {
      const pattern = targets
        .slice(i, i + length)
        .join(",");

      if (pattern === recentPattern) {
        const next = targets[i + length];

        if (next) {
          matches.push(next);
        }
      }
    }

    if (matches.length > 0) {
      const bigCount = matches.filter(
        (x) => x === "BIG"
      ).length;

      const smallCount = matches.filter(
        (x) => x === "SMALL"
      ).length;

      signal[`pattern${length}`] =
        bigCount >= smallCount
          ? "BIG"
          : "SMALL";
    }
  }

  return signal;
}

// ======================================================
// SIGNAL 2 - TRANSITION
// ======================================================

function getTransitionSignal(history) {
  const targets = history.map((item) =>
    normalizeResult(item.result)
  );

  if (targets.length < 2) {
    return {
      name: "transition",
      prediction: null,
      strength: 0
    };
  }

  const last = targets[targets.length - 1];

  let bigAfterBig = 0;
  let smallAfterBig = 0;

  let bigAfterSmall = 0;
  let smallAfterSmall = 0;

  for (let i = 0; i < targets.length - 1; i++) {
    const current = targets[i];
    const next = targets[i + 1];

    if (current === "BIG") {
      if (next === "BIG") bigAfterBig++;
      if (next === "SMALL") smallAfterBig++;
    }

    if (current === "SMALL") {
      if (next === "BIG") bigAfterSmall++;
      if (next === "SMALL") smallAfterSmall++;
    }
  }

  let prediction = null;
  let strength = 0;

  if (last === "BIG") {
    const total =
      bigAfterBig + smallAfterBig;

    if (total > 0) {
      if (bigAfterBig >= smallAfterBig) {
        prediction = "BIG";
      } else {
        prediction = "SMALL";
      }

      strength =
        Math.abs(
          bigAfterBig - smallAfterBig
        ) / total;
    }
  }

  if (last === "SMALL") {
    const total =
      bigAfterSmall + smallAfterSmall;

    if (total > 0) {
      if (bigAfterSmall >= smallAfterSmall) {
        prediction = "BIG";
      } else {
        prediction = "SMALL";
      }

      strength =
        Math.abs(
          bigAfterSmall - smallAfterSmall
        ) / total;
    }
  }

  return {
    name: "transition",
    prediction,
    strength
  };
}

// ======================================================
// SIGNAL 3 - STREAK
// ======================================================

function getStreakSignal(history) {
  const targets = history.map((item) =>
    normalizeResult(item.result)
  );

  if (targets.length < 2) {
    return {
      name: "streak",
      prediction: null,
      strength: 0,
      streakLength: 0
    };
  }

  const last =
    targets[targets.length - 1];

  let streakLength = 1;

  for (
    let i = targets.length - 2;
    i >= 0;
    i--
  ) {
    if (targets[i] === last) {
      streakLength++;
    } else {
      break;
    }
  }

  let prediction = null;

  if (streakLength >= 3) {
    prediction =
      last === "BIG"
        ? "SMALL"
        : "BIG";
  }

  return {
    name: "streak",
    prediction,
    strength:
      streakLength >= 3
        ? Math.min(
            1,
            (streakLength - 2) / 4
          )
        : 0,
    streakLength
  };
}

// ======================================================
// SIGNAL 4 - NUMBER RECURRENCE
// ======================================================

function getNumberSignal(history) {
  const numbers = history
    .map((item) => Number(item.number))
    .filter((n) => !Number.isNaN(n));

  if (numbers.length < 5) {
    return {
      name: "number",
      prediction: null,
      strength: 0
    };
  }

  const recentNumber =
    numbers[numbers.length - 1];

  const occurrences = [];

  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i] === recentNumber) {
      occurrences.push(numbers[i + 1]);

          }
  }

  if (occurrences.length === 0) {
    return {
      name: "number",
      prediction: null,
      strength: 0
    };
  }

  const bigCount = occurrences.filter(
    (n) => n >= 5
  ).length;

  const smallCount =
    occurrences.length - bigCount;

  return {
    name: "number",
    prediction:
      bigCount >= smallCount
        ? "BIG"
        : "SMALL",
    strength:
      Math.abs(
        bigCount - smallCount
      ) / occurrences.length
  };
}

// ======================================================
// SIGNAL 5 - STRUCTURE
// ======================================================

function getStructureSignal(history) {
  const targets = history.map((item) =>
    normalizeResult(item.result)
  );

  if (targets.length < 10) {
    return {
      name: "structure",
      prediction: null,
      strength: 0
    };
  }

  const recent = targets.slice(-10);

  let alternations = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i] !== recent[i - 1]) {
      alternations++;
    }
  }

  let prediction = null;

  if (alternations >= 7) {
    prediction =
      recent[recent.length - 1] === "BIG"
        ? "BIG"
        : "SMALL";
  } else if (alternations <= 3) {
    prediction =
      recent[recent.length - 1] === "BIG"
        ? "SMALL"
        : "BIG";
  }

  return {
    name: "structure",
    prediction,
    strength:
      Math.abs(alternations - 5) / 5
  };
}

// ======================================================
// SIGNAL 6 - RECENT 5
// ======================================================

function getRecentSignal(history, count) {
  const targets = history
    .slice(-count)
    .map((item) =>
      normalizeResult(item.result)
    );

  if (targets.length === 0) {
    return {
      prediction: null,
      strength: 0
    };
  }

  const bigCount = targets.filter(
    (x) => x === "BIG"
  ).length;

  const smallCount =
    targets.length - bigCount;

  return {
    prediction:
      bigCount >= smallCount
        ? "BIG"
        : "SMALL",

    strength:
      Math.abs(
        bigCount - smallCount
      ) / targets.length
  };
}

// ======================================================
// BASE WEIGHTS
// ======================================================

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

// ======================================================
// CALCULATE SIGNALS
// ======================================================

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
    pattern2: sequence.pattern2,
    pattern3: sequence.pattern3,
    pattern4: sequence.pattern4,
    pattern5: sequence.pattern5,

    transition:
      transition.prediction,

    transitionStrength:
      transition.strength,

    streak:
      streak.prediction,

    streakStrength:
      streak.strength,

    streakLength:
      streak.streakLength,

    number:
      number.prediction,

    numberStrength:
      number.strength,

    structure:
      structure.prediction,

    structureStrength:
      structure.strength,

    recent5:
      recent5.prediction,

    recent5Strength:
      recent5.strength,

    recent10:
      recent10.prediction,

    recent10Strength:
      recent10.strength
  };
}

// ======================================================
// SIGNAL PROBABILITY
// ======================================================

function signalProbability(
  prediction,
  strength = 1
) {
  if (!prediction) {
    return 0.5;
  }

  const normalizedStrength =
    Math.max(
      0,
      Math.min(1, strength)
    );

  if (prediction === "BIG") {
    return (
      0.5 +
      0.4 * normalizedStrength
    );
  }

  return (
    0.5 -
    0.4 * normalizedStrength
  );
}

// ======================================================
// CORE PREDICTION ENGINE
// ======================================================

function predictFromHistory(
  history,
  weights = BASE_WEIGHTS
) {
  if (!history || history.length < MIN_HISTORY) {
    return null;
  }

  const signals =
    calculateSignals(history);

  let bigScore = 0;
  let smallScore = 0;

  const addSignal = (
    name,
    prediction,
    strength = 1
  ) => {
    if (!prediction) return;

    const weight =
      weights[name] || 0;

    const probability =
      signalProbability(
        prediction,
        strength
      );

    bigScore +=
      probability * weight;

    smallScore +=
      (1 - probability) * weight;
  };

  addSignal(
    "pattern2",
    signals.pattern2,
    1
  );

  addSignal(
    "pattern3",
    signals.pattern3,
    1
  );

  addSignal(
    "pattern4",
    signals.pattern4,
    1
  );

  addSignal(
    "pattern5",
    signals.pattern5,
    1
  );

  addSignal(
    "transition",
    signals.transition,
    signals.transitionStrength
  );

  addSignal(
    "streak",
    signals.streak,
    signals.streakStrength
  );

  addSignal(
    "number",
    signals.number,
    signals.numberStrength
  );

  addSignal(
    "structure",
    signals.structure,
    signals.structureStrength
  );

  addSignal(
    "recent5",
    signals.recent5,
    signals.recent5Strength
  );

  addSignal(
    "recent10",
    signals.recent10,
    signals.recent10Strength
  );

  const totalScore =
    bigScore + smallScore;

  if (totalScore === 0) {
    return {
      prediction: "BIG",
      confidence: 50,
      bigProbability: 50,
      smallProbability: 50,
      historyUsed: history.length,
      patternInfo: "No strong pattern",
      signals
    };
  }

  let bigProbability =
    (bigScore / totalScore) * 100;

  let smallProbability =
    (smallScore / totalScore) * 100;

  // Avoid fake 100% certainty
  bigProbability =
    Math.max(
      10,
      Math.min(90, bigProbability)
    );

  smallProbability =
    100 - bigProbability;

  const prediction =
    bigProbability >= smallProbability
      ? "BIG"
      : "SMALL";

  const confidence =
    Math.round(
      Math.max(
        bigProbability,
        smallProbability
      )
    );

  const activePatterns = [];

  if (signals.pattern5)
    activePatterns.push("5-sequence");

  if (signals.pattern4)
    activePatterns.push("4-sequence");

  if (signals.pattern3)
    activePatterns.push("3-sequence");

  if (signals.pattern2)
    activePatterns.push("2-sequence");

  if (signals.transition)
    activePatterns.push("transition");

  if (signals.streak)
    activePatterns.push("streak");

  if (signals.number)
    activePatterns.push("number");

  if (signals.structure)
    activePatterns.push("structure");

  const patternInfo =
    activePatterns.length > 0
      ? activePatterns.join(", ")
      : "mixed signals";

  return {
    prediction,
    confidence,
    bigProbability:
      Number(bigProbability.toFixed(2)),
    smallProbability:
      Number(smallProbability.toFixed(2)),
    historyUsed: history.length,
    patternInfo,
    signals
  };
}

// ======================================================
// ADAPTIVE MODEL PERFORMANCE
// ======================================================

function calculateAdaptivePerformance(history) {
  if (!history || history.length < MIN_HISTORY + 1) {
    return {
      modelAccuracy: 50,
      signalPerformance: {},
      adaptiveWeights: BASE_WEIGHTS
    };
  }

  const signalNames = Object.keys(
    BASE_WEIGHTS
  );

  const signalStats = {};

  for (const name of signalNames) {
    signalStats[name] = {
      correct: 0,
      total: 0,
      accuracy: 50
    };
  }

  let modelCorrect = 0;
  let modelTotal = 0;

  // Walk-forward testing
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

          const prediction =
      predictFromHistory(
        trainingHistory,
        BASE_WEIGHTS
      );

    if (!prediction || !actual) {
      continue;
    }

    modelTotal++;

    if (
      prediction.prediction === actual
    ) {
      modelCorrect++;
    }

    const signals =
      prediction.signals;

    const signalPredictions = {
      pattern2: signals.pattern2,
      pattern3: signals.pattern3,
      pattern4: signals.pattern4,
      pattern5: signals.pattern5,
      transition: signals.transition,
      streak: signals.streak,
      number: signals.number,
      structure: signals.structure,
      recent5: signals.recent5,
      recent10: signals.recent10
    };

    for (const name of signalNames) {
      const signalPrediction =
        signalPredictions[name];

      if (!signalPrediction) {
        continue;
      }

      signalStats[name].total++;

      if (
        signalPrediction === actual
      ) {
        signalStats[name].correct++;
      }
    }
  }

  for (const name of signalNames) {
    const stats =
      signalStats[name];

    if (stats.total > 0) {
      stats.accuracy =
        (stats.correct / stats.total) *
        100;
    }
  }

  const modelAccuracy =
    modelTotal > 0
      ? (modelCorrect / modelTotal) * 100
      : 50;

  // Adaptive weights
  const adaptiveWeights = {};

  for (const name of signalNames) {
    const accuracy =
      signalStats[name].accuracy;

    // 50% = 1x
    // 75% = 1.5x
    // 25% = 0.5x
    let multiplier =
      1 + (accuracy - 50) / 50;

    multiplier =
      Math.max(
        0.35,
        Math.min(1.65, multiplier)
      );

    adaptiveWeights[name] =
      Number(
        (
          BASE_WEIGHTS[name] *
          multiplier
        ).toFixed(3)
      );
  }

  return {
    modelAccuracy:
      Number(modelAccuracy.toFixed(2)),

    signalPerformance:
      signalStats,

    adaptiveWeights
  };
}

// ======================================================
// GET ADAPTIVE WEIGHTS
// ======================================================

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
    return adaptiveCache;
  }

  const dbResults =
    await WinGoResult.find({})
      .sort({ createdAt: 1 })
      .limit(HISTORY_LIMIT)
      .lean();

  const history =
    sortByIssue(
      dbResults,
      false
    );

  const performance =
    calculateAdaptivePerformance(
      history
    );

  adaptiveCache = {
    weights:
      performance.adaptiveWeights,

    performance,

    createdAt: now
  };

  return adaptiveCache;
}

// ======================================================
// MAIN PREDICTION
// ======================================================

async function calculatePrediction() {
  const dbResults =
    await WinGoResult.find({})
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean();

  if (dbResults.length < MIN_HISTORY) {
    return null;
  }

  const history =
    sortByIssue(
      dbResults,
      false
    );

  const adaptive =
    await getAdaptiveWeights();

  const prediction =
    predictFromHistory(
      history,
      adaptive.weights
    );

  return {
    ...prediction,

    adaptive: {
      enabled: true,

      modelAccuracy:
        adaptive.performance
          .modelAccuracy,

      weights:
        adaptive.weights,

      signalPerformance:
        adaptive.performance
          .signalPerformance
    }
  };
}


// ======================================================
// SERVE NEW.HTML FROM PROJECT ROOT
// ======================================================

app.get("/predict", (req, res) => {
  res.sendFile(
    path.join(__dirname, "..", "new.html")
  );
});


app.get("/api/source-status", (req, res) => {
  res.json({
    success: true,
    sourceAvailable: !sourceBlocked,
    sourceBlocked,
    lastError: lastSourceError,
    lastErrorTime: lastSourceErrorTime,
    message: sourceBlocked
      ? "Live WinGo source is currently unavailable. Existing database history is being used."
      : "WinGo source is available."
  });
});


// ======================================================
// API - CURRENT PREDICTION
// ======================================================

app.get("/api/predict", async (req, res) => {
  try {
    const prediction =
      await calculatePrediction();

    if (!prediction) {
      return res.status(400).json({
        success: false,
        message:
          `Need at least ${MIN_HISTORY} results for prediction`
      });
    }

    const latest =
      await WinGoResult.findOne({})
        .sort({ createdAt: -1 })
        .lean();

    if (!latest) {
      return res.status(400).json({
        success: false,
        message: "No results available"
      });
    }

    const nextIssue =
      incrementIssueNumber(
        latest.issueNumber
      );

    res.json({
      success: true,

      nextIssue,

      latestResult: {
        issueNumber:
          latest.issueNumber,

        number:
          latest.number,

        result:
          latest.result
      },

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
      "Prediction API error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ======================================================
// SAVE PREDICTION
// ======================================================

async function savePredictionForIssue(
  issueNumber
) {
  try {
    const existing =
      await Prediction.findOne({
        issueNumber
      });

    if (existing) {
      return existing;
    }

    const prediction =
      await calculatePrediction();

    if (!prediction) {
      return null;
    }

    const newPrediction =
      await Prediction.create({
        issueNumber,

        prediction:
          prediction.prediction,

        confidence:
          prediction.confidence,

        bigProbability:
          prediction.bigProbability,

        smallProbability:
          prediction.smallProbability,

        actualResult: null,

        actualNumber: null,

        status: "PENDING"
      });

    console.log(
      `Prediction saved: ${issueNumber} | ${prediction.prediction} | ${prediction.confidence}%`
    );

    // Keep only latest 100 predictions
    await trimPredictionsToLimit();

    return newPrediction;
  } catch (error) {
    console.error(
      "Prediction save error:",
      error.message
    );

    return null;
  }
}

// ======================================================
// RESOLVE PREDICTION
// ======================================================

async function resolvePrediction(
  issueNumber,
  actualNumber,
  actualResult
) {
  try {
    const prediction =
      await Prediction.findOne({
        issueNumber
      });

    if (!prediction) {
      return;
    }

    if (prediction.status !== "PENDING") {
      return;
    }

    const actual =
      actualResult ||
      toTarget(actualNumber);

    const status =
      prediction.prediction === actual
        ? "WIN"
        : "LOSS";

    prediction.actualResult =
      actual;

    prediction.actualNumber =
      actualNumber;

    prediction.status =
      status;

    prediction.resolvedAt =
      new Date();

    await prediction.save();

    console.log(
      `Prediction resolved: ${issueNumber} | ${prediction.prediction} | Actual: ${actual} | ${status}`
    );
  } catch (error) {
    console.error(
      "Resolve prediction error:",
      error.message
    );
  }
}

// ======================================================
// API - PREDICTIONS
// ======================================================

app.get("/api/predictions", async (req, res) => {
  try {
    const predictions =
      await Prediction.find({})
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();

    const resolved =
      predictions.filter(
        (p) =>
          p.status === "WIN" ||
          p.status === "LOSS"
      );

    const wins =
      resolved.filter(
        (p) => p.status === "WIN"
      ).length;

    const losses =
      resolved.filter(
        (p) => p.status === "LOSS"
      ).length;

    const winRate =
      resolved.length > 0
        ? (wins / resolved.length) * 100
        : 0;

    res.json({      success: true,

      count: predictions.length,

      predictions,

      stats: {
        total: predictions.length,
        resolved: resolved.length,
        wins,
        losses,

        pending:
          predictions.filter(
            (p) => p.status === "PENDING"
          ).length,

        winRate:
          Number(winRate.toFixed(2))
      }
    });
  } catch (error) {
    console.error(
      "Predictions API error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ======================================================
// API - BACKTEST
// ======================================================

app.get("/api/backtest", async (req, res) => {
  try {
    const dbResults =
      await WinGoResult.find({})
        .sort({ createdAt: 1 })
        .limit(HISTORY_LIMIT)
        .lean();

    const history =
      sortByIssue(
        dbResults,
        false
      );

    if (
      history.length <
      MIN_HISTORY + 1
    ) {
      return res.status(400).json({
        success: false,
        message:
          `Need at least ${MIN_HISTORY + 1} results for backtest`
      });
    }

    const performance =
      calculateAdaptivePerformance(
        history
      );

    res.json({
      success: true,

      historyUsed:
        history.length,

      modelAccuracy:
        performance.modelAccuracy,

      signalPerformance:
        performance.signalPerformance,

      adaptiveWeights:
        performance.adaptiveWeights
    });
  } catch (error) {
    console.error(
      "Backtest error:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ======================================================
// API - MODEL PERFORMANCE
// ======================================================

app.get(
  "/api/model-performance",
  async (req, res) => {
    try {
      const adaptive =
        await getAdaptiveWeights();

      res.json({
        success: true,

        modelAccuracy:
          adaptive.performance
            .modelAccuracy,

        signalPerformance:
          adaptive.performance
            .signalPerformance,

        adaptiveWeights:
          adaptive.weights
      });
    } catch (error) {
      console.error(
        "Model performance error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ======================================================
// API - FORCE MODEL REFRESH
// ======================================================

app.get(
  "/api/model-refresh",
  async (req, res) => {
    try {
      const adaptive =
        await getAdaptiveWeights(true);

      res.json({
        success: true,

        message:
          "Adaptive model refreshed",

        modelAccuracy:
          adaptive.performance
            .modelAccuracy,

        weights:
          adaptive.weights,

        signalPerformance:
          adaptive.performance
            .signalPerformance
      });
    } catch (error) {
      console.error(
        "Model refresh error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ======================================================
// FETCH SOURCE RESULTS
// ======================================================

let sourceBlocked = false;
let lastSourceError = null;
let lastSourceErrorTime = null;

async function fetchSourceResults() {
  try {
    const url = `${SOURCE_API}?t=${Date.now()}`;

    console.log("====================================");
    console.log("Fetching WinGo source:", url);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: "https://draw.ar-lottery01.com/",
        Origin: "https://draw.ar-lottery01.com"
      }
    });

    console.log("SOURCE STATUS:", response.status);
    console.log(
      "SOURCE CONTENT-TYPE:",
      response.headers.get("content-type")
    );

    console.log(
      "SOURCE SERVER:",
      response.headers.get("server")
    );

    console.log(
      "SOURCE LOCATION:",
      response.headers.get("location")
    );

    const responseText = await response.text();

    console.log(
      "SOURCE RESPONSE BODY:",
      responseText.substring(0, 1000)
    );

    console.log("====================================");

    if (response.status === 403) {
      sourceBlocked = true;
      lastSourceError = "Source API returned 403 Forbidden";
      lastSourceErrorTime = new Date();

      console.warn(
        "WinGo source returned 403."
      );

      return [];
    }

    if (!response.ok) {
      throw new Error(
        `Source API error: ${response.status}`
      );
    }

    let json;

    try {
      json = JSON.parse(responseText);
    } catch (error) {
      throw new Error(
        "Source returned invalid JSON"
      );
    }

    sourceBlocked = false;
    lastSourceError = null;

    const list =
      json?.data?.list ||
      json?.data ||
      json?.list ||
      [];

    console.log(
      `Received ${list.length} results`
    );

    return list;

  } catch (error) {

    lastSourceError = error.message;
    lastSourceErrorTime = new Date();

    console.warn(
      "WinGo source temporarily unavailable:",
      error.message
    );

    return [];
  }
}

// ======================================================
// COLLECT RESULTS
// ======================================================

async function collectResults() {
  try {
    const list =
      await fetchSourceResults();

    if (!list.length) {
      return;
    }

    const operations = [];

    const validResults = [];

    for (const item of list) {
      const issueNumber =
        item.issueNumber ??
        item.issue ??
        item.period;

      const rawNumber =
        item.number ??
        item.result;

      const number =
        Number(rawNumber);

      if (
        !issueNumber ||
        Number.isNaN(number) ||
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

      operations.push({
        updateOne: {
          filter: {
            issueNumber:
              String(issueNumber)
          },

          update: {
            $set: {
              issueNumber:
                String(issueNumber),

              number,

              result
            }
          },

          upsert: true
        }
      });
    }

    if (!operations.length) {
      console.log(
        "No valid results found"
      );

      return;
    }

    const bulkResult =
      await WinGoResult.bulkWrite(
        operations,
        {
          ordered: false
        }
      );

    const newResults =
      bulkResult.upsertedCount || 0;

    console.log(
      `New results added: ${newResults}`
    );

    // Resolve predictions for newly received results
    for (const item of validResults) {
      await resolvePrediction(
        item.issueNumber,
        item.number,
        item.result
      );
    }

    // Keep actual results <= 100
    await trimResultsToLimit();

    // Reset adaptive cache when new data arrives
    if (newResults > 0) {
      adaptiveCache = {
        weights: null,
        performance: null,
        createdAt: 0
      };
    }

    const allResults =
      await WinGoResult.find({})
        .sort({ createdAt: -1 })
        .limit(HISTORY_LIMIT)
        .lean();

    console.log(
      `Database history: ${allResults.length}/${HISTORY_LIMIT}`
    );

    if (
      allResults.length >= MIN_HISTORY
    ) {
      const latest =
        sortByIssue(
          allResults,
          true
        )[0];

      if (latest) {
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
    }

    // Final prediction cleanup
    await trimPredictionsToLimit();
  } catch (error) {
    console.error(
      "Collector error:",
      error.message
    );
  }
}

// ======================================================
// ROOT API
// ======================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message:
      "WinGo 1M AI Predictor API is running",
    endpoints: [
      "/api/results",
      "/api/results/history",
      "/api/ml-data",
      "/api/predict",
      "/api/predictions",
      "/api/backtest",
      "/api/model-performance",
      "/api/model-refresh"
    ]
  });
});

// ======================================================
// MONGODB CONNECTION
// ======================================================

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log(
      "MongoDB connected successfully"
    );

    // ================================================
    // CLEAN OLD DATA ON SERVER START
    // ================================================

    await trimResultsToLimit();
    await trimPredictionsToLimit();

    // ================================================
    // SERVER START
    // ================================================

    app.listen(PORT, () => {
      console.log(
        `Server running on port ${PORT}`
      );
    });

    // ================================================
    // FIRST COLLECTION
    // ================================================

    await collectResults();

    // ================================================
    // AUTO COLLECT EVERY 10 SECONDS
    // ================================================

    setInterval(
      collectResults,
      10000
    );
  })
  .catch((error) => {
    console.error(
      "MongoDB connection error:",
      error.message
    );
  });