import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Camera,
  Image as ImageIcon,
  Zap,
  Calendar,
  Users,
  Save,
  Copy,
  Share2,
  Trash2,
  Eye,
  Download,
  BarChart3,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  X,
  Plus,
  Minus,
  Sparkles,
  FileText,
} from "lucide-react";

const ROOM_KEYS = ["102", "201", "202", "301", "302"] as const;
type RoomKey = (typeof ROOM_KEYS)[number];
type TabKey = RoomKey | "summary";

const DB_KEY_PREFIX = "suite_meter_v2026_";

const DEFAULT_ROOM_RENTS: Record<RoomKey, number> = {
  "102": 6500,
  "201": 8000,
  "202": 6000,
  "301": 8500,
  "302": 6500,
};

interface HistoryRecord {
  id: number;
  rentStart: string;
  rentEnd: string;
  meterDate: string;
  occupants: number;
  waterPay: number;
  prevDegree: number;
  currDegree: number;
  usedDegrees: number;
  rate: number;
  elecPay: number;
  currPhoto: string | null;
  prevPhoto: string | null;
}

interface RoomState {
  history: HistoryRecord[];
  rentStart: string;
  rentEnd: string;
  occupants: number;
  prevDegreeInput: string;
  currDegreeInput: string;
  rawCurrPhoto: string | null;
  watermarkedCurrPhoto: string | null;
  rawPrevPhoto: string | null;
  watermarkedPrevPhoto: string | null;
  aiStatus: {
    loading: boolean;
    target: "curr" | "prev" | null;
    meterType?: string;
    rawDisplay?: string;
    notes?: string;
    reading?: number;
    error?: string;
  };
  cachedBillMessage: string | null;
}

function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getLocalTodayStr(): string {
  return formatLocalDate(new Date());
}

function calcOneMonthEndDate(startDateStr: string): string {
  if (!startDateStr) return getLocalTodayStr();
  const [y, m, d] = startDateStr.split("-").map(Number);
  const daysInNextMonth = new Date(y, m + 1, 0).getDate();
  const targetDay = Math.min(d, daysInNextMonth);
  const endDate = new Date(y, m, targetDay);
  endDate.setDate(endDate.getDate() - 1);
  return formatLocalDate(endDate);
}

function calcNextDayStr(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const nextD = new Date(y, m - 1, d);
  nextD.setDate(nextD.getDate() + 1);
  return formatLocalDate(nextD);
}

function getPreviousMonthDate(dateString: string): string {
  const [y, m, d] = dateString.split("-").map(Number);
  const daysInPrevMonth = new Date(y, m - 1, 0).getDate();
  const prevD = new Date(y, m - 2, Math.min(d, daysInPrevMonth));
  return formatLocalDate(prevD);
}

function formatNumber(num: number): string {
  return Math.round(Number(num) || 0).toLocaleString("zh-TW");
}

function applyWatermarkToDataUrl(
  rawDataUrl: string,
  dateVal: string,
  quality = 0.82
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width;
      const h = img.height;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);

      const dateStr =
        "抄表日期：" + (dateVal || getLocalTodayStr()).replace(/-/g, "/");
      const fontSize = Math.max(20, Math.floor(h * 0.038));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const padding = Math.floor(fontSize * 0.5);
      const textWidth = ctx.measureText(dateStr).width;
      const bgX = w - textWidth - padding * 2 - 16;
      const bgY = h - fontSize - padding * 2 - 16;

      ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(
          bgX,
          bgY,
          textWidth + padding * 2,
          fontSize + padding * 2,
          8
        );
        ctx.fill();
      } else {
        ctx.fillRect(
          bgX,
          bgY,
          textWidth + padding * 2,
          fontSize + padding * 2
        );
      }

      ctx.fillStyle = "#FACC15";
      ctx.textBaseline = "top";
      ctx.fillText(dateStr, bgX + padding, bgY + padding + fontSize * 0.08);

      resolve(canvas.toDataURL("image/jpeg", quality).split(",")[1]);
    };
    img.onerror = reject;
    img.src = rawDataUrl;
  });
}

