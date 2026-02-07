// Import the dotenv package to load environment variables
require("dotenv").config();

const express = require("express");
const { MongoClient } = require("mongodb");

const PORT = process.env.PORT || 4000;
const MONGO_URI =
  "mongodb+srv://kojoyeboah53i:saints_salvation2@cluster0.sk4iy96.mongodb.net/generatedslips?retryWrites=true&w=majority";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "generatedslips";

const app = express();

// Middleware
app.use(express.json());

// ---- MongoDB Collections State ----
let client = null;
let db = null;
let collections = null;

// ---- Connect to MongoDB ----
async function connectMongo() {
  if (client && db && collections) {
    console.log("✅ MongoDB already connected");
    return;
  }

  console.log(`🔗 Connecting to MongoDB...`);
  try {
    client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    await client.connect();
    db = client.db(MONGO_DB_NAME);

    // Initialize collections
    collections = {
      master_slips: db.collection("master_slips"),
      generated_slips: db.collection("generated_slips"),
      optimized_slips: db.collection("optimized_slips"),
      master_slip_matches: db.collection("master_slip_matches"),
      generated_slip_legs: db.collection("generated_slip_legs"),

      matches: db.collection("matches"),
      slips: db.collection("slips"), // For the /generate-slip route
    };

    console.log(`✅ MongoDB connected to: ${db.databaseName}`);
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    client = null;
    db = null;
    collections = null;
  }
}

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
  if (!collections) {
    return res.status(503).json({
      success: false,
      error: "Database unavailable",
    });
  }

  try {
    const masterSlipId = generateMasterSlipId();

    const slip = {
      masterSlipId: masterSlipId,
      createdAt: new Date(),
    };

    await collections.slips.insertOne(slip);

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

/**
 * GET /api/placement-slips/:masterSlipId
 *
 * Fetches generated slips for a master slip with the exact same response
 * structure as the Laravel getPlacementSlips method.
 *
 * Response format:
 * {
 *   master_slip_id: number,
 *   engine_version: string,
 *   generated_at: ISO string,
 *   slips: Array<{
 *     slip_id: string,
 *     master_slip_id: number,
 *     confidence_score: string,
 *     total_odds: float,
 *     stake: float,
 *     estimated_return: float,
 *     risk_category: string (lowercase),
 *     diversity_score: float | null,
 *     created_at: ISO string,
 *     legs: Array<{
 *       match_id: number,
 *       home_team: string,
 *       away_team: string,
 *       market: string,
 *       selection: string,
 *       odds: float
 *     }>
 *   }>
 * }
 */
app.get("/api/placement-slips/:masterSlipId", async (req, res) => {
  // Guard: Ensure database collections are available
  if (!collections) {
    return res.status(503).json({
      success: false,
      error: "Database unavailable",
    });
  }

  try {
    const { masterSlipId } = req.params;

    // Ensure master slip exists (safe fail - matches Laravel's findOrFail)
    const masterSlip = await collections.master_slips.findOne({
      master_slip_id: masterSlipId,
    });

    if (!masterSlip) {
      return res.status(404).json({
        success: false,
        error: "Master slip not found",
        message: `No master slip found with ID: ${masterSlipId}`,
      });
    }

    // Fetch generated slips for this master slip
    const slips = await collections.generated_slips
      .find({ master_slip_id: String(masterSlipId) })
      .toArray();

    for (const slip of slips) {
      slip.legs = await collections.generated_slip_legs
        .find({ slip_id: slip.slip_id })
        .toArray();
    }

    // Get all unique match IDs from all legs
    const matchIds = new Set();
    slips.forEach((slip) => {
      if (slip.legs) {
        slip.legs.forEach((leg) => {
          if (leg.match_id) {
            matchIds.add(leg.match_id);
          }
        });
      }
    });

    // Strategy: Try to get match data from master_slip_matches first (has match_data),
    // then fall back to matches collection
    const matchesMap = new Map();

    // OPTION 1: Fetch from master_slip_matches (contains match_data JSON with team names)
    if (collections.master_slip_matches && matchIds.size > 0) {
      const masterSlipMatches = await collections.master_slip_matches
        .find({
          master_slip_id: parseInt(masterSlipId),
          match_id: { $in: Array.from(matchIds) },
        })
        .toArray();

      masterSlipMatches.forEach((match) => {
        if (match.match_data) {
          matchesMap.set(match.match_id, {
            id: match.match_id,
            home_team:
              match.match_data.home_team ||
              match.match_data.homeTeam ||
              "",
            away_team:
              match.match_data.away_team ||
              match.match_data.awayTeam ||
              "",
          });
        }
      });
    }

    // OPTION 2: For any remaining matches, try the matches collection
    const remainingMatchIds = Array.from(matchIds).filter(
      (id) => !matchesMap.has(id)
    );
    if (collections.matches && remainingMatchIds.length > 0) {
      const matches = await collections.matches
        .find({ id: { $in: remainingMatchIds } })
        .toArray();

      matches.forEach((match) => {
        matchesMap.set(match.id, match);
      });
    }

    // Map slips to Laravel response format
    const mappedSlips = slips
      .map((slip) => {
        // Calculate estimated_return (handle multiple field names)
        const estimatedReturn =
          slip.estimated_return ??
          slip.estimated_payout ??
          slip.possible_return ??
          0;

        // Get risk_category (handle both field names, ensure lowercase)
        const riskCategory = (
          slip.risk_category ??
          slip.risk_level ??
          "unknown"
        ).toLowerCase();

        return {
          slip_id: String(slip.slip_id || slip.id || ""),
          master_slip_id: parseInt(String(slip.master_slip_id)),
          confidence_score: String(slip.confidence_score ?? 0),
          total_odds: parseFloat(String(slip.total_odds ?? 0)),
          stake: parseFloat(String(slip.stake ?? 0)),
          estimated_return: parseFloat(String(estimatedReturn)),
          risk_category: riskCategory,
          diversity_score:
            slip.diversity_score !== null &&
            slip.diversity_score !== undefined
              ? parseFloat(String(slip.diversity_score))
              : null,
          created_at: (() => {
            const date = slip.created_at ?? slip.generated_at;
            return date instanceof Date ? date.toISOString() : String(date);
          })(),
          legs: (slip.legs ?? []).map((leg) => {
            // ---- NEW LOGIC: prefer leg.match, then fallback to matchesMap ----
            const match = leg.match || matchesMap.get(leg.match_id) || {};

            return {
              match_id: parseInt(String(leg.match_id)),
              home_team: String(match.home_team ?? ""),
              away_team: String(match.away_team ?? ""),
              market: String(leg.market ?? ""),
              selection: String(leg.selection ?? ""),
              odds: parseFloat(String(leg.odds ?? 0)),
            };
          }),
        };
      })
      // Sort by confidence_score DESC, total_odds DESC, then id ASC (matches Laravel)
      .sort((a, b) => {
        // First by confidence_score descending
        const confA = parseFloat(a.confidence_score);
        const confB = parseFloat(b.confidence_score);
        if (confB !== confA) return confB - confA;

        // Then by total_odds descending
        if (b.total_odds !== a.total_odds) return b.total_odds - a.total_odds;

        // Then by slip_id ascending (as proxy for id)
        return a.slip_id.localeCompare(b.slip_id);
      });

    // Return response matching Laravel format exactly
    return res.status(200).json({
      master_slip_id: parseInt(masterSlip.master_slip_id),
      engine_version: process.env.ENGINE_VERSION || "v1",
      generated_at: new Date().toISOString(),
      slips: mappedSlips,
    });
  } catch (err) {
    console.error(
      `Error fetching placement slips for master slip ${req.params.masterSlipId}:`,
      err
    );
    return res.status(500).json({
      success: false,
      error: "Failed to fetch placement slips",
      message: err.message,
    });
  }
});

/**
 * POST /api/sync-slips
 *
 * Sync master slip and generated slips (upsert) - ENHANCED with backward compatibility
 *
 * Accepts payload:
 * {
 *   master_slip: { ... },
 *   generated_slips: [ ... ],
 *   optimized_slips: [ ... ],  // optional
 *   matches: [ ... ]            // optional
 * }
 */
app.post("/api/sync-slips", async (req, res) => {
  // Guard: Ensure database collections are available
  if (!collections) {
    return res.status(503).json({
      success: false,
      error: "Database unavailable",
    });
  }

  try {
    const payload = req.body;

    if (!payload.master_slip) {
      return res.status(400).json({
        success: false,
        error: "Invalid payload: master_slip is required",
      });
    }

    const { master_slip, generated_slips, optimized_slips, matches } = payload;

    // ============================================================
    // 1. UPSERT MASTER SLIP
    // ============================================================
    const masterSlipData = {
      ...master_slip,
      master_slip_id: String(master_slip.id || master_slip.master_slip_id),
      updated_at: new Date(),
    };

    await collections.master_slips.updateOne(
      { master_slip_id: masterSlipData.master_slip_id },
      { $set: masterSlipData },
      { upsert: true }
    );

    let syncCounts = {
      master_slips: 1,
      generated_slips: 0,
      optimized_slips: 0,
      matches: 0,
      master_slip_matches: 0,
    };

    // ============================================================
    // 2. UPSERT GENERATED SLIPS (backward compatible)
    // ============================================================
    if (Array.isArray(generated_slips) && generated_slips.length > 0) {
      for (const slip of generated_slips) {
        const slipData = {
          ...slip,
          slip_id: String(
            slip.id ||
              slip.slip_id ||
              `gen_${Date.now()}_${Math.random()
                .toString(36)
                .slice(2)}`
          ),
          master_slip_id: masterSlipData.master_slip_id,
          updated_at: new Date(),
        };

        // 1️⃣ Upsert the slip
        await collections.generated_slips.updateOne(
          { slip_id: slipData.slip_id },
          { $set: slipData },
          { upsert: true }
        );

        syncCounts.generated_slips++;

        // 2️⃣ Upsert legs (✅ MUST be here)
        if (Array.isArray(slip.legs)) {
          for (const leg of slip.legs) {
            const legData = {
              ...leg,
              slip_id: slipData.slip_id,
              master_slip_id: masterSlipData.master_slip_id,
              match_id: leg.match_id,
              market: leg.market,
              selection: leg.selection,
              odds: leg.odds,
              match: leg.match || null,
              updated_at: new Date(),
            };

            await collections.generated_slip_legs.updateOne(
              { id: leg.id },
              { $set: legData },
              { upsert: true }
            );
          }
        }
      }
    }

    // ============================================================
    // 3. UPSERT OPTIMIZED SLIPS (new feature)
    // ============================================================
    if (
      collections.optimized_slips &&
      Array.isArray(optimized_slips) &&
      optimized_slips.length > 0
    ) {
      for (const slip of optimized_slips) {
        const slipData = {
          ...slip,
          master_slip_id: parseInt(masterSlipData.master_slip_id),
          updated_at: new Date(),
        };

        await collections.optimized_slips.updateOne(
          { id: slip.id, master_slip_id: slipData.master_slip_id },
          { $set: slipData },
          { upsert: true }
        );
        syncCounts.optimized_slips++;
      }
    }

    // ============================================================
    // 4. UPSERT MASTER SLIP MATCHES (new feature)
    // ============================================================
    if (
      collections.master_slip_matches &&
      Array.isArray(matches) &&
      matches.length > 0
    ) {
      for (const match of matches) {
        const matchData = {
          ...match,
          master_slip_id: parseInt(masterSlipData.master_slip_id),
          updated_at: new Date(),
        };

        await collections.master_slip_matches.updateOne(
          { id: match.id },
          { $set: matchData },
          { upsert: true }
        );
        syncCounts.master_slip_matches++;

        // ============================================================
        // 5. EXTRACT AND UPSERT MATCH DATA (if match_data exists)
        // ============================================================
        if (collections.matches && match.match_data) {
          const extractedMatch = {
            id: match.match_id,
            home_team:
              match.match_data.home_team ||
              match.match_data.homeTeam ||
              "",
            away_team:
              match.match_data.away_team ||
              match.match_data.awayTeam ||
              "",
            ...match.match_data,
          };

          await collections.matches.updateOne(
            { id: extractedMatch.id },
            { $set: extractedMatch },
            { upsert: true }
          );
          syncCounts.matches++;
        }
      }
    }

    // ============================================================
    // RESPONSE
    // ============================================================
    res.json({
      success: true,
      synced: syncCounts,
      message: `Successfully synced master slip ${masterSlipData.master_slip_id}`,
      details: {
        master_slip_id: masterSlipData.master_slip_id,
        generated_slips: syncCounts.generated_slips,
        optimized_slips: syncCounts.optimized_slips,
        matches: syncCounts.matches,
        master_slip_matches: syncCounts.master_slip_matches,
      },
    });
  } catch (err) {
    console.error("Error syncing slips:", err);
    res.status(500).json({
      success: false,
      error: "Failed to sync slips",
      message: err.message,
    });
  }
});

// ---- Graceful Shutdown ----
async function gracefulShutdown() {
  console.log("🛑 Shutting down gracefully...");
  try {
    if (client) {
      await client.close();
      console.log("✅ MongoDB connection closed");
      client = null;
      db = null;
      collections = null;
    }
  } catch (err) {
    console.error("❌ Error during shutdown:", err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ---- Start Server ----
async function startServer() {
  try {
    // Connect to MongoDB
    await connectMongo();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Database: ${MONGO_DB_NAME}`);
      console.log(`📡 DB connected: ${collections !== null}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
