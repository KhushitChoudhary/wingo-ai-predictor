const mongoose = require("mongoose");

const winGoResultSchema = new mongoose.Schema(
  {
    issueNumber: {
      type: String,
      required: true,
      unique: true,
      index: true
    },

    number: {
      type: Number,
      required: true,
      min: 0,
      max: 9
    },

    result: {
      type: String,
      enum: ["BIG", "SMALL"],
      required: true
    },

    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

module.exports = mongoose.model(
  "WinGoResult",
  winGoResultSchema
);