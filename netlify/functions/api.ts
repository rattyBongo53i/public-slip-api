import { MongoClient, Db } from "mongodb";
import type {
  MasterSlip,
  Match,
  MasterSlipMatch,
  GeneratedSlip,
  OptimizedSlip,
  DatabaseCollections,
  NetlifyEvent,
  NetlifyContext,
} from "./types";

// ---- Singleton DB Connection ----
let client: MongoClient | null = null;
let db: Db | null = null;
let collections: DatabaseCollections | null = null;

const MONGO_URI = process.env.MONGO_URI || "";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "generatedslips";
const DB_CONNECT_TIMEOUT_MS = Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000);

function maskMongoUri(uri: string): string {
  try {
    return uri.replace(
      /(\/\/)([^:@]+):([^@]+)@/,
      (_m, p1, u, _p) => `${p1}${u}:****@`,
    );
  } catch {
    return uri;
  }
}

function isMongoConnected(): boolean {
  return !!(client && db && collections);
}

async function connectMongo(): Promise<void> {
  if (isMongoConnected()) {
    console.log("✅ MongoDB already connected");
    return;
  }

  console.log(
    `🔗 Attempting MongoDB connection to ${maskMongoUri(MONGO_URI)} (db: ${MONGO_DB_NAME})`,
  );

  try {
    client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: DB_CONNECT_TIMEOUT_MS,
    });

    await client.connect();

    db = client.db(MONGO_DB_NAME);
    collections = {
      master_slips: db.collection<MasterSlip>("master_slips"),
      generated_slips: db.collection<GeneratedSlip>("generated_slips"),
      optimized_slips: db.collection<OptimizedSlip>("optimized_slips"),
      master_slip_matches: db.collection<MasterSlipMatch>(
        "master_slip_matches",
      ),
      matches: db.collection<Match>("matches"),
    };

    console.log(`✅ MongoDB connected to: ${db.databaseName}`);
    await createIndexes();
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    client = null;
    db = null;
    collections = null;
  }
}

async function createIndexes(): Promise<void> {
  if (!collections) {
    console.warn(
      "⚠️ Skipping index creation: DB collections are not initialized",
    );
    return;
  }

  try {
    await collections.master_slips.createIndex(
      { master_slip_id: 1 },
      { unique: true },
    );
    await collections.master_slips.createIndex({ user_id: 1 });
    await collections.master_slips.createIndex({ created_at: -1 });
    await collections.master_slips.createIndex({ status: 1 });

    await collections.generated_slips.createIndex(
      { slip_id: 1 },
      { unique: true },
    );
    await collections.generated_slips.createIndex({ master_slip_id: 1 });
    await collections.generated_slips.createIndex({ generated_at: -1 });
    await collections.generated_slips.createIndex({ status: 1 });
    await collections.generated_slips.createIndex({ risk_level: 1 });

    if (collections.optimized_slips) {
      await collections.optimized_slips.createIndex({ master_slip_id: 1 });
      await collections.optimized_slips.createIndex({ id: 1 });
    }

    if (collections.master_slip_matches) {
      await collections.master_slip_matches.createIndex({ master_slip_id: 1 });
      await collections.master_slip_matches.createIndex({ match_id: 1 });
      await collections.master_slip_matches.createIndex({ id: 1 });
    }

    if (collections.matches) {
      await collections.matches.createIndex({ id: 1 }, { unique: true });
    }

    console.log("✅ Database indexes ensured");
  } catch (err) {
    console.error("⚠️ Failed to create database indexes:", err);
  }
}

// ---- Response Helpers ----
function respondJson(statusCode: number, body: any) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

function respondError(statusCode: number, error: string, message?: string) {
  return respondJson(statusCode, {
    success: false,
    error,
    ...(message && { message }),
  });
}

// ---- Routing & Path Parsing ----
interface RequestContext {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
}

function parseRequest(event: NetlifyEvent): RequestContext {
  let path = event.path || "/";
  if (path.startsWith("/.netlify/functions/api")) {
    path = path.replace("/.netlify/functions/api", "") || "/";
  }

  const query = event.queryStringParameters || {};
  let body = null;

  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      body = event.body;
    }
  }

  return {
    method: event.httpMethod || "GET",
    path,
    query,
    body,
  };
}

