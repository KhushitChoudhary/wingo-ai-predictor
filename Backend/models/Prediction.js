const mongoose = require("mongoose");

const predictionSchema = new mongoose.Schema(
  {
    issueNumber: {
      type: String,
      required: true,
      unique: true,
      index: true
    },

    prediction: {
      type: String,
      enum: ["BIG", "SMALL"],
      required: true
    },

    confidence: {
      type: Number,
      required: true
    },

    bigProbability: {
      type: Number,
      required: true
    },

    smallProbability: {
      type: Number,
      required: true
    },

    actualResult: {
      type: String,
      enum: ["BIG", "SMALL", null],
      default: null
    },

    actualNumber: {
      type: Number,
      default: null
    },

    status: {
      type: String,
      enum: ["PENDING", "WIN", "LOSS"],
      default: "PENDING"
    },

    createdAt: {
      type: Date,
      default: Date.now
    },

    resolvedAt: {
      type: Date,
      default: null
    }
  },
  {
    versionKey: false
  }
);

module.exports = mongoose.model(
  "Prediction",
  predictionSchema
);