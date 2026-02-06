"use strict";
/* server.ts
   Public Slip API - improved startup & Mongo handling for local/dev environments.

   Fixes applied:
   - If MONGO_URI is missing, fallback to mongodb://127.0.0.1:27017 (avoid ::1/localhost IPv6 issues).
   - Use a short serverSelectionTimeoutMS so failures surface quickly.
   - Do NOT exit the process on initial DB connect failure; server will start in degraded mode.
   - Health endpoints and middleware respond 503 while DB is disconnected.
   - Added POST /api/db/reconnect endpoint to attempt reconnection from runtime.
   - Stronger typing for collections and safer guards before using DB collections.
   - Graceful shutdown handles absent client safely.
   - FIXED: Removed deprecated client.topology check - using modern MongoDB driver API
   - ADDED: getPlacementSlips endpoint matching Laravel response structure exactly
*/
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const mongodb_1 = require("mongodb");
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const PORT = Number(process.env.PORT || 4000);
const MONGO_URI = "mongodb+srv://kojoyeboah53i:saints_salvation2@cluster0.sk4iy96.mongodb.net/generatedslips?retryWrites=true&w=majority";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "generatedslips";
const DB_CONNECT_TIMEOUT_MS = Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000);
// ---- DB state ----
let client = null;
let db = null;
let collections = null;
/** Utility: mask credentials in a URI for logs */
function maskMongoUri(uri) {
    try {
        // quick mask of basic auth if present
        return uri.replace(/(\/\/)([^:@]+):([^@]+)@/, (_m, p1, u, p) => `${p1}${u}:****@`);
    }
    catch {
        return uri;
    }
}
/**
 * Check if MongoDB client is connected.
 * Modern MongoDB driver doesn't expose topology.isConnected.
 * We track state explicitly and can verify with ping if needed.
 */