function compressAndWatermarkImage(
  file: File,
  dateVal: string,
  maxDimension = 1200,
  quality = 0.82
): Promise<{ rawDataUrl: string; watermarkedBase64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        let w = img.width;
        let h = img.height;
        if (w > maxDimension || h > maxDimension) {
          if (w > h) {
            h = Math.round((h * maxDimension) / w);
            w = maxDimension;
          } else {
            w = Math.round((w * maxDimension) / h);
            h = maxDimension;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas context unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);

        const rawDataUrl = canvas.toDataURL("image/jpeg", quality);
        const watermarkedBase64 = await applyWatermarkToDataUrl(
          rawDataUrl,
          dateVal,
          quality
        );
        resolve({ rawDataUrl, watermarkedBase64 });
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 產生逼真的台灣單相滾輪式電錶測試照片，方便一鍵測試 AI 辨識
function createSampleMeterFile(readingInteger: number, decimalDigit: number): Promise<File> {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d")!;

    // 背景金屬外殼
    ctx.fillStyle = "#e2e8f0";
    ctx.fillRect(0, 0, 800, 600);

    // 圓形錶盤外框
    ctx.beginPath();
    ctx.arc(400, 300, 260, 0, Math.PI * 2);
    ctx.fillStyle = "#f8fafc";
    ctx.fill();
    ctx.lineWidth = 14;
    ctx.strokeStyle = "#334155";
    ctx.stroke();

    // 銘牌標示
    ctx.fillStyle = "#1e293b";
    ctx.font = "bold 26px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("單相二線式瓦時計 (kWh)", 400, 145);
    ctx.font = "600 18px monospace";
    ctx.fillStyle = "#475569";
    ctx.fillText("110/220V  30(100)A  60Hz  Kh=3.6", 400, 180);

    // 滾輪視窗底框
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.roundRect(175, 225, 450, 95, 10);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#94a3b8";
    ctx.stroke();

    // 5 位整數 + 1 位小數 (紅框)
    const intStr = String(readingInteger).padStart(5, "0");
    const digits = [...intStr.split(""), String(decimalDigit)];

    digits.forEach((digit, idx) => {
      const isDecimal = idx === 5;
      const boxX = 192 + idx * 70;
      const boxY = 238;
      const boxW = 58;
      const boxH = 68;

      ctx.fillStyle = isDecimal ? "#b91c1c" : "#1e293b";
      ctx.fillRect(boxX, boxY, boxW, boxH);

      ctx.lineWidth = isDecimal ? 4 : 2;
      ctx.strokeStyle = isDecimal ? "#ef4444" : "#64748b";
      ctx.strokeRect(boxX, boxY, boxW, boxH);

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 46px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(digit, boxX + boxW / 2, boxY + boxH / 2 + 2);
    });

    // 小數點標記與單位
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(192 + 5 * 70 - 6, 300, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 22px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("千瓦時 (kWh) · 最右紅框為 0.1 度", 400, 355);

    // 轉盤示意
    ctx.fillStyle = "#cbd5e1";
    ctx.fillRect(240, 395, 320, 22);
    ctx.fillStyle = "#dc2626";
    ctx.fillRect(380, 395, 45, 22);
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 2;
    ctx.strokeRect(240, 395, 320, 22);

    ctx.fillStyle = "#64748b";
    ctx.font = "16px monospace";
    ctx.fillText("NO. 88492016   TAIWAN METER CO.", 400, 465);

    canvas.toBlob(
      (blob) => {
        const file = new File([blob!], "sample_meter.jpg", {
          type: "image/jpeg",
        });
        resolve(file);
      },
      "image/jpeg",
      0.9
    );
  });
}

function base64ToFile(base64Data: string, filename = "meter.jpg"): File {
  const byteChars = atob(base64Data);
  const byteNums = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNums[i] = byteChars.charCodeAt(i);
  }
  return new File([new Uint8Array(byteNums)], filename, {
    type: "image/jpeg",
  });
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("102");
  const [globalEndDate, setGlobalEndDate] = useState<string>(() =>
    getLocalTodayStr()
  );

  const [rooms, setRooms] = useState<Record<RoomKey, RoomState>>(() => {
    const todayStr = getLocalTodayStr();
    const initial = {} as Record<RoomKey, RoomState>;

    ROOM_KEYS.forEach((room) => {
      let savedHistory: HistoryRecord[] = [];
      try {
        const raw = localStorage.getItem(`${DB_KEY_PREFIX}${room}`);
        if (raw) savedHistory = JSON.parse(raw) || [];
      } catch {
        savedHistory = [];
      }

      const savedOcc =
        parseInt(localStorage.getItem(`${DB_KEY_PREFIX}${room}_occ`) || "1", 10) ||
        1;

      let rStart = getPreviousMonthDate(todayStr);
      let rEnd = todayStr;

      if (savedHistory.length > 0 && savedHistory[0].rentEnd) {
        rStart = calcNextDayStr(savedHistory[0].rentEnd);
        rEnd = calcOneMonthEndDate(rStart);
      }

      const defaultPrev =
        savedHistory.length > 0 ? String(savedHistory[0].currDegree) : "";

      initial[room] = {
        history: savedHistory,
        rentStart: rStart,
        rentEnd: rEnd,
        occupants: savedOcc,
        prevDegreeInput: defaultPrev,
        currDegreeInput: "",
        rawCurrPhoto: null,
        watermarkedCurrPhoto: null,
        rawPrevPhoto: null,
        watermarkedPrevPhoto: null,
        aiStatus: {
          loading: false,
          target: null,
        },
        cachedBillMessage: null,
      };
    });

    return initial;
  });

  // Modals & Toast states
  const [mediaModal, setMediaModal] = useState<{
    open: boolean;
    room: RoomKey;
    targetField: "curr" | "prev";
  } | null>(null);

  const [photoViewer, setPhotoViewer] = useState<{
    room: RoomKey;
    title: string;
    subtitle: string;
    base64: string;
    degreesText: string;
  } | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{
    title: string;
    desc: string;
    onConfirm: () => void;
  } | null>(null);

  const [toast, setToast] = useState<{
    message: string;
    type: "info" | "success" | "warn";
  } | null>(null);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const pendingCaptureRef = useRef<{
    room: RoomKey;
    targetField: "curr" | "prev";
  }>({ room: "102", targetField: "curr" });

  const showToast = useCallback(
    (message: string, type: "info" | "success" | "warn" = "info") => {
      setToast({ message, type });
    },
    []
  );

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  // Calculate Room 202 rate based on globalEndDate month (June-Sept: 5.5, else 5.0)
  const get202Rate = useCallback(
    (dateVal = globalEndDate): number => {
      if (!dateVal) return 5.0;
      const month = parseInt(dateVal.split("-")[1], 10);
      return [6, 7, 8, 9].includes(month) ? 5.5 : 5.0;
    },
    [globalEndDate]
  );

  const getRoomRate = useCallback(
    (room: RoomKey, dateVal = globalEndDate): number => {
      return room === "202" ? get202Rate(dateVal) : 5.5;
    },
    [get202Rate, globalEndDate]
  );

  // Update watermarks on any unsaved photos when globalEndDate changes
  const handleGlobalDateChange = async (newDate: string) => {
    setGlobalEndDate(newDate);

    const updated = { ...rooms };
    for (const room of ROOM_KEYS) {
      const rState = { ...updated[room], cachedBillMessage: null };
      if (rState.rawCurrPhoto) {
        rState.watermarkedCurrPhoto = await applyWatermarkToDataUrl(
          rState.rawCurrPhoto,
          newDate
        );
      }
      if (rState.rawPrevPhoto) {
        rState.watermarkedPrevPhoto = await applyWatermarkToDataUrl(
          rState.rawPrevPhoto,
          newDate
        );
      }
      updated[room] = rState;
    }
    setRooms(updated);
  };

  const persistHistoryWithQuotaGuard = (
    targetRoom: RoomKey,
    newHistory: HistoryRecord[],
    allRoomsSnapshot: Record<RoomKey, RoomState>
  ) => {
    try {
      localStorage.setItem(
        `${DB_KEY_PREFIX}${targetRoom}`,
        JSON.stringify(newHistory)
      );
    } catch (e: unknown) {
      const err = e as { name?: string; code?: number };
      if (err?.name === "QuotaExceededError" || err?.code === 22) {
        ROOM_KEYS.forEach((r) => {
          const hist =
            r === targetRoom ? newHistory : allRoomsSnapshot[r].history;
          const trimmed = hist.map((item, idx) =>
            idx >= 2 ? { ...item, currPhoto: null, prevPhoto: null } : item
          );
          try {
            localStorage.setItem(
              `${DB_KEY_PREFIX}${r}`,
              JSON.stringify(trimmed)
            );
          } catch {
            // ignore
          }
        });
        showToast(
          "瀏覽器儲存空間已滿，已自動清理舊相片並保留所有帳務紀錄",
          "warn"
        );
      }
    }
  };

  const calculateRoomMetrics = (room: RoomKey, rState = rooms[room]) => {
    const prevInput = parseInt(rState.prevDegreeInput, 10);
    const currInput = parseInt(rState.currDegreeInput, 10);
    const prev = isNaN(prevInput) ? 0 : prevInput;
    const curr = isNaN(currInput) ? 0 : currInput;

    const hasAnomaly =
      rState.currDegreeInput !== "" && !isNaN(currInput) && curr < prev;
    const used = curr >= prev ? curr - prev : 0;
    const rate = getRoomRate(room);
    const elecPay = Math.floor(used * rate);
    const occupants = Math.max(1, rState.occupants || 1);
    const waterPay = occupants * 100;
    const rent = DEFAULT_ROOM_RENTS[room];
    const totalPay = rent + waterPay + elecPay;

    return {
      prev,
      curr,
      used,
      rate,
      elecPay,
      occupants,
      waterPay,
      rent,
      totalPay,
      hasAnomaly,
    };
  };

  const generateBillText = (
    room: RoomKey,
    customParams?: {
      rentStart: string;
      rentEnd: string;
      meterDate: string;
      metrics: ReturnType<typeof calculateRoomMetrics>;
    }
  ): string => {
    const rState = rooms[room];
    if (rState.cachedBillMessage && !customParams) {
      return rState.cachedBillMessage;
    }

    const metrics = customParams?.metrics || calculateRoomMetrics(room, rState);
    const rStart = customParams?.rentStart || rState.rentStart;
    const rEnd = customParams?.rentEnd || rState.rentEnd;
    const meterDate = customParams?.meterDate || globalEndDate;

    return `⚡ ${room} 房本月房租水電費明細
---------------------------
【租賃期間】${rStart} ~ ${rEnd}
【抄表日期】${meterDate}
【入住人數】${metrics.occupants} 人
【前期度數】${metrics.prev} 度 (舊)
【本期度數】${metrics.curr} 度 (新)
【實用度數】${metrics.used} 度
【計費費率】${metrics.rate.toFixed(1)} 元 / 度
---------------------------
🏠【房屋租金】NT$ ${formatNumber(metrics.rent)}
💧【自來水費】NT$ ${formatNumber(metrics.waterPay)} (${metrics.occupants}人 × $100)
⚡【本期電費】NT$ ${formatNumber(metrics.elecPay)}
---------------------------
💰【應繳總額】NT$ ${formatNumber(metrics.totalPay)}
---------------------------
*(請核對明細無誤後繳納，謝謝您！)*`;
  };

  const processSelectedFile = async (
    file: File,
    room: RoomKey,
    targetField: "curr" | "prev"
  ) => {
    const isPrev = targetField === "prev";
    showToast("正在壓印日期浮水印並進行智慧判讀電錶度數...", "info");

    setRooms((prev) => ({
      ...prev,
      [room]: {
        ...prev[room],
        aiStatus: {
          loading: true,
          target: targetField,
        },
      },
    }));

    try {
      const { rawDataUrl, watermarkedBase64 } = await compressAndWatermarkImage(
        file,
        globalEndDate,
        1200,
        0.82
      );

      // 先儲存浮水印相片至畫面預覽
      setRooms((prev) => ({
        ...prev,
        [room]: {
          ...prev[room],
          rawCurrPhoto: isPrev ? prev[room].rawCurrPhoto : rawDataUrl,
          watermarkedCurrPhoto: isPrev
            ? prev[room].watermarkedCurrPhoto
            : watermarkedBase64,
          rawPrevPhoto: isPrev ? rawDataUrl : prev[room].rawPrevPhoto,
          watermarkedPrevPhoto: isPrev
            ? watermarkedBase64
            : prev[room].watermarkedPrevPhoto,
          cachedBillMessage: null,
        },
      }));

      // 傳送原始清晰相片給後端進行電錶度數判讀（支援本機/Cloud Run 與 GitHub Pages 跨網域自動切換）
      const rawBase64 = rawDataUrl.split(",")[1];
      const requestBody = JSON.stringify({
        imageBase64: rawBase64,
        mimeType: "image/jpeg",
        room,
      });

      const isGitHubPages =
        typeof window !== "undefined" &&
        window.location.hostname.endsWith("github.io");
      const cloudRunApiUrl =
        "https://ais-pre-6fr6e6nrj5qe2bjyx6a5oi-654172174697.asia-east1.run.app/api/recognize-meter";

      let response: Response;
      if (isGitHubPages) {
        response = await fetch(cloudRunApiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        });
      } else {
        response = await fetch("/api/recognize-meter", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        });
        if (response.status === 404 || response.status === 405) {
          response = await fetch(cloudRunApiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
          });
        }
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `API 失敗 (${response.status})`);
      }

      if (data.isReadable && typeof data.reading === "number") {
        setRooms((prev) => ({
          ...prev,
          [room]: {
            ...prev[room],
            prevDegreeInput: isPrev
              ? String(data.reading)
              : prev[room].prevDegreeInput,
            currDegreeInput: isPrev
              ? prev[room].currDegreeInput
              : String(data.reading),
            cachedBillMessage: null,
            aiStatus: {
              loading: false,
              target: targetField,
              reading: data.reading,
              meterType: data.meterType,
              rawDisplay: data.rawDisplay,
              notes: data.notes,
            },
          },
        }));
        showToast(
          `AI 辨識成功：${isPrev ? "前期" : "本期"}電錶為 ${data.reading} 度`,
          "success"
        );
      } else {
        setRooms((prev) => ({
          ...prev,
          [room]: {
            ...prev[room],
            aiStatus: {
              loading: false,
              target: targetField,
              notes: data.notes || "相片中未能辨識出清晰的電錶數字，請手動確認",
              error: "請手動確認度數",
            },
          },
        }));
        showToast("相片未能辨識出清晰數字，請手動輸入度數", "warn");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "辨識過程發生異常";
      setRooms((prev) => ({
        ...prev,
        [room]: {
          ...prev[room],
          aiStatus: {
            loading: false,
            target: targetField,
            error: msg,
          },
        },
      }));
      showToast(`AI 辨識失敗：${msg}，請手動輸入度數`, "warn");
    }
  };

  const handleFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const { room, targetField } = pendingCaptureRef.current;
    await processSelectedFile(file, room, targetField);
    e.target.value = "";
  };

  const triggerMediaChoice = (room: RoomKey, targetField: "curr" | "prev") => {
    pendingCaptureRef.current = { room, targetField };
    setMediaModal({ open: true, room, targetField });
  };

  const handleSampleMeterTest = async (
    room: RoomKey,
    targetField: "curr" | "prev"
  ) => {
    setMediaModal(null);
    const rState = rooms[room];
    const basePrev = parseInt(rState.prevDegreeInput, 10) || 4680;
    const simulatedReading =
      targetField === "prev"
        ? basePrev
        : basePrev + Math.floor(110 + Math.random() * 140);
    const sampleFile = await createSampleMeterFile(simulatedReading, 6);
    await processSelectedFile(sampleFile, room, targetField);
  };

  const handleSaveRoomRecord = (room: RoomKey) => {
    const rState = rooms[room];
    const metrics = calculateRoomMetrics(room, rState);

    if (metrics.curr === 0 && metrics.prev === 0) {
      showToast("請先填寫或透過 AI 拍照辨識電錶度數！", "warn");
      return;
    }

    const lockedBill = generateBillText(room, {
      rentStart: rState.rentStart,
      rentEnd: rState.rentEnd,
      meterDate: globalEndDate,
      metrics,
    });

    const newRecord: HistoryRecord = {
      id: Date.now(),
      rentStart: rState.rentStart,
      rentEnd: rState.rentEnd,
      meterDate: globalEndDate,
      occupants: metrics.occupants,
      waterPay: metrics.waterPay,
      prevDegree: metrics.prev,
      currDegree: metrics.curr,
      usedDegrees: metrics.used,
      rate: metrics.rate,
      elecPay: metrics.elecPay,
      currPhoto: rState.watermarkedCurrPhoto || null,
      prevPhoto: rState.watermarkedPrevPhoto || null,
    };

    const nextHistory = [newRecord, ...rState.history];
    const nextRentStart = rState.rentEnd
      ? calcNextDayStr(rState.rentEnd)
      : rState.rentStart;
    const nextRentEnd = rState.rentEnd
      ? calcOneMonthEndDate(nextRentStart)
      : rState.rentEnd;

    setRooms((prev) => {
      const updatedRoom: RoomState = {
        ...prev[room],
        history: nextHistory,
        rentStart: nextRentStart,
        rentEnd: nextRentEnd,
        prevDegreeInput: String(metrics.curr),
        rawCurrPhoto: null,
        watermarkedCurrPhoto: null,
        cachedBillMessage: lockedBill,
      };
      const nextAll = { ...prev, [room]: updatedRoom };
      persistHistoryWithQuotaGuard(room, nextHistory, nextAll);
      return nextAll;
    });

    showToast("本期紀錄與相片已儲存！現在可直接點選傳送 LINE", "success");
  };

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      document.body.removeChild(textarea);
      return true;
    } catch {
      document.body.removeChild(textarea);
      return false;
    }
  };

  const downloadBase64Photo = (base64Data: string, filename: string) => {
    const a = document.createElement("a");
    a.href = `data:image/jpeg;base64,${base64Data}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const triggerExternalLink = (url: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleSendToLine = async (room: RoomKey) => {
    const rState = rooms[room];
    const msg = generateBillText(room);
    await copyToClipboard(msg);

    const photoBase64 =
      rState.watermarkedCurrPhoto || rState.history[0]?.currPhoto || null;

    if (photoBase64) {
      try {
        const photoFile = base64ToFile(
          photoBase64,
          `${room}房電錶照片_${globalEndDate || "最新"}.jpg`
        );
        if (navigator.canShare && navigator.canShare({ files: [photoFile] })) {
          showToast("帳單已複製，請於系統分享選單傳送相片與明細", "success");
          await navigator.share({
            title: `${room} 房電費明細`,
            text: msg,
            files: [photoFile],
          });
          return;
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === "AbortError") return;
      }

      downloadBase64Photo(photoBase64, `${room}房電錶照片_${globalEndDate}.jpg`);
      showToast("已自動下載浮水印電錶相片並複製帳單，正前往 LINE 分享", "success");
      setTimeout(() => {
        triggerExternalLink(
          `https://line.me/R/share?text=${encodeURIComponent(msg)}`
        );
      }, 450);
    } else {
      triggerExternalLink(
        `https://line.me/R/share?text=${encodeURIComponent(msg)}`
      );
      showToast("已複製明細並開啟 LINE 傳送", "success");
    }
  };

  // Native Canvas generator for Summary Chart (reliable, sharp, zero external dependencies)
  const buildSummaryChartCanvas = (): HTMLCanvasElement => {
    const canvas = document.createElement("canvas");
    const width = 920;
    const rowHeight = 64;
    const headerHeight = 96;
    const tableHeadHeight = 52;
    const footerHeight = 72;
    const padding = 32;
    const height =
      padding * 2 +
      headerHeight +
      tableHeadHeight +
      ROOM_KEYS.length * rowHeight +
      footerHeight;

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, width, height);

    // Card container
    const cardX = padding;
    const cardY = padding;
    const cardW = width - padding * 2;
    const cardH = height - padding * 2;

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 20);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#e2e8f0";
    ctx.stroke();

    // Top dark header
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, headerHeight, [20, 20, 0, 0]);
    ctx.fill();

    const currentYear = globalEndDate
      ? globalEndDate.split("-")[0]
      : String(new Date().getFullYear());

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `📊 ${currentYear} 年 套房租金水電金額總覽`,
      cardX + 28,
      cardY + headerHeight / 2
    );

    ctx.fillStyle = "#94a3b8";
    ctx.font = "600 16px monospace";
    ctx.textAlign = "right";
    ctx.fillText(
      `抄表基準日：${globalEndDate}`,
      cardX + cardW - 28,
      cardY + headerHeight / 2
    );

    // Table Header
    const thY = cardY + headerHeight;
    ctx.fillStyle = "#f1f5f9";
    ctx.fillRect(cardX + 1, thY, cardW - 2, tableHeadHeight);

    const cols = [
      { label: "房號", x: cardX + 60, align: "center" as const },
      { label: "租賃期間", x: cardX + 220, align: "center" as const },
      { label: "人數", x: cardX + 370, align: "center" as const },
      { label: "房屋租金", x: cardX + 500, align: "right" as const },
      { label: "本期電費", x: cardX + 630, align: "right" as const },
      { label: "自來水費", x: cardX + 740, align: "right" as const },
      { label: "應繳總額", x: cardX + cardW - 28, align: "right" as const },
    ];

    ctx.fillStyle = "#475569";
    ctx.font = "bold 17px sans-serif";
    cols.forEach((c) => {
      ctx.textAlign = c.align;
      ctx.fillText(c.label, c.x, thY + tableHeadHeight / 2);
    });

    let grandRent = 0;
    let grandElec = 0;
    let grandWater = 0;
    let grandTotal = 0;

    ROOM_KEYS.forEach((room, idx) => {
      const rowY = thY + tableHeadHeight + idx * rowHeight;
      const rState = rooms[room];
      const latest = rState.history[0];
      const rentBase = DEFAULT_ROOM_RENTS[room];
      const occ = latest ? latest.occupants || 1 : rState.occupants || 1;
      const waterFee = latest
        ? latest.waterPay !== undefined
          ? Number(latest.waterPay)
          : occ * 100
        : occ * 100;
      const elecPay = latest ? Number(latest.elecPay) || 0 : 0;
      const totalPay = rentBase + waterFee + elecPay;

      grandRent += rentBase;
      grandElec += elecPay;
      grandWater += waterFee;
      grandTotal += totalPay;

      if (idx % 2 === 1) {
        ctx.fillStyle = "#f8fafc";
        ctx.fillRect(cardX + 1, rowY, cardW - 2, rowHeight);
      }

      ctx.strokeStyle = "#f1f5f9";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cardX, rowY + rowHeight);
      ctx.lineTo(cardX + cardW, rowY + rowHeight);
      ctx.stroke();

      const cy = rowY + rowHeight / 2;

      // Room
      ctx.fillStyle = "#0f172a";
      ctx.font = "bold 20px monospace";
      ctx.textAlign = "center";
      ctx.fillText(room, cols[0].x, cy);

      // Period
      const periodStr = latest
        ? `${latest.rentStart.substring(5).replace("-", "/")}~${latest.rentEnd.substring(5).replace("-", "/")}`
        : "尚無紀錄";
      ctx.fillStyle = latest ? "#334155" : "#94a3b8";
      ctx.font = "600 16px monospace";
      ctx.fillText(periodStr, cols[1].x, cy);

      // Occupants
      ctx.fillStyle = "#334155";
      ctx.font = "600 17px sans-serif";
      ctx.fillText(`${occ}人`, cols[2].x, cy);

      // Rent
      ctx.fillStyle = "#475569";
      ctx.font = "600 18px monospace";
      ctx.textAlign = "right";
      ctx.fillText(`$${formatNumber(rentBase)}`, cols[3].x, cy);

      // Elec
      ctx.fillStyle = latest ? "#2563eb" : "#cbd5e1";
      ctx.font = "bold 18px monospace";
      ctx.fillText(latest ? `$${formatNumber(elecPay)}` : "-", cols[4].x, cy);

      // Water
      ctx.fillStyle = "#0891b2";
      ctx.font = "bold 18px monospace";
      ctx.fillText(`$${formatNumber(waterFee)}`, cols[5].x, cy);

      // Total
      ctx.fillStyle = "#059669";
      ctx.font = "bold 20px monospace";
      ctx.fillText(`$${formatNumber(totalPay)}`, cols[6].x, cy);
    });

    // Footer row
    const footY = thY + tableHeadHeight + ROOM_KEYS.length * rowHeight;
    ctx.fillStyle = "#ecfdf5";
    ctx.beginPath();
    ctx.roundRect(cardX + 1, footY, cardW - 2, footerHeight - 1, [0, 0, 20, 20]);
    ctx.fill();

    const fcy = footY + footerHeight / 2;
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("合計總收", cols[1].x, fcy);

    ctx.textAlign = "right";
    ctx.font = "bold 19px monospace";
    ctx.fillStyle = "#334155";
    ctx.fillText(`$${formatNumber(grandRent)}`, cols[3].x, fcy);

    ctx.fillStyle = "#1d4ed8";
    ctx.fillText(`$${formatNumber(grandElec)}`, cols[4].x, fcy);

    ctx.fillStyle = "#0e7490";
    ctx.fillText(`$${formatNumber(grandWater)}`, cols[5].x, fcy);

    ctx.fillStyle = "#047857";
    ctx.font = "bold 24px monospace";
    ctx.fillText(`$${formatNumber(grandTotal)}`, cols[6].x, fcy);

    return canvas;
  };

  const generateSummaryText = (): string => {
    const currentYear = globalEndDate
      ? globalEndDate.split("-")[0]
      : String(new Date().getFullYear());
    let msg = `📊 ${currentYear} 年 最新租金水電總覽\n---------------------------\n`;
    let grandElec = 0;
    let grandWater = 0;
    let grandTotal = 0;

    ROOM_KEYS.forEach((room) => {
      const rState = rooms[room];
      const latest = rState.history[0];
      const rentBase = DEFAULT_ROOM_RENTS[room];
      const currentOcc = rState.occupants || 1;

      if (latest) {
        const occ = latest.occupants || currentOcc;
        const waterFee =
          latest.waterPay !== undefined ? Number(latest.waterPay) : occ * 100;
        const elecPay = Number(latest.elecPay) || 0;
        const totalPay = rentBase + waterFee + elecPay;

        grandElec += elecPay;
        grandWater += waterFee;
        grandTotal += totalPay;

        const startShort = latest.rentStart
          ? latest.rentStart.substring(5).replace("-", "/")
          : "";
        const endShort = latest.rentEnd
          ? latest.rentEnd.substring(5).replace("-", "/")
          : "";
        const rentPeriod =
          startShort && endShort ? `(${startShort}~${endShort})` : "";

        msg += `【${room}房】$${formatNumber(totalPay)} (${occ}人) ${rentPeriod}\n`;
        msg += ` ↳ 租金$${formatNumber(rentBase)} + 水費$${formatNumber(waterFee)} + 電費$${formatNumber(elecPay)}\n`;
      } else {
        const waterFee = currentOcc * 100;
        const totalPay = rentBase + waterFee;
        grandWater += waterFee;
        grandTotal += totalPay;
        msg += `【${room}房】$${formatNumber(totalPay)} (${currentOcc}人，未抄表)\n`;
      }
    });

    msg += `---------------------------\n`;
    msg += `⚡ 總收電費: $${formatNumber(grandElec)}\n`;
    msg += `💧 總收水費: $${formatNumber(grandWater)}\n`;
    msg += `💰 合計總收: $${formatNumber(grandTotal)}\n`;
    msg += `---------------------------`;
    return msg;
  };

  const handleDownloadSummaryChart = () => {
    const canvas = buildSummaryChartCanvas();
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `套房水電總覽_${globalEndDate}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast("已下載高清總覽報表圖檔", "success");
  };

  const handleShareSummaryChart = async () => {
    const canvas = buildSummaryChartCanvas();
    const msg = generateSummaryText();
    await copyToClipboard(msg);

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], `套房水電總覽_${globalEndDate}.png`, {
        type: "image/png",
      });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: "套房租金水電總覽",
            text: msg,
            files: [file],
          });
          return;
        } catch {
          // user cancelled or fallback
        }
      }
      handleDownloadSummaryChart();
      triggerExternalLink(
        `https://line.me/R/share?text=${encodeURIComponent(msg)}`
      );
    }, "image/png");
  };

  const activeRoom: RoomKey = activeTab === "summary" ? "102" : activeTab;
  const currentRoomState = rooms[activeRoom];
  const currentMetrics = calculateRoomMetrics(activeRoom, currentRoomState);
  const rate202 = get202Rate();

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 pb-16">
      {/* Top Navigation Bar */}
      <header className="bg-slate-900 text-white sticky top-0 z-40 border-b border-slate-800 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 shrink-0">
            <Zap className="w-4 h-4 text-amber-400" />
            <span className="font-bold text-sm tracking-tight whitespace-nowrap hidden sm:inline">
              套房電錶 AI 算費系統
            </span>
          </div>

          <nav
            className="flex items-center gap-1 overflow-x-auto py-1"
            aria-label="房號切換"
          >
            {ROOM_KEYS.map((room) => {
              const isSelected = activeTab === room;
              const hasSavedThisMonth = rooms[room].history.some(
                (h) => h.meterDate === globalEndDate
              );
              return (
                <button
                  key={room}
                  type="button"
                  onClick={() => setActiveTab(room)}
                  className={`px-3.5 py-1.5 rounded-xl font-bold text-xs transition whitespace-nowrap shrink-0 flex items-center gap-1 cursor-pointer ${
                    isSelected
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-300 hover:text-white hover:bg-slate-800"
                  }`}
                >
                  <span>{room}</span>
                  {hasSavedThisMonth && (
                    <span className="text-[10px] text-emerald-300">✓</span>
                  )}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setActiveTab("summary")}
              className={`px-3.5 py-1.5 rounded-xl font-bold text-xs transition whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
                activeTab === "summary"
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "text-emerald-400 hover:text-emerald-300 hover:bg-slate-800"
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>總覽</span>
            </button>
          </nav>

          <div className="hidden md:flex items-center text-xs text-slate-400 font-mono whitespace-nowrap shrink-0">
            <span>202費率: {rate202.toFixed(1)}元/度</span>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="max-w-5xl mx-auto px-4 pt-5 space-y-5">
        {/* Global Meter Reading Date Bar */}
        {activeTab !== "summary" && (
          <div className="bg-white rounded-2xl p-4 border border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
                <Calendar className="w-4 h-4 text-blue-600" />
                <span>本期抄表基準日（同步壓印至電錶相片浮水印）</span>
              </div>
              <p className="text-xs text-slate-500">
                202 房依月份自動切換：{rate202.toFixed(1)} 元/度（
                {rate202 === 5.5 ? "6~9月夏季電價" : "非夏季電價"}）· 其餘房號固定 5.5 元/度
              </p>
            </div>
            <div className="sm:w-52 shrink-0">
              <input
                type="date"
                value={globalEndDate}
                onChange={(e) => handleGlobalDateChange(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-mono font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>
        )}

        {/* Room Workspace View */}
        {activeTab !== "summary" ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Left Column: Meter AI Recognition & Inputs */}
            <div className="lg:col-span-7 space-y-4">
              {/* Room Header Summary */}
              <div className="bg-white rounded-2xl p-4 border border-slate-200 flex items-center justify-between">
                <div>
                  <h1 className="font-extrabold text-slate-900 text-lg tracking-tight">
                    {activeRoom} 號套房電錶核算
                  </h1>
                  <p className="text-xs text-slate-500 mt-0.5">
                    每月基本房租 NT$ {formatNumber(DEFAULT_ROOM_RENTS[activeRoom])} · 水費每人 $100
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-[11px] text-slate-400 block">
                    本期適用電價
                  </span>
                  <span className="font-extrabold text-blue-600 font-mono text-base tabular-nums">
                    {currentMetrics.rate.toFixed(1)} 元 / 度
                  </span>
                </div>
              </div>

              {/* Lease Period & Occupants Config */}
              <div className="bg-amber-50/70 rounded-2xl p-4 border border-amber-200/90 space-y-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-amber-700" />
                    租賃期間與入住人數
                  </span>
                  <span className="text-[11px] text-amber-800">
                    修改起始日自動推算一個月迄日
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-amber-900/80 mb-1">
                      租金起始日
                    </label>
                    <input
                      type="date"
                      value={currentRoomState.rentStart}
                      onChange={(e) => {
                        const startVal = e.target.value;
                        if (!startVal) return;
                        const endVal = calcOneMonthEndDate(startVal);
                        setRooms((prev) => ({
                          ...prev,
                          [activeRoom]: {
                            ...prev[activeRoom],
                            rentStart: startVal,
                            rentEnd: endVal,
                            cachedBillMessage: null,
                          },
                        }));
                        showToast(`已自動推算租期迄日至 ${endVal}`, "info");
                      }}
                      className="w-full bg-white border border-amber-300 rounded-xl px-3 py-2 text-xs font-mono font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-amber-900/80 mb-1">
                      租金結束日
                    </label>
                    <input
                      type="date"
                      value={currentRoomState.rentEnd}
                      onChange={(e) => {
                        const endVal = e.target.value;
                        setRooms((prev) => ({
                          ...prev,
                          [activeRoom]: {
                            ...prev[activeRoom],
                            rentEnd: endVal,
                            cachedBillMessage: null,
                          },
                        }));
                      }}
                      className="w-full bg-white/80 border border-amber-200 rounded-xl px-3 py-2 text-xs font-mono font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                </div>

                <div className="pt-2.5 border-t border-amber-200/70 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-950">
                    <Users className="w-3.5 h-3.5 text-amber-700" />
                    <span>入住人數</span>
                    <span className="text-[11px] font-normal text-amber-800">
                      (每人水費 $100)
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <div className="flex items-center bg-white border border-amber-300 rounded-xl overflow-hidden">
                      <button
                        type="button"
                        onClick={() => {
                          const nextOcc = Math.max(
                            1,
                            currentRoomState.occupants - 1
                          );
                          localStorage.setItem(
                            `${DB_KEY_PREFIX}${activeRoom}_occ`,
                            String(nextOcc)
                          );
                          setRooms((prev) => ({
                            ...prev,
                            [activeRoom]: {
                              ...prev[activeRoom],
                              occupants: nextOcc,
                              cachedBillMessage: null,
                            },
                          }));
                        }}
                        className="px-3 py-1.5 text-amber-900 hover:bg-amber-100 font-bold text-xs transition cursor-pointer"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="w-9 text-center text-xs font-bold font-mono tabular-nums text-slate-800">
                        {currentRoomState.occupants}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const nextOcc = Math.min(
                            10,
                            currentRoomState.occupants + 1
                          );
                          localStorage.setItem(
                            `${DB_KEY_PREFIX}${activeRoom}_occ`,
                            String(nextOcc)
                          );
                          setRooms((prev) => ({
                            ...prev,
                            [activeRoom]: {
                              ...prev[activeRoom],
                              occupants: nextOcc,
                              cachedBillMessage: null,
                            },
                          }));
                        }}
                        className="px-3 py-1.5 text-amber-900 hover:bg-amber-100 font-bold text-xs transition cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <span className="text-xs font-bold text-cyan-800 font-mono tabular-nums">
                      水費 ${formatNumber(currentMetrics.waterPay)}
                    </span>
                  </div>
                </div>
              </div>

              {/* AI Camera Meter Reading Card */}
              <div className="bg-white rounded-2xl p-4 border border-slate-200 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-slate-800 text-xs flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-blue-600" />
                    <span>AI 電錶拍照辨識與度數比對</span>
                  </h2>
                  <span className="text-[11px] text-slate-500">
                    自動忽略紅框小數位
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <button
                    type="button"
                    disabled={currentRoomState.aiStatus.loading}
                    onClick={() => triggerMediaChoice(activeRoom, "curr")}
                    className="sm:col-span-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 active:scale-[0.99] text-white py-3.5 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition cursor-pointer"
                  >
                    {currentRoomState.aiStatus.loading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>AI 正在判讀電錶度數中...</span>
                      </>
                    ) : (
                      <>
                        <Camera className="w-4 h-4" />
                        <span>拍照 / 上傳本期電錶相片自動判讀</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={currentRoomState.aiStatus.loading}
                    onClick={() => handleSampleMeterTest(activeRoom, "curr")}
                    className="bg-slate-100 hover:bg-slate-200 disabled:opacity-60 text-slate-700 py-3.5 px-3 rounded-2xl font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                    title="產生模擬台灣滾輪電錶照片並直接測試智慧判讀"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                    <span>範例電錶 AI 實測</span>
                  </button>
                </div>

                {/* Photo & AI Status Preview Box */}
                {(currentRoomState.watermarkedCurrPhoto ||
                  currentRoomState.watermarkedPrevPhoto ||
                  currentRoomState.aiStatus.loading ||
                  currentRoomState.aiStatus.notes) && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3.5 space-y-2.5">
                    <div className="flex items-start gap-3.5">
                      {(currentRoomState.watermarkedCurrPhoto ||
                        currentRoomState.watermarkedPrevPhoto) && (
                        <button
                          type="button"
                          onClick={() => {
                            const isPrev =
                              currentRoomState.aiStatus.target === "prev" &&
                              currentRoomState.watermarkedPrevPhoto;
                            const b64 = isPrev
                              ? currentRoomState.watermarkedPrevPhoto!
                              : (currentRoomState.watermarkedCurrPhoto ||
                                  currentRoomState.watermarkedPrevPhoto)!;
                            setPhotoViewer({
                              room: activeRoom,
                              title: `${activeRoom} 號房 ${isPrev ? "前期" : "本期"}電錶預覽`,
                              subtitle: `浮水印抄表日：${globalEndDate}`,
                              base64: b64,
                              degreesText: `${isPrev ? currentMetrics.prev : currentMetrics.curr} 度`,
                            });
                          }}
                          className="relative group shrink-0 cursor-pointer"
                        >
                          <img
                            src={`data:image/jpeg;base64,${
                              currentRoomState.aiStatus.target === "prev" &&
                              currentRoomState.watermarkedPrevPhoto
                                ? currentRoomState.watermarkedPrevPhoto
                                : currentRoomState.watermarkedCurrPhoto ||
                                  currentRoomState.watermarkedPrevPhoto
                            }`}
                            alt="電錶縮圖"
                            className="w-20 h-20 object-cover rounded-xl border border-slate-300"
                          />
                          <span className="absolute inset-0 bg-slate-900/40 opacity-0 group-hover:opacity-100 transition rounded-xl flex items-center justify-center text-white text-[10px] font-bold">
                            點擊放大
                          </span>
                        </button>
                      )}

                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-slate-800">
                            {currentRoomState.aiStatus.meterType ||
                              "AI 電錶視覺判讀"}
                          </span>
                          {currentRoomState.aiStatus.loading ? (
                            <span className="text-xs font-mono text-blue-600 flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              辨識中...
                            </span>
                          ) : currentRoomState.aiStatus.reading !== undefined ? (
                            <span className="text-xs font-mono font-bold text-emerald-700 flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              判讀：{currentRoomState.aiStatus.reading} 度
                            </span>
                          ) : (
                            <span className="text-xs font-mono text-amber-700">
                              手動確認
                            </span>
                          )}
                        </div>

                        {currentRoomState.aiStatus.rawDisplay && (
                          <p className="text-xs text-slate-600 font-mono">
                            錶面完整顯示：{currentRoomState.aiStatus.rawDisplay}
                          </p>
                        )}

                        {currentRoomState.aiStatus.notes && (
                          <p className="text-[11px] text-slate-500 leading-relaxed">
                            {currentRoomState.aiStatus.notes}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Degree Inputs */}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <div className="flex justify-between items-center mb-1.5">
                      <label className="text-xs font-bold text-slate-700">
                        前期度數 (舊)
                      </label>
                      <button
                        type="button"
                        onClick={() => triggerMediaChoice(activeRoom, "prev")}
                        className="text-[11px] font-bold text-blue-600 hover:text-blue-800 underline cursor-pointer"
                      >
                        📷 拍舊錶
                      </button>
                    </div>
                    <input
                      type="number"
                      step="1"
                      value={currentRoomState.prevDegreeInput}
                      placeholder="輸入前期整數度數"
                      onChange={(e) => {
                        const val = e.target.value;
                        setRooms((prev) => ({
                          ...prev,
                          [activeRoom]: {
                            ...prev[activeRoom],
                            prevDegreeInput: val,
                            cachedBillMessage: null,
                          },
                        }));
                      }}
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-sm font-mono font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600 tabular-nums"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-1.5">
                      <label className="text-xs font-bold text-slate-700">
                        本期度數 (新)
                      </label>
                      <button
                        type="button"
                        onClick={() => triggerMediaChoice(activeRoom, "curr")}
                        className="text-[11px] font-bold text-blue-600 hover:text-blue-800 underline cursor-pointer"
                      >
                        📷 拍新錶
                      </button>
                    </div>
                    <input
                      type="number"
                      step="1"
                      value={currentRoomState.currDegreeInput}
                      placeholder="AI 自動填入或手輸"
                      onChange={(e) => {
                        const val = e.target.value;
                        setRooms((prev) => ({
                          ...prev,
                          [activeRoom]: {
                            ...prev[activeRoom],
                            currDegreeInput: val,
                            cachedBillMessage: null,
                          },
                        }));
                      }}
                      className="w-full bg-blue-50/60 border border-blue-300 rounded-xl px-3 py-2.5 text-sm font-mono font-bold text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-600 tabular-nums"
                    />
                  </div>
                </div>

                {currentMetrics.hasAnomaly && (
                  <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5 font-medium flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>
                      提醒：本期度數小於前期度數，目前實用度數以 0 度計算，請確認是否輸入顛倒或電錶歸零。
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px] text-slate-400">
                    若電錶滾輪剛好看在兩數中間，可微調本期度數：
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const curr =
                          parseInt(currentRoomState.currDegreeInput, 10) || 0;
                        setRooms((prev) => ({
                          ...prev,
                          [activeRoom]: {
                            ...prev[activeRoom],
                            currDegreeInput: String(Math.max(0, curr - 1)),
                            cachedBillMessage: null,
                          },
                        }));
                      }}
                      className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-lg font-mono transition cursor-pointer"
                    >
                      -1 度
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const curr =
                          parseInt(currentRoomState.currDegreeInput, 10) || 0;
                        setRooms((prev) => ({
                          ...prev,
                          [activeRoom]: {
                            ...prev[activeRoom],
                            currDegreeInput: String(curr + 1),
                            cachedBillMessage: null,
                          },
                        }));
                      }}
                      className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-lg font-mono transition cursor-pointer"
                    >
                      +1 度
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Live Calculation Summary, Actions & Room History */}
            <div className="lg:col-span-5 space-y-4">
              {/* Dark Calculation Card */}
              <div className="bg-slate-900 rounded-3xl p-5 text-white shadow-lg space-y-4">
                <div className="grid grid-cols-2 gap-4 border-b border-slate-800 pb-4">
                  <div>
                    <span className="text-xs text-slate-400">本期實用度數</span>
                    <div className="text-2xl font-black font-mono tabular-nums text-white mt-0.5">
                      {currentMetrics.used}{" "}
                      <span className="text-xs text-slate-400 font-normal">
                        度
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-emerald-400">
                      本期純電費 ({currentMetrics.rate.toFixed(1)}元/度)
                    </span>
                    <div className="text-2xl font-black font-mono tabular-nums text-emerald-400 mt-0.5">
                      $ {formatNumber(currentMetrics.elecPay)}
                    </div>
                  </div>
                </div>

                <div className="bg-slate-800/80 rounded-2xl p-3.5 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-300">
                    <span>房屋租金</span>
                    <span className="font-mono tabular-nums">
                      NT$ {formatNumber(currentMetrics.rent)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-300">
                    <span>自來水費 ({currentMetrics.occupants} 人)</span>
                    <span className="font-mono tabular-nums">
                      NT$ {formatNumber(currentMetrics.waterPay)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-300">
                    <span>本期電費 ({currentMetrics.used} 度)</span>
                    <span className="font-mono tabular-nums">
                      NT$ {formatNumber(currentMetrics.elecPay)}
                    </span>
                  </div>
                  <div className="flex justify-between text-white font-bold pt-2 border-t border-slate-700 text-sm">
                    <span>本期應繳總額</span>
                    <span className="font-mono tabular-nums text-emerald-400">
                      NT$ {formatNumber(currentMetrics.totalPay)}
                    </span>
                  </div>
                </div>

                <div className="space-y-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => handleSaveRoomRecord(activeRoom)}
                    className="w-full bg-blue-600 hover:bg-blue-500 active:scale-[0.99] text-white py-3 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition cursor-pointer"
                  >
                    <Save className="w-4 h-4" />
                    <span>確認並儲存本期紀錄 (自動存浮水印相片)</span>
                  </button>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleSendToLine(activeRoom)}
                      className="flex-1 bg-[#06c755] hover:bg-[#05b34c] active:scale-[0.99] text-white py-2.5 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      <span>傳送 LINE 帳單與相片</span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await copyToClipboard(generateBillText(activeRoom));
                        showToast("帳單明細已複製到剪貼簿！", "success");
                      }}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 py-2.5 px-3.5 rounded-xl font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>複製明細</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Room History Table Card */}
              <div className="bg-white rounded-2xl p-4 border border-slate-200 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <h3 className="font-bold text-slate-800 text-xs flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-slate-500" />
                    <span>{activeRoom} 房歷史抄表紀錄（含照片查驗）</span>
                  </h3>
                  {currentRoomState.history.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setDeleteConfirm({
                          title: `清空 ${activeRoom} 房所有紀錄？`,
                          desc: "清空後此房號的歷史抄表紀錄與相片將無法復原。",
                          onConfirm: () => {
                            setRooms((prev) => {
                              const next = {
                                ...prev,
                                [activeRoom]: {
                                  ...prev[activeRoom],
                                  history: [],
                                },
                              };
                              persistHistoryWithQuotaGuard(
                                activeRoom,
                                [],
                                next
                              );
                              return next;
                            });
                            showToast(`已清空 ${activeRoom} 房歷史紀錄`, "info");
                          },
                        })
                      }
                      className="text-[11px] text-red-600 hover:text-red-700 font-medium underline cursor-pointer"
                    >
                      清空此房
                    </button>
                  )}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="text-slate-500 border-b border-slate-100 bg-slate-50 text-[11px]">
                      <tr>
                        <th className="py-2 px-1.5 font-semibold text-center">
                          租期
                        </th>
                        <th className="py-2 px-1 font-semibold text-center">
                          人
                        </th>
                        <th className="py-2 px-1.5 font-semibold text-right">
                          度數
                        </th>
                        <th className="py-2 px-1.5 font-semibold text-right">
                          電費
                        </th>
                        <th className="py-2 px-1.5 font-semibold text-right text-emerald-700">
                          總額
                        </th>
                        <th className="py-2 px-1 text-center">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {currentRoomState.history.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6}
                            className="py-6 text-center text-slate-400 text-xs"
                          >
                            尚無歷史抄表紀錄
                          </td>
                        </tr>
                      ) : (
                        currentRoomState.history.map((item) => {
                          const startShort = item.rentStart
                            ? item.rentStart.substring(5).replace("-", "/")
                            : "";
                          const endShort = item.rentEnd
                            ? item.rentEnd.substring(5).replace("-", "/")
                            : "";
                          const rentPeriod =
                            startShort && endShort
                              ? `${startShort}~${endShort}`
                              : "-";
                          const rent = DEFAULT_ROOM_RENTS[activeRoom];
                          const occ = item.occupants || 1;
                          const water =
                            item.waterPay !== undefined
                              ? Number(item.waterPay)
                              : occ * 100;
                          const elec = Number(item.elecPay) || 0;
                          const total = rent + water + elec;

                          return (
                            <tr
                              key={item.id}
                              className="hover:bg-slate-50 transition"
                            >
                              <td className="py-2.5 px-1.5 font-mono text-[11px] text-slate-700 text-center whitespace-nowrap tabular-nums">
                                {rentPeriod}
                              </td>
                              <td className="py-2.5 px-1 font-mono text-[11px] text-slate-600 text-center tabular-nums">
                                {occ}
                              </td>
                              <td
                                className="py-2.5 px-1.5 font-mono text-[11px] text-slate-800 font-bold text-right tabular-nums"
                                title={`舊 ${item.prevDegree} → 新 ${item.currDegree}`}
                              >
                                {item.usedDegrees}度
                              </td>
                              <td className="py-2.5 px-1.5 font-mono text-[11px] text-blue-600 text-right tabular-nums">
                                ${formatNumber(elec)}
                              </td>
                              <td className="py-2.5 px-1.5 font-mono text-[11px] text-emerald-700 font-bold text-right tabular-nums">
                                ${formatNumber(total)}
                              </td>
                              <td className="py-2.5 px-1 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  {item.currPhoto && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setPhotoViewer({
                                          room: activeRoom,
                                          title: `${activeRoom} 號套房電錶紀錄相片`,
                                          subtitle: `抄表日：${item.meterDate || "無"} ｜ 租期：${item.rentStart} ~ ${item.rentEnd}`,
                                          base64: item.currPhoto!,
                                          degreesText: `${item.currDegree} 度 (實用 ${item.usedDegrees} 度 / 電費 $${formatNumber(item.elecPay)})`,
                                        })
                                      }
                                      className="p-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg transition cursor-pointer"
                                      title="查看電錶照片"
                                    >
                                      <Eye className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setDeleteConfirm({
                                        title: "確定要刪除這筆紀錄嗎？",
                                        desc: "刪除後將無法復原此筆資料與相片。",
                                        onConfirm: () => {
                                          const nextHist =
                                            currentRoomState.history.filter(
                                              (h) => h.id !== item.id
                                            );
                                          setRooms((prev) => {
                                            const next = {
                                              ...prev,
                                              [activeRoom]: {
                                                ...prev[activeRoom],
                                                history: nextHist,
                                              },
                                            };
                                            persistHistoryWithQuotaGuard(
                                              activeRoom,
                                              nextHist,
                                              next
                                            );
                                            return next;
                                          });
                                          showToast("已刪除該筆抄表紀錄", "info");
                                        },
                                      })
                                    }
                                    className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg transition cursor-pointer"
                                    title="刪除此筆紀錄"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Summary Overview Tab */
          <div className="space-y-4">
            <div className="bg-white rounded-2xl overflow-hidden border border-slate-200 shadow-sm">
              <div className="bg-slate-900 p-4 flex items-center justify-between">
                <h2 className="font-bold text-white text-sm flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-emerald-400" />
                  <span>
                    {globalEndDate
                      ? `${globalEndDate.split("-")[0]} 年`
                      : `${new Date().getFullYear()} 年`}{" "}
                    套房租金水電金額總覽
                  </span>
                </h2>
                <span className="text-xs text-slate-300 font-mono">
                  最新一期彙整
                </span>
              </div>

              <div className="p-2 sm:p-4 overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse min-w-[480px]">
                  <thead className="text-slate-500 bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="py-3 px-2 font-bold text-center">房號</th>
                      <th className="py-3 px-2 font-bold text-center">
                        租賃期間
                      </th>
                      <th className="py-3 px-2 font-bold text-center">人數</th>
                      <th className="py-3 px-2 font-bold text-right">
                        房屋租金
                      </th>
                      <th className="py-3 px-2 font-bold text-right">
                        本期電費
                      </th>
                      <th className="py-3 px-2 font-bold text-right">
                        自來水費
                      </th>
                      <th className="py-3 px-2.5 font-bold text-right text-emerald-700">
                        應繳總額
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium">
                    {ROOM_KEYS.map((room) => {
                      const rState = rooms[room];
                      const latest = rState.history[0];
                      const rentBase = DEFAULT_ROOM_RENTS[room];
                      const occ = latest
                        ? latest.occupants || 1
                        : rState.occupants || 1;
                      const waterFee = latest
                        ? latest.waterPay !== undefined
                          ? Number(latest.waterPay)
                          : occ * 100
                        : occ * 100;
                      const elecPay = latest ? Number(latest.elecPay) || 0 : 0;
                      const totalPay = rentBase + waterFee + elecPay;

                      const startShort = latest?.rentStart
                        ? latest.rentStart.substring(5).replace("-", "/")
                        : "";
                      const endShort = latest?.rentEnd
                        ? latest.rentEnd.substring(5).replace("-", "/")
                        : "";
                      const periodDisplay =
                        startShort && endShort
                          ? `${startShort}~${endShort}`
                          : "尚無紀錄";

                      return (
                        <tr
                          key={room}
                          onClick={() => setActiveTab(room)}
                          className="hover:bg-blue-50/40 transition cursor-pointer"
                        >
                          <td className="py-3 px-2 font-bold text-slate-900 font-mono text-center">
                            {room}
                          </td>
                          <td
                            className={`py-3 px-2 font-mono text-center whitespace-nowrap ${
                              latest ? "text-slate-600" : "text-slate-400 italic"
                            }`}
                          >
                            {periodDisplay}
                          </td>
                          <td className="py-3 px-2 font-mono text-slate-700 text-center">
                            {occ}人
                          </td>
                          <td className="py-3 px-2 text-right font-mono text-slate-600 tabular-nums">
                            ${formatNumber(rentBase)}
                          </td>
                          <td className="py-3 px-2 text-right font-mono text-blue-600 font-bold tabular-nums">
                            {latest ? `$${formatNumber(elecPay)}` : "-"}
                          </td>
                          <td className="py-3 px-2 text-right font-mono text-cyan-700 font-bold tabular-nums">
                            ${formatNumber(waterFee)}
                          </td>
                          <td className="py-3 px-2.5 text-right font-mono font-black text-emerald-700 bg-emerald-50/30 tabular-nums">
                            ${formatNumber(totalPay)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 font-bold border-t-2 border-slate-200">
                    {(() => {
                      let grandRent = 0;
                      let grandElec = 0;
                      let grandWater = 0;
                      let grandTotal = 0;
                      ROOM_KEYS.forEach((room) => {
                        const rState = rooms[room];
                        const latest = rState.history[0];
                        const rentBase = DEFAULT_ROOM_RENTS[room];
                        const occ = latest
                          ? latest.occupants || 1
                          : rState.occupants || 1;
                        const waterFee = latest
                          ? latest.waterPay !== undefined
                            ? Number(latest.waterPay)
                            : occ * 100
                          : occ * 100;
                        const elecPay = latest
                          ? Number(latest.elecPay) || 0
                          : 0;
                        grandRent += rentBase;
                        grandElec += elecPay;
                        grandWater += waterFee;
                        grandTotal += rentBase + waterFee + elecPay;
                      });
                      return (
                        <tr>
                          <td
                            colSpan={3}
                            className="py-3.5 px-2 text-slate-800 text-center"
                          >
                            合計總收
                          </td>
                          <td className="py-3.5 px-2 text-right font-mono text-slate-700 tabular-nums">
                            ${formatNumber(grandRent)}
                          </td>
                          <td className="py-3.5 px-2 text-right font-mono text-blue-700 tabular-nums">
                            ${formatNumber(grandElec)}
                          </td>
                          <td className="py-3.5 px-2 text-right font-mono text-cyan-800 tabular-nums">
                            ${formatNumber(grandWater)}
                          </td>
                          <td className="py-3.5 px-2.5 text-right font-mono text-emerald-800 text-sm bg-emerald-100/60 tabular-nums">
                            ${formatNumber(grandTotal)}
                          </td>
                        </tr>
                      );
                    })()}
                  </tfoot>
                </table>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-slate-200 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-slate-800 text-xs">
                  匯出總覽報表圖檔與文字
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  一鍵產生高解析度表格圖片並複製總覽文字明細
                </p>
              </div>
              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={handleShareSummaryChart}
                  className="flex-1 sm:flex-initial bg-[#06c755] hover:bg-[#05b34c] text-white py-2.5 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>傳送 LINE 總覽圖表</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadSummaryChart}
                  className="bg-slate-800 hover:bg-slate-700 text-white py-2.5 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>下載圖表</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Hidden File Inputs for Camera & Gallery */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileInputChange}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Media Source Selection Modal */}
      {mediaModal?.open && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-sm w-full p-5 space-y-4 shadow-xl border border-slate-100">
            <div className="flex justify-between items-center pb-2 border-b border-slate-100">
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <Camera className="w-4 h-4 text-blue-600" />
                <span>選擇電錶照片來源</span>
              </h3>
              <button
                type="button"
                onClick={() => setMediaModal(null)}
                className="text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600">
              準備辨識{" "}
              <span className="font-bold text-slate-900">
                {mediaModal.room} 號房
              </span>{" "}
              的【
              {mediaModal.targetField === "curr"
                ? "本期電錶度數 (新)"
                : "前期電錶度數 (舊)"}
              】：
            </p>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setMediaModal(null);
                  cameraInputRef.current?.click();
                }}
                className="flex flex-col items-center justify-center gap-2 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 py-4 px-3 rounded-2xl transition cursor-pointer"
              >
                <Camera className="w-6 h-6" />
                <span className="text-xs font-bold">開啟相機拍照</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMediaModal(null);
                  galleryInputRef.current?.click();
                }}
                className="flex flex-col items-center justify-center gap-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 py-4 px-3 rounded-2xl transition cursor-pointer"
              >
                <ImageIcon className="w-6 h-6" />
                <span className="text-xs font-bold">從相簿選照片</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() =>
                handleSampleMeterTest(mediaModal.room, mediaModal.targetField)
              }
              className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              <span>使用範例台灣滾輪電錶照片測試 AI 判讀</span>
            </button>

            <button
              type="button"
              onClick={() => setMediaModal(null)}
              className="w-full py-2 text-slate-500 hover:text-slate-700 text-xs font-medium transition cursor-pointer"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Photo Viewer Modal */}
      {photoViewer && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full overflow-hidden shadow-2xl border border-slate-200">
            <div className="p-3.5 bg-slate-900 text-white flex justify-between items-center">
              <div>
                <h4 className="font-bold text-xs">{photoViewer.title}</h4>
                <p className="text-[11px] text-slate-300 font-mono mt-0.5">
                  {photoViewer.subtitle}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPhotoViewer(null)}
                className="text-slate-400 hover:text-white p-1 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-3 bg-slate-100 flex items-center justify-center min-h-[240px] max-h-[420px]">
              <img
                src={`data:image/jpeg;base64,${photoViewer.base64}`}
                alt="電錶紀錄"
                className="max-w-full max-h-[390px] object-contain rounded-lg shadow-sm"
              />
            </div>
            <div className="p-3.5 bg-white border-t border-slate-100 flex justify-between items-center text-xs">
              <div>
                <span className="text-slate-500">紀錄度數：</span>
                <span className="font-black text-blue-600 font-mono">
                  {photoViewer.degreesText}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    downloadBase64Photo(
                      photoViewer.base64,
                      `${photoViewer.room}房電錶_${globalEndDate}.jpg`
                    )
                  }
                  className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold rounded-xl transition cursor-pointer"
                >
                  下載相片
                </button>
                <button
                  type="button"
                  onClick={() => setPhotoViewer(null)}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition cursor-pointer"
                >
                  關閉
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-xs w-full p-5 space-y-4 shadow-2xl text-center">
            <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <h4 className="font-bold text-slate-900 text-sm">
              {deleteConfirm.title}
            </h4>
            <p className="text-xs text-slate-500">{deleteConfirm.desc}</p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  deleteConfirm.onConfirm();
                  setDeleteConfirm(null);
                }}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white text-xs font-bold py-2.5 rounded-xl transition cursor-pointer"
              >
                確定刪除
              </button>
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold py-2.5 rounded-xl transition cursor-pointer"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
          <div className="bg-slate-900/95 text-white text-xs font-medium px-4 py-2.5 rounded-full shadow-lg flex items-center gap-2 border border-slate-700 whitespace-nowrap">
            {toast.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : toast.type === "warn" ? (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            ) : (
              <Sparkles className="w-4 h-4 text-blue-400 shrink-0" />
            )}
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
