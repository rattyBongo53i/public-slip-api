// Import the dotenv package to load environment variables
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");

const PORT = process.env.PORT || 4000;
const MONGO_URI = "mongodb+srv://kojoyeboah53i:saints_salvation2@cluster0.sk4iy96.mongodb.net/generatedslips?retryWrites=true&w=majority";

const app = express();

// Middleware
app.use(express.json());

// Slip Schema
const slipSchema = new mongoose.Schema({
  masterSlipId: {
    type: String,
    required: true,
    unique: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Slip = mongoose.model("Slip", slipSchema);

// Generate Master Slip ID
function generateMasterSlipId() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `MS-${timestamp}-${random}`;
}

// Route to generate a new slip
app.post("/generate-slip", async (req, res) => {
  try {
    const masterSlipId = generateMasterSlipId();

    const slip = new Slip({
      masterSlipId: masterSlipId,
    });

    await slip.save();

    res.status(201).json({
      success: true,
      masterSlipId: slip.masterSlipId,
      createdAt: slip.createdAt,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Route to get a slip by master slip ID
app.get("api/v1/slip/:masterSlipId", async (req, res) => {
  try {
    const slip = await Slip.findOne({ masterSlipId: req.params.masterSlipId });

    if (!slip) {
      return res.status(404).json({
        success: false,
        message: "Slip not found",
      });
    }

    res.json({
      success: true,
      slip: slip,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Connect to MongoDB and start server
mongoose
  .connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  })
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas");
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("❌ MongoDB connection error:", error.message);
  });