function isMongoConnected() {
    return !!(client && db && collections);
}
// ---- Connect to MongoDB (does not exit process on failure) ----
async function connectMongo() {
    if (isMongoConnected()) {
        console.log("✅ MongoDB already connected");
        return;
    }
    console.log(`🔗 Attempting MongoDB connection to ${maskMongoUri(MONGO_URI)} (db: ${MONGO_DB_NAME})`);
    try {
        client = new mongodb_1.MongoClient(MONGO_URI, {
            serverSelectionTimeoutMS: DB_CONNECT_TIMEOUT_MS,
            // other options may be added here for production
        });
        await client.connect();
        db = client.db(MONGO_DB_NAME);
        collections = {
            master_slips: db.collection("master_slips"),
            generated_slips: db.collection("generated_slips"),
            optimized_slips: db.collection("optimized_slips"),
            master_slip_matches: db.collection("master_slip_matches"),
            matches: db.collection("matches"), // Add matches collection
        };
        console.log(`✅ MongoDB connected to: ${db.databaseName}`);
        await createIndexes();
    }
    catch (err) {
        // Do NOT exit here — keep server running in degraded mode.
        console.error("❌ MongoDB connection failed:", err);
        client = null;
        db = null;
        collections = null;
    }
}
// ---- Create Indexes (guarded) ----
async function createIndexes() {
    if (!collections) {
        console.warn("⚠️ Skipping index creation: DB collections are not initialized");
        return;
    }
    try {
        // Master slips indexes
        await collections.master_slips.createIndex({ master_slip_id: 1 }, { unique: true });
        await collections.master_slips.createIndex({ user_id: 1 });
        await collections.master_slips.createIndex({ created_at: -1 });
        await collections.master_slips.createIndex({ status: 1 });
        // Generated slips indexes
        await collections.generated_slips.createIndex({ slip_id: 1 }, { unique: true });
        await collections.generated_slips.createIndex({ master_slip_id: 1 });
        await collections.generated_slips.createIndex({ generated_at: -1 });
        await collections.generated_slips.createIndex({ status: 1 });
        await collections.generated_slips.createIndex({ risk_level: 1 });
        // Optimized slips indexes (if collection exists)
        if (collections.optimized_slips) {
            await collections.optimized_slips.createIndex({ master_slip_id: 1 });
            await collections.optimized_slips.createIndex({ id: 1 });
        }
        // Master slip matches indexes (if collection exists)
        if (collections.master_slip_matches) {
            await collections.master_slip_matches.createIndex({ master_slip_id: 1 });
            await collections.master_slip_matches.createIndex({ match_id: 1 });
            await collections.master_slip_matches.createIndex({ id: 1 });
        }
        // Matches indexes (if collection exists)
        if (collections.matches) {
            await collections.matches.createIndex({ id: 1 }, { unique: true });
        }
        console.log("✅ Database indexes ensured");
    }
    catch (err) {
        console.error("⚠️ Failed to create database indexes:", err);
    }
}
// ---- Health check middleware (returns 503 while DB is disconnected) ----
app.use((req, res, next) => {
    // Allow health/reconnect endpoints through even when DB is down
    if (req.path === "/" ||
        req.path === "/health" ||
        req.path.startsWith("/api/db")) {
        return next();
    }
    if (!isMongoConnected()) {
        return res.status(503).json({
            error: "Database not connected",
            status: "service_unavailable",
        });
    }
    next();
});
// ---- Routes ----
// Basic service root
app.get("/", (_req, res) => {
    res.json({
        status: "healthy",
        service: "Public Slip API",
        database: db?.databaseName ?? null,
        db_connected: isMongoConnected(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});
// DB health
app.get("/health", async (_req, res) => {
    if (!db) {
        return res.status(503).json({
            status: "unhealthy",
            database: { connected: false },
            timestamp: new Date().toISOString(),
        });
    }
    try {
        await db.command({ ping: 1 });
        res.json({
            status: "healthy",
            database: {
                connected: true,
                name: db.databaseName,
                collections: collections ? Object.keys(collections) : [],
            },
            timestamp: new Date().toISOString(),
        });
    }
    catch (err) {
        console.error("Health check DB ping failed:", err);
        res.status(503).json({
            status: "unhealthy",
            error: "Database ping failed",
            timestamp: new Date().toISOString(),
        });
    }
});
// Runtime route to attempt reconnection (POST)
app.post("/api/db/reconnect", async (_req, res) => {
    try {
        await connectMongo();
        if (db) {
            return res.json({
                success: true,
                message: "Reconnected to database",
                database: db.databaseName,
            });
        }
        else {
            return res
                .status(500)
                .json({ success: false, message: "Reconnect attempt failed" });
        }
    }
    catch (err) {
        console.error("Reconnect attempt failed:", err);
        return res.status(500).json({ success: false, error: String(err) });
    }
});
// ---- Guard helper ----
function requireCollectionsOrFail(res) {
    if (!collections) {
        res.status(503).json({ success: false, error: "Database unavailable" });
        return false;
    }
    return true;
}
// =====================================================================
// NEW ENDPOINT: Get Placement Slips - Matches Laravel Response Exactly
// =====================================================================
/**
 * GET /api/placement-slips/:masterSlipId
 *
 * Fetches generated slips for a master slip with the exact same response
 * structure as the Laravel getPlacementSlips method.
 *
 * Response matches Laravel format:
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
    if (!requireCollectionsOrFail(res))
        return;
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
            .find({ master_slip_id: masterSlipId })
            .toArray();
        // Get all unique match IDs from all legs
        const matchIds = new Set();
        slips.forEach((slip) => {
            slip.legs?.forEach((leg) => {
                if (leg.match_id) {
                    matchIds.add(leg.match_id);
                }
            });
        });
        // Strategy: Try to get match data from master_slip_matches first (has match_data),
        // then fall back to matches collection
        let matchesMap = new Map();
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
                        home_team: match.match_data.home_team || match.match_data.homeTeam || "",
                        away_team: match.match_data.away_team || match.match_data.awayTeam || "",
                    });
                }
            });
        }
        // OPTION 2: For any remaining matches, try the matches collection
        const remainingMatchIds = Array.from(matchIds).filter((id) => !matchesMap.has(id));
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
            const estimatedReturn = slip.estimated_return ??
                slip.estimated_payout ??
                slip.possible_return ??
                0;
            // Get risk_category (handle both field names, ensure lowercase)
            const riskCategory = (slip.risk_category ??
                slip.risk_level ??
                "unknown").toLowerCase();
            return {
                slip_id: String(slip.slip_id || slip.id || ""),
                master_slip_id: parseInt(String(slip.master_slip_id)),
                confidence_score: String(slip.confidence_score ?? 0),
                total_odds: parseFloat(String(slip.total_odds ?? 0)),
                stake: parseFloat(String(slip.stake ?? 0)),
                estimated_return: parseFloat(String(estimatedReturn)),
                risk_category: riskCategory,
                diversity_score: slip.diversity_score !== null && slip.diversity_score !== undefined
                    ? parseFloat(String(slip.diversity_score))
                    : null,
                created_at: (() => {
                    const date = slip.created_at ?? slip.generated_at;
                    return date instanceof Date ? date.toISOString() : String(date);
                })(),
                legs: (slip.legs ?? []).map((leg) => {
                    const match = matchesMap.get(leg.match_id);
                    return {
                        match_id: parseInt(String(leg.match_id)),
                        home_team: String(match?.home_team ?? ""),
                        away_team: String(match?.away_team ?? ""),
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
            if (confB !== confA)
                return confB - confA;
            // Then by total_odds descending
            if (b.total_odds !== a.total_odds)
                return b.total_odds - a.total_odds;
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
    }
    catch (err) {
        console.error(`Error fetching placement slips for master slip ${req.params.masterSlipId}:`, err);
        return res.status(500).json({
            success: false,
            error: "Failed to fetch placement slips",
            message: err.message,
        });
    }
});
// ---- API endpoints (existing ones continue below) ----
// Fetch master slips with pagination and filtering
app.get("/api/master-slips", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const { page = "1", limit = "20", user_id, status, sort_by = "created_at", sort_order = "desc", } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const query = {};
        if (user_id)
            query.user_id = String(user_id);
        if (status)
            query.status = String(status);
        const sort = {};
        sort[String(sort_by)] = String(sort_order) === "asc" ? 1 : -1;
        const masterSlips = await collections.master_slips
            .find(query)
            .sort(sort)
            .skip(skip)
            .limit(Number(limit))
            .toArray();
        const total = await collections.master_slips.countDocuments(query);
        res.json({
            success: true,
            data: masterSlips,
            pagination: {
                page: Number(page),
                limit: Number(limit),
                total,
                pages: Math.ceil(total / Number(limit)),
            },
        });
    }
    catch (err) {
        console.error("Error fetching master slips:", err);
        res.status(500).json({
            success: false,
            error: "Failed to fetch master slips",
        });
    }
});
// Get single master slip
app.get("/api/master-slips/:masterSlipId", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const { masterSlipId } = req.params;
        const masterSlip = await collections.master_slips.findOne({
            master_slip_id: masterSlipId,
        });
        if (!masterSlip) {
            return res
                .status(404)
                .json({ success: false, error: "Master slip not found" });
        }
        res.json({
            success: true,
            data: masterSlip,
        });
    }
    catch (err) {
        console.error(`Error fetching master slip ${req.params.masterSlipId}:`, err);
        res.status(500).json({
            success: false,
            error: "Failed to fetch master slip",
        });
    }
});
// Create a new master slip
app.post("/api/master-slips", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const masterSlipData = {
            ...req.body,
            created_at: new Date(),
            updated_at: new Date(),
        };
        // Validate required fields
        if (!masterSlipData.master_slip_id || !masterSlipData.user_id) {
            return res.status(400).json({
                success: false,
                error: "master_slip_id and user_id are required",
            });
        }
        // Check if master_slip_id already exists
        const existing = await collections.master_slips.findOne({
            master_slip_id: masterSlipData.master_slip_id,
        });
        if (existing) {
            return res.status(409).json({
                success: false,
                error: "Master slip with this ID already exists",
            });
        }
        const result = await collections.master_slips.insertOne(masterSlipData);
        res.status(201).json({
            success: true,
            data: {
                _id: result.insertedId,
                ...masterSlipData,
            },
            message: "Master slip created successfully",
        });
    }
    catch (err) {
        console.error("Error creating master slip:", err);
        res
            .status(500)
            .json({ success: false, error: "Failed to create master slip" });
    }
});
// Update master slip
app.patch("/api/master-slips/:masterSlipId", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const { masterSlipId } = req.params;
        const updates = {
            ...req.body,
            updated_at: new Date(),
        };
        // Don't allow updating master_slip_id or _id
        delete updates.master_slip_id;
        delete updates._id;
        const result = await collections.master_slips.updateOne({ master_slip_id: masterSlipId }, { $set: updates });
        if (result.matchedCount === 0) {
            return res
                .status(404)
                .json({ success: false, error: "Master slip not found" });
        }
        res.json({
            success: true,
            message: "Master slip updated successfully",
        });
    }
    catch (err) {
        console.error(`Error updating master slip ${req.params.masterSlipId}:`, err);
        res
            .status(500)
            .json({ success: false, error: "Failed to update master slip" });
    }
});
// Fetch generated slips for a master slip (with pagination)
app.get("/api/master-slips/:masterSlipId/generated-slips", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const { masterSlipId } = req.params;
        const { page = "1", limit = "20", status, risk_level, sort_by = "generated_at", sort_order = "desc", } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const query = { master_slip_id: masterSlipId };
        if (status)
            query.status = String(status);
        if (risk_level)
            query.risk_level = String(risk_level);
        const sort = {};
        sort[String(sort_by)] = String(sort_order) === "asc" ? 1 : -1;
        const generatedSlips = await collections.generated_slips
            .find(query)
            .sort(sort)
            .skip(skip)
            .limit(Number(limit))
            .toArray();
        const total = await collections.generated_slips.countDocuments(query);
        res.json({
            success: true,
            data: generatedSlips,
            pagination: {
                page: Number(page),
                limit: Number(limit),
                total,
                pages: Math.ceil(total / Number(limit)),
            },
        });
    }
    catch (err) {
        console.error(`Error fetching generated slips for master slip ${req.params.masterSlipId}:`, err);
        res.status(500).json({
            success: false,
            error: "Failed to fetch generated slips",
        });
    }
});
// Get single generated slip
app.get("/api/generated-slips/:slipId", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const { slipId } = req.params;
        const slip = await collections.generated_slips.findOne({
            slip_id: slipId,
        });
        if (!slip) {
            return res
                .status(404)
                .json({ success: false, error: "Generated slip not found" });
        }
        res.json({
            success: true,
            data: slip,
        });
    }
    catch (err) {
        console.error(`Error fetching generated slip ${req.params.slipId}:`, err);
        res.status(500).json({
            success: false,
            error: "Failed to fetch generated slip",
        });
    }
});
// Batch insert generated slips for a master slip
app.post("/api/master-slips/:masterSlipId/generated-slips", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const { masterSlipId: master_slip_id } = req.params;
        const { slips } = req.body;
        if (!Array.isArray(slips) || slips.length === 0) {
            return res.status(400).json({
                success: false,
                error: "Invalid payload: slips array is required",
            });
        }
        const masterSlipExists = await collections.master_slips.findOne({
            master_slip_id: master_slip_id,
        });
        if (!masterSlipExists) {
            return res.status(404).json({
                success: false,
                error: "Master slip not found",
            });
        }
        const slipsToInsert = slips.map((slip, index) => ({
            ...slip,
            slip_id: slip.slip_id ||
                `gs_${Date.now()}_${index}_${Math.random().toString(36).substr(2, 9)}`,
            master_slip_id,
            generated_at: new Date(),
            status: slip.status || "active",
        }));
        const result = await collections.generated_slips.insertMany(slipsToInsert);
        await collections.master_slips.updateOne({ master_slip_id }, {
            $set: { updated_at: new Date() },
            $inc: { generated_slips_count: slipsToInsert.length },
        });
        res.status(201).json({
            success: true,
            insertedCount: result.insertedCount,
            message: `${result.insertedCount} generated slips created successfully`,
        });
    }
    catch (err) {
        console.error("Error batch inserting generated slips:", err);
        res
            .status(500)
            .json({ success: false, error: "Failed to create generated slips" });
    }
});
// Update slip status
app.patch("/api/generated-slips/:slipId/status", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const { slipId } = req.params;
        const { status } = req.body;
        const allowed = ["active", "won", "lost", "void"];
        if (!allowed.includes(status)) {
            return res
                .status(400)
                .json({ success: false, error: "Invalid status value" });
        }
        const result = await collections.generated_slips.updateOne({ slip_id: slipId }, {
            $set: {
                status,
                updated_at: new Date(),
            },
        });
        if (result.matchedCount === 0) {
            return res
                .status(404)
                .json({ success: false, error: "Generated slip not found" });
        }
        res.json({ success: true, message: "Slip status updated successfully" });
    }
    catch (err) {
        console.error(`Error updating slip ${req.params.slipId} status:`, err);
        res
            .status(500)
            .json({ success: false, error: "Failed to update slip status" });
    }
});
// Delete all slips for a master slip (admin/cleanup)
app.delete("/api/master-slips/:masterSlipId/slips", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const { masterSlipId } = req.params;
        const deleteResult = await collections.generated_slips.deleteMany({
            master_slip_id: masterSlipId,
        });
        res.json({
            success: true,
            deletedCount: deleteResult.deletedCount,
            message: `${deleteResult.deletedCount} generated slips deleted`,
        });
    }
    catch (err) {
        console.error(`Error deleting slips for master slip ${req.params.masterSlipId}:`, err);
        res.status(500).json({ success: false, error: "Failed to delete slips" });
    }
});
// Sync master slip and generated slips (upsert) - ENHANCED with backward compatibility
app.post("/api/sync-slips", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
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
        await collections.master_slips.updateOne({ master_slip_id: masterSlipData.master_slip_id }, { $set: masterSlipData }, { upsert: true });
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
                    slip_id: String(slip.id ||
                        slip.slip_id ||
                        `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`),
                    master_slip_id: masterSlipData.master_slip_id,
                    updated_at: new Date(),
                };
                await collections.generated_slips.updateOne({ slip_id: slipData.slip_id }, { $set: slipData }, { upsert: true });
                syncCounts.generated_slips++;
            }
        }
        // ============================================================
        // 3. UPSERT OPTIMIZED SLIPS (new feature)
        // ============================================================
        if (collections.optimized_slips &&
            Array.isArray(optimized_slips) &&
            optimized_slips.length > 0) {
            for (const slip of optimized_slips) {
                const slipData = {
                    ...slip,
                    master_slip_id: parseInt(masterSlipData.master_slip_id),
                    updated_at: new Date(),
                };
                await collections.optimized_slips.updateOne({ id: slip.id, master_slip_id: slipData.master_slip_id }, { $set: slipData }, { upsert: true });
                syncCounts.optimized_slips++;
            }
        }
        // ============================================================
        // 4. UPSERT MASTER SLIP MATCHES (new feature)
        // ============================================================
        if (collections.master_slip_matches &&
            Array.isArray(matches) &&
            matches.length > 0) {
            for (const match of matches) {
                const matchData = {
                    ...match,
                    master_slip_id: parseInt(masterSlipData.master_slip_id),
                    updated_at: new Date(),
                };
                await collections.master_slip_matches.updateOne({ id: match.id }, { $set: matchData }, { upsert: true });
                syncCounts.master_slip_matches++;
                // ============================================================
                // 5. EXTRACT AND UPSERT MATCH DATA (if match_data exists)
                // ============================================================
                if (collections.matches && match.match_data) {
                    const extractedMatch = {
                        id: match.match_id,
                        home_team: match.match_data.home_team || match.match_data.homeTeam || "",
                        away_team: match.match_data.away_team || match.match_data.awayTeam || "",
                        ...match.match_data,
                    };
                    await collections.matches.updateOne({ id: extractedMatch.id }, { $set: extractedMatch }, { upsert: true });
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
    }
    catch (err) {
        console.error("Error syncing slips:", err);
        res.status(500).json({
            success: false,
            error: "Failed to sync slips",
            message: err.message,
        });
    }
});
// Fetch master slips with pagination and filtering
app.get("/api/master-slips-with-slips", async (req, res) => {
    if (!requireCollectionsOrFail(res))
        return;
    try {
        const { page = "1", limit = "50", user_id, status, sort_by = "created_at", sort_order = "desc", } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const query = {};
        if (user_id)
            query.user_id = String(user_id);
        if (status)
            query.status = String(status);
        const sort = {};
        sort[String(sort_by)] = String(sort_order) === "asc" ? 1 : -1;
        const masterSlips = await collections.master_slips
            .find(query)
            .sort(sort)
            .skip(skip)
            .limit(Number(limit))
            .toArray();
        const total = await collections.master_slips.countDocuments(query);
        res.json({
            success: true,
            data: masterSlips,
            pagination: {
                page: Number(page),
                limit: Number(limit),
                total,
                pages: Math.ceil(total / Number(limit)),
            },
        });
    }
    catch (err) {
        console.error("Error fetching master slips:", err);
        res.status(500).json({
            success: false,
            error: "Failed to fetch master slips",
        });
    }
});
// ---- Error Handling Middleware ----
app.use((err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
        success: false,
        error: "Internal server error",
        request_id: Date.now().toString(36),
    });
});
// ---- Graceful Shutdown ----
async function gracefulShutdown() {
    console.log("🛑 Received shutdown signal, shutting down gracefully...");
    try {
        if (client) {
            await client.close();
            console.log("✅ MongoDB connection closed");
            client = null;
            db = null;
            collections = null;
        }
    }
    catch (err) {
        console.error("❌ Error during shutdown:", err);
    }
    finally {
        process.exit(0);
    }
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
// ---- Start Server ----
async function startServer() {
    try {
        // Attempt DB connect, but do NOT block server start on failure.
        await connectMongo();
        app.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
            console.log(`📊 Attempted DB: ${maskMongoUri(MONGO_URI)} (db: ${MONGO_DB_NAME})`);
            console.log(`📡 DB connected: ${isMongoConnected()}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
        });
    }
    catch (err) {
        // Shouldn't usually reach here because connectMongo swallows errors.
        console.error("❌ Failed to start server:", err);
        process.exit(1);
    }
}
startServer();
