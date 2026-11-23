import "dotenv/config";
import crypto from "crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Ephemeral signing secret fallback when SESSION_SECRET is not set
const SESSION_SECRET =
  process.env.SESSION_SECRET?.trim() || crypto.randomBytes(32).toString("hex");
const ENV_COMPARE_SALT = crypto.randomBytes(16).toString("hex");
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BASE64_LENGTH = 16 * 1024 * 1024; // ~12MB decoded image

// First-run in-memory claimed passcode (locked once claimed, always overridden by process.env.LANDLORD_PASSCODE)
interface PasscodeHashRecord {
  salt: string;
  hashHex: string;
}
let claimedPasscodeRecord: PasscodeHashRecord | null = null;
const revokedTokenIds = new Map<string, number>();

function getEnvPasscode(): string {
  return (process.env.LANDLORD_PASSCODE || "").trim();
}

function hashPasscodeScrypt(passcode: string, salt: string): string {
  return crypto.scryptSync(passcode, salt, 64).toString("hex");
}

function verifyPasscodeAgainstRecord(
  input: string,
  record: PasscodeHashRecord
): boolean {
  const derived = Buffer.from(hashPasscodeScrypt(input, record.salt), "hex");
  const expected = Buffer.from(record.hashHex, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function verifyPasscodeAgainstEnv(input: string, envPasscode: string): boolean {
  const inputBuf = Buffer.from(
    hashPasscodeScrypt(input, ENV_COMPARE_SALT),
    "hex"
  );
  const envBuf = Buffer.from(
    hashPasscodeScrypt(envPasscode, ENV_COMPARE_SALT),
    "hex"
  );
  if (inputBuf.length !== envBuf.length) return false;
  return crypto.timingSafeEqual(inputBuf, envBuf);
}

function signTokenPayload(payloadB64: string): string {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

function createSessionToken(): { token: string; expiresInSeconds: number } {
  const now = Date.now();
  const payload = {
    role: "landlord",
    iat: now,
    exp: now + SESSION_TTL_MS,
    jti: crypto.randomBytes(12).toString("hex"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const sig = signTokenPayload(payloadB64);
  return {
    token: `${payloadB64}.${sig}`,
    expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
  };
}

function pruneRevokedTokens() {
  const now = Date.now();
  for (const [jti, exp] of revokedTokenIds.entries()) {
    if (exp <= now) revokedTokenIds.delete(jti);
  }
}

function verifySessionToken(
  authHeader: string | undefined
): { valid: boolean; jti?: string; exp?: number } {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false };
  }
  const token = authHeader.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false };

  const [payloadB64, providedSig] = parts;
  const expectedSig = signTokenPayload(payloadB64);
  const providedBuf = Buffer.from(providedSig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return { valid: false };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as { role?: string; exp?: number; jti?: string };
    if (
      parsed.role !== "landlord" ||
      typeof parsed.exp !== "number" ||
      typeof parsed.jti !== "string"
    ) {
      return { valid: false };
    }
    if (parsed.exp <= Date.now()) return { valid: false };
    pruneRevokedTokens();
    if (revokedTokenIds.has(parsed.jti)) return { valid: false };
    return { valid: true, jti: parsed.jti, exp: parsed.exp };
  } catch {
    return { valid: false };
  }
}

// Parse configured CORS allowlist from ALLOWED_ORIGINS and APP_URL
function buildStaticAllowedOrigins(): Set<string> {
  const allowed = new Set<string>([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);
  const rawList = [
    ...(process.env.ALLOWED_ORIGINS || "").split(","),
    process.env.APP_URL || "",
  ];
  for (const item of rawList) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    try {
      const normalized = new URL(trimmed).origin;
      allowed.add(normalized);
    } catch {
      // Ignore malformed origin entries
    }
  }
  return allowed;
}

function isOriginAllowed(origin: string, req: Request): boolean {
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    return false;
  }

  const staticAllowed = buildStaticAllowedOrigins();
  if (staticAllowed.has(normalizedOrigin)) return true;

  // Allow same-origin requests matching X-Forwarded-Host or Host
  const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)
    ?.split(",")[0]
    ?.trim();
  const host = forwardedHost || req.headers.host;
  if (host) {
    if (
      normalizedOrigin === `https://${host}` ||
      normalizedOrigin === `http://${host}`
    ) {
      return true;
    }
  }

  return false;
}