// ---- Route Handlers ----

async function handleRoot() {
  return respondJson(200, {
    status: "healthy",
    service: "Public Slip API",
    database: db?.databaseName ?? null,
    db_connected: isMongoConnected(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}

async function handleHealth() {
  if (!db) {
    return respondJson(503, {
      status: "unhealthy",
      database: { connected: false },
      timestamp: new Date().toISOString(),
    });
  }

  try {
    await db.command({ ping: 1 });
    return respondJson(200, {
      status: "healthy",
      database: {
        connected: true,
        name: db.databaseName,
        collections: collections ? Object.keys(collections) : [],
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Health check DB ping failed:", err);
    return respondJson(503, {
      status: "unhealthy",
      error: "Database ping failed",
      timestamp: new Date().toISOString(),
    });
  }
}

async function handleDbReconnect() {
  try {
    await connectMongo();
    if (db) {
      return respondJson(200, {
        success: true,
        message: "Reconnected to database",
        database: db.databaseName,
      });
    } else {
      return respondError(500, "Reconnect attempt failed");
    }
  } catch (err) {
    console.error("Reconnect attempt failed:", err);
    return respondError(500, "Reconnect failed", String(err));
  }
}

async function handleGetPlacementSlips(masterSlipId: string) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const masterSlip = await collections.master_slips.findOne({
      master_slip_id: masterSlipId,
    });

    if (!masterSlip) {
      return respondJson(404, {
        success: false,
        error: "Master slip not found",
        message: `No master slip found with ID: ${masterSlipId}`,
      });
    }

    const slips = await collections.generated_slips
      .find({ master_slip_id: masterSlipId })
      .toArray();

    const matchIds = new Set<number>();
    slips.forEach((slip) => {
      slip.legs?.forEach((leg) => {
        if (leg.match_id) {
          matchIds.add(leg.match_id);
        }
      });
    });

    let matchesMap = new Map<number, any>();

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
              match.match_data.home_team || match.match_data.homeTeam || "",
            away_team:
              match.match_data.away_team || match.match_data.awayTeam || "",
          });
        }
      });
    }

    const remainingMatchIds = Array.from(matchIds).filter(
      (id) => !matchesMap.has(id),
    );
    if (collections.matches && remainingMatchIds.length > 0) {
      const matches = await collections.matches
        .find({ id: { $in: remainingMatchIds } })
        .toArray();

      matches.forEach((match) => {
        matchesMap.set(match.id, match);
      });
    }

    const mappedSlips = slips
      .map((slip) => {
        const estimatedReturn =
          slip.estimated_return ??
          slip.estimated_payout ??
          slip.possible_return ??
          0;

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
            slip.diversity_score !== null && slip.diversity_score !== undefined
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
      .sort((a, b) => {
        const confA = parseFloat(a.confidence_score);
        const confB = parseFloat(b.confidence_score);
        if (confB !== confA) return confB - confA;
        if (b.total_odds !== a.total_odds) return b.total_odds - a.total_odds;
        return a.slip_id.localeCompare(b.slip_id);
      });

    return respondJson(200, {
      master_slip_id: parseInt(masterSlip.master_slip_id),
      engine_version: process.env.ENGINE_VERSION || "v1",
      generated_at: new Date().toISOString(),
      slips: mappedSlips,
    });
  } catch (err: any) {
    console.error(
      `Error fetching placement slips for master slip ${masterSlipId}:`,
      err,
    );
    return respondError(500, "Failed to fetch placement slips", err.message);
  }
}

async function handleGetMasterSlips(ctx: RequestContext) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const page = Number(ctx.query.page || 1);
    const limit = Number(ctx.query.limit || 20);
    const skip = (page - 1) * limit;
    const query: any = {};

    if (ctx.query.user_id) query.user_id = String(ctx.query.user_id);
    if (ctx.query.status) query.status = String(ctx.query.status);

    const sortBy = String(ctx.query.sort_by || "created_at");
    const sortOrder = String(ctx.query.sort_order || "desc");
    const sort: any = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const masterSlips = await collections.master_slips
      .find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await collections.master_slips.countDocuments(query);

    return respondJson(200, {
      success: true,
      data: masterSlips,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    console.error("Error fetching master slips:", err);
    return respondError(500, "Failed to fetch master slips");
  }
}

