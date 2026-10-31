import "dotenv/config";
import express from "express";
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

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: "25mb" }));

  app.post("/api/recognize-meter", async (req, res) => {
    try {
      const { imageBase64, mimeType = "image/jpeg", room = "" } = req.body || {};

      if (!imageBase64 || typeof imageBase64 !== "string") {
        res.status(400).json({ error: "未提供有效的電錶相片資料" });
        return;
      }

      const cleanBase64 = imageBase64.includes(",")
        ? imageBase64.split(",")[1]
        : imageBase64;

      const systemInstruction = `你是一位專業的台灣出租套房電錶判讀專家（熟悉大同、中興、東元、玖鼎等單相瓦時計、機械滾輪式電錶、液晶數位式電錶與指針式電錶）。
請仔細檢視使用者上傳的電錶照片，並準確判讀目前顯示的累積用電度數（kWh / 千瓦時）。

判讀規則：
1. 僅回傳電錶上的「整數」有效度數（reading）。
2. 台灣常見的機械滾輪式電錶通常由左至右有 4 位或 5 位黑底白字的「整數位」，以及最右側 1 位紅框、紅字、或標有小數點（0.1 度）的「小數位」。請務必忽略最右側的小數位與前導零（例如：滾輪顯示 0 5 6 7 8 紅框 2，即 5678.2 度，reading 請回傳整數 5678）。
3. 若為液晶數位式電錶，請讀取主畫面標示 kWh 的累積總度數，若有小數點（如 12345.6 kWh），請只取小數點前的整數 12345；請勿誤讀為電壓（如 110V/220V）、電流（A）或電錶出廠編號（No. / 6~8位印刷條碼號）。
4. 若某個滾輪數字剛好卡在兩個數字中間（例如 7 與 8 之間），請觀察下一位數是否已跨過 0：若下一位為 8 或 9（尚未過 0），該位仍讀較小的數字；若已過 0 則讀較大的數字。
5. 若相片中完全沒有電錶或模糊到無法辨識任何度數，請將 isReadable 設為 false，reading 設為 0。`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: cleanBase64,
              },
            },
            {
              text: `請辨識這張${room ? ` ${room} 號房` : ""}電錶相片的目前整數度數（kWh），並回傳 JSON 結果。`,
            },
          ],
        },
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isReadable: {
                type: Type.BOOLEAN,
                description: "是否成功從照片中辨識出電錶度數",
              },
              reading: {
                type: Type.INTEGER,
                description: "電錶上的整數有效度數（已排除小數點後或紅框小數位）",
              },
              rawDisplay: {
                type: Type.STRING,
                description: "電錶視窗上顯示的完整數字字串（含前導零與小數位，例如 '05678.2'）",
              },
              meterType: {
                type: Type.STRING,
                description: "電錶類型，例如：機械滾輪式電錶、液晶數位式電錶、指針式電錶",
              },
              notes: {
                type: Type.STRING,
                description: "簡短說明判讀依據（例如：讀取整數窗格 5678，已忽略最右側紅框小數位 2）",
              },
            },
            required: ["isReadable", "reading", "rawDisplay", "meterType", "notes"],
          },
        },
      });

      const text = (response.text ?? "{}").trim();
      const parsed = JSON.parse(text);

      res.json({
        isReadable: Boolean(parsed.isReadable),
        reading: typeof parsed.reading === "number" ? Math.floor(parsed.reading) : parseInt(String(parsed.reading), 10) || 0,
        rawDisplay: parsed.rawDisplay || String(parsed.reading || ""),
        meterType: parsed.meterType || "電錶",
        notes: parsed.notes || "",
      });
    } catch (error: unknown) {
      console.error("Error recognizing meter reading:", error);
      const errMessage = error instanceof Error ? error.message : "AI 辨識發生錯誤";
      res.status(500).json({
        error: errMessage,
      });
    }
  });

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