// In-memory sliding-window rate limiter per client IP
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  errorMessage: string;
}) {
  const buckets = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const ip = getClientIp(req);
    const windowStart = now - options.windowMs;

    // Periodic cleanup to keep memory bounded
    if (buckets.size > 500) {
      for (const [key, timestamps] of buckets.entries()) {
        const recent = timestamps.filter((t) => t > windowStart);
        if (recent.length === 0) buckets.delete(key);
        else buckets.set(key, recent);
      }
    }

    const existing = (buckets.get(ip) || []).filter((t) => t > windowStart);
    if (existing.length >= options.maxRequests) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((existing[0] + options.windowMs - now) / 1000)
      );
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: options.errorMessage,
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    existing.push(now);
    buckets.set(ip, existing);
    next();
  };
}

function requireLandlordAuth(req: Request, res: Response, next: NextFunction) {
  const verification = verifySessionToken(req.headers.authorization);
  if (!verification.valid) {
    res.status(401).json({
      error: "請先輸入房東存取密碼解鎖 AI 辨識功能",
      code: "AUTH_REQUIRED",
    });
    return;
  }
  next();
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.set("trust proxy", 1);

  // Strict CORS allowlist (no wildcard on authenticated APIs)
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (isOriginAllowed(origin, req)) {
        res.header("Access-Control-Allow-Origin", origin);
        res.header("Vary", "Origin");
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.header(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization"
        );
      } else {
        if (req.method === "OPTIONS") {
          res.sendStatus(403);
          return;
        }
        res.status(403).json({
          error:
            "此來源網域未在後端允許名單內，請將您的 GitHub Pages 網域加入伺服器 ALLOWED_ORIGINS 環境變數",
          code: "ORIGIN_FORBIDDEN",
        });
        return;
      }
    }

    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: "25mb" }));

  const authRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 10,
    errorMessage: "密碼驗證嘗試過於頻繁，請 15 分鐘後再試",
  });

  const recognizeRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 20,
    errorMessage: "短時間內 AI 辨識次數過多，請稍後再試",
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Check whether landlord passcode is configured and whether current session is unlocked
  app.get("/api/auth/status", (req, res) => {
    const envPasscode = getEnvPasscode();
    const source = envPasscode
      ? "env"
      : claimedPasscodeRecord
        ? "claimed"
        : "unclaimed";
    const session = verifySessionToken(req.headers.authorization);
    res.json({
      configured: source !== "unclaimed",
      source,
      authenticated: session.valid,
    });
  });

  // First-run landlord passcode claim (only active when LANDLORD_PASSCODE env var is unset and unclaimed)
  app.post("/api/auth/setup", authRateLimiter, (req, res) => {
    if (getEnvPasscode() || claimedPasscodeRecord) {
      res.status(409).json({
        error: "房東存取密碼已設定完成，請直接輸入密碼登入",
      });
      return;
    }

    const passcode =
      typeof req.body?.passcode === "string" ? req.body.passcode.trim() : "";
    if (passcode.length < 4 || passcode.length > 64) {
      res.status(400).json({
        error: "請設定 4 至 64 個字元的房東存取密碼",
      });
      return;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    claimedPasscodeRecord = {
      salt,
      hashHex: hashPasscodeScrypt(passcode, salt),
    };

    const { token, expiresInSeconds } = createSessionToken();
    res.json({
      token,
      expiresInSeconds,
      source: "claimed",
    });
  });

  // Verify landlord passcode and issue short-lived Bearer token
  app.post("/api/auth/login", authRateLimiter, (req, res) => {
    const envPasscode = getEnvPasscode();
    if (!envPasscode && !claimedPasscodeRecord) {
      res.status(412).json({
        error: "尚未設定房東存取密碼，請先建立初始存取密碼",
        code: "SETUP_REQUIRED",
      });
      return;
    }

    const passcode =
      typeof req.body?.passcode === "string" ? req.body.passcode.trim() : "";
    if (!passcode || passcode.length > 64) {
      res.status(400).json({ error: "請輸入有效的房東存取密碼" });
      return;
    }

    // Environment variable passcode always overrides any claimed fallback hash
    const isValid = envPasscode
      ? verifyPasscodeAgainstEnv(passcode, envPasscode)
      : claimedPasscodeRecord
        ? verifyPasscodeAgainstRecord(passcode, claimedPasscodeRecord)
        : false;

    if (!isValid) {
      res.status(401).json({ error: "存取密碼錯誤，請重新輸入" });
      return;
    }

    const { token, expiresInSeconds } = createSessionToken();
    res.json({
      token,
      expiresInSeconds,
    });
  });

  // Revoke active Bearer token
  app.post("/api/auth/logout", (req, res) => {
    const session = verifySessionToken(req.headers.authorization);
    if (session.valid && session.jti && session.exp) {
      revokedTokenIds.set(session.jti, session.exp);
    }
    res.json({ ok: true });
  });

  // Protected AI meter recognition endpoint
  app.post(
    "/api/recognize-meter",
    requireLandlordAuth,
    recognizeRateLimiter,
    async (req, res) => {
      try {
        const {
          imageBase64,
          mimeType = "image/jpeg",
          room = "",
        } = req.body || {};

        if (!imageBase64 || typeof imageBase64 !== "string") {
          res.status(400).json({ error: "未提供有效的電錶相片資料" });
          return;
        }

        if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
          res.status(413).json({ error: "電錶相片檔案過大，請重新拍攝或壓縮" });
          return;
        }

        const safeMimeType =
          typeof mimeType === "string" && ALLOWED_MIME_TYPES.has(mimeType)
            ? mimeType
            : "image/jpeg";

        const safeRoom =
          typeof room === "string"
            ? room.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 12)
            : "";

        const cleanBase64 = imageBase64.includes(",")
          ? imageBase64.split(",")[1]
          : imageBase64;

        const promptText = `你是一位專業的台灣出租套房電錶判讀專家（熟悉大同、中興、東元、玖鼎等單相瓦時計、機械滾輪式電錶、液晶數位式電錶與指針式電錶）。
請仔細檢視這張${safeRoom ? ` ${safeRoom} 號房` : ""}電錶照片，並準確判讀目前顯示的累積用電度數（kWh / 千瓦時）。

判讀規則：
1. 僅回傳電錶上的「整數」有效度數（reading）。
2. 台灣常見的機械滾輪式電錶通常由左至右有 4 位或 5 位黑底白字的「整數位」，以及最右側 1 位紅框、紅字、或標有小數點（0.1 度）的「小數位」。請務必忽略最右側的小數位與前導零（例如：滾輪顯示 0 5 6 7 8 紅框 2，即 5678.2 度，reading 請回傳整數 5678）。
3. 若為液晶數位式電錶，請讀取主畫面標示 kWh 的累積總度數，若有小數點（如 12345.6 kWh），請只取小數點前的整數 12345；請勿誤讀為電壓（110V/220V）、電流（A）或電錶出廠編號。
4. 若相片中完全沒有電錶或模糊到無法辨識任何度數，請將 isReadable 設為 false，reading 設為 0。
5. meterType 請填寫「機械滾輪式電錶」、「液晶數位式電錶」或「指針式電錶」；notes 請用繁體中文簡短說明判讀依據。`;

        const response = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite",
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: safeMimeType,
                  data: cleanBase64,
                },
              },
              {
                text: promptText,
              },
            ],
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                isReadable: { type: Type.BOOLEAN },
                reading: { type: Type.INTEGER },
                rawDisplay: { type: Type.STRING },
                meterType: { type: Type.STRING },
                notes: { type: Type.STRING },
              },
              required: [
                "isReadable",
                "reading",
                "rawDisplay",
                "meterType",
                "notes",
              ],
            },
          },
        });

        const text = (response.text ?? "{}").trim();
        const parsed = JSON.parse(text);

        res.json({
          isReadable: Boolean(parsed.isReadable),
          reading:
            typeof parsed.reading === "number"
              ? Math.floor(parsed.reading)
              : parseInt(String(parsed.reading), 10) || 0,
          rawDisplay: parsed.rawDisplay || String(parsed.reading || ""),
          meterType: parsed.meterType || "電錶",
          notes: parsed.notes || "",
        });
      } catch (error: unknown) {
        console.error("Error recognizing meter reading:", error);
        const errMessage =
          error instanceof Error ? error.message : "AI 辨識發生錯誤";
        res.status(500).json({
          error: errMessage,
        });
      }
    }
  );

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*all", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