async function handleGetMasterSlip(masterSlipId: string) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const masterSlip = await collections.master_slips.findOne({
      master_slip_id: masterSlipId,
    });

    if (!masterSlip) {
      return respondError(404, "Master slip not found");
    }

    return respondJson(200, {
      success: true,
      data: masterSlip,
    });
  } catch (err: any) {
    console.error(`Error fetching master slip ${masterSlipId}:`, err);
    return respondError(500, "Failed to fetch master slip");
  }
}

async function handleCreateMasterSlip(ctx: RequestContext) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const masterSlipData: Partial<MasterSlip> = {
      ...ctx.body,
      created_at: new Date(),
      updated_at: new Date(),
    };

    if (!masterSlipData.master_slip_id || !masterSlipData.user_id) {
      return respondError(400, "master_slip_id and user_id are required");
    }

    const existing = await collections.master_slips.findOne({
      master_slip_id: masterSlipData.master_slip_id,
    });

    if (existing) {
      return respondError(409, "Master slip with this ID already exists");
    }

    const result = await collections.master_slips.insertOne(
      masterSlipData as MasterSlip,
    );

    return respondJson(201, {
      success: true,
      data: {
        _id: result.insertedId,
        ...masterSlipData,
      },
      message: "Master slip created successfully",
    });
  } catch (err: any) {
    console.error("Error creating master slip:", err);
    return respondError(500, "Failed to create master slip");
  }
}

async function handleUpdateMasterSlip(
  masterSlipId: string,
  ctx: RequestContext,
) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const updates = {
      ...ctx.body,
      updated_at: new Date(),
    };

    delete updates.master_slip_id;
    delete updates._id;

    const result = await collections.master_slips.updateOne(
      { master_slip_id: masterSlipId },
      { $set: updates },
    );

    if (result.matchedCount === 0) {
      return respondError(404, "Master slip not found");
    }

    return respondJson(200, {
      success: true,
      message: "Master slip updated successfully",
    });
  } catch (err: any) {
    console.error(`Error updating master slip ${masterSlipId}:`, err);
    return respondError(500, "Failed to update master slip");
  }
}

async function handleGetGeneratedSlips(
  masterSlipId: string,
  ctx: RequestContext,
) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const page = Number(ctx.query.page || 1);
    const limit = Number(ctx.query.limit || 20);
    const skip = (page - 1) * limit;
    const query: any = { master_slip_id: masterSlipId };

    if (ctx.query.status) query.status = String(ctx.query.status);
    if (ctx.query.risk_level) query.risk_level = String(ctx.query.risk_level);

    const sortBy = String(ctx.query.sort_by || "generated_at");
    const sortOrder = String(ctx.query.sort_order || "desc");
    const sort: any = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const generatedSlips = await collections.generated_slips
      .find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await collections.generated_slips.countDocuments(query);

    return respondJson(200, {
      success: true,
      data: generatedSlips,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    console.error(
      `Error fetching generated slips for master slip ${masterSlipId}:`,
      err,
    );
    return respondError(500, "Failed to fetch generated slips");
  }
}

async function handleGetGeneratedSlip(slipId: string) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const slip = await collections.generated_slips.findOne({
      slip_id: slipId,
    });

    if (!slip) {
      return respondError(404, "Generated slip not found");
    }

    return respondJson(200, {
      success: true,
      data: slip,
    });
  } catch (err: any) {
    console.error(`Error fetching generated slip ${slipId}:`, err);
    return respondError(500, "Failed to fetch generated slip");
  }
}

async function handleCreateGeneratedSlips(
  masterSlipId: string,
  ctx: RequestContext,
) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const { slips } = ctx.body;

    if (!Array.isArray(slips) || slips.length === 0) {
      return respondError(400, "Invalid payload: slips array is required");
    }

    const masterSlipExists = await collections.master_slips.findOne({
      master_slip_id: masterSlipId,
    });

    if (!masterSlipExists) {
      return respondError(404, "Master slip not found");
    }

    const slipsToInsert: GeneratedSlip[] = slips.map(
      (slip: any, index: number) => ({
        ...slip,
        slip_id:
          slip.slip_id ||
          `gs_${Date.now()}_${index}_${Math.random().toString(36).substr(2, 9)}`,
        master_slip_id: masterSlipId,
        generated_at: new Date(),
        status: slip.status || "active",
      }),
    );

    const result = await collections.generated_slips.insertMany(slipsToInsert);

    await collections.master_slips.updateOne(
      { master_slip_id: masterSlipId },
      {
        $set: { updated_at: new Date() },
        $inc: { generated_slips_count: slipsToInsert.length },
      },
    );

    return respondJson(201, {
      success: true,
      insertedCount: result.insertedCount,
      message: `${result.insertedCount} generated slips created successfully`,
    });
  } catch (err: any) {
    console.error("Error batch inserting generated slips:", err);
    return respondError(500, "Failed to create generated slips");
  }
}

async function handleUpdateSlipStatus(slipId: string, ctx: RequestContext) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const { status } = ctx.body;

    const allowed = ["active", "won", "lost", "void"];
    if (!allowed.includes(status)) {
      return respondError(400, "Invalid status value");
    }

    const result = await collections.generated_slips.updateOne(
      { slip_id: slipId },
      {
        $set: {
          status,
          updated_at: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return respondError(404, "Generated slip not found");
    }

    return respondJson(200, {
      success: true,
      message: "Slip status updated successfully",
    });
  } catch (err: any) {
    console.error(`Error updating slip ${slipId} status:`, err);
    return respondError(500, "Failed to update slip status");
  }
}

async function handleDeleteSlips(masterSlipId: string) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const deleteResult = await collections.generated_slips.deleteMany({
      master_slip_id: masterSlipId,
    });

    return respondJson(200, {
      success: true,
      deletedCount: deleteResult.deletedCount,
      message: `${deleteResult.deletedCount} generated slips deleted`,
    });
  } catch (err: any) {
    console.error(`Error deleting slips for master slip ${masterSlipId}:`, err);
    return respondError(500, "Failed to delete slips");
  }
}

async function handleSyncSlips(ctx: RequestContext) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const payload = ctx.body;

    if (!payload.master_slip) {
      return respondError(400, "Invalid payload: master_slip is required");
    }

    const { master_slip, generated_slips, optimized_slips, matches } = payload;

    const masterSlipData = {
      ...master_slip,
      master_slip_id: String(master_slip.id || master_slip.master_slip_id),
      updated_at: new Date(),
    };

    await collections.master_slips.updateOne(
      { master_slip_id: masterSlipData.master_slip_id },
      { $set: masterSlipData },
      { upsert: true },
    );

    let syncCounts = {
      master_slips: 1,
      generated_slips: 0,
      optimized_slips: 0,
      matches: 0,
      master_slip_matches: 0,
    };

    if (Array.isArray(generated_slips) && generated_slips.length > 0) {
      for (const slip of generated_slips) {
        const slipData = {
          ...slip,
          slip_id: String(
            slip.id ||
              slip.slip_id ||
              `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          ),
          master_slip_id: masterSlipData.master_slip_id,
          updated_at: new Date(),
        };

        await collections.generated_slips.updateOne(
          { slip_id: slipData.slip_id },
          { $set: slipData },
          { upsert: true },
        );
        syncCounts.generated_slips++;
      }
    }

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
          { upsert: true },
        );
        syncCounts.optimized_slips++;
      }
    }

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
          { upsert: true },
        );
        syncCounts.master_slip_matches++;

        if (collections.matches && match.match_data) {
          const extractedMatch = {
            id: match.match_id,
            home_team:
              match.match_data.home_team || match.match_data.homeTeam || "",
            away_team:
              match.match_data.away_team || match.match_data.awayTeam || "",
            ...match.match_data,
          };

          await collections.matches.updateOne(
            { id: extractedMatch.id },
            { $set: extractedMatch },
            { upsert: true },
          );
          syncCounts.matches++;
        }
      }
    }

    return respondJson(200, {
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
  } catch (err: any) {
    console.error("Error syncing slips:", err);
    return respondError(500, "Failed to sync slips", err.message);
  }
}

async function handleGetMasterSlipsWithSlips(ctx: RequestContext) {
  if (!collections) {
    return respondError(503, "Database unavailable");
  }

  try {
    const page = Number(ctx.query.page || 1);
    const limit = Number(ctx.query.limit || 50);
    const skip = (page - 1) * limit;
    const query: any = {};

    if (ctx.query.user_id) query.user_id = String(ctx.query.user_id);
    if (ctx.query.status) query.status = String(ctx.query.status);

    const sortBy = String(ctx.query.sort_by || "created_at");
    const sortOrder = String(ctx.query.sort_order || "desc");
    const sort: any = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const masterSlips = await collections.master_slips
      .find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await collections.master_slips.countDocuments(query);

    return respondJson(200, {
      success: true,
      data: masterSlips,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    console.error("Error fetching master slips:", err);
    return respondError(500, "Failed to fetch master slips");
  }
}

// ---- Main Handler ----
export async function handler(event: NetlifyEvent, _context: NetlifyContext) {
  // Initialize DB connection on first request
  if (!isMongoConnected() && MONGO_URI) {
    await connectMongo();
  }

  const ctx = parseRequest(event);

  // OPTIONS (CORS)
  if (ctx.method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
  }

  // Routes
  if (ctx.path === "/" && ctx.method === "GET") {
    return await handleRoot();
  }

  if (ctx.path === "/health" && ctx.method === "GET") {
    return await handleHealth();
  }

  if (ctx.path === "/api/db/reconnect" && ctx.method === "POST") {
    return await handleDbReconnect();
  }

  // Placement slips
  const placementMatch = ctx.path.match(/^\/api\/placement-slips\/([^/]+)$/);
  if (placementMatch && ctx.method === "GET") {
    return await handleGetPlacementSlips(placementMatch[1]);
  }

  // Master slips list
  if (ctx.path === "/api/master-slips" && ctx.method === "GET") {
    return await handleGetMasterSlips(ctx);
  }

  // Create master slip
  if (ctx.path === "/api/master-slips" && ctx.method === "POST") {
    return await handleCreateMasterSlip(ctx);
  }

  // Get single master slip
  const masterSlipMatch = ctx.path.match(/^\/api\/master-slips\/([^/]+)$/);
  if (masterSlipMatch && ctx.method === "GET") {
    return await handleGetMasterSlip(masterSlipMatch[1]);
  }

  // Update master slip
  if (masterSlipMatch && ctx.method === "PATCH") {
    return await handleUpdateMasterSlip(masterSlipMatch[1], ctx);
  }

  // Generated slips for master slip
  const genSlipsMatch = ctx.path.match(
    /^\/api\/master-slips\/([^/]+)\/generated-slips$/,
  );
  if (genSlipsMatch && ctx.method === "GET") {
    return await handleGetGeneratedSlips(genSlipsMatch[1], ctx);
  }

  if (genSlipsMatch && ctx.method === "POST") {
    return await handleCreateGeneratedSlips(genSlipsMatch[1], ctx);
  }

  // Single generated slip
  const singleSlipMatch = ctx.path.match(/^\/api\/generated-slips\/([^/]+)$/);
  if (singleSlipMatch && ctx.method === "GET") {
    return await handleGetGeneratedSlip(singleSlipMatch[1]);
  }

  // Update slip status
  const statusMatch = ctx.path.match(
    /^\/api\/generated-slips\/([^/]+)\/status$/,
  );
  if (statusMatch && ctx.method === "PATCH") {
    return await handleUpdateSlipStatus(statusMatch[1], ctx);
  }

  // Delete slips
  const deleteMatch = ctx.path.match(/^\/api\/master-slips\/([^/]+)\/slips$/);
  if (deleteMatch && ctx.method === "DELETE") {
    return await handleDeleteSlips(deleteMatch[1]);
  }

  // Sync slips
  if (ctx.path === "/api/sync-slips" && ctx.method === "POST") {
    return await handleSyncSlips(ctx);
  }

  // Master slips with slips
  if (ctx.path === "/api/master-slips-with-slips" && ctx.method === "GET") {
    return await handleGetMasterSlipsWithSlips(ctx);
  }

  // 404
  return respondJson(404, {
    success: false,
    error: "Not found",
    path: ctx.path,
    method: ctx.method,
  });
}
