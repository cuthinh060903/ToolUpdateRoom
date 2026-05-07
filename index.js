const fs = require("fs").promises;
const axios = require("axios");
require("dotenv").config();
const csvtojson = require("csvtojson");
const xlsx = require("xlsx");
const { google } = require("googleapis");
const OpenAI = require("openai");
const { LIST_GGSHEET } = require("./constants");
const { extension, roomNameAliases } = require("./extension");
const { sendTelegramMessage } = require("./telegram_bot");
const path = require("path");
const dayjs = require("dayjs");
const { Client } = require("minio");
const mammoth = require("mammoth");
const heicConvert = require("heic-convert");

const DAILY_ROTATION_LOG_FILES = new Set([
  "nhamoi.txt",
  "capnhatdriver.txt",
  "capnhatgia.txt",
  "capnhattrong.txt",
]);
const DEFAULT_LOG_RETENTION_DAYS = 3;
const DEFAULT_API_TIMEOUT_MS = 30000;
const MAIN_RUN_LOCK_DIR = path.join("logs", ".locks");
const MAIN_RUN_LOCK_FILE = path.join(MAIN_RUN_LOCK_DIR, "main-updater.lock");

function toBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "y", "on"].includes(
    value.toString().trim().toLowerCase(),
  );
}

function normalizeRunContext(value = "") {
  const context = value.toString().trim().toLowerCase();
  if (context === "manual") {
    return "manual";
  }
  return "daily";
}

class UpdateRoomSari {
  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.OpenAI = this.apiKey ? new OpenAI({ apiKey: this.apiKey }) : null;
    if (!this.apiKey) {
      console.warn(
        "[config] OPENAI_API_KEY is missing. OpenAI features will be disabled.",
      );
    }
    this.AUTH_USERNAME = "bot2nguon";
    this.AUTH_PASSWORD = "1234567";
    this.PAGE = 0;
    this.SIZE = 1000;
    this.minFileUpload = 3;
    this.baseURL = "https://api-legacy.sari.vn/v1/";
    this.URL_API_REALNEW_SEARCH =
      "https://api-legacy.sari.vn/v1/realnews/search";
    this.URL_API_ROOM_SEARCH = "https://api-legacy.sari.vn/v1/rooms/search";
    this.URL_API_UNLOCK_ROOM = "https://api-legacy.sari.vn/v1/rooms/unlockRoom";
    this.URL_API_UPDATE_ROOM = "https://api-legacy.sari.vn/v1/rooms/";
    this.URL_API_LOCK_ROOM =
      "https://api-legacy.sari.vn/v1/rooms/lockRoomToDate?";
    this.LIST_GGSHEET = LIST_GGSHEET;
    this.START_ID = Number(process.env.START_ID || 1);
    if (!Number.isFinite(this.START_ID) || this.START_ID < 1) {
      this.START_ID = 8;
    }
    this.RUN_ONLY_IDS = (process.env.RUN_ONLY_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "")
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    const configuredRunContext =
      process.env.TOOL_RUN_CONTEXT || process.env.RUN_CONTEXT || "";
    this.RUN_CONTEXT = normalizeRunContext(configuredRunContext || "manual");
    this.mainRunLockPath = path.resolve(process.cwd(), MAIN_RUN_LOCK_FILE);
    this.API_KEY_GGSHEET = "4f74e1628d70cc3b23f7ad9d1d0a50802d01d1ea";
    this.BUCKETNAME = "sari";
    this.MINIO_ACCESS_KEY = (process.env.MINIO_ACCESS_KEY || "").trim();
    this.MINIO_SECRET_KEY = (process.env.MINIO_SECRET_KEY || "").trim();
    this.hasMinioCredentials = Boolean(
      this.MINIO_ACCESS_KEY && this.MINIO_SECRET_KEY,
    );
    if (!this.hasMinioCredentials) {
      console.warn(
        "[config] Missing MINIO_ACCESS_KEY/MINIO_SECRET_KEY. Create a .env file from .env.example before uploading images.",
      );
    }
    // Conflict resolution: prefer higher features (e.g., 2N > 1N)
    this.priorityGroups = [
      ["3N", "2N", "1N"],
      ["2WC", "1WC"],
    ];
    this.addressMatchProfileCache = new Map();
    this.addressVariantCache = new Map();
    const configuredLogRetentionDays = Number(
      process.env.LOG_RETENTION_DAYS || DEFAULT_LOG_RETENTION_DAYS,
    );
    this.logRetentionDays =
      Number.isFinite(configuredLogRetentionDays) &&
      configuredLogRetentionDays >= 1
        ? Math.floor(configuredLogRetentionDays)
        : DEFAULT_LOG_RETENTION_DAYS;
    this.logRetentionCleanupDateByFile = new Map();
    const configuredApiTimeout = Number(process.env.API_REQUEST_TIMEOUT_MS);
    this.apiRequestTimeoutMs =
      Number.isFinite(configuredApiTimeout) && configuredApiTimeout >= 5000
        ? Math.floor(configuredApiTimeout)
        : DEFAULT_API_TIMEOUT_MS;
    this.verboseRuntimeLogs = toBooleanEnv(process.env.VERBOSE_RUNTIME_LOGS, false);
    axios.defaults.timeout = this.apiRequestTimeoutMs;

    this.minioClient = new Client({
      endPoint: "s3.sari.vn",
      port: 443,
      useSSL: true,
      accessKey: this.MINIO_ACCESS_KEY,
      secretKey: this.MINIO_SECRET_KEY,
    });
  }

  getMainTelegramTargetKey() {
    return this.RUN_CONTEXT === "manual"
      ? "mainUpdaterManual"
      : "mainUpdaterDaily";
  }

  async sendMainTelegramMessage(message, options = {}) {
    return sendTelegramMessage(message, {
      targetKey: this.getMainTelegramTargetKey(),
      ...options,
    });
  }

  formatLockTimestamp(date = new Date()) {
    const pad = (value) => value.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate(),
    )}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(
      date.getSeconds(),
    )}`;
  }

  isProcessAlive(pid) {
    const normalizedPid = Number(pid);
    if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
      return false;
    }

    try {
      process.kill(normalizedPid, 0);
      return true;
    } catch (error) {
      // EPERM means process exists but cannot be signaled due to permissions.
      if (error?.code === "EPERM") {
        return true;
      }
      return false;
    }
  }

  async moveCurrentLockToStale(reason = "stale_lock") {
    const lockPath = this.mainRunLockPath;
    const lockDir = path.dirname(lockPath);
    const safeReason = this.normalizeSheetCellText(reason)
      .replace(/[^a-z0-9_-]/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const stalePath = path.join(
      lockDir,
      `stale-main-updater-${this.formatLockTimestamp()}-${safeReason || "stale"}.lock`,
    );

    try {
      await fs.rename(lockPath, stalePath);
      return stalePath;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  async cleanupStaleMainRunLock() {
    const lockPath = this.mainRunLockPath;
    let rawLockContent = "";
    try {
      rawLockContent = await fs.readFile(lockPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { cleaned: false, reason: "lock_missing" };
      }
      throw error;
    }

    const trimmedContent = (rawLockContent || "").trim();
    if (!trimmedContent) {
      const stalePath = await this.moveCurrentLockToStale("empty_lock");
      return { cleaned: Boolean(stalePath), reason: "empty_lock", stalePath };
    }

    let lockData = null;
    try {
      lockData = JSON.parse(trimmedContent);
    } catch {
      const stalePath = await this.moveCurrentLockToStale("invalid_json_lock");
      return {
        cleaned: Boolean(stalePath),
        reason: "invalid_json_lock",
        stalePath,
      };
    }

    const lockPid = Number(lockData?.pid);
    if (!Number.isFinite(lockPid) || lockPid <= 0) {
      const stalePath = await this.moveCurrentLockToStale("missing_pid_lock");
      return {
        cleaned: Boolean(stalePath),
        reason: "missing_pid_lock",
        stalePath,
      };
    }

    if (this.isProcessAlive(lockPid)) {
      return { cleaned: false, reason: `active_pid_${lockPid}` };
    }

    const stalePath = await this.moveCurrentLockToStale(`dead_pid_${lockPid}`);
    return {
      cleaned: Boolean(stalePath),
      reason: `dead_pid_${lockPid}`,
      stalePath,
    };
  }

  async acquireMainRunLock() {
    const lockPath = this.mainRunLockPath;
    const lockDir = path.dirname(lockPath);
    await fs.mkdir(lockDir, { recursive: true });

    const writeNewLock = async () => {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify(
            {
              pid: process.pid,
              run_context: this.RUN_CONTEXT,
              started_at: new Date().toISOString(),
              cwd: process.cwd(),
            },
            null,
            2,
          ),
          "utf8",
        );
      } finally {
        await handle.close();
      }
    };

    try {
      await writeNewLock();
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        const cleanupResult = await this.cleanupStaleMainRunLock();
        if (cleanupResult?.cleaned) {
          if (cleanupResult?.stalePath) {
            console.warn(
              `[run-lock] Phat hien lock cu (${cleanupResult.reason}), da chuyen sang ${cleanupResult.stalePath}.`,
            );
          }
          try {
            await writeNewLock();
            return true;
          } catch (retryError) {
            if (retryError?.code === "EEXIST") {
              return false;
            }
            throw retryError;
          }
        }
        return false;
      }
      throw error;
    }
  }

  async releaseMainRunLock() {
    try {
      await fs.unlink(this.mainRunLockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(
          `[run-lock] Failed to release ${this.mainRunLockPath}: ${
            error?.message || error
          }`,
        );
      }
    }
  }

  ensureMinioCredentials() {
    if (this.hasMinioCredentials) {
      return;
    }

    throw new Error(
      "Missing MINIO_ACCESS_KEY/MINIO_SECRET_KEY. Create .env from .env.example and paste the real values.",
    );
  }

  /**
   * Trích folder ID từ link Google Drnive
   */
  extractFolderId(driveLink) {
    if (!driveLink) return null;
    const normalizedLink = driveLink.toString().trim();
    const folderMatch = normalizedLink.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (folderMatch) {
      return folderMatch[1];
    }

    const queryMatch = normalizedLink.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    return queryMatch ? queryMatch[1] : null;
  }

  normalizeExternalUrl(rawValue) {
    if (!rawValue) {
      return "";
    }

    return rawValue
      .toString()
      .trim()
      .replace(/[\])},;]+$/g, "");
  }

  getImageSourceType(rawLink) {
    const normalizedLink = this.normalizeExternalUrl(rawLink);
    if (!normalizedLink) {
      return null;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(normalizedLink);
    } catch {
      return null;
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname || "";
    if (
      hostname === "drive.google.com" &&
      this.extractFolderId(normalizedLink)
    ) {
      return "drive_folder";
    }

    if (hostname === "photos.app.goo.gl") {
      return "google_photos_share";
    }

    if (hostname === "photos.google.com" && pathname.startsWith("/share/")) {
      return "google_photos_share";
    }

    if (hostname.endsWith("googleusercontent.com")) {
      return "direct_image";
    }

    return null;
  }

  extractImageSourceLink(rawValue) {
    if (!rawValue) {
      return null;
    }

    const urlMatches =
      rawValue.toString().match(/https?:\/\/[^\s"'<>]+/gi) || [];
    for (const urlMatch of urlMatches) {
      const normalizedLink = this.normalizeExternalUrl(urlMatch);
      if (this.getImageSourceType(normalizedLink)) {
        return normalizedLink;
      }
    }

    return null;
  }

  pickImageSourceCandidate(rawValue) {
    if (!rawValue) {
      return null;
    }

    const normalized = this.normalizeExternalUrl(rawValue);
    if (!normalized) {
      return null;
    }

    if (
      this.getImageSourceType(normalized) ||
      this.extractDriveLink(normalized)
    ) {
      return normalized;
    }

    return null;
  }

  resolveImageDriverFromCell(cell = {}) {
    const hyperlinkCandidate = this.pickImageSourceCandidate(
      cell?.hyperlink || "",
    );
    if (hyperlinkCandidate) {
      return hyperlinkCandidate;
    }

    const formulaLink = this.extractHyperlinkFromFormula(cell?.formula || "");
    const formulaCandidate = this.pickImageSourceCandidate(formulaLink);
    if (formulaCandidate) {
      return formulaCandidate;
    }

    const valueCandidate = this.extractImageSourceLink(cell?.value || "");
    if (valueCandidate) {
      return valueCandidate;
    }

    const formulaTextCandidate = this.extractImageSourceLink(
      cell?.formula || "",
    );
    if (formulaTextCandidate) {
      return formulaTextCandidate;
    }

    return null;
  }

  resolveImageDriverFromRow(row = {}, preferredColumn = null) {
    const preferredCell =
      preferredColumn !== null && preferredColumn !== undefined
        ? row[`field${preferredColumn}`] || {}
        : {};
    const preferredCandidate = this.resolveImageDriverFromCell(preferredCell);
    if (preferredCandidate) {
      return preferredCandidate;
    }

    const fieldKeys = Object.keys(row || {}).filter((key) =>
      key.startsWith("field"),
    );
    for (const key of fieldKeys) {
      const candidate = this.resolveImageDriverFromCell(row[key] || {});
      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  extractDriveLink(rawValue) {
    if (!rawValue) return null;
    const match = rawValue
      .toString()
      .match(/https:\/\/drive\.google\.com\/[^\s"'<>]+/i);
    return match ? match[0] : null;
  }

  createDriveClient(auth) {
    return google.drive({ version: "v3", auth });
  }

  isGoogleDrivePermissionError(error) {
    const statusCode = error?.code || error?.response?.status;
    const message = (error?.message || "").toLowerCase();
    return (
      statusCode === 401 ||
      statusCode === 403 ||
      statusCode === 404 ||
      message.includes("access denied") ||
      message.includes("permission denied") ||
      message.includes("insufficient permissions") ||
      message.includes("not found")
    );
  }
  /**
   *
   * @param {*} objectPath
   * @param {*} bucketName
   * @returns
   */
  async checkUploadFile(objectPath, bucketName, expectedCount = 0) {
    this.ensureMinioCredentials();
    const exists = await this.minioClient.bucketExists(bucketName);
    if (!exists) {
      await this.minioClient.makeBucket(bucketName);
      console.log(`✅ Created bucket: ${bucketName}`);
    }
    const found = await this.listMinioObjectsByPrefix(objectPath, bucketName);

    if (expectedCount > 0) {
      return found.length >= expectedCount;
    }

    return found.length > this.minFileUpload;
  }

  async listMinioObjectsByPrefix(objectPath, bucketName) {
    this.ensureMinioCredentials();
    const objectsStream = this.minioClient.listObjects(
      bucketName,
      objectPath,
      true,
    );
    const found = [];
    await new Promise((resolve, reject) => {
      objectsStream.on("data", (obj) => {
        found.push(obj);
      });
      objectsStream.on("error", reject);
      objectsStream.on("end", resolve);
    });

    return found;
  }

  async removeMinioObjectsByPrefix(objectPath, bucketName) {
    const existingObjects = await this.listMinioObjectsByPrefix(
      objectPath,
      bucketName,
    );
    if (!existingObjects.length) {
      return 0;
    }

    for (const objectInfo of existingObjects) {
      if (!objectInfo?.name) {
        continue;
      }
      await this.minioClient.removeObject(bucketName, objectInfo.name);
    }

    return existingObjects.length;
  }

  /**
   * Upload stream lên MinIO nếu chưa tồn tại
   * @param {Stream} stream - Stream dữ liệu cần upload
   * @param {string} objectName - Tên file (hoặc path + tên file)
   * @param {string} bucketName - Tên bucket
   */
  async uploadToMinIO(fileData, objectName, bucketName, size) {
    this.ensureMinioCredentials();
    const validSize = Number.isFinite(size) && size > 0 ? size : undefined;
    await this.minioClient.putObject(
      bucketName,
      objectName,
      fileData,
      validSize,
    );
    console.log(`??? Uploaded "${objectName}" to bucket "${bucketName}"`);
    return true;
  }

  getImageExtension(file) {
    const fileNameExt = path.extname(file?.name || "");
    if (fileNameExt) {
      return fileNameExt.toLowerCase();
    }

    const mimeTypeToExt = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/heif": ".heic",
      "image/heic": ".heic",
    };

    return mimeTypeToExt[(file?.mimeType || "").toLowerCase()] || ".jpg";
  }

  isHeicFile(file) {
    const ext = this.getImageExtension(file);
    const mimeType = (file?.mimeType || "").toLowerCase();
    return (
      ext === ".heic" ||
      ext === ".heif" ||
      mimeType === "image/heic" ||
      mimeType === "image/heif"
    );
  }

  async prepareImageForUpload(file, fileBuffer) {
    if (!this.isHeicFile(file)) {
      return {
        buffer: fileBuffer,
        ext: this.getImageExtension(file),
      };
    }

    console.log(`Converting HEIC to JPG before upload: ${file.name}`);
    const convertedBuffer = await heicConvert({
      buffer: fileBuffer,
      format: "JPEG",
      quality: 0.92,
    });

    return {
      buffer: Buffer.from(convertedBuffer),
      ext: ".jpg",
    };
  }

  /**
   * Lấy danh sách ảnh trong folder Google Drive
   */
  async listDriveImagesInFolder(driveClient, folderId) {
    const res = await driveClient.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "files(id, name, mimeType, size)",
      pageSize: 1000,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    return res.data.files || [];
  }

  async downloadDriveFile(driveClient, fileId) {
    const res = await driveClient.files.get(
      {
        fileId,
        alt: "media",
        supportsAllDrives: true,
      },
      { responseType: "arraybuffer" },
    );

    return Buffer.from(res.data);
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  formatErrorForLog(value = "") {
    if (value === null || value === undefined) {
      return "";
    }

    let text = "";
    if (typeof value === "string") {
      text = value;
    } else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }

    return text.replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  getRequestErrorSummary(error) {
    return {
      status: error?.response?.status || "",
      code: error?.code || "",
      detail: this.formatErrorForLog(
        error?.response?.data || error?.message || error,
      ),
    };
  }

  isRetryableRequestError(error) {
    const retryableCodes = new Set([
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNABORTED",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ECONNREFUSED",
      "EPIPE",
    ]);
    const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

    return (
      retryableCodes.has(error?.code) ||
      retryableStatuses.has(error?.response?.status)
    );
  }

  async ensureLocalDirectory(localFolder = "downloads") {
    const dirPath = path.join(__dirname, localFolder);
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }

    return dirPath;
  }

  buildGooglePhotosOriginalImageUrl(rawUrl) {
    const normalizedUrl = this.normalizeExternalUrl(rawUrl)
      .replace(/\\u003d/gi, "=")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/");
    if (!normalizedUrl) {
      return null;
    }

    const [withoutHash] = normalizedUrl.split("#");
    const [baseUrl, queryString = ""] = withoutHash.split("?");
    const originalBaseUrl = baseUrl.replace(/=[^=/?#]+$/i, "");
    return `${originalBaseUrl}=w0${queryString ? `?${queryString}` : ""}`;
  }

  extractGooglePhotosImageUrls(pageHtml) {
    if (!pageHtml) {
      return [];
    }

    const normalizedHtml = pageHtml
      .toString()
      .replace(/\\u003d/gi, "=")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/");
    const rawImageUrls =
      normalizedHtml.match(
        /https?:\/\/lh\d+\.googleusercontent\.com\/[^\s"'<>\\]+/gi,
      ) || [];
    const imageUrls = [];
    const seen = new Set();

    for (const rawUrl of rawImageUrls) {
      let parsedUrl;
      try {
        parsedUrl = new URL(rawUrl);
      } catch {
        continue;
      }

      const hostname = parsedUrl.hostname.toLowerCase();
      if (!hostname.endsWith("googleusercontent.com")) {
        continue;
      }

      if (!/^\/(pw|p)\//i.test(parsedUrl.pathname || "")) {
        continue;
      }

      const originalUrl = this.buildGooglePhotosOriginalImageUrl(rawUrl);
      if (!originalUrl || seen.has(originalUrl)) {
        continue;
      }

      seen.add(originalUrl);
      imageUrls.push(originalUrl);
    }

    return imageUrls;
  }

  async fetchGooglePhotosSharePage(shareLink) {
    if (this.getImageSourceType(shareLink) !== "google_photos_share") {
      throw new Error("Link Google Photos không hợp lệ.");
    }

    let response;
    try {
      response = await axios.get(shareLink, {
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        },
        maxRedirects: 5,
        responseType: "text",
        timeout: 30000,
      });
    } catch (error) {
      const statusCode = error?.response?.status;
      if (statusCode === 404) {
        throw new Error(
          "Không truy cập được album Google Photos. Kiểm tra lại link chia sẻ hoặc quyền public của album.",
        );
      }

      if (statusCode === 401 || statusCode === 403) {
        throw new Error(
          "Google Photos từ chối truy cập album. Kiểm tra lại quyền chia sẻ công khai của link ảnh.",
        );
      }

      throw error;
    }

    const finalUrl =
      response?.request?.res?.responseUrl ||
      response?.request?._redirectable?._currentUrl ||
      shareLink;
    const finalSourceType = this.getImageSourceType(finalUrl);
    if (
      finalSourceType !== "google_photos_share" &&
      finalSourceType !== "direct_image"
    ) {
      throw new Error("Google Photos đã chuyển hướng sang link không hỗ trợ.");
    }

    return {
      html: response.data || "",
      finalUrl: finalUrl,
    };
  }

  async downloadImageByUrl(imageUrl) {
    const response = await axios.get(imageUrl, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      },
      maxRedirects: 5,
      responseType: "arraybuffer",
      timeout: 30000,
    });

    return {
      buffer: Buffer.from(response.data),
      mimeType: response.headers["content-type"] || "",
      size: Number(response.headers["content-length"]) || undefined,
    };
  }

  async uploadImageFiles(imageFiles, room, downloadFile) {
    if (!Array.isArray(imageFiles) || imageFiles.length === 0) {
      return { status: "empty_folder" };
    }

    const photosPrefix = `rooms/${room.id}/photos`;
    const existingObjects = await this.listMinioObjectsByPrefix(
      photosPrefix,
      this.BUCKETNAME,
    );
    const existingCount = existingObjects.length;
    const incomingCount = imageFiles.length;

    if (existingCount > 0 && existingCount === incomingCount) {
      console.log(
        `Room ${room.id} already has ${incomingCount} image(s) on MinIO.`,
      );
      return { status: "already_uploaded", count: incomingCount };
    }

    if (existingCount > 0 && existingCount !== incomingCount) {
      if (incomingCount >= 2) {
        const deletedCount = await this.removeMinioObjectsByPrefix(
          photosPrefix,
          this.BUCKETNAME,
        );
        console.log(
          `Room ${room.id} image count changed ${existingCount} -> ${incomingCount}. Deleted ${deletedCount} old image(s) and re-uploading.`,
        );
      } else {
        console.log(
          `Room ${room.id} image count changed ${existingCount} -> ${incomingCount} but incoming image count < 2, keep existing images.`,
        );
        return {
          status: "keep_existing_low_new_count",
          count: existingCount,
          incomingCount,
        };
      }
    }

    const delayMs = 1000;
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const downloadedFile = await downloadFile(file, i);
      const rawBuffer = Buffer.isBuffer(downloadedFile)
        ? downloadedFile
        : Buffer.isBuffer(downloadedFile?.buffer)
          ? downloadedFile.buffer
          : Buffer.from(downloadedFile?.buffer || []);

      if (!rawBuffer.length) {
        throw new Error(`Không tải được dữ liệu ảnh ${file?.name || i + 1}`);
      }

      const preparedFile = await this.prepareImageForUpload(
        {
          ...file,
          mimeType: downloadedFile?.mimeType || file?.mimeType,
          name: downloadedFile?.name || file?.name || `image_${i + 1}`,
        },
        rawBuffer,
      );
      const objectName = `rooms/${room.id}/photos/${room.id}_${i}${preparedFile.ext}`;
      await this.uploadToMinIO(
        preparedFile.buffer,
        objectName,
        this.BUCKETNAME,
        preparedFile.buffer.length,
      );

      console.log(
        `??? ?????i ${delayMs}ms tr?????c khi t???i ???nh ti???p theo...`,
      );
      await this.sleep(delayMs);
    }

    console.log("??? Upload ho??n t???t!");
    return { status: "uploaded", count: imageFiles.length };
  }

  /**
   * Tải tất cả file trong folder Google Drive về máy
   * @param {string} driveLink - Link thư mục Google Drive
   * @param {string} localFolder - Tên thư mục local để lưu file
   */
  async downloadAllFilesFromDriveFolder(
    driveLink,
    room,
    localFolder = "downloads",
  ) {
    const folderId = this.extractFolderId(driveLink);

    if (!folderId) {
      return {
        status: "invalid_link",
        message: "Không tìm thấy thư mục Google Drive trong link ảnh.",
      };
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: "ggsheets.json",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const driveSources = [
      {
        name: "service_account",
        client: this.createDriveClient(auth),
      },
    ];
    if (this.API_KEY_GGSHEET) {
      driveSources.push({
        name: "api_key",
        client: this.createDriveClient(this.API_KEY_GGSHEET),
      });
    }
    await this.ensureLocalDirectory(localFolder);

    let imageFiles = null;
    let preferredSource = null;
    let lastDriveError = null;
    for (const driveSource of driveSources) {
      try {
        imageFiles = await this.listDriveImagesInFolder(
          driveSource.client,
          folderId,
        );
        preferredSource = driveSource;
        break;
      } catch (error) {
        lastDriveError = error;
        console.warn(
          `[drive] ${driveSource.name} cannot access folder ${folderId}: ${
            error?.message || error
          }`,
        );
      }
    }

    if (!imageFiles || !preferredSource) {
      throw lastDriveError || new Error("Không truy cập được folder ảnh.");
    }

    const sourceOrder = [
      preferredSource,
      ...driveSources.filter((source) => source.name !== preferredSource.name),
    ];
    return this.uploadImageFiles(imageFiles, room, async (file) => {
      let fileBuffer = null;
      let lastDownloadError = null;
      for (const driveSource of sourceOrder) {
        try {
          fileBuffer = await this.downloadDriveFile(
            driveSource.client,
            file.id,
          );
          break;
        } catch (error) {
          lastDownloadError = error;
          if (!this.isGoogleDrivePermissionError(error)) {
            throw error;
          }
          console.warn(
            `[drive] ${driveSource.name} cannot download file ${file.id}: ${
              error?.message || error
            }`,
          );
        }
      }

      if (!fileBuffer) {
        throw lastDownloadError || new Error(`Không tải được file ${file.id}`);
      }

      return {
        buffer: fileBuffer,
        mimeType: file.mimeType,
        name: file.name,
      };
    });
  }

  async downloadAllFilesFromGooglePhotosShare(
    shareLink,
    room,
    localFolder = "downloads",
  ) {
    await this.ensureLocalDirectory(localFolder);
    const sharePage = await this.fetchGooglePhotosSharePage(shareLink);
    if (this.getImageSourceType(sharePage.finalUrl) === "direct_image") {
      return this.downloadDirectImage(sharePage.finalUrl, room, localFolder);
    }

    const imageUrls = this.extractGooglePhotosImageUrls(sharePage.html);
    if (imageUrls.length === 0) {
      return {
        status: "empty_folder",
        message: "Không tìm thấy ảnh công khai trong album Google Photos.",
      };
    }

    console.log(
      `[google_photos] Found ${imageUrls.length} image(s) from shared link.`,
    );
    const imageFiles = imageUrls.map((url, index) => ({
      name: `google_photos_${index + 1}.jpg`,
      mimeType: "image/jpeg",
      url,
    }));

    return this.uploadImageFiles(imageFiles, room, async (file, index) => {
      const downloadedFile = await this.downloadImageByUrl(file.url);
      const mimeType = (downloadedFile.mimeType || "").toLowerCase();
      if (!mimeType.startsWith("image/")) {
        throw new Error(
          `Google Photos trả về file không phải ảnh ở mục ${index + 1}.`,
        );
      }

      return {
        buffer: downloadedFile.buffer,
        mimeType: downloadedFile.mimeType,
        name: file.name,
      };
    });
  }

  async downloadDirectImage(imageUrl, room, localFolder = "downloads") {
    await this.ensureLocalDirectory(localFolder);
    return this.uploadImageFiles(
      [
        {
          name: "direct_image",
          mimeType: "",
          url: imageUrl,
        },
      ],
      room,
      async (file) => {
        const downloadedFile = await this.downloadImageByUrl(file.url);
        const mimeType = (downloadedFile.mimeType || "").toLowerCase();
        if (!mimeType.startsWith("image/")) {
          throw new Error("Link ảnh trực tiếp không trả về file ảnh hợp lệ.");
        }

        return {
          buffer: downloadedFile.buffer,
          mimeType: downloadedFile.mimeType,
          name: file.name,
        };
      },
    );
  }

  async downloadAllFilesFromFolder(imageLink, room, localFolder = "downloads") {
    const sourceType = this.getImageSourceType(imageLink);
    if (sourceType === "drive_folder") {
      return this.downloadAllFilesFromDriveFolder(imageLink, room, localFolder);
    }

    if (sourceType === "google_photos_share") {
      return this.downloadAllFilesFromGooglePhotosShare(
        imageLink,
        room,
        localFolder,
      );
    }

    if (sourceType === "direct_image") {
      return this.downloadDirectImage(imageLink, room, localFolder);
    }

    return {
      status: "unsupported_link",
      message:
        "Link ảnh không được hỗ trợ. Chỉ nhận Google Drive folder, Google Photos share link hoặc googleusercontent image link.",
    };
  }

  convertDescription2Extension(description) {
    const result = new Set();
    const normalizedDesc = description.toLowerCase();

    // Map to hold matched codes with their priority (higher number = more important)
    const matched = new Map();

    for (const [code, patterns] of Object.entries(extension)) {
      for (const pattern of patterns) {
        const regex = new RegExp(`\\b${pattern}\\b`, "i");
        if (regex.test(normalizedDesc)) {
          matched.set(code, true);
          break;
        }
      }
    }

    for (const group of this.priorityGroups) {
      const found = group.find((code) => matched.has(code));
      if (found) {
        result.add(found);
      } else {
        // If none found, add default
        if (group.includes("1N")) result.add("1N");
        if (group.includes("1WC")) result.add("1WC");
      }
    }

    // Add the rest (e.g., BC, GX, 1K)
    for (const code of matched.keys()) {
      if (!this.priorityGroups.flat().includes(code)) {
        result.add(code);
      }
    }

    return Array.from(result);
  }

  async removeVietnameseTones(str) {
    return str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/,/g, "")
      .toLowerCase()
      .trim();
  }

  toSlug(str) {
    return str
      .toLowerCase()
      .replace(/đ/g, "d") // chuyển đ → d
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // bỏ dấu
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
  }

  removeVietnameseTonesSync(str = "") {
    return str
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .replace(/,/g, "")
      .toLowerCase()
      .trim();
  }

  normalizeSheetCellText(value) {
    if (value === undefined || value === null) {
      return "";
    }

    return value
      .toString()
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  sanitizeTextForLegacyApi(value) {
    if (value === undefined || value === null) {
      return "";
    }

    const sanitized = value
      .toString()
      .replace(/[\u{10000}-\u{10FFFF}]/gu, "")
      .replace(/[\u200D\uFE0E\uFE0F]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .trim();

    return this.removeContactPhoneTokens(sanitized);
  }

  removeContactPhoneTokens(value = "") {
    if (!value) {
      return "";
    }

    return value
      .toString()
      .replace(/(?:\+?84|0)(?:[\s().-]*\d){8,12}(?!\d)/g, " ")
      .replace(
        /\b(?:sđt|sdt|zalo|lien\s*he|liên\s*hệ|call|tel|phone)\b\s*[:\-]*/gi,
        " ",
      )
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s+([,.;:])/g, "$1")
      .replace(/^[,;:|.\-\s]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  isSheetHeaderText(value) {
    if (!value) {
      return false;
    }

    const normalized = this.removeVietnameseTonesSync(value).replace(
      /\s+/g,
      " ",
    );
    if (/^(cot|column)\s*\d+$/i.test(normalized)) {
      return true;
    }
    return [
      "dia chi",
      "khu vuc",
      "phong",
      "so phong",
      "gia niem yet",
      "link anh + video",
      "link anh video",
    ].includes(normalized);
  }

  composeAddressFromColumns(row, columns = []) {
    if (!Array.isArray(columns) || columns.length === 0) {
      return "";
    }

    const [primaryColumn, ...extraColumns] = columns;
    const primaryValue = this.normalizeSheetCellText(
      row?.[`field${primaryColumn}`]?.value,
    );
    if (!primaryValue || this.isSheetHeaderText(primaryValue)) {
      return "";
    }

    const parts = [primaryValue];
    const seen = new Set([this.toSlug(primaryValue)]);
    for (const column of extraColumns) {
      const value = this.normalizeSheetCellText(row?.[`field${column}`]?.value);
      if (!value || this.isSheetHeaderText(value)) {
        continue;
      }

      const slug = this.toSlug(value);
      if (!slug || seen.has(slug)) {
        continue;
      }

      if (
        [...seen].some(
          (existing) => existing.includes(slug) || slug.includes(existing),
        )
      ) {
        continue;
      }

      seen.add(slug);
      parts.push(value);
    }

    return parts.join(" - ").trim();
  }

  rowHasConfiguredRoomValue(row = {}, roomColumns = []) {
    if (!Array.isArray(roomColumns) || roomColumns.length === 0) {
      return false;
    }

    return roomColumns.some((column) => {
      if (column === null || column === undefined) {
        return false;
      }

      const value = this.normalizeSheetCellText(row?.[`field${column}`]?.value);
      return Boolean(value);
    });
  }

  rowHasUsableRoomValue(row = {}, roomColumns = [], config = {}) {
    if (!Array.isArray(roomColumns) || roomColumns.length === 0) {
      return false;
    }

    return roomColumns.some((column) => {
      if (column === null || column === undefined) {
        return false;
      }

      const value = this.normalizeSheetCellText(row?.[`field${column}`]?.value);
      if (!value) {
        return false;
      }

      const normalizedRoom = this.normalizeRoomValue(value, config);
      return Boolean(
        normalizedRoom && !this.isLikelySheetNoiseRoom(normalizedRoom),
      );
    });
  }

  isLikelyAddressAnchorText(value = "") {
    const normalized = this.normalizeSheetCellText(value);
    if (!normalized) {
      return false;
    }

    if (this.isSheetHeaderText(normalized)) {
      return false;
    }

    if (this.isLikelySheetNoteAddress(normalized)) {
      return false;
    }

    const collapsed = normalized.replace(/\s+/g, "");
    if (
      /^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?$/.test(collapsed) ||
      /^\d+(?:[.,]\d+)?$/.test(collapsed) ||
      /^\d+(?:[.,]\d+)?\s*(?:tr|trieu|m|k|vnđ|vnd|đ)$/i.test(normalized)
    ) {
      return false;
    }

    if (!/[a-z]/i.test(this.normalizeComparableText(normalized))) {
      return false;
    }

    return true;
  }

  normalizeComparableText(value = "") {
    return this.removeVietnameseTonesSync(this.normalizeSheetCellText(value))
      .replace(/\s+/g, " ")
      .trim();
  }

  isImportRangeFormula(formula = "") {
    const f = formula || "";
    return /\bIMPORTRANGE\s*\(/i.test(f);
  }

  /**
   * Tìm ô chứa tiêu đề "ĐỊA CHỈ:" (có thể lệch sang cột B/C khi IMPORTRANGE).
   * Nếu nhiều ô cùng dòng khớp, lấy ô cuối (banner xếp chồng trên một dòng).
   */
  findAddressBannerTextInRow(row, startCol = 0, colCount = 4) {
    let lastMatch = "";
    for (let c = 0; c < colCount; c++) {
      const colIndex = startCol + c;
      const raw = this.normalizeSheetCellText(row?.[`field${colIndex}`]?.value);
      if (!raw) {
        continue;
      }
      if (/^dia\s*chi\s*:/i.test(this.normalizeComparableText(raw))) {
        lastMatch = raw;
      }
    }
    return lastMatch;
  }

  stripAddressBannerPrefix(rawAddress = "") {
    let address = this.normalizeSheetCellText(rawAddress);
    if (address && address.includes(":")) {
      address = address.split(":").slice(1).join(":").trim();
    }
    return address;
  }

  isLikelySheetNoteAddress(value = "") {
    const normalized = this.normalizeComparableText(value);
    if (!normalized) {
      return true;
    }

    if (this.isSheetHeaderText(value)) {
      return true;
    }

    if (
      [
        /^thong tin toa nha\b/i,
        /^ho tro gia\b/i,
        /\bthanh toan dai han\b/i,
        /^thoi gian ap dung\b/i,
        /^dia diem\b/i,
        /^chuong trinh\b/i,
        /^uu dai\b/i,
        /^khuyen mai\b/i,
        /^top chot phong\b/i,
        /^so phong chot\b/i,
        /^dia chi nha\b/i,
        /^anh+video\b/i,
      ].some((pattern) => pattern.test(normalized))
    ) {
      return true;
    }

    return [
      /^trang\s*\d*$/i,
      /^kinh nho\b/i,
      /^finish$/i,
      /^done$/i,
      /\bdoi tac\b/i,
      /\bghep khach\b/i,
      /^hotline\b/i,
      /^sdt\b/i,
      /^lien he\b/i,
    ].some((pattern) => pattern.test(normalized));
  }

  isLikelySheetNoiseRoom(value = "") {
    const normalized = this.normalizeComparableText(value);
    const rawText = this.normalizeSheetCellText(value);
    if (!normalized) {
      return true;
    }

    if (this.isSheetHeaderText(value)) {
      return true;
    }

    if (/^trang\s*\d*$/i.test(normalized)) {
      return true;
    }

    if (
      [
        /^thong tin toa nha\b/i,
        /^ho tro gia\b/i,
        /\bthanh toan dai han\b/i,
        /^thoi gian ap dung\b/i,
        /^dia diem\b/i,
        /^chuong trinh\b/i,
        /^uu dai\b/i,
        /^khuyen mai\b/i,
        /^top chot phong\b/i,
        /^so phong chot\b/i,
        /^dia chi nha\b/i,
        /^anh+video\b/i,
      ].some((pattern) => pattern.test(normalized))
    ) {
      return true;
    }

    const numberTokens =
      rawText.match(/\d+/g) || normalized.match(/\d+/g) || [];
    const hasExplicitRoomListDelimiter = /[,;|]/.test(rawText);
    const looksLikeRoomCodeList =
      hasExplicitRoomListDelimiter &&
      numberTokens.length >= 2 &&
      numberTokens.every((token) => token.length >= 2 && token.length <= 4);
    if (looksLikeRoomCodeList) {
      return false;
    }

    const digitCount = normalized.replace(/\D/g, "").length;
    const nonNumericRemainder = normalized.replace(/[\d\s().+\-]/g, "");
    if (digitCount >= 8 && !nonNumericRemainder) {
      return true;
    }

    if (/^no$/i.test(normalized)) {
      return true;
    }

    if (/^(?:nha|toa(?:\s*nha)?)\s+[a-z0-9-]+$/i.test(normalized)) {
      return true;
    }

    return [
      /^kinh nho\b/i,
      /^finish$/i,
      /^done$/i,
      /\bdoi tac\b/i,
      /\bghep khach\b/i,
      /^hotline\b/i,
      /^sdt\b/i,
    ].some((pattern) => pattern.test(normalized));
  }

  normalizeRoomValue(roomRaw, config = {}) {
    const roomText = this.normalizeSheetCellText(roomRaw);
    if (!roomText) {
      return "";
    }

    const normalizePrefixedRoomToken = (token = "") => {
      const normalizedToken = this.normalizeSheetCellText(token);
      if (!normalizedToken) {
        return "";
      }

      // Some sheets encode room + address prefix in one token (e.g. N6.39304, 2.27504).
      // Keep only the trailing room digits to avoid creating wrong room names.
      if (/^[a-z]?\d+(?:\.\d+)+$/i.test(normalizedToken)) {
        const groups = normalizedToken.match(/\d+/g) || [];
        if (groups.length >= 2) {
          const lastGroup = groups[groups.length - 1] || "";
          if (/^\d{3,4}$/.test(lastGroup)) {
            return lastGroup;
          }
          if (/^\d{5,}$/.test(lastGroup)) {
            return lastGroup.slice(-3);
          }
        }
      }

      return normalizedToken;
    };

    const normalizedTokens = roomText
      .split(/[,\n;]+/)
      .map((token) => normalizePrefixedRoomToken(token))
      .filter(Boolean);
    if (normalizedTokens.length > 0) {
      return [...new Set(normalizedTokens)].join(", ");
    }

    const shouldUseNumericRooms = Boolean(config?.room_number_only);
    if (!shouldUseNumericRooms) {
      return roomText;
    }

    const minDigits = Number.isFinite(config?.room_number_min_digits)
      ? config.room_number_min_digits
      : 3;
    const maxDigits = Number.isFinite(config?.room_number_max_digits)
      ? config.room_number_max_digits
      : 4;
    const roomMatches =
      roomText.match(new RegExp(`\\b\\d{${minDigits},${maxDigits}}\\b`, "g")) ||
      [];

    return [...new Set(roomMatches)].join(", ");
  }

  splitCombinedRoomPriceByMetadata(cellText = "", metadata = null) {
    if (!metadata?.split) {
      return null;
    }

    const parts = cellText
      .toString()
      .split(metadata.split)
      .map((part) => this.normalizeSheetCellText(part))
      .filter(Boolean);

    if (parts.length < 2) {
      return null;
    }

    const roomIndex = metadata.before === 1 ? 0 : 1;
    const priceIndex = metadata.before === 3 ? 0 : 1;
    const roomRaw = parts[roomIndex] || "";
    const priceRaw = parts[priceIndex] || "";

    if (!roomRaw && !priceRaw) {
      return null;
    }

    return { roomRaw, priceRaw };
  }

  isClosedSharedRoomSegment(value = "") {
    const normalized = this.normalizeComparableText(value);
    if (!normalized) {
      return false;
    }

    return /\b(?:da\s*bay|bay|da\s*chot|da\s*ban|sold|full|kin|het\s*phong)\b/i.test(
      normalized,
    );
  }

  isFutureAvailabilitySegment(value = "") {
    const normalized = this.normalizeComparableText(value);
    if (!normalized) {
      return false;
    }

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentDay = now.getDate();

    const monthMatch = normalized.match(
      /\bhet\s*(?:th|thang)\s*(\d{1,2})\b.*\b(?:vao|vo)\s*(?:o\s*)?duoc\b/i,
    );
    if (monthMatch) {
      const targetMonth = parseInt(monthMatch[1], 10);
      if (Number.isFinite(targetMonth) && targetMonth >= currentMonth) {
        return true;
      }
    }

    const dateMatch = normalized.match(
      /\b(?:tu|sau|vao|vo)\s*(?:ngay\s*)?(\d{1,2})\s*[/-]\s*(\d{1,2})\b/i,
    );
    if (dateMatch) {
      const targetDay = parseInt(dateMatch[1], 10);
      const targetMonth = parseInt(dateMatch[2], 10);
      if (
        Number.isFinite(targetDay) &&
        Number.isFinite(targetMonth) &&
        (targetMonth > currentMonth ||
          (targetMonth === currentMonth && targetDay > currentDay))
      ) {
        return true;
      }
    }

    return false;
  }

  looksLikeNamedRoomLabel(value = "") {
    const normalized = this.normalizeComparableText(value);
    if (!normalized || normalized.length > 60) {
      return false;
    }

    return /\b(?:studio|1k1n|1n1k|1pn|2pn|3pn|duplex|loft|gac\s*xep)\b/i.test(
      normalized,
    );
  }

  extractNamedRoomPriceFromSharedCell(cellValue, config = {}) {
    const cellText = this.normalizeSheetCellText(cellValue);
    if (!cellText) {
      return null;
    }

    const namedMatch = cellText.match(
      /^\s*((?:studio|1k1n|1n1k|1pn|2pn|3pn|duplex|loft|g[aá]c\s*x[ée]p)[^:;|-]{0,20})\s*[:\-]\s*(.+)$/i,
    );
    if (!namedMatch) {
      return null;
    }

    const roomRaw = this.normalizeSheetCellText(namedMatch[1]);
    const priceRaw = this.normalizeSheetCellText(namedMatch[2]);
    if (!roomRaw || !priceRaw) {
      return null;
    }

    const normalizedPrice = this.normalizePriceValue(priceRaw, config);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice < 1000) {
      return null;
    }

    return { roomRaw, priceRaw, sourceText: cellText };
  }

  extractLeadingTextRoomPriceFromSharedCell(cellValue, config = {}) {
    if (!config?.hybrid_prefer_textual_room_label) {
      return null;
    }

    const rawLines = cellValue
      .toString()
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => this.normalizeSheetCellText(line))
      .filter(Boolean);
    const firstLine = rawLines[0] || "";
    if (!firstLine) {
      return null;
    }

    if (
      /^(?:phong\s*)?[a-z]?\d{2,5}(?:\.\d+(?:\+\d+)*)?[a-jl-z]?\b/i.test(
        firstLine,
      )
    ) {
      return null;
    }

    const priceMatch = firstLine.match(
      /(\d+(?:[.,]\d+)?)\s*(trieu|tr|m|cu|k|vnđ|vnd|đ)(\d{0,6})\b/i,
    );
    if (!priceMatch) {
      return null;
    }

    const priceRaw = this.normalizeSheetCellText(priceMatch[0]);
    const normalizedPrice = this.normalizePriceValue(priceRaw, config);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice < 1000) {
      return null;
    }

    const roomRaw = this.normalizeSheetCellText(
      firstLine.slice(0, priceMatch.index || 0),
    )
      .replace(/[\s\-–—:|/.,]+$/g, "")
      .trim();
    if (!roomRaw || !/[a-z]/i.test(this.normalizeComparableText(roomRaw))) {
      return null;
    }

    return {
      roomRaw,
      priceRaw,
      sourceText: firstLine,
    };
  }

  extractRoomPriceFromSharedSegment(segmentValue, config = {}) {
    const segmentText = this.normalizeSheetCellText(segmentValue);
    if (!segmentText || this.isClosedSharedRoomSegment(segmentText)) {
      return null;
    }

    const roomTokenPattern =
      /^(?:phong\s*)?([a-z]?(?:\d{2,5}(?:\.\d+(?:\+\d+)*)?|\d\.\d+(?:\+\d+)*)[a-jl-z]?)\b/i;
    const roomMatch = segmentText.match(roomTokenPattern);
    if (!roomMatch) {
      return null;
    }

    const roomRaw = roomMatch[1]?.trim();
    if (!roomRaw) {
      return null;
    }

    let remainder = segmentText.slice(roomMatch[0].length).trim();
    remainder = remainder.replace(/^[\s\-–—:|/.,]+/g, "").trim();
    const normalizedRemainder = remainder
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (/^(?:gia|price)\b/i.test(normalizedRemainder)) {
      remainder = normalizedRemainder
        .replace(/^(?:gia|price)\s*[:\-]?\s*/i, "")
        .trim();
    }

    if (!remainder || !/^\d/.test(remainder)) {
      return null;
    }

    const normalizedPrice = this.normalizePriceValue(remainder, config);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice < 1000) {
      return null;
    }

    return { roomRaw, priceRaw: remainder, sourceText: segmentText };
  }

  extractRoomPriceEntriesFromSharedCell(cellValue, config = {}) {
    const cellText = this.normalizeSheetCellText(cellValue);
    if (!cellText) {
      return [];
    }

    const metadataSplit = this.splitCombinedRoomPriceByMetadata(
      cellText,
      config?.metadata,
    );
    if (metadataSplit) {
      return [metadataSplit];
    }

    const roomPattern =
      /(?:phong\s*)?[a-z]?(?:\d{2,5}(?:\.\d+(?:\+\d+)*)?|\d\.\d+(?:\+\d+)*)[a-jl-z]?\b/gi;
    const roomStartPattern =
      /^(?:phong\s*)?[a-z]?(?:\d{2,5}(?:\.\d+(?:\+\d+)*)?|\d\.\d+(?:\+\d+)*)[a-jl-z]?\b/i;
    const isPricePrefixSegment = (value = "") => {
      const normalized = this.removeVietnameseTonesSync(
        this.normalizeSheetCellText(value),
      ).toLowerCase();
      return /^(?:gia|price)\b/.test(normalized);
    };

    const rawText = cellValue
      .toString()
      .replace(/\r/g, "\n")
      .replace(
        /\s{2,}(?=(?:phong\s*)?[a-z]?(?:\d{2,5}(?:\.\d+(?:\+\d+)*)?|\d\.\d+(?:\+\d+)*)[a-jl-z]?\b)/gi,
        "\n",
      );
    const baseSegmentsRaw = rawText
      .split(/\n+|[;|]+/)
      .map((segment) => this.normalizeSheetCellText(segment))
      .filter(Boolean);
    const baseSegments = [];
    for (let i = 0; i < baseSegmentsRaw.length; i++) {
      const currentSegment = baseSegmentsRaw[i];
      const nextSegment = baseSegmentsRaw[i + 1];
      if (
        nextSegment &&
        roomStartPattern.test(currentSegment) &&
        isPricePrefixSegment(nextSegment)
      ) {
        baseSegments.push(`${currentSegment} ${nextSegment}`.trim());
        i++;
        continue;
      }

      baseSegments.push(currentSegment);
    }

    const entries = [];
    const leadingTextEntry = this.extractLeadingTextRoomPriceFromSharedCell(
      cellValue,
      config,
    );
    if (leadingTextEntry) {
      entries.push(leadingTextEntry);
    }

    for (const baseSegment of baseSegments) {
      if (!roomStartPattern.test(baseSegment)) {
        continue;
      }

      const roomMatches = [];
      roomPattern.lastIndex = 0;
      let match;
      while ((match = roomPattern.exec(baseSegment)) !== null) {
        roomMatches.push({
          index: match.index,
        });
      }

      if (roomMatches.length <= 1) {
        const entry = this.extractRoomPriceFromSharedSegment(
          baseSegment,
          config,
        );
        if (entry) {
          entries.push(entry);
        }
        continue;
      }

      roomMatches.forEach((roomMatch, index) => {
        const startIndex = roomMatch.index;
        const endIndex =
          index + 1 < roomMatches.length
            ? roomMatches[index + 1].index
            : baseSegment.length;
        const segment = this.normalizeSheetCellText(
          baseSegment.slice(startIndex, endIndex),
        );
        const entry = this.extractRoomPriceFromSharedSegment(segment, config);
        if (entry) {
          entries.push(entry);
        }
      });
    }

    return [
      ...new Map(
        entries.map((entry) => [
          `${entry.roomRaw}|${this.normalizeSheetCellText(entry.priceRaw)}`,
          entry,
        ]),
      ).values(),
    ];
  }

  pickPreferredSharedRoomEntries(entries = [], config = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return [];
    }

    if (!config?.shared_cell_pick_first_open) {
      return entries;
    }

    const availableEntries = entries.filter(
      (entry) => !this.isFutureAvailabilitySegment(entry?.sourceText || ""),
    );
    if (availableEntries.length > 0) {
      return [availableEntries[0]];
    }

    return [entries[0]];
  }

  extractRoomPriceEntries(roomRaw, priceRaw, roomCol, priceCol, config = {}) {
    const normalizedPriceRaw = this.normalizeSheetCellText(priceRaw);
    const shouldTrySharedCellParse =
      roomCol === priceCol || !normalizedPriceRaw;

    if (!shouldTrySharedCellParse) {
      return [{ roomRaw, priceRaw }];
    }

    const sharedEntries = this.extractRoomPriceEntriesFromSharedCell(
      roomRaw,
      config,
    );
    if (sharedEntries.length > 0) {
      return this.pickPreferredSharedRoomEntries(sharedEntries, config);
    }

    const namedEntry = this.extractNamedRoomPriceFromSharedCell(
      roomRaw,
      config,
    );
    if (namedEntry) {
      return [namedEntry];
    }

    if (roomCol === priceCol) {
      return this.looksLikeNamedRoomLabel(roomRaw)
        ? [{ roomRaw, priceRaw: "" }]
        : [];
    }

    return [{ roomRaw, priceRaw }];
  }

  resolvePriceRawFromRow(row, primaryPriceCol, config = {}) {
    const getCellValue = (column) => {
      if (column === null || column === undefined || column === "") {
        return null;
      }
      return row?.[`field${column}`]?.value;
    };

    const primaryValue = getCellValue(primaryPriceCol);
    if (this.normalizeSheetCellText(primaryValue)) {
      return primaryValue;
    }

    const fallbackColumnsRaw = Array.isArray(config?.price_fallback_columns)
      ? config.price_fallback_columns
      : Array.isArray(config?.price_fallback_column)
        ? config.price_fallback_column
        : config?.price_fallback_columns !== undefined
          ? [config.price_fallback_columns]
          : config?.price_fallback_column !== undefined
            ? [config.price_fallback_column]
            : [];

    const fallbackColumns = fallbackColumnsRaw.filter(
      (col) => col !== null && col !== undefined && col !== primaryPriceCol,
    );
    for (const fallbackCol of fallbackColumns) {
      const fallbackValue = getCellValue(fallbackCol);
      if (this.normalizeSheetCellText(fallbackValue)) {
        return fallbackValue;
      }
    }

    return primaryValue;
  }

  extractHyperlinkFromFormula(formulaValue) {
    if (!formulaValue) {
      return null;
    }

    const hyperlinkMatch = formulaValue.match(
      /HYPERLINK\(\s*"([^"]+)"|HYPERLINK\(\s*'([^']+)'/i,
    );
    if (hyperlinkMatch) {
      return hyperlinkMatch[1] || hyperlinkMatch[2] || null;
    }

    const genericUrlMatch = formulaValue.match(/https?:\/\/[^\s"',)]+/i);
    return genericUrlMatch ? genericUrlMatch[0] : null;
  }

  extractHyperlinkFromCell(cell) {
    const chipLink =
      cell?.chipRuns
        ?.map((run) => run?.chip?.richLinkProperties?.uri)
        .find(Boolean) || null;

    return (
      cell?.hyperlink ||
      cell?.userEnteredFormat?.textFormat?.link?.uri ||
      cell?.textFormatRuns?.find((run) => run.format?.link)?.format?.link
        ?.uri ||
      chipLink ||
      this.extractHyperlinkFromFormula(cell?.userEnteredValue?.formulaValue) ||
      null
    );
  }

  normalizeAddressTypoPrefixes(rawAddress = "") {
    const normalized = this.normalizeSheetCellText(rawAddress);
    if (!normalized) {
      return "";
    }

    return normalized
      .replace(/(^|[\s,;])s{2,}(?:ố|o)\s*(\d)/gi, "$1số $2")
      .replace(/(^|[\s,;])s(?:ố|o)\s*(\d)/gi, "$1số $2")
      .replace(/(^|[\s,;])s\s*\/?\s*n\.?\s*(\d)/gi, "$1số $2");
  }

  cleanAddressForMatch(rawAddress) {
    if (!rawAddress) {
      return "";
    }

    const normalizedValue = this.normalizeAddressTypoPrefixes(rawAddress);
    if (!normalizedValue) {
      return "";
    }

    let cleanedAddress = normalizedValue
      .replace(/\b(?:\+?84|0)[\d.\s-]{7,}\d\b/g, (phoneLikeText) => {
        const digits = (phoneLikeText.match(/\d/g) || []).length;
        return digits >= 9 ? " " : phoneLikeText;
      })
      .replace(/\b(?:có|co|không|khong|ko)\s*thang\s*máy\b/gi, " ")
      .replace(/\bthang\s*bộ\b/gi, " ");

    const trailingNoisePatterns = [
      /\b(?:quản\s*lý(?:\s*dẫn)?|quan\s*ly(?:\s*dan)?|ql\s*dẫn|ql\s*dan|quản\s*lý\s*tòa|quan\s*ly\s*toa|liên\s*hệ|lien\s*he|sđt|sdt|zalo|call|tel)\b/i,
      /\b(?:nội\s*thất|noi\s*that|phí\s*dịch\s*vụ|phi\s*dich\s*vu|ghi\s*chú|ghi\s*chu|số\s*người\s*ở|so\s*nguoi\s*o)\b/i,
    ];
    let cutIndex = cleanedAddress.length;
    for (const pattern of trailingNoisePatterns) {
      const match = cleanedAddress.match(pattern);
      if (match && Number.isInteger(match.index) && match.index < cutIndex) {
        cutIndex = match.index;
      }
    }

    if (cutIndex < cleanedAddress.length) {
      cleanedAddress = cleanedAddress.slice(0, cutIndex);
    }

    // Strip trailing room-type suffixes accidentally appended in address cells.
    cleanedAddress = cleanedAddress.replace(
      /\s*(?:[,;|/-]\s*)?(?:\d+\s*n\s*\d*\s*k|studio|gac\s*xep|gac\s*sep|gx|ccmn|chdv)\s*$/i,
      " ",
    );

    return cleanedAddress
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  cleanupAddressAliasText(rawSegment) {
    const cleanedSegment = this.normalizeSheetCellText(rawSegment)
      .replace(
        /^(?:địa\s*chỉ\s*(?:cũ|mới)(?:\s*là)?|dia\s*chi\s*(?:cu|moi)(?:\s*la)?|đc\s*(?:cũ|mới)(?:\s*là)?|dc\s*(?:cu|moi)(?:\s*la)?)\s*[:\-]*/i,
        "",
      )
      .trim();
    return this.cleanAddressForMatch(cleanedSegment);
  }

  expandCompoundRouteAddressVariants(rawAddress) {
    const normalizedValue = this.normalizeSheetCellText(rawAddress);
    if (!normalizedValue) {
      return [];
    }

    const variants = new Set();
    const compoundNgoPattern =
      /\b(?:ngo|ngõ)\s+((?:\d+[a-z]?\s*\/\s*)+\d+[a-z]?)\b/gi;
    const expandedNgoVariant = normalizedValue.replace(
      compoundNgoPattern,
      (match, rawPath) => {
        const pathParts = this.normalizeAddressNumberSignature(rawPath)
          .split("/")
          .filter(Boolean);
        if (pathParts.length < 2) {
          return match;
        }

        const outerPath = pathParts[0];
        const innerPath = pathParts.slice(1).join("/");
        return `ngách ${innerPath}, ngõ ${outerPath}`;
      },
    );

    if (expandedNgoVariant !== normalizedValue) {
      variants.add(expandedNgoVariant);
    }

    return [...variants];
  }

  extractAddressCoreText(rawAddress) {
    const normalizedValue = this.normalizeSheetCellText(rawAddress);
    if (!normalizedValue) {
      return "";
    }

    const segments = normalizedValue
      .split(",")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length <= 1) {
      return this.cleanAddressForMatch(normalizedValue);
    }

    const hasNumberSignal = segments.some((segment) =>
      /\d/.test(this.removeVietnameseTonesSync(segment)),
    );
    if (!hasNumberSignal) {
      return this.cleanAddressForMatch(normalizedValue);
    }

    const firstSegmentKeywordTokens = this.extractAddressKeywordTokens(
      segments[0],
    );
    const minSegmentsToKeep = firstSegmentKeywordTokens.length === 0 ? 2 : 1;
    let keepUntil = segments.length;

    while (keepUntil > minSegmentsToKeep) {
      const trailingSegment = segments[keepUntil - 1];
      const normalizedTrailingSegment =
        this.removeVietnameseTonesSync(trailingSegment);
      if (!normalizedTrailingSegment) {
        keepUntil--;
        continue;
      }

      if (/\d/.test(normalizedTrailingSegment)) {
        break;
      }

      keepUntil--;
    }

    return this.cleanAddressForMatch(
      segments.slice(0, Math.max(minSegmentsToKeep, keepUntil)).join(", "),
    );
  }

  looksLikeAddressCandidate(rawValue = "") {
    const cleanedValue = this.cleanAddressForMatch(rawValue);
    if (!cleanedValue) {
      return false;
    }

    const normalizedValue = this.removeVietnameseTonesSync(cleanedValue);
    return /\d/.test(normalizedValue) && /[a-z]/i.test(normalizedValue);
  }

  getAddressVariants(rawAddress) {
    const cacheKey = this.normalizeSheetCellText(rawAddress);
    if (!cacheKey) {
      return [];
    }

    if (this.addressVariantCache.has(cacheKey)) {
      return this.addressVariantCache.get(cacheKey);
    }

    const variants = [];
    const seen = new Set();
    const pushVariant = (value) => {
      const cleanedValue = this.cleanAddressForMatch(value);
      if (!cleanedValue) {
        return;
      }

      const normalizedKey = this.removeVietnameseTonesSync(cleanedValue);
      if (!normalizedKey || seen.has(normalizedKey)) {
        return;
      }

      seen.add(normalizedKey);
      variants.push(cleanedValue);
    };

    const pushVariantWithExpansions = (value) => {
      pushVariant(value);
      this.expandCompoundRouteAddressVariants(value).forEach(pushVariant);
    };

    pushVariantWithExpansions(cacheKey);

    const dashSegments = cacheKey
      .split(/\s+[–—-]\s+/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (dashSegments.length > 1) {
      for (let index = 1; index < dashSegments.length; index++) {
        const prefixVariant = dashSegments.slice(0, index).join(" - ").trim();
        if (this.looksLikeAddressCandidate(prefixVariant)) {
          pushVariantWithExpansions(prefixVariant);
        }
      }
    }

    const parentheticalMatches = cacheKey.match(/\([^)]*\)/g) || [];
    for (const rawMatch of parentheticalMatches) {
      const aliasValue = this.cleanupAddressAliasText(
        rawMatch.replace(/[()]/g, " "),
      );
      if (this.looksLikeAddressCandidate(aliasValue)) {
        pushVariantWithExpansions(aliasValue);
      }
    }

    const aliasPattern =
      /\b(?:địa\s*chỉ\s*(?:cũ|mới)(?:\s*là)?|dia\s*chi\s*(?:cu|moi)(?:\s*la)?|đc\s*(?:cũ|mới)(?:\s*là)?|dc\s*(?:cu|moi)(?:\s*la)?)\s*[:\-]*/i;
    const aliasMatch = cacheKey.match(aliasPattern);
    if (aliasMatch && Number.isInteger(aliasMatch.index)) {
      const aliasValue = this.cleanupAddressAliasText(
        cacheKey.slice(aliasMatch.index + aliasMatch[0].length),
      );
      if (this.looksLikeAddressCandidate(aliasValue)) {
        pushVariantWithExpansions(aliasValue);
      }
    }

    this.addressVariantCache.set(cacheKey, variants);
    return variants;
  }

  extractAddressCompoundNumbers(rawAddress) {
    const normalizedAddress = this.removeVietnameseTonesSync(
      this.cleanAddressForMatch(rawAddress),
    );
    const matches =
      normalizedAddress.match(/\d+[a-z]?(?:[/.-]\d+[a-z]?)+\b/g) || [];
    return [
      ...new Set(
        matches
          .map((match) => this.normalizeAddressNumberSignature(match))
          .filter(Boolean),
      ),
    ];
  }

  extractAddressNumberTokens(rawAddress) {
    const normalizedAddress = this.removeVietnameseTonesSync(
      this.cleanAddressForMatch(rawAddress),
    );
    const matches =
      normalizedAddress.match(/\d+[a-z]?(?:[/.-]\d+[a-z]?)*\b/g) || [];
    const tokens = new Set();

    for (const match of matches) {
      const normalizedToken = this.normalizeAddressNumberSignature(match);
      if (!normalizedToken) {
        continue;
      }

      tokens.add(normalizedToken);
      normalizedToken
        .split("/")
        .filter(Boolean)
        .forEach((part) => tokens.add(part));
    }

    return [...tokens];
  }

  extractLeadingAddressPathSegments(rawAddress) {
    const normalizedAddress = this.removeVietnameseTonesSync(
      this.cleanAddressForMatch(rawAddress),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!normalizedAddress) {
      return [];
    }

    const addressCore = normalizedAddress
      .replace(/^(?:so|nha(?:\s+so)?|so\s+nha)\s+/i, "")
      .trim();
    const leadingPathMatch =
      normalizedAddress.match(/^(\d+[a-z]?(?:[/.-]\d+[a-z]?)+)\b/i) ||
      addressCore.match(/^(\d+[a-z]?(?:[/.-]\d+[a-z]?)+)\b/i);
    if (!leadingPathMatch) {
      return [];
    }

    const normalizedPath = this.normalizeAddressNumberSignature(
      leadingPathMatch[1],
    );
    if (!normalizedPath) {
      return [];
    }

    return normalizedPath.split("/").filter(Boolean);
  }

  extractAddressRouteNumberTokens(rawAddress) {
    const normalizedAddress = this.removeVietnameseTonesSync(
      this.cleanAddressForMatch(rawAddress),
    )
      .replace(/\s+/g, " ")
      .trim();
    const routeMatches = [
      ...normalizedAddress.matchAll(
        /\b(?:ngo|ngach|hem|pho|duong|ngoach|toa|toa nha|lk|lo)\s+(\d+[a-z]?(?:[/.-]\d+[a-z]?)+|\d+[a-z]*)\b/gi,
      ),
    ];
    const routeTokens = new Set(
      routeMatches
        .map((match) => this.normalizeAddressNumberSignature(match[1]))
        .filter(Boolean),
    );

    if (routeTokens.size === 0) {
      const leadingPathSegments =
        this.extractLeadingAddressPathSegments(rawAddress);
      if (leadingPathSegments.length > 1) {
        leadingPathSegments
          .slice(1)
          .forEach((segment) => routeTokens.add(segment));
      }
    }

    return [...routeTokens];
  }

  extractAddressHouseNumber(rawAddress) {
    const normalizedAddress = this.removeVietnameseTonesSync(
      this.cleanAddressForMatch(rawAddress),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!normalizedAddress) {
      return "";
    }

    const explicitHouseNumberMatch = normalizedAddress.match(
      /\b(?:nha|so|sn|so\s+nha|nha\s+so)\s+(\d+[a-z]*)\b/i,
    );
    if (explicitHouseNumberMatch) {
      return this.normalizeAddressNumberSignature(explicitHouseNumberMatch[1]);
    }

    const prefixedHouseNumberMatch = normalizedAddress.match(
      /^(?:so|sn)\s*(\d+[a-z]*)\b/i,
    );
    if (prefixedHouseNumberMatch) {
      return this.normalizeAddressNumberSignature(prefixedHouseNumberMatch[1]);
    }

    const leadingHouseNumberMatch = normalizedAddress.match(/^(\d+[a-z]*)\b/i);
    if (leadingHouseNumberMatch) {
      return this.normalizeAddressNumberSignature(leadingHouseNumberMatch[1]);
    }

    const looseNumberMatches = [
      ...normalizedAddress.matchAll(/\b(\d+[a-z]*)\b/gi),
    ].map((match) => match[1]);
    if (looseNumberMatches.length === 1) {
      return this.normalizeAddressNumberSignature(looseNumberMatches[0]);
    }

    return "";
  }

  buildAddressMatchProfile(rawAddress) {
    const cacheKey = this.normalizeSheetCellText(rawAddress);
    if (!cacheKey) {
      return null;
    }

    if (this.addressMatchProfileCache.has(cacheKey)) {
      return this.addressMatchProfileCache.get(cacheKey);
    }

    const cleanedAddress = this.cleanAddressForMatch(cacheKey);
    if (!cleanedAddress) {
      this.addressMatchProfileCache.set(cacheKey, null);
      return null;
    }

    const coreAddress =
      this.extractAddressCoreText(cleanedAddress) || cleanedAddress;
    const normalizedAddress = this.removeVietnameseTonesSync(cleanedAddress)
      .replace(/[():,\\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const coreNormalizedAddress = this.removeVietnameseTonesSync(coreAddress)
      .replace(/[():,\\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const keywordTokens = this.extractAddressKeywordTokens(cleanedAddress);
    const coreKeywordTokens = this.extractAddressKeywordTokens(coreAddress);
    const numberTokens = this.extractAddressNumberTokens(cleanedAddress);
    const routeNumbers = this.extractAddressRouteNumberTokens(cleanedAddress);
    const compoundNumbers = this.extractAddressCompoundNumbers(cleanedAddress);
    const houseNumber = this.extractAddressHouseNumber(cleanedAddress);
    const profile = {
      rawAddress: cacheKey,
      cleanedAddress,
      coreAddress,
      normalizedAddress,
      coreNormalizedAddress,
      slug: this.toSlug(cleanedAddress),
      keywordTokens,
      coreKeywordTokens,
      numberTokens,
      routeNumbers,
      compoundNumbers,
      houseNumber,
    };

    this.addressMatchProfileCache.set(cacheKey, profile);
    return profile;
  }

  getCandidateAddressVariants(candidate) {
    if (!candidate) {
      return [];
    }

    const sources = [
      candidate?.address,
      candidate?.address_valid,
      candidate?.searchableAddress,
      candidate?.name,
    ];
    const variants = [];
    const seen = new Set();

    for (const source of sources) {
      for (const variant of this.getAddressVariants(source)) {
        const normalizedVariant = this.removeVietnameseTonesSync(variant);
        if (!normalizedVariant || seen.has(normalizedVariant)) {
          continue;
        }

        seen.add(normalizedVariant);
        variants.push(variant);
      }
    }

    return variants;
  }

  normalizeAddressNumberSignature(rawValue = "") {
    const compactValue = rawValue
      .toString()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[.-]+/g, "/")
      .replace(/[^a-z0-9/]/g, "");
    if (!compactValue) {
      return "";
    }

    return compactValue
      .split("/")
      .filter(Boolean)
      .map((part) => {
        const numericSuffixMatch = part.match(/^(\d+)([a-z]*)$/i);
        if (!numericSuffixMatch) {
          return part;
        }

        const normalizedNumber = String(
          parseInt(numericSuffixMatch[1], 10) || 0,
        );
        return `${normalizedNumber}${numericSuffixMatch[2] || ""}`;
      })
      .join("/");
  }

  extractPrimaryAddressNumberSignature(rawAddress) {
    const normalizedSource = this.removeVietnameseTonesSync(
      this.cleanAddressForMatch(rawAddress),
    )
      .toLowerCase()
      .replace(/[:,-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const explicitHouseNumberMatch = normalizedSource.match(
      /\b(?:nha|so|sn|so\s+nha|nha\s+so)\s+(\d+[a-z]*)\b/i,
    );
    const explicitHouseNumber = explicitHouseNumberMatch
      ? this.normalizeAddressNumberSignature(explicitHouseNumberMatch[1])
      : "";

    const normalized = normalizedSource
      .toLowerCase()
      .replace(
        /\b(dia chi|so nha|nha so|sn|so|nha|san van phong|toa nha)\b/g,
        " ",
      )
      .replace(/[:,-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) {
      return "";
    }

    const compoundNumberMatch = normalized.match(
      /\b(\d+[a-z]?(?:[/.-]\d+[a-z]?)+)\b/i,
    );
    if (compoundNumberMatch) {
      const compoundSignature = this.normalizeAddressNumberSignature(
        compoundNumberMatch[1],
      );
      if (explicitHouseNumber) {
        return `${explicitHouseNumber}|${compoundSignature}`;
      }
      return compoundSignature;
    }

    const match = normalized.match(/^(\d+[a-z]?(?:\/\d+[a-z]?)*)\b/i);
    if (match) {
      const normalizedMatch = this.normalizeAddressNumberSignature(match[1]);
      if (explicitHouseNumber && explicitHouseNumber !== normalizedMatch) {
        return `${explicitHouseNumber}|${normalizedMatch}`;
      }
      return explicitHouseNumber || normalizedMatch;
    }

    const fallbackMatches = normalized.match(/\d+[a-z]?(?:\/\d+[a-z]?)*\b/g);
    if (!fallbackMatches || fallbackMatches.length === 0) {
      return explicitHouseNumber || "";
    }

    const fallbackSignature = this.normalizeAddressNumberSignature(
      fallbackMatches[fallbackMatches.length - 1],
    );
    if (explicitHouseNumber && explicitHouseNumber !== fallbackSignature) {
      return `${explicitHouseNumber}|${fallbackSignature}`;
    }

    return explicitHouseNumber || fallbackSignature;
  }

  extractAddressKeywordTokens(rawAddress) {
    const normalized = this.removeVietnameseTonesSync(
      this.cleanAddressForMatch(rawAddress),
    )
      .replace(/[.:/\\(),-]/g, " ")
      .replace(
        /\b(dia|chi|so|nha|sn|san|van|phong|vp|toa|duong|pho|ngo|ngach|hem|khu|do|thi|kdt|lk|lo|can|ho|mat|bang|kinh|doanh)\b/g,
        " ",
      )
      .replace(/\d+[a-z]?/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) {
      return [];
    }

    return [
      ...new Set(normalized.split(" ").filter((token) => token.length >= 2)),
    ];
  }

  getAddressKeywordOverlapScore(searchTokens, candidateAddress) {
    if (!Array.isArray(searchTokens) || searchTokens.length === 0) {
      return 0;
    }

    const candidateTokens = new Set(
      this.extractAddressKeywordTokens(candidateAddress),
    );
    if (candidateTokens.size === 0) {
      return 0;
    }

    return searchTokens.filter((token) => candidateTokens.has(token)).length;
  }

  normalizeArticleAddressText(rawAddress) {
    return this.removeVietnameseTonesSync(rawAddress)
      .replace(/[.:/\\(),-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  extractArticleAddressTokens(rawAddress) {
    const normalized = this.normalizeArticleAddressText(rawAddress)
      .replace(
        /\b(tang|toa|toa nha|nha|so|duong|pho|ngo|ngach|hem|phuong|quan|tp|thanh pho)\b/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) {
      return [];
    }

    return [
      ...new Set(normalized.split(" ").filter((token) => token.length >= 2)),
    ];
  }

  getTokenCoverageRatio(sourceTokens = [], candidateTokens = []) {
    if (!Array.isArray(sourceTokens) || sourceTokens.length === 0) {
      return 0;
    }

    const candidateTokenSet = new Set(candidateTokens || []);
    if (candidateTokenSet.size === 0) {
      return 0;
    }

    const overlapCount = sourceTokens.filter((token) =>
      candidateTokenSet.has(token),
    ).length;
    return overlapCount / Math.max(sourceTokens.length, candidateTokenSet.size);
  }

  getArticleAddressSimilarity(searchTerm, candidateAddress) {
    const normalizedSearchAddress =
      this.normalizeArticleAddressText(searchTerm);
    const normalizedCandidateAddress =
      this.normalizeArticleAddressText(candidateAddress);

    if (!normalizedSearchAddress || !normalizedCandidateAddress) {
      return 0;
    }

    if (
      normalizedSearchAddress === normalizedCandidateAddress ||
      normalizedSearchAddress.includes(normalizedCandidateAddress) ||
      normalizedCandidateAddress.includes(normalizedSearchAddress)
    ) {
      return 1;
    }

    const searchTokens = this.extractArticleAddressTokens(searchTerm);
    const candidateTokens = this.extractArticleAddressTokens(candidateAddress);
    if (searchTokens.length === 0 || candidateTokens.length === 0) {
      return 0;
    }

    return this.getTokenCoverageRatio(searchTokens, candidateTokens);
  }

  extractTrailingAddressTokens(rawAddress) {
    const segments = this.normalizeSheetCellText(rawAddress)
      .split(",")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      return [];
    }

    const trailingSegment = segments[segments.length - 1];
    if (!trailingSegment || /\d/.test(trailingSegment)) {
      return [];
    }

    return this.normalizeArticleAddressText(trailingSegment)
      .split(" ")
      .filter((token) => token.length >= 2);
  }

  hasCompatibleTrailingAddress(searchTerm, candidateAddress) {
    const searchTrailingTokens = this.extractTrailingAddressTokens(searchTerm);
    const candidateTrailingTokens =
      this.extractTrailingAddressTokens(candidateAddress);

    if (
      searchTrailingTokens.length === 0 ||
      candidateTrailingTokens.length === 0
    ) {
      return true;
    }

    return searchTrailingTokens.some((token) =>
      candidateTrailingTokens.includes(token),
    );
  }

  getCandidateAddressMatchText(candidate) {
    return (
      candidate?.item?.address ||
      candidate?.item?.searchableAddress ||
      candidate?.item?.address_valid ||
      candidate?.item?.name ||
      candidate?.address ||
      candidate?.searchableAddress ||
      candidate?.address_valid ||
      candidate?.name ||
      ""
    );
  }

  areNumberPathsCompatible(firstValue = "", secondValue = "") {
    if (!firstValue || !secondValue) {
      return false;
    }

    if (firstValue === secondValue) {
      return true;
    }

    const firstParts = firstValue.split("/").filter(Boolean);
    const secondParts = secondValue.split("/").filter(Boolean);
    const shorterParts =
      firstParts.length <= secondParts.length ? firstParts : secondParts;
    const longerParts =
      firstParts.length > secondParts.length ? firstParts : secondParts;

    if (shorterParts.every((part, index) => longerParts[index] === part)) {
      return true;
    }

    const maxStartIndex = longerParts.length - shorterParts.length;
    for (let startIndex = 0; startIndex <= maxStartIndex; startIndex++) {
      const isContiguousSubPath = shorterParts.every(
        (part, index) => longerParts[startIndex + index] === part,
      );
      if (isContiguousSubPath) {
        return true;
      }
    }

    return false;
  }

  hasCompatibleCompoundNumbers(searchNumbers = [], candidateNumbers = []) {
    if (!Array.isArray(searchNumbers) || searchNumbers.length === 0) {
      return true;
    }

    if (!Array.isArray(candidateNumbers) || candidateNumbers.length === 0) {
      return true;
    }

    return searchNumbers.some((searchNumber) =>
      candidateNumbers.some((candidateNumber) =>
        this.areNumberPathsCompatible(searchNumber, candidateNumber),
      ),
    );
  }

  getCompatibleNumberPathCoverage(searchNumbers = [], candidateNumbers = []) {
    if (!Array.isArray(searchNumbers) || searchNumbers.length === 0) {
      return 0;
    }

    if (!Array.isArray(candidateNumbers) || candidateNumbers.length === 0) {
      return 0;
    }

    const normalizedCandidateNumbers = [
      ...new Set(candidateNumbers.filter(Boolean)),
    ];
    if (normalizedCandidateNumbers.length === 0) {
      return 0;
    }

    const matchedCount = searchNumbers.filter((searchNumber) =>
      normalizedCandidateNumbers.some((candidateNumber) =>
        this.areNumberPathsCompatible(searchNumber, candidateNumber),
      ),
    ).length;

    return matchedCount / searchNumbers.length;
  }

  getAddressMatchThreshold(config = {}) {
    const configuredThresholds = [
      config.address_match_threshold,
      config.article_address_similarity_threshold,
    ];

    for (const threshold of configuredThresholds) {
      const numericThreshold = Number(threshold);
      if (Number.isFinite(numericThreshold) && numericThreshold > 0) {
        return numericThreshold;
      }
    }

    return 0.72;
  }

  scoreAddressProfiles(searchProfile, candidateProfile, config = {}) {
    if (!searchProfile || !candidateProfile) {
      return {
        accepted: false,
        matchScore: 0,
        rejectReason: "missing_profile",
      };
    }

    const searchKeywordTokens = searchProfile.keywordTokens || [];
    const candidateKeywordTokens = candidateProfile.keywordTokens || [];
    const searchCoreKeywordTokens = searchProfile.coreKeywordTokens || [];
    const candidateCoreKeywordTokens = candidateProfile.coreKeywordTokens || [];
    const searchNumberTokens = searchProfile.numberTokens || [];
    const candidateNumberTokens = candidateProfile.numberTokens || [];
    const searchRouteNumbers = searchProfile.routeNumbers || [];
    const candidateRouteNumbers = candidateProfile.routeNumbers || [];
    const searchCompoundNumbers = searchProfile.compoundNumbers || [];
    const candidateCompoundNumbers = candidateProfile.compoundNumbers || [];
    const houseNumberMismatch =
      searchProfile.houseNumber &&
      candidateProfile.houseNumber &&
      searchProfile.houseNumber !== candidateProfile.houseNumber;
    if (houseNumberMismatch) {
      return {
        accepted: false,
        matchScore: 0,
        rejectReason: "house_number_mismatch",
      };
    }

    const searchNumberTokenSet = new Set(searchNumberTokens);
    const candidateNumberTokenSet = new Set(candidateNumberTokens);
    const overlappingNumberTokens = searchNumberTokens.filter((token) =>
      candidateNumberTokenSet.has(token),
    );
    if (
      searchNumberTokenSet.size > 0 &&
      candidateNumberTokenSet.size > 0 &&
      overlappingNumberTokens.length === 0
    ) {
      return {
        accepted: false,
        matchScore: 0,
        rejectReason: "number_token_mismatch",
      };
    }

    if (
      !this.hasCompatibleCompoundNumbers(
        searchCompoundNumbers,
        candidateCompoundNumbers,
      )
    ) {
      return {
        accepted: false,
        matchScore: 0,
        rejectReason: "compound_number_mismatch",
      };
    }

    const fullKeywordCoverage = this.getTokenCoverageRatio(
      searchKeywordTokens,
      candidateKeywordTokens,
    );
    const reverseFullKeywordCoverage = this.getTokenCoverageRatio(
      candidateKeywordTokens,
      searchKeywordTokens,
    );
    const fullKeywordScore =
      searchKeywordTokens.length > 0
        ? Math.min(
            1,
            (fullKeywordCoverage * 2 + reverseFullKeywordCoverage) / 3,
          )
        : 0;
    const coreKeywordCoverage = this.getTokenCoverageRatio(
      searchCoreKeywordTokens,
      candidateCoreKeywordTokens,
    );
    const reverseCoreKeywordCoverage = this.getTokenCoverageRatio(
      candidateCoreKeywordTokens,
      searchCoreKeywordTokens,
    );
    const coreKeywordScore =
      searchCoreKeywordTokens.length > 0
        ? Math.min(
            1,
            (coreKeywordCoverage * 2 + reverseCoreKeywordCoverage) / 3,
          )
        : 0;
    const keywordCoverage = Math.max(fullKeywordCoverage, coreKeywordCoverage);
    const keywordScore = Math.max(fullKeywordScore, coreKeywordScore);
    const numberCoverage = this.getTokenCoverageRatio(
      searchNumberTokens,
      candidateNumberTokens,
    );
    const reverseNumberCoverage = this.getTokenCoverageRatio(
      candidateNumberTokens,
      searchNumberTokens,
    );
    const numberScore =
      searchNumberTokens.length > 0
        ? Math.min(1, (numberCoverage * 2 + reverseNumberCoverage) / 3)
        : 0;
    const routeCoverageCandidates =
      candidateRouteNumbers.length > 0
        ? candidateRouteNumbers
        : [...candidateCompoundNumbers, ...candidateNumberTokens];
    const routeCoverage =
      searchRouteNumbers.length > 0
        ? this.getCompatibleNumberPathCoverage(
            searchRouteNumbers,
            routeCoverageCandidates,
          )
        : 0;
    let houseScore = 0;
    if (searchProfile.houseNumber || candidateProfile.houseNumber) {
      if (
        searchProfile.houseNumber &&
        candidateProfile.houseNumber &&
        searchProfile.houseNumber === candidateProfile.houseNumber
      ) {
        houseScore = 1;
      } else if (
        searchProfile.houseNumber &&
        candidateNumberTokenSet.has(searchProfile.houseNumber)
      ) {
        houseScore = 0.85;
      } else if (
        candidateProfile.houseNumber &&
        searchNumberTokenSet.has(candidateProfile.houseNumber)
      ) {
        houseScore = 0.75;
      }
    }

    const normalizedSearchAddress = searchProfile.normalizedAddress || "";
    const normalizedCandidateAddress = candidateProfile.normalizedAddress || "";
    const normalizedSearchCoreAddress =
      searchProfile.coreNormalizedAddress || "";
    const normalizedCandidateCoreAddress =
      candidateProfile.coreNormalizedAddress || "";
    const exactTextScore =
      (normalizedSearchAddress &&
        normalizedCandidateAddress &&
        (normalizedSearchAddress === normalizedCandidateAddress ||
          normalizedSearchAddress.includes(normalizedCandidateAddress) ||
          normalizedCandidateAddress.includes(normalizedSearchAddress))) ||
      (normalizedSearchCoreAddress &&
        normalizedCandidateCoreAddress &&
        (normalizedSearchCoreAddress === normalizedCandidateCoreAddress ||
          normalizedSearchCoreAddress.includes(
            normalizedCandidateCoreAddress,
          ) ||
          normalizedCandidateCoreAddress.includes(normalizedSearchCoreAddress)))
        ? 1
        : 0;
    const scoringComponents = [];
    if (searchKeywordTokens.length > 0) {
      scoringComponents.push({ weight: 4, score: keywordScore });
    }
    if (searchNumberTokens.length > 0 || candidateNumberTokens.length > 0) {
      scoringComponents.push({ weight: 3, score: numberScore });
    }
    if (searchProfile.houseNumber || candidateProfile.houseNumber) {
      scoringComponents.push({ weight: 3, score: houseScore });
    }
    if (searchRouteNumbers.length > 0 || candidateRouteNumbers.length > 0) {
      scoringComponents.push({ weight: 2, score: routeCoverage });
    }
    scoringComponents.push({ weight: 1, score: exactTextScore });

    const totalWeight = scoringComponents.reduce(
      (sum, component) => sum + component.weight,
      0,
    );
    const matchScore =
      totalWeight > 0
        ? scoringComponents.reduce(
            (sum, component) => sum + component.weight * component.score,
            0,
          ) / totalWeight
        : 0;
    const keywordThreshold = searchKeywordTokens.length >= 3 ? 0.45 : 0.3;
    const numberThreshold = searchNumberTokens.length > 0 ? 0.3 : 0;
    const threshold = this.getAddressMatchThreshold(config);
    const rejectReason =
      matchScore < threshold
        ? "score_below_threshold"
        : keywordCoverage < keywordThreshold
          ? "keyword_below_threshold"
          : numberScore < numberThreshold
            ? "number_below_threshold"
            : null;

    return {
      accepted: !rejectReason,
      matchScore,
      exactTextScore,
      keywordCoverage,
      numberScore,
      routeCoverage,
      houseScore,
      rejectReason,
    };
  }

  scoreAddressCandidate(searchTerm, candidate, config = {}) {
    const candidateItem = candidate?.item || candidate;
    if (!candidateItem) {
      return null;
    }

    const searchVariants = this.getAddressVariants(searchTerm);
    const candidateVariants = this.getCandidateAddressVariants(candidateItem);
    if (searchVariants.length === 0 || candidateVariants.length === 0) {
      return null;
    }

    let bestMatch = null;
    for (const searchVariant of searchVariants) {
      const searchProfile = this.buildAddressMatchProfile(searchVariant);
      if (!searchProfile) {
        continue;
      }

      for (const candidateVariant of candidateVariants) {
        const candidateProfile =
          this.buildAddressMatchProfile(candidateVariant);
        if (!candidateProfile) {
          continue;
        }

        const scoreResult = this.scoreAddressProfiles(
          searchProfile,
          candidateProfile,
          config,
        );
        const shouldReplaceBestMatch =
          !bestMatch ||
          (scoreResult.accepted && !bestMatch.accepted) ||
          (scoreResult.accepted === bestMatch.accepted &&
            (scoreResult.matchScore > bestMatch.matchScore ||
              (scoreResult.matchScore === bestMatch.matchScore &&
                scoreResult.exactTextScore > bestMatch.exactTextScore)));
        if (shouldReplaceBestMatch) {
          bestMatch = {
            ...scoreResult,
            item: candidateItem,
            searchVariant,
            candidateVariant,
          };
        }
      }
    }

    return bestMatch;
  }

  isArticleAddressCompatible(searchTerm, candidateAddress, config = {}) {
    if (config.article_address_match_mode === "similarity_threshold") {
      const configuredThreshold = Number(
        config.article_address_similarity_threshold,
      );
      const similarityThreshold = Number.isFinite(configuredThreshold)
        ? configuredThreshold
        : 0.7;
      return (
        this.getArticleAddressSimilarity(searchTerm, candidateAddress) >=
        similarityThreshold
      );
    }

    const normalizedSearchAddress =
      this.normalizeArticleAddressText(searchTerm);
    const normalizedCandidateAddress =
      this.normalizeArticleAddressText(candidateAddress);

    if (!normalizedSearchAddress || !normalizedCandidateAddress) {
      return false;
    }

    if (
      normalizedSearchAddress === normalizedCandidateAddress ||
      normalizedSearchAddress.includes(normalizedCandidateAddress) ||
      normalizedCandidateAddress.includes(normalizedSearchAddress)
    ) {
      return true;
    }

    if (!this.hasCompatibleTrailingAddress(searchTerm, candidateAddress)) {
      return false;
    }

    const searchTokens = this.extractArticleAddressTokens(searchTerm);
    const candidateTokens = new Set(
      this.extractArticleAddressTokens(candidateAddress),
    );
    if (searchTokens.length === 0 || candidateTokens.size === 0) {
      return false;
    }

    const overlapCount = searchTokens.filter((token) =>
      candidateTokens.has(token),
    ).length;
    return overlapCount / searchTokens.length >= 0.6;
  }

  filterRealnewsForMatching(list = [], config = {}) {
    if (!Array.isArray(list) || list.length === 0) {
      return [];
    }

    if (!config.only_match_listed_realnews) {
      return list;
    }

    return list.filter((item) => Boolean(item?.is_list));
  }

  selectBestAddressMatch(searchTerm, matches = [], config = {}) {
    if (!Array.isArray(matches) || matches.length === 0) {
      return null;
    }

    const scoredMatches = matches
      .map((match) => this.scoreAddressCandidate(searchTerm, match, config))
      .filter(Boolean)
      .sort((a, b) => {
        if (a.accepted !== b.accepted) {
          return a.accepted ? -1 : 1;
        }
        if (b.matchScore !== a.matchScore) {
          return b.matchScore - a.matchScore;
        }
        if (b.exactTextScore !== a.exactTextScore) {
          return b.exactTextScore - a.exactTextScore;
        }
        return 0;
      });

    return scoredMatches[0] || null;
  }

  getBuildingSearchAddress(item) {
    return this.cleanAddressForMatch(
      item?.address || item?.address_valid || item?.name || "",
    );
  }

  async fuzzySearch(searchTerm, list, config = {}) {
    // if (searchTerm.includes('Ngõ 52 Quan Nhân')) console.log(searchTerm);

    const processedSearchTerm = this.normalizeSheetCellText(searchTerm);
    if (!processedSearchTerm) {
      return null;
    }
    const normalizedSearchKey =
      this.normalizeComparableText(processedSearchTerm);
    const configuredAliases = config?.address_aliases || {};
    const aliasSearchTerm =
      Object.entries(configuredAliases).find(
        ([alias]) =>
          this.normalizeComparableText(alias) === normalizedSearchKey,
      )?.[1] || processedSearchTerm;
    const searchableList = this.filterRealnewsForMatching(list, config).map(
      (item) => ({
        ...item,
        address: item?.address || item?.address_valid || item?.name || "",
        searchableAddress: this.getBuildingSearchAddress(item),
      }),
    );
    const selectedResult = this.selectBestAddressMatch(
      aliasSearchTerm,
      searchableList,
      config,
    );
    if (selectedResult?.item) {
      const normalizedSearchTerm =
        this.normalizeComparableText(processedSearchTerm);
      const normalizedCandidateAddress = this.normalizeComparableText(
        selectedResult.candidateVariant || "",
      );
      const keywordTokens =
        this.extractAddressKeywordTokens(processedSearchTerm);
      if (
        config?.require_address_detail_for_match &&
        normalizedSearchTerm &&
        !/\d/.test(normalizedSearchTerm) &&
        keywordTokens.length <= 1 &&
        normalizedSearchTerm !== normalizedCandidateAddress
      ) {
        if (this.verboseRuntimeLogs) {
          console.warn(
            `[address-match] Bo qua match "${searchTerm}" vi dia chi qua chung chung cho ${
              config?.web || "sheet"
            } (${selectedResult.candidateVariant})`,
          );
        }
        return null;
      }
    }
    if (selectedResult?.accepted && selectedResult?.item) {
      if (this.verboseRuntimeLogs) {
        console.log(
          `Chuoi gan nhat: ${
            selectedResult.candidateVariant
          } voi chuoi goc ${searchTerm} (match score: ${selectedResult.matchScore.toFixed(
            2,
          )})`,
        );
      }
      return selectedResult.item;
    }
    if (selectedResult?.item) {
      if (this.verboseRuntimeLogs) {
        console.warn(
          `[address-match] Bo qua match "${searchTerm}" voi dia chi "${
            selectedResult.candidateVariant
          }" (score ${selectedResult.matchScore.toFixed(2)}, ly do: ${
            selectedResult.rejectReason || "threshold"
          })`,
        );
      }
      return null;
    }
    return null;
  }

  extractDocumentId(url) {
    return this.extractGoogleDriveFileId(url);
  }

  extractGoogleDriveFileId(url) {
    if (!url) {
      return null;
    }

    const normalizedUrl = this.normalizeExternalUrl(url);
    if (!normalizedUrl) {
      return null;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      return null;
    }

    const host = (parsedUrl.hostname || "").toLowerCase();
    if (!host.includes("google.com")) {
      return null;
    }

    const path = parsedUrl.pathname || "";
    const documentMatch = path.match(/\/document\/d\/([a-zA-Z0-9_-]+)/i);
    if (documentMatch) {
      return documentMatch[1];
    }

    const driveFileMatch = path.match(/\/file\/d\/([a-zA-Z0-9_-]+)/i);
    if (driveFileMatch) {
      return driveFileMatch[1];
    }

    const genericDMatch = path.match(/\/d\/([a-zA-Z0-9_-]+)/i);
    if (genericDMatch) {
      return genericDMatch[1];
    }

    const queryId = parsedUrl.searchParams.get("id");
    if (queryId) {
      return queryId;
    }

    return null;
  }

  async extractGoogleSheetInfo(url, fallbackGid = null) {
    const normalizedUrl = (url || "").toString().trim();
    const spreadsheetMatch = normalizedUrl.match(
      /\/spreadsheets\/d\/([^\/?#]+)/i,
    );
    const gidMatch = normalizedUrl.match(/[?#&]gid=(\d+)/i);
    const normalizedFallbackGid = String(fallbackGid ?? "").trim();
    const resolvedGid =
      gidMatch?.[1] ||
      (normalizedFallbackGid && normalizedFallbackGid !== "0"
        ? normalizedFallbackGid
        : null);

    return {
      spreadsheetId: spreadsheetMatch?.[1] || null,
      gid: resolvedGid || null,
    };
  }

  buildSheetUrl(baseUrl, gid) {
    const normalizedGid = String(gid ?? "").trim();
    if (!normalizedGid || normalizedGid === "0") {
      return baseUrl;
    }

    if (/gid=/i.test(baseUrl)) {
      return baseUrl.replace(/gid=[^&#]*/i, `gid=${normalizedGid}`);
    }

    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}gid=${normalizedGid}`;
  }

  normalizeSheetGid(value) {
    if (value === null || value === undefined) {
      return null;
    }

    const normalized = value.toString().trim();
    return normalized === "" ? null : normalized;
  }

  extractSheetGidFromUrl(url) {
    const normalizedUrl = (url || "").toString().trim();
    if (!normalizedUrl) {
      return null;
    }

    const gidMatch = normalizedUrl.match(/[?#&]gid=(\d+)/i);
    return this.normalizeSheetGid(gidMatch?.[1] || null);
  }

  isTemplateOrFallbackGid(gid) {
    const normalizedGid = this.normalizeSheetGid(gid);
    if (normalizedGid === null) {
      return true;
    }

    // Legacy constants dùng gid mẫu 246641757 để đánh dấu "có nhiều tab".
    return normalizedGid === "0" || normalizedGid === "246641757";
  }

  normalizeSheetGidList(values) {
    if (!Array.isArray(values)) {
      return [];
    }

    return values
      .map((value) => this.normalizeSheetGid(value))
      .filter((value) => value !== null);
  }

  resolveSourceGidByIndex(config = {}, index = 0, fallbackGid = null) {
    const explicitGid = this.normalizeSheetGid(config?.gid);
    if (explicitGid !== null) {
      return explicitGid;
    }

    const gidList = this.normalizeSheetGidList(config?.list_address);
    if (gidList.length === 0) {
      return this.normalizeSheetGid(fallbackGid);
    }

    if (index >= 0 && index < gidList.length) {
      return gidList[index];
    }

    const normalizedFallback = this.normalizeSheetGid(fallbackGid);
    if (normalizedFallback !== null && gidList.includes(normalizedFallback)) {
      return normalizedFallback;
    }

    return gidList[0];
  }

  getSheetSourceCandidates(huydev, idSheetUrl = null, sheetIndex = 0) {
    const candidates = [];
    const dedupe = new Set();
    const preferPrioritySourcesFirst = Boolean(
      huydev?.sheet_source_priority_first,
    );

    const pushCandidate = (candidate = {}) => {
      const link = (candidate?.link || "").toString().trim();
      if (!link) {
        return;
      }

      const gid = this.normalizeSheetGid(candidate?.gid);
      const label = (candidate?.label || "SOURCE").toString().trim() || "SOURCE";
      const key = `${link}|${gid ?? ""}`;
      if (dedupe.has(key)) {
        return;
      }
      dedupe.add(key);

      candidates.push({
        label,
        link,
        gid,
      });
    };

    const getOrderedGids = (link, primaryGid) => {
      const normalizedPrimaryGid = this.normalizeSheetGid(primaryGid);
      const linkGid = this.extractSheetGidFromUrl(link);
      const shouldPreferLinkGidFirst =
        normalizedPrimaryGid !== null &&
        linkGid !== null &&
        normalizedPrimaryGid !== linkGid &&
        this.isTemplateOrFallbackGid(normalizedPrimaryGid);

      const gidCandidates = shouldPreferLinkGidFirst
        ? [linkGid, normalizedPrimaryGid]
        : [normalizedPrimaryGid, linkGid];
      return [...new Set(gidCandidates.filter((gid) => gid !== null))];
    };

    const pushSourceWithAutoGids = (label, link, primaryGid) => {
      const orderedGids = getOrderedGids(link, primaryGid);
      if (orderedGids.length === 0) {
        pushCandidate({ label, link, gid: null });
        return;
      }

      orderedGids.forEach((gid) => pushCandidate({ label, link, gid }));
    };

    // Mặc định: giữ nguyên hành vi cũ, ưu tiên AI0 trước.
    if (!preferPrioritySourcesFirst) {
      pushSourceWithAutoGids("AI0", huydev?.link, idSheetUrl);
    }

    const normalizedSheetSourcePriority = Array.isArray(huydev?.sheet_source_priority)
      ? huydev.sheet_source_priority
      : [];

    normalizedSheetSourcePriority.forEach((sourceConfig, sourceIndex) => {
      if (!sourceConfig || sourceConfig.enabled === false) {
        return;
      }

      const resolvedGid = this.resolveSourceGidByIndex(
        sourceConfig,
        sheetIndex,
        idSheetUrl,
      );
      const sourceLabel =
        sourceConfig.label ||
        sourceConfig.name ||
        sourceConfig.key ||
        `SOURCE_${sourceIndex + 1}`;
      pushSourceWithAutoGids(sourceLabel, sourceConfig.link, resolvedGid);
    });

    // CDT đặc thù: ưu tiên nguồn trong `sheet_source_priority` trước, AI0 làm fallback.
    if (preferPrioritySourcesFirst) {
      pushSourceWithAutoGids("AI0", huydev?.link, idSheetUrl);
      const ai0Candidates = candidates.filter((c) => c.label === "AI0");
      const nonAi0Candidates = candidates.filter((c) => c.label !== "AI0");
      candidates.length = 0;
      candidates.push(...nonAi0Candidates, ...ai0Candidates);
    }

    const legacyFallbackSources = [
      {
        label: "AI1",
        link: huydev?.link_ai1 || huydev?.ai1_link,
        list_address: huydev?.list_address_ai1 || huydev?.ai1_list_address,
        gid: huydev?.gid_ai1 || huydev?.ai1_gid,
      },
      {
        label: "AI2",
        link: huydev?.link_ai2 || huydev?.ai2_link,
        list_address: huydev?.list_address_ai2 || huydev?.ai2_list_address,
        gid: huydev?.gid_ai2 || huydev?.ai2_gid,
      },
      {
        label: "MANUAL3",
        link: huydev?.link_manual3 || huydev?.manual3_link,
        list_address:
          huydev?.list_address_manual3 || huydev?.manual3_list_address,
        gid: huydev?.gid_manual3 || huydev?.manual3_gid,
      },
    ];

    legacyFallbackSources.forEach((sourceConfig) => {
      const resolvedGid = this.resolveSourceGidByIndex(
        sourceConfig,
        sheetIndex,
        idSheetUrl,
      );
      pushSourceWithAutoGids(
        sourceConfig.label,
        sourceConfig.link,
        resolvedGid,
      );
    });

    return candidates;
  }

  async convertToCSVLink(editUrl) {
    const spreadsheetMatch = editUrl.match(/\/spreadsheets\/d\/([^\/]+)/);
    const gidMatch = editUrl.match(/gid=(\d+)/);

    if (spreadsheetMatch) {
      let csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetMatch[1]}/export?format=csv`;
      if (gidMatch) {
        csvUrl += `&gid=${gidMatch[1]}`;
      }
      return csvUrl;
    }
    return null;
  }

  async retryRequest(requestFunction, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await requestFunction();
        return response;
      } catch (error) {
        if (this.isRetryableRequestError(error) && i < retries - 1) {
          const { status, code, detail } = this.getRequestErrorSummary(error);
          const retryLabel = code || status || "UNKNOWN";
          const delayMs = 500 * (i + 1);
          console.warn(
            `Retrying request (${
              i + 1
            }/${retries}) after ${retryLabel}: ${detail}`,
          );
          await this.sleep(delayMs);
          continue;
        }
        throw error;
      }
    }
  }

  async spreadsheets(spreadsheetId, targetGid, options = {}) {
    const auth = new google.auth.GoogleAuth({
      keyFile: "ggsheets.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    try {
      const sheets = google.sheets({ version: "v4", auth });
      // 📌 Lấy danh sách sheet để tìm sheet có `gid`
      const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
      const sheet = sheetInfo.data.sheets.find(
        (s) => s.properties.sheetId == targetGid,
      );

      if (!sheet) {
        throw new Error(`Không tìm thấy sheet với gid=${targetGid}`);
      }

      const sheetTitle = sheet.properties.title;
      console.log(`📄 Sheet tìm thấy: ${sheetTitle} (gid: ${targetGid})`);

      // 📌 Lấy thông tin màu nền của từng ô trong sheet
      const response = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`${sheetTitle}`], // Lấy màu từ A1 đến Z100
        includeGridData: true,
        // fields: "sheets.data.rowData.values.effectiveFormat.backgroundColor"
      });
      const getRows = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: sheetTitle,
      });
      const rows = getRows.data.values;
      const data = response.data.sheets[0].data[0].rowData;
      if (data && data.length && rows?.length) {
        const jsonRows = rows.map((row, rowIndex) => {
          const obj = {};
          row.forEach(async (value, colIndex) => {
            const cell = data[rowIndex]?.values[colIndex];
            const backgroundColor = cell?.effectiveFormat?.backgroundColor;
            const textColor =
              cell?.effectiveFormat?.textFormat?.foregroundColor;
            const backgroundColorHex = backgroundColor
              ? this.rgbaToHex(
                  backgroundColor.red,
                  backgroundColor.green,
                  backgroundColor.blue,
                  backgroundColor.alpha,
                )
              : null;
            const textColorHex = textColor
              ? this.rgbaToHex(
                  textColor.red,
                  textColor.green,
                  textColor.blue,
                  textColor.alpha,
                )
              : null;

            const hyperlink = this.extractHyperlinkFromCell(cell);
            const formulaValue =
              cell?.userEnteredValue?.formulaValue ||
              cell?.userEnteredValue?.formula ||
              "";
            obj[`field${colIndex}`] = {
              value,
              formula: formulaValue,
              bgColor: backgroundColorHex,
              textColor: textColorHex,
              hyperlink: hyperlink,
              note: cell?.note || "",
            };
          });
          return obj;
        });

        return jsonRows;
      } else {
        console.log("No data found in gg sheets.");
        return [];
      }
    } catch (error) {
      if (!options?.silentErrors) {
        console.error(
          `An error occurred in spreadsheets (${spreadsheetId}, ${targetGid}):`,
          error,
        );
      }
      throw error;
    }
  }

  rgbaToHex(r = 0, g = 0, b = 0, a = 1) {
    const toHex = (c) => {
      const intVal = Math.round(c * 255);
      const hex = intVal.toString(16).padStart(2, "0");
      return hex;
    };

    const hexRed = toHex(r);
    const hexGreen = toHex(g);
    const hexBlue = toHex(b);
    const hexAlpha = a !== undefined ? toHex(a) : "";

    return `#${hexRed}${hexGreen}${hexBlue}${hexAlpha}`;
  }

  getAllDuplicateIndexes(arr) {
    const map = new Map();

    arr.forEach((item, index) => {
      if (!map.has(item)) {
        map.set(item, []);
      }
      map.get(item).push(index);
    });

    // Lọc ra chỉ những phần tử xuất hiện > 1 lần
    const duplicates = [];
    for (const [key, indexes] of map.entries()) {
      if (indexes.length > 1 && key !== null && key !== undefined) {
        duplicates.push({ value: key, indexes });
      }
    }

    return duplicates;
  }

  getRangeFromSheetData(data, rangeStr) {
    const [startRaw, endRaw] = (rangeStr || "").toString().split(":");
    const start = (startRaw || "").trim();
    const end = (endRaw || startRaw || "").trim();
    if (!start || !end) {
      return "";
    }

    // Chuyển chữ cột sang số (A => 0, H => 7)
    const colToIndex = (col) => {
      return (
        col
          .toUpperCase()
          .split("")
          .reduce((acc, char) => acc * 26 + (char.charCodeAt(0) - 64), 0) - 1
      );
    };

    const getRowCol = (ref) => {
      const match = ref.match(/^([A-Z]+)(\d+)$/);
      if (!match) throw new Error("Invalid cell ref");
      const [, col, row] = match;
      return { row: parseInt(row, 10) - 1, col: colToIndex(col) };
    };

    const { row: startRow, col: startCol } = getRowCol(start);
    const { row: endRow, col: endCol } = getRowCol(end);

    // Xử lý mảng object
    const result = data.slice(startRow, endRow + 1).map((rowObj) => {
      const row = [];
      for (let i = startCol; i <= endCol; i++) {
        row.push(rowObj?.[`field${i}`]?.value || "");
      }
      return row;
    });

    return result.join(". ");
  }

  async readGoogleDocByLink(docUrl) {
    if (docUrl == null || docUrl == undefined) return "";

    const normalizedUrl = this.normalizeExternalUrl(docUrl);
    const extractedFileId = this.extractGoogleDriveFileId(normalizedUrl);
    if (!extractedFileId) {
      return "";
    }

    // Xác thực OAuth2
    const auth = new google.auth.GoogleAuth({
      keyFile: "ggsheets.json", // thay bằng path thật
      scopes: [
        "https://www.googleapis.com/auth/documents.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
    });

    try {
      const drive = google.drive({ version: "v3", auth });
      let fileId = extractedFileId;
      let metadata = await drive.files.get({
        fileId,
        fields: "mimeType, name, shortcutDetails(targetId,targetMimeType)",
      });

      if (
        metadata?.data?.mimeType === "application/vnd.google-apps.shortcut" &&
        metadata?.data?.shortcutDetails?.targetId
      ) {
        fileId = metadata.data.shortcutDetails.targetId;
        metadata = await drive.files.get({
          fileId,
          fields: "mimeType, name",
        });
      }

      let text = "";
      if (metadata.data.mimeType === "application/vnd.google-apps.document") {
        const docs = google.docs({ version: "v1", auth });
        const res = await docs.documents.get({ documentId: fileId });
        const content = res.data.body.content;
        for (const element of content) {
          if (element.paragraph) {
            for (const elem of element.paragraph.elements || []) {
              if (elem.textRun) {
                text += elem.textRun.content;
              }
            }
          }
        }
      } else if (
        metadata.data.mimeType ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        metadata.data.mimeType === "application/msword"
      ) {
        // Tải file .docx / .doc về dưới dạng buffer và đọc bằng mammoth
        const res = await drive.files.get(
          { fileId: fileId, alt: "media" },
          { responseType: "arraybuffer" },
        );
        const result = await mammoth.extractRawText({
          buffer: Buffer.from(res.data),
        });
        text = result.value;
      } else {
        console.warn(
          `⚠️ Bỏ qua: File "${metadata.data.name}" (${fileId}) là định dạng ${metadata.data.mimeType}, không hỗ trợ đọc nội dung.`,
        );
        return "";
      }

      return text;
    } catch (error) {
      if (error.code === 403 || error.code === 404) {
        console.error(
          `❌ Không có quyền truy cập hoặc không tìm thấy Doc: ${docUrl}`,
        );
      } else {
        console.error(`❌ Lỗi khi đọc Doc (${docUrl}): ${error.message}`);
      }
      return "";
    }
  }

  isEmpty(value) {
    return (
      value == null || // null hoặc undefined
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    );
  }

  hasConfiguredField(value) {
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value === "number") {
      return Number.isFinite(value);
    }

    if (Array.isArray(value)) {
      return value.some((item) => this.hasConfiguredField(item));
    }

    return value.toString().trim() !== "";
  }

  hasLegacyColumnConfig(config = {}, index = -1) {
    const legacyColumns = Array.isArray(config?.column) ? config.column : [];
    if (index < 0 || index >= legacyColumns.length) {
      return false;
    }
    return this.hasConfiguredField(legacyColumns[index]);
  }

  validateRequiredSheetFields(config = {}) {
    const hasVerticalAddressField =
      this.hasConfiguredField(config?.columnVertical) &&
      this.hasConfiguredField(config?.colorExitVerticalBg);
    const hasAddressField =
      this.hasConfiguredField(config?.address_column) ||
      this.hasLegacyColumnConfig(config, 0) ||
      hasVerticalAddressField;
    const hasRoomField =
      this.hasConfiguredField(config?.room_column) ||
      this.hasLegacyColumnConfig(config, 1);
    const hasPriceField =
      this.hasConfiguredField(config?.price_column) ||
      this.hasLegacyColumnConfig(config, 3);

    const missingFields = [];
    if (!hasAddressField) missingFields.push("địa chỉ");
    if (!hasRoomField) missingFields.push("tên phòng");
    if (!hasPriceField) missingFields.push("giá");

    return {
      ok: missingFields.length === 0,
      missingFields,
    };
  }

  hasUsableAddressDataInSheetRows(rows = [], config = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return false;
    }

    const hasVerticalAddressField =
      !this.isEmpty(config?.columnVertical) &&
      !this.isEmpty(config?.colorExitVerticalBg);
    const addressColumns = Array.isArray(config?.address_column)
      ? config.address_column
      : [];
    const primaryAddressColumn = addressColumns.find(
      (column) => column !== null && column !== undefined,
    );

    for (const row of rows) {
      if (!row || typeof row !== "object") {
        continue;
      }

      const composedAddress = this.composeAddressFromColumns(row, addressColumns);
      if (
        composedAddress &&
        this.isLikelyAddressAnchorText(composedAddress) &&
        !this.isLikelySheetNoteAddress(composedAddress)
      ) {
        return true;
      }

      if (primaryAddressColumn !== undefined) {
        const primaryAddress = this.normalizeSheetCellText(
          row?.[`field${primaryAddressColumn}`]?.value,
        );
        if (
          primaryAddress &&
          this.isLikelyAddressAnchorText(primaryAddress) &&
          !this.isLikelySheetNoteAddress(primaryAddress)
        ) {
          return true;
        }
      }

      if (hasVerticalAddressField) {
        const vCol = Number(config.columnVertical);
        const verticalAddress = this.normalizeSheetCellText(
          row?.[`field${vCol}`]?.value,
        );
        const bannerAddress = this.findAddressBannerTextInRow(row, vCol, 4);
        const normalizedAddress = this.stripAddressBannerPrefix(
          bannerAddress || verticalAddress,
        );
        if (
          normalizedAddress &&
          this.isLikelyAddressAnchorText(normalizedAddress) &&
          !this.isLikelySheetNoteAddress(normalizedAddress)
        ) {
          return true;
        }
      }
    }

    return false;
  }

  async processCsvData(huydev, idSheetUrl = null, sheetIndex = 0) {
    try {
      let sheetData;
      const sourceCandidates = this.getSheetSourceCandidates(
        huydev,
        idSheetUrl,
        sheetIndex,
      );
      const sourceErrors = [];
      let selectedSource = null;

      if (sourceCandidates.length === 0) {
        throw new Error(
          `Không có nguồn bảng hàng khả dụng cho CDT ${huydev?.id || "unknown"}.`,
        );
      }

      for (const sourceCandidate of sourceCandidates) {
        const sheetUrl = this.buildSheetUrl(
          sourceCandidate.link,
          sourceCandidate.gid,
        );
        const sourceLabel = sourceCandidate.label || "SOURCE";

        try {
          if (huydev.if == "caocap") {
            const { spreadsheetId, gid } = await this.extractGoogleSheetInfo(
              sheetUrl,
              sourceCandidate.gid,
            );
            if (!spreadsheetId || !gid) {
              throw new Error(
                `Không xác định được spreadsheetId/gid từ link: ${sheetUrl}`,
              );
            }

            try {
              sheetData = await this.spreadsheets(spreadsheetId, gid, {
                silentErrors: true,
              });
            } catch (error) {
              const configuredLinkInfo = await this.extractGoogleSheetInfo(
                sourceCandidate.link || "",
                sourceCandidate.gid,
              );
              const fallbackGid = configuredLinkInfo?.gid;
              const canFallbackToLinkGid =
                fallbackGid !== null &&
                fallbackGid !== undefined &&
                String(fallbackGid).trim() !== "" &&
                String(fallbackGid).trim() !== "0" &&
                String(fallbackGid) !== String(gid);

              if (!canFallbackToLinkGid) {
                throw error;
              }

              console.warn(
                `[sheet-fallback][${sourceLabel}] gid=${gid} không tồn tại, thử lại bằng gid trên link=${fallbackGid}`,
              );
              sheetData = await this.spreadsheets(spreadsheetId, fallbackGid, {
                silentErrors: true,
              });
            }
          } else if (huydev.if == "binhthuong") {
            const csvUrl = await this.convertToCSVLink(sheetUrl);
            if (!csvUrl) {
              throw new Error(`Không convert được CSV URL từ link: ${sheetUrl}`);
            }
            const response = await axios.get(csvUrl);
            const data = await csvtojson().fromString(response.data);

            const worksheet = xlsx.utils.json_to_sheet(data);
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Sheet1");
            sheetData = xlsx.utils.sheet_to_json(worksheet);
          } else {
            throw new Error(`Loại nguồn không hỗ trợ: ${huydev.if}`);
          }

          // Rule fallback: luôn thử AI0 trước; chỉ chạy link đích khi AI0
          // không xác định được dữ liệu cột địa chỉ.
          if (
            huydev.if == "caocap" &&
            !this.hasUsableAddressDataInSheetRows(sheetData, huydev)
          ) {
            throw new Error("khong tim duoc cot dia chi");
          }

          selectedSource = {
            label: sourceLabel,
            link: sourceCandidate.link,
            gid: sourceCandidate.gid,
            sheetUrl,
          };
          break;
        } catch (error) {
          const errorMessage = error?.message || String(error);
          sourceErrors.push(`${sourceLabel}: ${errorMessage}`);
          console.warn(
            `[sheet-source] Không đọc được nguồn ${sourceLabel} cho CDT ${huydev?.id}: ${errorMessage}`,
          );
        }
      }

      if (!selectedSource || !sheetData) {
        throw new Error(
          `Không đọc được bảng hàng từ các nguồn ưu tiên (${sourceErrors.join(" | ")})`,
        );
      }

      if (selectedSource.label !== "AI0") {
        console.warn(
          `[sheet-source] CDT ${huydev?.id} fallback sang ${selectedSource.label} (${selectedSource.sheetUrl})`,
        );
      } else {
        console.log(
          `[sheet-source] CDT ${huydev?.id} chạy trực tiếp AI0 (${selectedSource.sheetUrl})`,
        );
      }

      if (!sheetData) {
        return {
          rows: [],
          source: selectedSource,
          sourceErrors,
          attemptedRootSource: sourceCandidates.some(
            (source) =>
              (source?.label || "").toString().trim().toUpperCase() === "AI0",
          ),
          selectedSourceLabel: selectedSource?.label || "",
        };
      }
      let results = sheetData;

      let header = [];
      if (huydev.header) {
        header = results[huydev.header];
      }
      // Ghi nhận tổng số phòng ban đầu (trước khi lọc theo trạng thái exit/kín)
      let initialValidRooms = results.filter((row) => {
        const rawAddress =
          this.composeAddressFromColumns(row, huydev.address_column) ||
          row[`field${huydev.address_column[0]}`]?.value ||
          "";
        const rawRoom = row[`field${huydev.room_column[0]}`]?.value || "";
        if (!rawAddress || !rawRoom) {
          return false;
        }

        return !(
          this.isLikelySheetNoteAddress(rawAddress) ||
          this.isLikelySheetNoiseRoom(rawRoom)
        );
      }).length;
      huydev.totalPhongLayDuoc = initialValidRooms;

      // color
      if (huydev.exitBackgroundColor && huydev.exitColumnColor !== null) {
        results = results.filter(
          (row) =>
            !huydev.exitBackgroundColor.includes(
              row[`field${huydev.exitColumnColor}`]?.bgColor,
            ),
        );
      }
      // text color
      if (huydev.exitTextColor && huydev.exitColumnColor !== null) {
        results = results.filter(
          (row) =>
            !huydev.exitTextColor.includes(
              row[`field${huydev.exitColumnColor}`]?.textColor,
            ),
        );
      }
      // text (exit keywords are evaluated per-row later, after address carry-over)
      // to avoid losing address anchor rows that are marked FULL.
      const exitKeywords = (huydev.exit || [])
        .flatMap((item) =>
          item === undefined || item === null
            ? []
            : item.toString().split(/[;,|]/),
        )
        .map((item) => this.normalizeComparableText(item))
        .filter(Boolean);

      // address ngang thành dọc
      // if (
      //   huydev.columnVertical !== null &&
      //   huydev.colorExitVerticalBg !== null
      // ) {
      //   this.copyValueToLastField(results, huydev.columnVertical, {
      //     key: "bgColor",
      //     value: huydev.colorExitVerticalBg,
      //   });
      // }

      // if (
      //   huydev.columnVertical !== null &&
      //   huydev.colorExitVerticalText !== null
      // ) {
      //   this.copyValueToLastField(results, huydev.columnVertical, {
      //     key: "textColor",
      //     value: huydev.colorExitVerticalText,
      //   });
      // }
      let datas = [];
      let address;
      const descriptionCarryColumns = new Set(
        (Array.isArray(huydev?.mota_carry_forward_columns)
          ? huydev.mota_carry_forward_columns
          : []
        )
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item)),
      );
      const carriedDescriptionCellsByAddress = new Map();
      const requireImportRangeBeforeAddress = Boolean(
        huydev?.address_only_after_import_range,
      );
      let importRangeSeen = !requireImportRangeBeforeAddress;
      for (let row of results) {
        // if(huydev?.header && count <= huydev.header) {
        //   continue; // Bỏ qua các hàng trước header
        // }
        if (
          !this.isEmpty(huydev?.columnVertical) &&
          !this.isEmpty(huydev?.colorExitVerticalBg)
        ) {
          const vCol = Number(huydev.columnVertical);
          const verticalCell = row[`field${vCol}`];

          if (requireImportRangeBeforeAddress) {
            let importRangeRow = false;
            for (let c = 0; c < 4; c++) {
              const f = row[`field${c}`]?.formula || "";
              if (this.isImportRangeFormula(f)) {
                importRangeRow = true;
                break;
              }
            }
            if (importRangeRow) {
              importRangeSeen = true;
              address = undefined;
              continue;
            }
          }

          const rowBgColor = (verticalCell?.bgColor || "").toLowerCase();
          const markerBgColor = (huydev.colorExitVerticalBg || "")
            .toString()
            .toLowerCase();
          const isGreyAddressRow =
            rowBgColor && rowBgColor.includes(markerBgColor);

          const bannerRaw = this.findAddressBannerTextInRow(row, vCol, 4);
          const isAddressBannerText = Boolean(bannerRaw);
          const requireAddressBanner = Boolean(huydev?.address_banner_required);
          const rowHasUsableRoomData = this.rowHasUsableRoomValue(
            row,
            huydev.room_column,
            huydev,
          );
          const rawVerticalAddress = this.normalizeSheetCellText(
            verticalCell?.value,
          );
          const isAddressTextAnchor = this.isLikelyAddressAnchorText(
            rawVerticalAddress,
          );
          const isAddressAnchorRow =
            isAddressBannerText ||
            (!requireAddressBanner &&
              ((isGreyAddressRow && isAddressTextAnchor) ||
                (isAddressTextAnchor && rowHasUsableRoomData)));

          if (isAddressAnchorRow) {
            if (requireImportRangeBeforeAddress && !importRangeSeen) {
              continue;
            }
            const rawForAddress = bannerRaw || rawVerticalAddress;
            if (rawForAddress) {
              address = this.stripAddressBannerPrefix(rawForAddress);
            }
            if (!rowHasUsableRoomData) {
              continue;
            }
          }
        } else {
          let tempAddr = row[`field${huydev.address_column[0]}`]?.value; // Lấy địa chỉ từ cột đã chỉ định
          if (
            tempAddr !== undefined &&
            tempAddr !== null &&
            tempAddr.toString().trim() !== ""
          ) {
            address = tempAddr;
          }
        }

        if (
          this.isEmpty(huydev?.columnVertical) ||
          this.isEmpty(huydev?.colorExitVerticalBg)
        ) {
          const composedAddress = this.composeAddressFromColumns(
            row,
            huydev.address_column,
          );
          if (composedAddress) {
            address = composedAddress;
          }
        }

        if (!address || address.toLowerCase().trim() === "địa chỉ") {
          continue; // Bỏ qua nếu địa chỉ không hợp lệ
        }

        const isRowExcludedByExitKeyword =
          huydev.exitColumn !== null &&
          exitKeywords.length > 0 &&
          (() => {
            const cellValue = row[`field${huydev.exitColumn}`]?.value;
            const normalizedCellValue = this.normalizeComparableText(cellValue);
            if (!normalizedCellValue) {
              return false;
            }
            return exitKeywords.some(
              (keyword) =>
                normalizedCellValue === keyword ||
                normalizedCellValue.includes(keyword),
            );
          })();

        let description = "";
        if (huydev?.mota && huydev?.mota?.length > 0) {
          const docContents = [];
          const textContents = [];
          const normalizedAddressKey = this.normalizeComparableText(address);
          let carryByColumn = null;
          if (normalizedAddressKey && descriptionCarryColumns.size > 0) {
            carryByColumn =
              carriedDescriptionCellsByAddress.get(normalizedAddressKey) ||
              new Map();
            if (!carriedDescriptionCellsByAddress.has(normalizedAddressKey)) {
              carriedDescriptionCellsByAddress.set(
                normalizedAddressKey,
                carryByColumn,
              );
            }
          }

          for (const item of huydev.mota) {
            let cellValue = "";
            let hyperlink = "";
            let cellNote = "";
            const itemColumn =
              typeof item === "number" && Number.isFinite(item) ? item : null;
            const shouldCarryCell =
              itemColumn !== null &&
              descriptionCarryColumns.has(itemColumn) &&
              carryByColumn;

            if (typeof item === "string") {
              cellValue = this.getRangeFromSheetData(results, item);
            } else {
              cellValue = row[`field${item}`]?.value;
              hyperlink = row[`field${item}`]?.hyperlink;
              cellNote = row[`field${item}`]?.note;
            }

            if (shouldCarryCell) {
              const hasCurrentCellData = Boolean(
                this.normalizeSheetCellText(cellValue) ||
                  hyperlink ||
                  this.normalizeSheetCellText(cellNote),
              );
              if (hasCurrentCellData) {
                carryByColumn.set(itemColumn, {
                  cellValue,
                  hyperlink,
                  cellNote,
                });
              } else if (carryByColumn.has(itemColumn)) {
                const carriedCell = carryByColumn.get(itemColumn);
                cellValue = carriedCell?.cellValue || "";
                hyperlink = carriedCell?.hyperlink || "";
                cellNote = carriedCell?.cellNote || "";
              }
            }

            // Prioritize Google Doc/Drive textual content when a cell has link
            let appendedDocContent = false;
            if (hyperlink) {
              const content = await this.readGoogleDocByLink(hyperlink);
              if (content) {
                docContents.push(content);
                appendedDocContent = true;
              }
            }

            if (
              !appendedDocContent &&
              cellValue &&
              cellValue.toString().includes("docs.google.com/document/d/")
            ) {
              const urlMatch = cellValue
                .toString()
                .match(
                  /https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_-]+/,
                );
              if (urlMatch) {
                const content = await this.readGoogleDocByLink(urlMatch[0]);
                if (content) {
                  docContents.push(content);
                  appendedDocContent = true;
                }
              }
            }

            if (!appendedDocContent && cellNote) {
              textContents.push(cellNote);
              appendedDocContent = true;
            }

            if (!appendedDocContent && cellValue) {
              const headerVal =
                typeof item === "number"
                  ? header[`field${item}`]?.value || ""
                  : "";
              textContents.push(
                headerVal ? `${headerVal}: ${cellValue}` : cellValue,
              );
            }
          }

          description = [...textContents, ...docContents].join(". ");
        }

        const roomCols = huydev.room_column;
        const priceCols = huydev.price_column;
        const bldCol = huydev.building_code_column[0];

        const buildingCode =
          bldCol !== null && row[`field${bldCol}`]?.value
            ? row[`field${bldCol}`]?.value
            : null;

        roomCols.forEach((roomCol, i) => {
          if (isRowExcludedByExitKeyword) {
            return;
          }

          const priceCol =
            priceCols && priceCols[i] !== undefined
              ? priceCols[i]
              : priceCols
                ? priceCols[0]
                : null;
          if (roomCol === null || !row[`field${roomCol}`]?.value) return;

          const roomEntries = this.extractRoomPriceEntries(
            row[`field${roomCol}`]?.value,
            this.resolvePriceRawFromRow(row, priceCol, huydev),
            roomCol,
            priceCol,
            huydev,
          );

          roomEntries.forEach((entry) => {
            const normalizedRoomRaw = this.normalizeRoomValue(
              entry.roomRaw,
              huydev,
            );
            if (
              !normalizedRoomRaw ||
              this.isLikelySheetNoteAddress(address) ||
              this.isLikelySheetNoiseRoom(normalizedRoomRaw)
            ) {
              return;
            }

            const priceResolution = this.resolvePriceRawByCurrencyPreference(
              entry.priceRaw,
              huydev,
            );
            const finalPriceRaw = priceResolution.priceRaw || entry.priceRaw;
            const usdOnlyDescriptionNote = this.normalizeSheetCellText(
              huydev?.usd_only_description_note,
            );
            let finalDescription = description;
            if (priceResolution.isUsdOnly && usdOnlyDescriptionNote) {
              const normalizedDescription =
                this.normalizeComparableText(finalDescription);
              const normalizedUsdOnlyDescriptionNote =
                this.normalizeComparableText(usdOnlyDescriptionNote);
              if (
                !normalizedDescription ||
                !normalizedDescription.includes(
                  normalizedUsdOnlyDescriptionNote,
                )
              ) {
                finalDescription = finalDescription
                  ? `${finalDescription}. ${usdOnlyDescriptionNote}`
                  : usdOnlyDescriptionNote;
              }
            }

            datas.push({
              ADDRESS: address,
              IMAGE_DRIVER: this.resolveImageDriverFromRow(
                row,
                huydev.exitLinkDriver,
              ),
              PRICE: this.applyConfiguredPriceScale(
                this.normalizePriceValue(finalPriceRaw, huydev),
                huydev,
              ),
              ROOMS: normalizedRoomRaw,
              DESCRIPTIONS: finalDescription,
              BUILDING: buildingCode,
            });
          });
        });
      }
      datas = datas.filter((row) => {
        if (!row || !row.ADDRESS || !row.ROOMS) {
          return false;
        }

        const normalizedAddress = this.removeVietnameseTonesSync(
          this.cleanAddressForMatch(row.ADDRESS),
        ).toLowerCase();
        const normalizedRooms = this.removeVietnameseTonesSync(
          row.ROOMS.toString().trim(),
        ).toLowerCase();

        if (!normalizedAddress || !normalizedRooms) {
          return false;
        }

        if (
          this.isLikelySheetNoteAddress(row.ADDRESS) ||
          this.isLikelySheetNoiseRoom(row.ROOMS)
        ) {
          return false;
        }

        if (
          normalizedAddress === "dia chi" ||
          normalizedAddress === "co so" ||
          normalizedAddress.includes("dia chi toa nha") ||
          normalizedRooms.includes("so phong")
        ) {
          return false;
        }

        return true;
      });

      return {
        rows: datas,
        source: selectedSource,
        sourceErrors,
        attemptedRootSource: sourceCandidates.some(
          (source) =>
            (source?.label || "").toString().trim().toUpperCase() === "AI0",
        ),
        selectedSourceLabel: selectedSource?.label || "",
      };
    } catch (error) {
      console.error(`Có lỗi xảy ra: ${error}`);
      throw error;
    }
  }

  // config
  copyValueToLastField(results, column, exitCondition) {
    let copiedValue = null;
    for (let i = 0; i < results.length; i++) {
      const obj = results[i];

      if (
        obj[`field${column}`] &&
        obj[`field${column}`][exitCondition.key] === exitCondition.value
      ) {
        copiedValue = obj[`field${column}`].value;
      } else if (copiedValue) {
        let fieldCount = Object.keys(obj).length;
        obj[`field${fieldCount}`] = { value: copiedValue };
      }
    }
  }

  async run() {
    let hasRunLock = false;
    try {
      hasRunLock = await this.acquireMainRunLock();
      if (!hasRunLock) {
        const lockMessage =
          "[run-lock] Bỏ qua lượt chạy vì tool trống kín đang chạy ở phiên khác.";
        console.warn(lockMessage);
        await this.sendMainTelegramMessage(lockMessage);
        return;
      }

      this.runStats = {};
      let totalTrong = 0;
      let totalTaoMoi = 0;
      let cdtStats = {};
      const countedTotalDongKeys = new Set();
      const allowManualRerun = this.RUN_CONTEXT === "manual";

      await fs.writeFile("thong_ke.txt", "");
      await this.sendMainTelegramMessage(
        `Bắt đầu cập nhật... [${this.RUN_CONTEXT.toUpperCase()}]`,
      );
      if (this.RUN_ONLY_IDS.length > 0) {
        console.log(
          `[config] Chạy giới hạn cho ID: ${this.RUN_ONLY_IDS.join(", ")}`,
        );
      } else {
        console.log(`[config] Chạy từ ID: ${this.START_ID}`);
      }
      let investors = [];
      let flag = false;
      for (let huydev of this.LIST_GGSHEET) {
        if (
          this.RUN_ONLY_IDS.length > 0 &&
          !this.RUN_ONLY_IDS.includes(Number(huydev.id))
        ) {
          continue;
        }
        if (this.RUN_ONLY_IDS.length === 0) {
          if (flag || huydev.id >= this.START_ID) {
            flag = true;
          } else {
            continue;
          }
        }

        if (!cdtStats[huydev.id]) {
          cdtStats[huydev.id] = {
            trong: 0,
            taoMoi: 0,
            error: false,
            empty: true,
            totalDong: 0,
            link: huydev.link,
          };
        }

        let missingAddresses = new Set();
        const executionKey = this.getSheetExecutionKey(huydev);
        const requiredFieldCheck = this.validateRequiredSheetFields(huydev);

        console.log(
          `------------------------------------------------------- ${executionKey} ------------------------------------------------------------------ `,
        );
        if (!requiredFieldCheck.ok) {
          const missingText = requiredFieldCheck.missingFields.join(", ");
          console.warn(
            `[config] Bỏ qua ${executionKey}: thiếu trường bắt buộc (${missingText}). Chưa chạy cập nhật kín/trống để tránh sai dữ liệu.`,
          );
          cdtStats[huydev.id].error = true;
          await this.appendToFile(
            "driver_error.txt",
            `${executionKey}|MISSING_REQUIRED_FIELDS|${missingText}|${this.getFormattedDate()}\n`,
          );
          continue;
        }
        const formattedDate = this.getFormattedDate();
        const entryExitsRun = `${executionKey}|${formattedDate}|TRUE`;
        const exitRunMismatch = await this.checkIfEntryExists(
          "exits.txt",
          entryExitsRun,
        );
        if (!exitRunMismatch || allowManualRerun) {
          if (exitRunMismatch && allowManualRerun) {
            console.log(
              `[manual-rerun] Bỏ qua chặn exits.txt cho ${executionKey} để ưu tiên kết quả chạy tay mới nhất.`,
            );
          }
          // run
          try {
            const sheetAddressList = Array.isArray(huydev.list_address)
              ? huydev.list_address
              : [null];
            for (const [sheetIndex, idSheetUrl] of sheetAddressList.entries()) {
              const searchRealnews = await this.searchRealnewByInvestor(
                huydev.id,
              );
              if (this.verboseRuntimeLogs) {
                console.log(
                  `[DEBUG] CDT ${huydev.id} found ${searchRealnews.content.length} buildings on web.`,
                );
                searchRealnews.content.forEach((b) =>
                  console.log(
                    `  - Web Building: ${b.id} | ${b.code} | ${b.address_valid}`,
                  ),
                );
              }

              if (huydev?.id && !investors.includes(huydev.id)) {
                // update all room of realnews kín
                for (let item of searchRealnews.content) {
                  const searchRooms = await this.searchRoom(item.id);
                  console.log(
                    `Đang cập nhật phòng kín cho tòa nhà ${item.id} - ${item.code} - ${item.address_valid} - ${searchRooms?.content?.length} phòng`,
                  );
                  await this.updateRoomByRealnew(searchRooms?.content || []);
                }
                investors.push(huydev.id);
              }

              const processedResult = await this.processCsvData(
                huydev,
                idSheetUrl,
                sheetIndex,
              );
              const processedData = Array.isArray(processedResult?.rows)
                ? processedResult.rows
                : [];
              const selectedSource = processedResult?.source || null;
              if (!processedResult) {
                console.log(
                  "link bảng hàng::",
                  this.buildSheetUrl(huydev.link, idSheetUrl),
                );
                console.log("Bảng hàng này bị lỗi trên ggsheet.");
                cdtStats[huydev.id].error = true;
                break;
              }
              if (selectedSource?.link) {
                cdtStats[huydev.id].link = selectedSource.link;
              }
              console.log("SỐ LƯỢNG BẢNG HÀNG ", processedData?.length);

              if (processedData?.length > 0) {
                const totalDongKey = `${huydev.id}|${
                  selectedSource?.link || huydev.link
                }|${selectedSource?.gid ?? idSheetUrl}`;
                const allowDuplicateRoomNames = Boolean(
                  huydev.allow_duplicate_room_names,
                );
                const roomAllocationPool = new Map();
                const processedAddressRoomKeys = new Set();
                if (!countedTotalDongKeys.has(totalDongKey)) {
                  cdtStats[huydev.id].totalDong +=
                    huydev.totalPhongLayDuoc || processedData.length;
                  countedTotalDongKeys.add(totalDongKey);
                }
                cdtStats[huydev.id].empty = false;
                for (let row of processedData) {
                  if (
                    row.hasOwnProperty("ADDRESS") &&
                    row.hasOwnProperty("ROOMS") &&
                    row["ADDRESS"] !== ""
                  ) {
                    if (row["ADDRESS"] && row["ROOMS"]) {
                      const dedupeKey = `${this.normalizeComparableText(
                        row["ADDRESS"],
                      )}|${this.normalizeComparableText(row["ROOMS"])}`;
                      if (processedAddressRoomKeys.has(dedupeKey)) {
                        if (this.verboseRuntimeLogs) {
                          console.log(
                            `[DEBUG] Skip duplicate ADDRESS+ROOMS in same sheet run: ADDRESS="${row["ADDRESS"]}" ROOMS="${row["ROOMS"]}"`,
                          );
                        }
                        continue;
                      }
                      processedAddressRoomKeys.add(dedupeKey);

                      if (this.verboseRuntimeLogs) {
                        console.log(
                          `[DEBUG] Row processing: ADDRESS="${row["ADDRESS"]}" ROOMS="${row["ROOMS"]}"`,
                        );
                      }
                      if (searchRealnews && searchRealnews.content.length > 0) {
                        const item = await this.fuzzySearch(
                          row["ADDRESS"],
                          searchRealnews.content,
                          huydev,
                        );
                        if (item) {
                          if (this.verboseRuntimeLogs) {
                            console.log(
                              `[DEBUG] Matched "${row["ADDRESS"]}" to building ${item.id} (${item.address_valid})`,
                            );
                          }
                          const searchRooms = await this.searchRoom(item.id);

                          if (searchRooms?.content) {
                            // cập nhật room
                            const roomsInput = this.convertRoom(row["ROOMS"]);
                            const matchedRoomIds = new Set();
                            const allocatedRoomIds = this.getAllocatedRoomIds(
                              roomAllocationPool,
                              item.id,
                            );
                            for (const roomRef of roomsInput) {
                              const roomNumbersArray =
                                await this.replaceAbbreviations(
                                  roomRef,
                                  huydev.type,
                                );

                              for (const roomNumber of roomNumbersArray) {
                                const normalizedRowPrice =
                                  this.normalizePriceValue(
                                    row["PRICE"],
                                    huydev,
                                  );
                                const room = this.findMatchedRoom(
                                  searchRooms?.content || [],
                                  roomNumber,
                                  huydev.type,
                                  allocatedRoomIds,
                                  allowDuplicateRoomNames,
                                  normalizedRowPrice,
                                  huydev,
                                );

                                if (room && !matchedRoomIds.has(room.id)) {
                                  matchedRoomIds.add(room.id);
                                  if (allowDuplicateRoomNames) {
                                    allocatedRoomIds.add(room.id);
                                  }
                                  console.log("roomNumber", roomNumber);
                                  // Luôn đếm là phòng trống trong báo cáo nếu thấy trong sheet
                                  this.incrementRunStats(huydev, item, "trong");

                                  const formattedDateIter =
                                    this.getFormattedDate();
                                  const entryContent = `${
                                    huydev.link + idSheetUrl
                                  }|${item.id}|${item.code}|${row["ADDRESS"]}|${
                                    room.id
                                  }|${roomNumber}|${formattedDateIter}`;

                                  const unlockedRoomsContent =
                                    await this.checkIfEntryExists(
                                      "capnhattrong.txt",
                                      entryContent,
                                    );

                                  if (!unlockedRoomsContent) {
                                    console.log(
                                      `Đã tìm thấy phòng ${roomNumber}, đang gọi unlockRoom...`,
                                    );
                                    await this.updateRoom_RONG_PRICE_FB_DRIVER(
                                      room,
                                      row,
                                      item,
                                      huydev,
                                      idSheetUrl,
                                      roomNumber,
                                    );
                                  } else {
                                    console.log(
                                      `Phòng ${roomNumber} có ID ${room.id} đã được mở khóa.`,
                                    );
                                  }
                                } else if (!room) {
                                  // Logic tạo phòng mới nếu không tìm thấy room pattern trên web
                                  // Nhưng chỉ tạo nếu roomNumber này chưa được tạo/xử lý
                                  const formattedDate = this.getFormattedDate();
                                  const shouldSkipCreateWhenMissingPrice =
                                    Boolean(
                                      huydev?.skip_create_room_when_price_missing,
                                    ) && normalizedRowPrice <= 0;
                                  const normalizedDescriptionForCreate =
                                    this.sanitizeTextForLegacyApi(
                                      row["DESCRIPTIONS"] || "",
                                    );
                                  if (shouldSkipCreateWhenMissingPrice) {
                                    await this.appendToFile(
                                      "khongcodulieu.txt",
                                      `${huydev.link + idSheetUrl}|${
                                        item.code
                                      }|${row["ADDRESS"]}|${roomNumber}|${
                                        normalizedRowPrice
                                      }|SKIP_CREATE_ROOM_MISSING_PRICE|${formattedDate}|${
                                        huydev.web
                                      }\n`,
                                    );
                                    console.warn(
                                      `Bỏ qua tạo mới phòng ${roomNumber} do thiếu giá (CDT ${huydev.id}).`,
                                    );
                                    continue;
                                  }
                                  const entryAddressContent = `${
                                    huydev.link + idSheetUrl
                                  }|${item.code}|${
                                    row["ADDRESS"]
                                  }|${roomNumber}|${normalizedRowPrice}|${formattedDate}`;

                                  const roomCreatedToday =
                                    await this.checkIfEntryExists(
                                      "phongmoi.txt",
                                      entryAddressContent,
                                    );

                                  if (!roomCreatedToday) {
                                    // Tạo phòng mới... (Omitted for brevity, but I should keep it)

                                    let data = {
                                      real_new_id: item.id,
                                      name: roomNumber,
                                      price: row["PRICE"] || 0,
                                      rent_price_hour: 0,
                                      rent_price_day: 0,
                                      area: 0,
                                      status: "con",
                                      empty_room_date: dayjs(new Date()).format(
                                        "YYYY-MM-DD",
                                      ),
                                      image_link:
                                        room?.image_link || row["IMAGE_DRIVER"],
                                      origin_link: row["IMAGE_DRIVER"] || "",
                                      is_deleted: false,
                                      description: normalizedDescriptionForCreate,
                                    };
                                    const res = await this.createRoom(data);
                                    if (!res?.id) {
                                      const createErrorSummary =
                                        this.formatErrorForLog(
                                          [res?.status, res?.code, res?.detail]
                                            .filter(Boolean)
                                            .join(" | "),
                                        );
                                      await this.appendToFile(
                                        "taophongloi.txt",
                                        `${huydev.link + idSheetUrl}|${
                                          item.code
                                        }|${
                                          row["ADDRESS"]
                                        }|${roomNumber}|${normalizedRowPrice}|${
                                          createErrorSummary
                                            ? "CREATE_ROOM_FAILED"
                                            : "CREATE_ROOM_NULL"
                                        }|${formattedDate}|${huydev.web}${
                                          createErrorSummary
                                            ? `|${createErrorSummary}`
                                            : ""
                                        }\n`,
                                      );
                                      console.error(
                                        `Tạo phòng ${roomNumber} thất bại cho tòa ${item.code}. ${createErrorSummary}`,
                                      );
                                      continue;
                                    }
                                    if (
                                      allowDuplicateRoomNames &&
                                      res?.id !== undefined &&
                                      res?.id !== null
                                    ) {
                                      allocatedRoomIds.add(res.id);
                                    }
                                    if (Array.isArray(searchRooms?.content)) {
                                      searchRooms.content.push(res);
                                    }
                                    this.incrementRunStats(
                                      huydev,
                                      item,
                                      "taoMoi",
                                    );
                                    this.incrementRunStats(
                                      huydev,
                                      item,
                                      "trong",
                                    );
                                    await this.appendToFile(
                                      "phongmoi.txt",
                                      `${huydev.link + idSheetUrl}|${
                                        item.code
                                      }|${row["ADDRESS"]}|${
                                        res?.id
                                      }|${roomNumber}|${normalizedRowPrice}|${formattedDate}|${
                                        huydev.web
                                      } Tạo phòng mới thành công\n`,
                                    );
                                    try {
                                      await this.updateRoom_RONG_PRICE_FB_DRIVER(
                                        res,
                                        row,
                                        item,
                                        huydev,
                                        idSheetUrl,
                                        roomNumber,
                                      );
                                    } catch (updateError) {
                                      await this.appendToFile(
                                        "taophongloi.txt",
                                        `${huydev.link + idSheetUrl}|${
                                          item.code
                                        }|${
                                          row["ADDRESS"]
                                        }|${roomNumber}|${normalizedRowPrice}|UPDATE_NEW_ROOM_FAILED|${formattedDate}|${
                                          huydev.web
                                        }|${
                                          updateError?.message || updateError
                                        }\n`,
                                      );
                                      console.error(
                                        `Tạo phòng ${roomNumber} thành công nhưng cập nhật sau tạo thất bại:`,
                                        updateError?.message || updateError,
                                      );
                                    }
                                  } else {
                                    console.log(
                                      `Phòng này ${roomNumber} đã tồn tại trong phongmoi.txt`,
                                    );
                                  }
                                }
                              }
                            }
                          } else {
                            console.log(
                              "No rooms found or searchRooms.content is undefined.",
                            );
                          }
                        } else {
                          const formattedDate = this.getFormattedDate();
                          const entryAddressContent = `${
                            huydev.link + idSheetUrl
                          }|${row["ADDRESS"]}|${formattedDate}`;

                          const noAddress = await this.checkIfEntryExists(
                            "nhamoi.txt",
                            entryAddressContent,
                          );

                          if (!noAddress) {
                            const errorMsg = `⚠️ KHÔNG TÌM THẤY ĐỊA CHỈ: ${row["ADDRESS"]} (Bảng hàng: ${huydev.web})`;
                            console.log(`\x1b[31m[DANGER] ${errorMsg}\x1b[0m`);
                            // await sendTelegramMessage(errorMsg);
                            missingAddresses.add(row["ADDRESS"]);
                            await this.appendToFile(
                              "thong_ke.txt",
                              `${this.getFormattedDate()} - KHÔNG TÌM THẤY ĐỊA CHỈ: ${
                                row["ADDRESS"]
                              } - ${huydev.web}\n`,
                            );

                            const formattedDate = this.getFormattedDate();

                            // let data = {
                            //   "code": `${new Date().getTime()}`,
                            //   "title": row["ADDRESS"],
                            //   "slugname": this.stringToSlug(row["ADDRESS"]),
                            //   "intro":  row["DESCRIPTIONS"] || "",
                            //   "content": row["DESCRIPTIONS"] || "",
                            //   "service_type": "string",
                            //   "service_time": new Date(),
                            //   "type": "chdv",
                            //   "status": "con",
                            //   "price": row["PRICE"] || 0,
                            //   "address": row["ADDRESS"],
                            //   "price": 0,
                            //   "rent_price_hour": 0,
                            //   "rent_price_day": 0,
                            //   "rent_price_month":  row["PRICE"] || 0,
                            //   "is_public": true,
                            //   "sale_bonus": 0,
                            //   "province_id": 0,
                            //   "district_id": 0,
                            //   "fb_group_url": "",
                            //   "fb_page_url": "",
                            //   "point": 0,
                            //   "owner_name": "",
                            //   "owner_phone": "",
                            //   "manager_phone": "",
                            //   "created_by": 0,
                            //   "created_time": new Date(),
                            //   "thumbnail": "",
                            //   "rent_time": "",
                            //   "bedroom_number": 0,
                            //   "floor_number": 0,
                            //   "acreage": 0,
                            //   "member_id": 0,
                            //   "rent_enddate": dayjs(new Date()).format('YYYY-MM-DD'),
                            //   "request_id": 0,
                            //   "address_valid": "",
                            //   "activity_time": new Date(),
                            //   "ophone_duplicate": 0,
                            //   "vaddress_duplicate": 0,
                            //   "rooms": `[]`,
                            //   "hide_revenue_expenditure": true,
                            //   "telegram_group": "",
                            //   "email": "",
                            //   "bank_account": "",
                            //   "collaborator_price": "",
                            //   "wholesale_price": "",
                            //   "want_borrow": 0,
                            //   "accountant_phone": "",
                            //   "is_list": true,
                            //   "created_at": new Date(),
                            //   "updated_at": null,
                            //   "is_list": true,
                            //   "updated_by": null,
                            //   "latitude": 0,
                            //   "longitude": 0,
                            //   "coordinates_valid": true,
                            //   "chu_dau_tu":  huydev.id,
                            // }

                            // const res = await this.createRealnew(data);
                            await this.appendToFile(
                              "nhamoi.txt",
                              `${huydev.link + idSheetUrl}|${
                                row["ADDRESS"]
                              }|${formattedDate}|${huydev.web} \n `,
                            );
                          } else {
                            console.log(
                              "Không tìm thấy địa chỉ trùng tên trong web.",
                            );
                          }
                        }
                      } else {
                        console.log(
                          "Tìm kiếm " +
                            row["ADDRESS"] +
                            "phòng " +
                            row["ROOMS"],
                          searchRealnews.content,
                        );

                        const formattedDate = this.getFormattedDate();
                        const normalizedRowPrice = this.normalizePriceValue(
                          row["PRICE"],
                          huydev,
                        );
                        const entryHollowContent = `${
                          huydev.link + idSheetUrl
                        }|${row["ADDRESS"]}|${
                          row["ROOMS"]
                        }|${normalizedRowPrice}|${formattedDate}`;

                        const arrayHollowAddress =
                          await this.checkIfEntryExists(
                            "khongcodulieu.txt",
                            entryHollowContent,
                          );

                        if (!arrayHollowAddress) {
                          const formattedDate = this.getFormattedDate();
                          await this.appendToFile(
                            "khongcodulieu.txt",
                            `${huydev.link + idSheetUrl}|${row["ADDRESS"]}|${
                              row["ROOMS"]
                            }|${normalizedRowPrice}|${formattedDate}|${
                              huydev.web
                            }\n`,
                          );

                          const errorMsg = `⚠️ KHÔNG CÓ DỮ LIỆU TÒA NHÀ TRÊN WEB: ${row["ADDRESS"]} (Bảng hàng: ${huydev.web})`;
                          console.log(`\x1b[31m[DANGER] ${errorMsg}\x1b[0m`);
                          // await sendTelegramMessage(errorMsg);
                          missingAddresses.add(row["ADDRESS"]);
                          await this.appendToFile(
                            "thong_ke.txt",
                            `${this.getFormattedDate()} - KHÔNG CÓ DỮ LIỆU TÒA NHÀ TRÊN WEB: ${
                              row["ADDRESS"]
                            } - ${huydev.web}\n`,
                          );
                        } else {
                          console.log(
                            `Đã tồn tại dữ liệu trong khongcodulieu.txt`,
                          );
                        }
                      }
                    } else {
                      console.log("Missing data in row:", row);
                      const formattedDate = this.getFormattedDate();
                      const entryContentroomsMismatch = `${
                        huydev.link + idSheetUrl
                      }|${row["BUILDING"]}|${row["ADDRESS"]}|${formattedDate}`;

                      const roomsMismatch = await this.checkIfEntryExists(
                        "ggsheet.txt",
                        entryContentroomsMismatch,
                      );

                      if (!roomsMismatch) {
                        const formattedDate = this.getFormattedDate();
                        await this.appendToFile(
                          "ggsheet.txt",
                          `${huydev.link + idSheetUrl}|${row["BUILDING"]}|${
                            row["ADDRESS"]
                          }|${formattedDate}|${huydev.web}\n`,
                        );
                      } else {
                        console.log(
                          `Đã lưu lỗi phòng trống vào file không có phòng ở google sheet.txt`,
                        );
                      }
                    }
                  } else {
                    console.log(
                      'Missing "ADDRESS" or "ROOMS" property in row:',
                      row,
                    );
                  }
                }

                if (this.runStats) {
                  for (let key in this.runStats) {
                    const stats = this.runStats[key];
                    totalTrong += stats.trong;
                    totalTaoMoi += stats.taoMoi;
                    const text = `Mã cdt: ${stats.cdt} | Mã tòa: ${
                      stats.toa
                    } | Trống: ${stats.trong} | Tạo mới: ${
                      stats.taoMoi
                    } | ${this.getFormattedDate()} | ${stats.bot}`;
                    await this.appendToFile("thong_ke.txt", `${text} \n`);

                    if (!cdtStats[stats.cdt]) {
                      cdtStats[stats.cdt] = {
                        trong: 0,
                        taoMoi: 0,
                        error: false,
                        empty: true,
                        totalDong: 0,
                      };
                    }
                    cdtStats[stats.cdt].trong += stats.trong;
                    cdtStats[stats.cdt].taoMoi += stats.taoMoi;
                  }
                  this.runStats = {}; // clear for next sheet
                }
              } else {
                console.log("Không có dữ liệu để xử lý.");
              }
            }

            // Gửi báo cáo địa chỉ thiếu sau khi chạy xong 1 CDT
            if (missingAddresses.size > 0) {
              const missingList = Array.from(missingAddresses).join("\n+ ");
              const summaryMsg = `❌ DANH SÁCH ĐỊA CHỈ THIẾU (id: ${huydev.id}|${executionKey}):\n+ ${missingList}`;
              await this.sendMainTelegramMessage(summaryMsg);
            }
            const formattedDate = this.getFormattedDate();
            await this.appendToFile(
              "exits.txt",
              `${executionKey}|${formattedDate}|TRUE\n`,
            );
          } catch (err) {
            console.error("Lỗi trong quá trình chạy" + huydev.web, err);
            cdtStats[huydev.id].error = true;
            const formattedDate = this.getFormattedDate();
            await this.appendToFile(
              "exits.txt",
              `${executionKey}|${formattedDate}|FALSE\n`,
            );
          }
          // quit
        } else {
          console.log(
            `Link GGSHEET + ${executionKey} đã được thực thi. nếu muốn chạy lại vui lòng vào exits.txt để cập nhật thành false hoặc delete.`,
          );
        }
      }

      // Calculate totals and build final message
      let finalMessages = [];
      for (let cdt in cdtStats) {
        let fileLine = `Mã cdt: ${cdt} | Tổng dòng: ${cdtStats[cdt].totalDong}`;
        if (cdtStats[cdt].error && cdtStats[cdt].link) {
          fileLine += ` | Lỗi link: ${cdtStats[cdt].link}`;
        }
        await this.appendToFile("thong_ke.txt", `${fileLine} \n`);

        if (cdtStats[cdt].error || cdtStats[cdt].empty) {
          finalMessages.push(
            `Mã cdt: ${cdt} không có phòng nào hoặc bị lỗi link`,
          );
        } else {
          let message = `Mã cdt: ${cdt} | Tổng dòng: ${cdtStats[cdt].totalDong}`;
          if (cdtStats[cdt].trong > 0 || cdtStats[cdt].taoMoi > 0) {
            message += ` | Trống: ${cdtStats[cdt].trong} | Tạo mới: ${cdtStats[cdt].taoMoi}`;
          }
          finalMessages.push(message);
        }
      }

      if (finalMessages.length > 0) {
        const BATCH_SIZE = 20;
        for (let i = 0; i < finalMessages.length; i += BATCH_SIZE) {
          let chunk = finalMessages.slice(i, i + BATCH_SIZE);
          if (i + BATCH_SIZE >= finalMessages.length) {
            let finalMessageText =
              chunk.join("\n") +
              `\nTổng Trống: ${totalTrong} | Tổng Tạo mới: ${totalTaoMoi} | ${this.getFormattedDate()}`;
            await this.sendMainTelegramMessage(finalMessageText);
          } else {
            let finalMessageText = chunk.join("\n");
            await this.sendMainTelegramMessage(finalMessageText);
          }
          await this.sleep(1000); // Tránh rate limit telegram khi gửi nhiều
        }
      } else if (totalTrong > 0 || totalTaoMoi > 0) {
        const finalMessage = `Trống: ${totalTrong} | Tạo mới: ${totalTaoMoi} | ${this.getFormattedDate()}`;
        await this.sendMainTelegramMessage(finalMessage);
      } else {
        const finalMessage = `Không có cập nhật mới | ${this.getFormattedDate()}`;
        await this.sendMainTelegramMessage(finalMessage);
      }

      await this.sendMainTelegramMessage(
        `Hoàn thành [${this.RUN_CONTEXT.toUpperCase()}]`,
      );
    } catch (error) {
      console.log("Lỗi ngoài cùng", error);
      try {
        await this.sendMainTelegramMessage(
          `Cập nhật thất bại [${this.RUN_CONTEXT.toUpperCase()}]: ${
            error?.message || error
          }`,
        );
      } catch (telegramError) {
        console.error(
          "[telegram] Không gửi được thông báo thất bại:",
          telegramError?.message || telegramError,
        );
      }
    } finally {
      if (hasRunLock) {
        await this.releaseMainRunLock();
      }
    }
  }

  // update phòng
  async updateRoom_RONG_PRICE_FB_DRIVER(
    room,
    row,
    item,
    huydev,
    idSheetUrl,
    roomNumber,
  ) {
    const formattedDate = this.getFormattedDate();
    const normalizedIncomingPrice = this.normalizePriceValue(
      row["PRICE"],
      huydev,
    );
    const normalizedCurrentPrice = this.normalizePriceValue(room?.price, huydev);
    const hasIncomingPrice = normalizedIncomingPrice > 0;
    const hasCurrentPrice = normalizedCurrentPrice > 0;
    const keepOldPriceWhenSheetMissing = Boolean(
      huydev?.keep_old_price_when_sheet_missing,
    );
    const hideRoomWhenNoPriceData = Boolean(huydev?.hide_room_when_no_price_data);

    if (!hasIncomingPrice && hideRoomWhenNoPriceData && !hasCurrentPrice) {
      await this.appendToFile(
        "khongcodulieu.txt",
        `${huydev.link + idSheetUrl}|${item.code}|${row["ADDRESS"]}|${
          room.id
        }|${roomNumber}|HIDE_ROOM_MISSING_NEW_AND_OLD_PRICE|${formattedDate}|${
          huydev.web
        }\n`,
      );
      try {
        await this.lockRoom({ id: room.id, date: "2099-12-30" });
      } catch (lockError) {
        console.warn(
          `Không khóa lại được phòng ${roomNumber} (${room.id}) khi thiếu giá:`,
          lockError?.message || lockError,
        );
      }
      console.warn(
        `Phòng ${roomNumber} (${room.id}) thiếu cả giá mới và giá cũ, giữ ở trạng thái kín.`,
      );
      return;
    }

    await this.unlockRoom(room.id);

    await this.appendToFile(
      "capnhattrong.txt",
      `${huydev.link + idSheetUrl}|${item.id}|${item.code}|${row["ADDRESS"]}|${
        room.id
      }|${roomNumber}|${formattedDate}|${huydev.web}\n`,
    );
    console.log(`Phòng ${roomNumber} với ID ${room.id} đã được mở khóa.`);
    let description = this.sanitizeTextForLegacyApi(room?.description || "");
    let price = room?.price;
    if (row["DESCRIPTIONS"]) {
      const rawDescription = row["DESCRIPTIONS"];
      const nextDescription = this.sanitizeTextForLegacyApi(rawDescription);
      if (nextDescription) {
        description = nextDescription;
        const extension = this.convertDescription2Extension(nextDescription);
        if (this.verboseRuntimeLogs) {
          console.log(extension);
        }
        const res = await this.callApi({
          domain: `https://apiv1.sari.vn/v1`,
          path: `/tag-relations/room/${room.id}`,
          method: "PUT",
          data: extension,
        });
        if (res.status !== 200) {
          console.log("Cập nhật trống thất bại");
        } else {
          if (this.verboseRuntimeLogs) {
            console.log("room.id=>>>>", room.id);
            console.log("Cập nhật trống thành công");
          }
        }
      }
    }

    const priceConvert = normalizedIncomingPrice;
    console.log(
      "Giá CŨ ĐÃ EDIT :",
      priceConvert + " Giá WEB SARI :",
      room.price,
    );

    if (hasIncomingPrice) {
      if (normalizedCurrentPrice !== priceConvert) {
        price = priceConvert;

        await this.appendToFile(
          "capnhatgia.txt",
          `${huydev.link + idSheetUrl}|${item.code}|${row["ADDRESS"]}|${
            room.id
          }|${roomNumber}|${
            room.price
          }(CŨ)|${priceConvert}(MỚI)|${formattedDate}|${huydev.web}\n`,
        );
      }
    } else if (keepOldPriceWhenSheetMissing) {
      await this.appendToFile(
        "khongcodulieu.txt",
        `${huydev.link + idSheetUrl}|${item.code}|${row["ADDRESS"]}|${
          room.id
        }|${roomNumber}|KEEP_OLD_PRICE_MISSING_SHEET_PRICE|${formattedDate}|${
          huydev.web
        }\n`,
      );
      console.log(
        `Phòng ${roomNumber} (${room.id}) thiếu giá trên sheet, giữ nguyên giá cũ ${room.price}.`,
      );
    } else if (normalizedCurrentPrice !== priceConvert) {
      price = priceConvert;

      await this.appendToFile(
        "capnhatgia.txt",
        `${huydev.link + idSheetUrl}|${item.code}|${row["ADDRESS"]}|${
          room.id
        }|${roomNumber}|${
          room.price
        }(CŨ)|${priceConvert}(MỚI)|${formattedDate}|${huydev.web}\n`,
      );
    }

    await this.updateRoom(room.id, {
      description: description,
      price: price,
      status: "con",
      is_deleted: false,
    });
    await this.updateAndDriver(
      room,
      row,
      roomNumber,
      huydev,
      idSheetUrl,
      item,
      formattedDate,
    );
    console.log(
      `Phòng ${roomNumber} với ID ${room.id} đã cập nhật giá/mô tả thành công.`,
    );
  }
  // update price
  async updateAndLogPrice(
    room,
    row,
    roomNumber,
    huydev,
    idSheetUrl,
    item,
    formattedDate,
  ) {
    const priceConvert = this.normalizePriceValue(row["PRICE"], huydev);
    if (
      priceConvert <= 0 &&
      Boolean(huydev?.keep_old_price_when_sheet_missing)
    ) {
      return;
    }
    console.log(
      "Giá CŨ ĐÃ EDIT :",
      priceConvert + " Giá WEB SARI :",
      room.price,
    );

    if (room.price !== priceConvert) {
      await this.updateRoom(room.id, { price: priceConvert });

      await this.appendToFile(
        "capnhatgia.txt",
        `${huydev.link + idSheetUrl}|${item.code}|${row["ADDRESS"]}|${
          room.id
        }|${roomNumber}|${
          room.price
        }(CŨ)|${priceConvert}(MỚI)|${formattedDate}|${huydev.web}\n`,
      );
      console.log(
        `Phòng ${roomNumber} với ID ${room.id} và đã được cập nhật giá ${row["PRICE"]}.`,
      );
    }
  }
  // kiểm tra fb có chưa
  async logImageLinkStatus(
    room,
    row,
    roomNumber,
    huydev,
    idSheetUrl,
    item,
    formattedDate,
  ) {
    if (!room.image_link) {
      await this.appendToFile(
        "facebook.txt",
        `${huydev.link + idSheetUrl}|${item.code}|${
          row["ADDRESS"]
        }|${roomNumber}|CHƯA CÓ LINK FB|${formattedDate}|${huydev.web}\n`,
      );
      console.log(`Phòng ${roomNumber} với ID ${room.id} chưa có link FB.`);
    }
  }
  // update link driver
  async updateAndDriver(
    room,
    row,
    roomNumber,
    huydev,
    idSheetUrl,
    item,
    formattedDate,
  ) {
    const imageDriver = (row["IMAGE_DRIVER"] || "").toString().trim();
    if (imageDriver) {
      try {
        const uploadResult = await this.downloadAllFilesFromFolder(
          imageDriver,
          room,
          "downloads",
        );

        if (uploadResult?.status === "uploaded") {
          await this.updateRoom(room.id, { origin_link: imageDriver });
          await this.appendToFile(
            "capnhatdriver.txt",
            `${huydev.link + idSheetUrl}|${item.code}|${
              row["ADDRESS"]
            }|${roomNumber}|${imageDriver}(M???I)|${formattedDate}|${
              huydev.web
            }\n`,
          );
          console.log(
            `Ph??ng ${roomNumber} v???i ID ${room.id} v?? ???? ???????c c???p nh???t h??nh t??? driver link ${imageDriver}.`,
          );
        } else if (uploadResult?.status === "already_uploaded") {
          await this.updateRoom(room.id, { origin_link: imageDriver });
          console.log(
            `Ph??ng ${roomNumber} v???i ID ${room.id} ???? c?? s???n ${uploadResult.count} ???nh tr??n MinIO.`,
          );
        } else if (uploadResult?.status === "keep_existing_low_new_count") {
          console.log(
            `Giữ ảnh cũ cho phòng ${roomNumber} (${room.id}) vì link mới chỉ có ${uploadResult.incomingCount} ảnh (<2).`,
          );
        } else if (uploadResult?.status === "empty_folder") {
          console.log(
            `Không tìm thấy ảnh khả dụng từ link ${imageDriver} cho phòng ${roomNumber}.`,
          );
        } else if (
          uploadResult?.status === "invalid_link" ||
          uploadResult?.status === "unsupported_link"
        ) {
          throw new Error(
            uploadResult?.message ||
              "Link ảnh không hợp lệ hoặc chưa được hỗ trợ.",
          );
        }
      } catch (error) {
        await this.appendToFile(
          "driver_error.txt",
          `${huydev.link + idSheetUrl}|${item.code}|${row["ADDRESS"]}|${
            room.id
          }|${roomNumber}|${imageDriver}|${
            error?.message || error
          }|${formattedDate}|${huydev.web}\n`,
        );
        console.error(
          `Lỗi cập nhật ảnh cho phòng ${roomNumber} với ID ${room.id}:`,
          error?.message || error,
        );
      }
    } else {
      const formattedDate = this.getFormattedDate();
      const entryContentIMAGE_DRIVERMismatch = `${huydev.link + idSheetUrl}|${
        row["BUILDING"]
      }|${row["ADDRESS"]}|KHÔNG CÓ LINK DRIVER|${formattedDate}|${huydev.web}`;

      const driversMismatch = await this.checkIfEntryExists(
        "ggsheet.txt",
        entryContentIMAGE_DRIVERMismatch,
      );

      if (!driversMismatch) {
        const formattedDate = this.getFormattedDate();
        await this.appendToFile(
          "ggsheet.txt",
          `${huydev.link + idSheetUrl}|${row["BUILDING"]}|${
            row["ADDRESS"]
          }|KHÔNG CÓ LINK DRIVER|${formattedDate}|${huydev.web}\n`,
        );
      } else {
        console.log(
          `Đã lưu lỗi driver vào file không có driver ở google sheet.txt`,
        );
      }
    }
  }

  getFormattedDate() {
    const now = new Date();
    return `${now.getDate()}/${
      now.getMonth() + 1
    }/${now.getFullYear()}-${now.getHours()}:${String(
      now.getMinutes(),
    ).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  }

  getIsoDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  normalizeLogFileName(fileName) {
    return path.basename(fileName || "").toLowerCase();
  }

  extractIsoDayKeyFromLogLine(line = "") {
    const match = line.match(
      /(\d{1,2})\/(\d{1,2})\/(\d{4})-(\d{1,2}):(\d{2})(?::(\d{2}))?/,
    );
    if (!match) {
      return null;
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const hours = Number(match[4]);
    const minutes = Number(match[5]);
    const seconds = Number(match[6] || 0);
    const parsedDate = new Date(year, month - 1, day, hours, minutes, seconds);
    const isValid =
      parsedDate.getFullYear() === year &&
      parsedDate.getMonth() === month - 1 &&
      parsedDate.getDate() === day &&
      parsedDate.getHours() === hours &&
      parsedDate.getMinutes() === minutes &&
      parsedDate.getSeconds() === seconds;

    if (!isValid) {
      return null;
    }

    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(
      2,
      "0",
    )}`;
  }

  async enforceLogRetentionByDay(fileName) {
    const normalizedFileName = this.normalizeLogFileName(fileName);
    if (!DAILY_ROTATION_LOG_FILES.has(normalizedFileName)) {
      return;
    }

    const todayKey = this.getIsoDayKey();
    if (
      this.logRetentionCleanupDateByFile.get(normalizedFileName) === todayKey
    ) {
      return;
    }

    try {
      const fileContent = await fs.readFile(fileName, "utf8");
      const lines = fileContent.split(/\r?\n/);
      const lineInfos = lines.map((line) => ({
        line,
        dayKey: this.extractIsoDayKeyFromLogLine(line),
      }));
      const dayKeys = [
        ...new Set(
          lineInfos.map((lineInfo) => lineInfo.dayKey).filter(Boolean),
        ),
      ].sort();

      if (dayKeys.length > this.logRetentionDays) {
        const keptDayKeys = new Set(dayKeys.slice(-this.logRetentionDays));
        const filteredLines = lineInfos
          .filter((lineInfo) => {
            if (!lineInfo.line || !lineInfo.line.trim()) {
              return false;
            }
            if (!lineInfo.dayKey) {
              return true;
            }
            return keptDayKeys.has(lineInfo.dayKey);
          })
          .map((lineInfo) => lineInfo.line);
        const nextContent =
          filteredLines.length > 0 ? `${filteredLines.join("\n")}\n` : "";

        if (nextContent !== fileContent) {
          await fs.writeFile(fileName, nextContent, "utf8");
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(
          `[log-retention] Skip cleanup for ${fileName}: ${
            error?.message || error
          }`,
        );
      }
    } finally {
      this.logRetentionCleanupDateByFile.set(normalizedFileName, todayKey);
    }
  }

  async appendToFile(fileName, content) {
    await this.enforceLogRetentionByDay(fileName);
    await fs.appendFile(fileName, content);
  }

  incrementRunStats(huydev, item, type) {
    if (!this.runStats) this.runStats = {};
    const statsKey = `${item.code}|${huydev.type || "default"}`;
    if (!this.runStats[statsKey]) {
      this.runStats[statsKey] = {
        cdt: huydev.id,
        toa: item.code,
        trong: 0,
        taoMoi: 0,
        bot: this.getSheetExecutionKey(huydev),
      };
    }
    if (type === "trong") {
      this.runStats[statsKey].trong += 1;
    } else if (type === "taoMoi") {
      this.runStats[statsKey].taoMoi += 1;
    }
  }

  async checkIfEntryExists(fileName, entryContent) {
    try {
      const fileContent = await fs.readFile(fileName, "utf8");
      return fileContent.includes(entryContent);
    } catch (error) {
      console.error(`Error reading file ${fileName}:`, error);
      return false;
    }
  }

  convertRoom(room) {
    if (!room) {
      return [];
    }
    // Handle multiple delimiters: comma, semicolon, newline
    let data = room.split(/[,\n;]/);
    let separators = ["\\(", "sẵn", "giá"];
    let roomseparate = "+";
    // Tạo biểu thức chính quy từ mảng các separators
    const regex = new RegExp(separators.join("|"), "gi");
    const rooms = [];
    data.forEach((item) => {
      let roomInfo = item.trim();
      if (!roomInfo) return;

      // Tách bỏ phần thông tin phụ sau dấu ( hoặc từ "giá" hoặc từ "sẵn"
      let roomPart = roomInfo.split(regex)[0].trim();
      if (!roomPart) return;

      // Xử lý định dạng 701.1+2+3
      let roomName = roomPart.split(".")[0];
      if (roomPart.split(".").length > 1) {
        roomPart
          .split(".")[1]
          .split(roomseparate)
          .forEach((suffix) => {
            rooms.push(`${roomName}.${suffix.trim()}`);
          });
      } else {
        rooms.push(roomName);
      }
    });
    return rooms;
  }

  convertPrice(priceStr) {
    if (typeof priceStr === "number") {
      return priceStr;
    }
    if (!priceStr) {
      return 0;
    }

    priceStr = priceStr.toLowerCase();

    // Ưu tiên lấy phần sau chữ "giá" nếu có
    if (priceStr.includes("giá")) {
      const parts = priceStr.split("giá");
      priceStr = parts[parts.length - 1];
    }

    // Thay thế dấu phẩy bằng dấu chấm để xử lý số thập phân
    priceStr = priceStr.replace(/,/g, ".");

    if (priceStr.includes("-") || priceStr.includes("–")) {
      return this.handlePriceRange(priceStr);
    }

    let total = 0;
    let unitFound = false;

    // 1. Xử lý các trường hợp có đơn vị (tr, m, k, trieu, ...)
    // Pattern: [Số] [Đơn vị] [Số phụ]
    const unitPatterns = [
      { regex: /(\d+(\.\d+)?)\s*(tr)(?!ieu|iệu)\s*(\d*)/g, unit: 1000000 },
      {
        regex: /(\d+(\.\d+)?)\s*(m|t(?!r)|trieu|triệu|củ)\s*(\d*)/g,
        unit: 1000000,
      },
      { regex: /(\d+(\.\d+)?)\s*k/g, unit: 1000 },
    ];

    unitPatterns.forEach((pattern) => {
      let match;
      while ((match = pattern.regex.exec(priceStr)) !== null) {
        unitFound = true;
        total += parseFloat(match[1]) * pattern.unit;
        if (match[4] && match[4].length > 0) {
          // Xử lý phần số sau đơn vị (ví dụ 3tr450 -> 3.450.000)
          total += parseInt(match[4].padEnd(6, "0"));
        }
      }
    });

    if (unitFound) {
      return total;
    }

    // 2. Nếu không có đơn vị, xử lý định dạng số có dấu chấm (ví dụ 5.000.000)
    const plainNumberWithDots = priceStr.match(/(\d{1,3})(\.\d{3})+/);
    if (plainNumberWithDots) {
      return parseInt(plainNumberWithDots[0].replace(/\./g, ""));
    }

    // 3. Cuối cùng, lấy số cuối cùng xuất hiện trong chuỗi (thường là giá, tránh số phòng ở đầu)
    const allNumbers = priceStr.match(/\d+/g);
    if (allNumbers && allNumbers.length > 0) {
      return parseInt(allNumbers[allNumbers.length - 1]);
    }

    return total;
  }

  getPricePlainNumberMultiplier(config = {}) {
    const multiplier = Number(config?.price_plain_number_multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      return 1;
    }
    return multiplier;
  }

  scalePlainPriceNumber(priceValue, config = {}) {
    const multiplier = this.getPricePlainNumberMultiplier(config);
    if (
      multiplier > 1 &&
      Number.isInteger(priceValue) &&
      priceValue >= 1000 &&
      priceValue < 100000
    ) {
      return priceValue * multiplier;
    }
    return priceValue;
  }

  applyConfiguredPriceScale(priceValue, config = {}) {
    const numericPrice = Number(priceValue);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      return 0;
    }

    const roundedPrice = Math.round(numericPrice);
    const hesogia = Number(config?.hesogia);
    if (!Number.isFinite(hesogia) || hesogia <= 0 || hesogia === 1) {
      return roundedPrice;
    }

    const hesogiaApplyWhenPriceLt = Number(config?.hesogia_apply_when_price_lt);
    if (
      Number.isFinite(hesogiaApplyWhenPriceLt) &&
      hesogiaApplyWhenPriceLt > 0 &&
      roundedPrice >= hesogiaApplyWhenPriceLt
    ) {
      return roundedPrice;
    }

    return Math.round(roundedPrice * hesogia);
  }

  extractVndPriceSegment(priceText = "") {
    const normalizedPriceText = this.normalizeSheetCellText(priceText);
    if (!normalizedPriceText) {
      return "";
    }

    const unitMatches = [
      ...normalizedPriceText.matchAll(
        /(\d+(?:[.,]\d+)?)\s*(?:trieu|triệu|tr|m|t(?!r)|cu|củ|k|vnđ|vnd|đ)(\d{0,6})\b/gi,
      ),
    ];
    if (unitMatches.length > 0) {
      return this.normalizeSheetCellText(
        unitMatches[unitMatches.length - 1]?.[0] || "",
      );
    }

    const dottedMatches = [
      ...normalizedPriceText.matchAll(/\b\d{1,3}(?:\.\d{3})+\b/g),
    ];
    if (dottedMatches.length > 0) {
      return this.normalizeSheetCellText(
        dottedMatches[dottedMatches.length - 1]?.[0] || "",
      );
    }

    const plainMatches = [...normalizedPriceText.matchAll(/\b\d{6,}\b/g)];
    if (plainMatches.length > 0) {
      return this.normalizeSheetCellText(
        plainMatches[plainMatches.length - 1]?.[0] || "",
      );
    }

    return "";
  }

  resolvePriceRawByCurrencyPreference(priceRaw, config = {}) {
    const normalizedPriceRaw = this.normalizeSheetCellText(priceRaw);
    if (!normalizedPriceRaw) {
      return { priceRaw: "", isUsdOnly: false };
    }

    if (!config?.prefer_vnd_over_usd) {
      return { priceRaw: normalizedPriceRaw, isUsdOnly: false };
    }

    const hasUsd = /(?:\$|\busd\b)/i.test(normalizedPriceRaw);
    if (!hasUsd) {
      return { priceRaw: normalizedPriceRaw, isUsdOnly: false };
    }

    const vndSegment = this.extractVndPriceSegment(normalizedPriceRaw);
    if (vndSegment) {
      return { priceRaw: vndSegment, isUsdOnly: false };
    }

    return { priceRaw: normalizedPriceRaw, isUsdOnly: true };
  }

  normalizePriceValue(priceStr, config = {}) {
    const hesogiaNum = Number(config?.hesogia);
    const treatSmallPlainNumberAsUsd =
      Number.isFinite(hesogiaNum) && hesogiaNum > 1;

    if (typeof priceStr === "number") {
      if (!Number.isFinite(priceStr) || priceStr <= 0) {
        return 0;
      }
      if (Number.isInteger(priceStr)) {
        const scaledIntegerPrice = this.scalePlainPriceNumber(priceStr, config);
        if (scaledIntegerPrice !== priceStr) {
          return scaledIntegerPrice;
        }
      }
      if (priceStr >= 1000) {
        return Math.round(priceStr);
      }
      if (treatSmallPlainNumberAsUsd) {
        return Math.round(priceStr);
      }
      return Math.round(priceStr * 1000000);
    }
    if (!priceStr) {
      return 0;
    }

    let normalizedPrice = priceStr
      .toString()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    if (normalizedPrice.includes("gia")) {
      const parts = normalizedPrice.split("gia");
      normalizedPrice = parts[parts.length - 1];
    }

    normalizedPrice = normalizedPrice
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/,/g, ".")
      .replace(/vn\u0111|vnd|\u0111/g, "")
      .replace(/\s*-\s*$/g, "")
      .trim();
    normalizedPrice = normalizedPrice.replace(/(\d)\s+(?=\d)/g, "$1");

    if (normalizedPrice.includes("-")) {
      return this.handleNormalizedPriceRange(normalizedPrice, config);
    }

    const compactMillionMatch = normalizedPrice.match(
      /(\d+(?:\.\d+)?)\s*(trieu|tr|m|t(?!r)|cu)\s*(\d{0,6})/i,
    );
    if (compactMillionMatch) {
      const mainValue = parseFloat(compactMillionMatch[1]) * 1000000;
      const suffixValue = this.convertCompactMillionDigits(
        compactMillionMatch[3],
      );
      return Math.round(mainValue + suffixValue);
    }

    const thousandMatch = normalizedPrice.match(/(\d+(?:\.\d+)?)\s*k\b/i);
    if (thousandMatch) {
      return Math.round(parseFloat(thousandMatch[1]) * 1000);
    }

    const plainNumberWithDots = normalizedPrice.match(
      /\b\d{1,3}(?:\.\d{3})+\b/,
    );
    if (plainNumberWithDots) {
      const dottedValue = parseInt(
        plainNumberWithDots[0].replace(/\./g, ""),
        10,
      );
      return this.scalePlainPriceNumber(dottedValue, config);
    }

    const decimalMatch = normalizedPrice.match(/\b\d+(?:\.\d+)\b/);
    if (decimalMatch) {
      const decimalValue = parseFloat(decimalMatch[0]);
      if (decimalValue >= 1000) {
        return this.scalePlainPriceNumber(Math.round(decimalValue), config);
      }
      if (treatSmallPlainNumberAsUsd) {
        return Math.round(decimalValue);
      }
      return Math.round(decimalValue * 1000000);
    }

    if (/^\d+$/.test(normalizedPrice)) {
      return this.scalePlainPriceNumber(parseInt(normalizedPrice, 10), config);
    }

    const plainNumber = normalizedPrice.match(/\b\d{4,}\b/);
    if (plainNumber) {
      return this.scalePlainPriceNumber(parseInt(plainNumber[0], 10), config);
    }

    const allNumbers = normalizedPrice.match(/\d+/g);
    if (allNumbers && allNumbers.length > 0) {
      const fallbackValue = parseInt(allNumbers[allNumbers.length - 1], 10);
      if (fallbackValue >= 1000) {
        return this.scalePlainPriceNumber(fallbackValue, config);
      }
    }

    return 0;
  }

  convertCompactMillionDigits(value = "") {
    if (!value) {
      return 0;
    }
    return parseInt(value.padEnd(6, "0").slice(0, 6), 10);
  }

  normalizeDuLichRoomName(value = "") {
    return this.removeVietnameseTonesSync(value).replace(/[^a-z0-9]+/g, "");
  }

  canonicalizeDuLichRoomName(value = "") {
    const normalizedValue = this.normalizeDuLichRoomName(value);
    if (!normalizedValue) {
      return "";
    }

    // Keep plain numeric room tokens as-is.
    // Avoid mapping "2" -> "2k1n" (or similar) via loose alias contains checks.
    if (/^\d+$/.test(normalizedValue)) {
      return normalizedValue;
    }

    for (const [canonicalName, aliases] of Object.entries(roomNameAliases)) {
      const candidates = [canonicalName, ...(aliases || [])]
        .map((alias) => this.normalizeDuLichRoomName(alias))
        .filter(Boolean);

      if (
        candidates.some(
          (candidate) =>
            normalizedValue === candidate ||
            normalizedValue.includes(candidate),
        )
      ) {
        return this.normalizeDuLichRoomName(canonicalName);
      }
    }

    return normalizedValue;
  }

  extractChdvRoomNames(text = "") {
    const result = [];
    const normalizedText = this.normalizeSheetCellText(text);

    // Handle compact "two rooms one price" notation, e.g. "502.402-3.7tr"
    // -> expand into ["502", "402"] so each room can be matched independently.
    const compactPairMatches =
      normalizedText.match(/\b\d{2,4}\.\d{2,4}\b/g) || [];
    compactPairMatches.forEach((pair) => {
      const [left, right] = pair.split(".");
      if (left && right) {
        result.push(left, right);
      }
    });

    const chdvPatterns = [
      // Preserve full alphanumeric room codes such as 405A4 / 202A19.
      /\b[pP]?\d{2,5}[a-zA-Z]\d{1,3}\b/g,
      /\b[pP]?\d{2,5}[a-zA-Z]?\b/g,
      /\b[tT]\d+[a-zA-Z]?\b/g,
      /\bCH\d*[a-zA-Z]?\b/gi,
      /tầng\s*[a-zA-Z0-9]+/gi,
      /sàn\s*[a-zA-Z0-9]+/gi,
      /phòng\s*[a-zA-Z0-9]+/gi,
      /giường\s*\d+/gi,
      /gác\s*xép/gi,
    ];

    chdvPatterns.forEach((pattern) => {
      const matches = normalizedText.match(pattern);
      if (matches) {
        result.push(...matches);
      }
    });

    const pMatch = normalizedText.match(/P?(\d+)\.([\d.]+)/gi);
    if (pMatch) {
      pMatch.forEach((p) => {
        const [, base, rest] = p.match(/P?(\d+)\.([\d.]+)/i);
        const subs = rest.split(".").map((sub) => `${base}.${sub}`);
        result.push(...subs);
      });
    }

    const floorRegex = /tầng\s*(\d+([\s,|+-]*\d+)*)/gi;
    const remainingText = normalizedText.replace(floorRegex, (_, floors) => {
      const expanded = floors
        .split(/[\s,|+-]+/)
        .map((f) => f.trim())
        .filter((f) => f)
        .map((f) => `Tầng ${f}`);
      result.push(...expanded);
      return "";
    });

    // Extract plain numeric room codes only when they stand alone.
    const codeRegex = /\b\d{3}(?:\.\d+)?\b/g;
    const matchesRoom = remainingText.match(codeRegex);
    if (matchesRoom) {
      result.push(...matchesRoom);
    }

    const uniqueRaw = [
      ...new Set(result.map((r) => r.toString().toLowerCase())),
    ];
    const unique = uniqueRaw.filter((str, index, arr) => {
      return !arr.some((otherStr, otherIndex) => {
        return index !== otherIndex && otherStr.includes(str);
      });
    });

    const alphaNumericRoomCodes = unique.filter(
      (value) => /[a-z]/i.test(value) && /\d/.test(value),
    );
    if (alphaNumericRoomCodes.length > 0) {
      return alphaNumericRoomCodes;
    }

    const strictRoomCodes = unique.filter((value) =>
      /^\d{2,4}(?:\.\d+)?$/.test(value),
    );
    if (strictRoomCodes.length > 0) {
      return strictRoomCodes;
    }

    return unique;
  }

  extractDuLichRoomNames(text = "") {
    const expandCombinedRoomCodes = (value = "") => {
      const roomText = this.normalizeSheetCellText(value);
      if (!roomText.includes("+")) {
        return [roomText];
      }

      const parts = roomText
        .split("+")
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length <= 1) {
        return [roomText];
      }

      const roomCodePattern =
        /^(?:[a-z]+\.)?\d+(?:\.\d+)?[a-z]*$|^[a-z]+\d+(?:\.\d+)?[a-z]*$/i;
      const suffixPattern = /^\d+[a-z]*$/i;
      if (!roomCodePattern.test(parts[0])) {
        return [roomText];
      }

      const prefixMatch = parts[0].match(/^(.*?)(\d+(?:\.\d+)?[a-z]*)$/i);
      const shorthandPrefix = prefixMatch ? prefixMatch[1] : "";

      const expandedParts = [parts[0]];
      for (const part of parts.slice(1)) {
        if (suffixPattern.test(part) && shorthandPrefix) {
          expandedParts.push(`${shorthandPrefix}${part}`);
          continue;
        }

        if (roomCodePattern.test(part)) {
          expandedParts.push(part);
          continue;
        }

        return [roomText];
      }

      return expandedParts;
    };

    const expandRangeRoomCodes = (value = "") => {
      const roomText = this.normalizeSheetCellText(value);
      if (!roomText) {
        return [];
      }

      const normalizedText = this.removeVietnameseTonesSync(roomText)
        .replace(/\s+/g, " ")
        .trim();

      const samePrefixRangeMatch = normalizedText.match(
        /^([a-z]+)\s*(\d+[a-z]?)\s*[-\u2013\u2014]\s*(?:([a-z]+)\s*)?(\d+[a-z]?)$/i,
      );
      if (!samePrefixRangeMatch) {
        return [roomText];
      }

      const [, startPrefix, startSuffix, endPrefix, endSuffix] =
        samePrefixRangeMatch;
      if (endPrefix && startPrefix !== endPrefix) {
        return [roomText];
      }

      const normalizedPrefix = startPrefix.toUpperCase();
      return [
        `${normalizedPrefix}${startSuffix.toUpperCase()}`,
        `${normalizedPrefix}${endSuffix.toUpperCase()}`,
      ];
    };

    return [
      ...new Set(
        this.normalizeSheetCellText(text)
          .split(/[,\n;|]+/)
          .map((part) => part.trim())
          .filter((part) => part)
          .flatMap((part) => expandRangeRoomCodes(part))
          .flatMap((part) => expandCombinedRoomCodes(part))
          .filter((part) => this.extractChdvRoomNames(part).length === 0)
          .map((part) => this.canonicalizeDuLichRoomName(part))
          .filter(Boolean),
      ),
    ];
  }

  extractHybridRoomNames(text = "") {
    return [
      ...new Set([
        ...this.extractChdvRoomNames(text),
        ...this.extractDuLichRoomNames(text),
      ]),
    ];
  }

  roomNamesMatch(roomName = "", inputName = "", type = "chdv") {
    if (type === "du_lich") {
      return (
        this.canonicalizeDuLichRoomName(roomName) ===
        this.canonicalizeDuLichRoomName(inputName)
      );
    }

    if (type === "hybrid") {
      const normalizedRoomName = roomName.trim().toLowerCase();
      const normalizedInputName = inputName.trim().toLowerCase();
      if (normalizedRoomName === normalizedInputName) {
        return true;
      }

      const roomCandidates = this.extractHybridRoomNames(roomName);
      const inputCandidates = this.extractHybridRoomNames(inputName);
      if (roomCandidates.length > 0 && inputCandidates.length > 0) {
        return roomCandidates.some((candidate) =>
          inputCandidates.includes(candidate),
        );
      }

      return (
        this.canonicalizeDuLichRoomName(roomName) ===
        this.canonicalizeDuLichRoomName(inputName)
      );
    }

    return roomName.trim().toLowerCase() === inputName.trim().toLowerCase();
  }

  getAllocatedRoomIds(roomAllocationPool, realNewId) {
    const allocationKey = String(realNewId);
    if (!roomAllocationPool.has(allocationKey)) {
      roomAllocationPool.set(allocationKey, new Set());
    }
    return roomAllocationPool.get(allocationKey);
  }

  findMatchedRoom(
    rooms = [],
    roomNumber = "",
    type = "chdv",
    allocatedRoomIds = new Set(),
    allowDuplicateRoomNames = false,
    targetPrice = 0,
    priceConfig = {},
  ) {
    const pickMatchedRoom = (candidates = []) => {
      if (candidates.length === 0) {
        return null;
      }
      if (!allowDuplicateRoomNames) {
        return candidates[0];
      }
      return candidates.find((room) => !allocatedRoomIds.has(room.id)) || null;
    };

    const matchingRooms = rooms.filter((room) =>
      this.roomNamesMatch(room.name, roomNumber, type),
    );
    if (matchingRooms.length === 0) {
      return null;
    }

    if (matchingRooms.length > 1) {
      const normalizedTargetPrice = this.normalizePriceValue(
        targetPrice,
        priceConfig,
      );
      // Có nhiều phòng trùng tên trong cùng tòa:
      // bắt buộc dùng GIÁ để định danh, không fallback "lấy phòng đầu tiên".
      if (normalizedTargetPrice <= 0) {
        return null;
      }

      const priceMatchedRooms = matchingRooms.filter((room) => {
        const normalizedRoomPrice = this.normalizePriceValue(
          room?.price,
          priceConfig,
        );
        return normalizedRoomPrice === normalizedTargetPrice;
      });
      const matchedByPrice = pickMatchedRoom(priceMatchedRooms);
      if (matchedByPrice) {
        return matchedByPrice;
      }

      // Trùng tên nhưng không khớp giá => coi là phòng khác, tránh cập nhật nhầm.
      return null;
    }

    return pickMatchedRoom(matchingRooms);
  }

  handleNormalizedPriceRange(rangeStr, config = {}) {
    const [startStr] = rangeStr
      .split(/[-\u2013\u2014]/)
      .map((part) => part.trim());
    return this.normalizePriceValue(startStr, config);
  }

  handlePriceRange(rangeStr) {
    const [startStr] = rangeStr.split(/[-–]/).map((part) => part.trim());
    return this.convertPrice(startStr);
  }

  handlePriceRange(rangeStr) {
    const [startStr] = rangeStr
      .split(/[-\u2013\u2014]/)
      .map((part) => part.trim());
    return this.normalizePriceValue(startStr);
  }

  getSheetExecutionKey(huydev) {
    const customExecutionKey = this.normalizeSheetCellText(
      huydev?.execution_key,
    );
    if (customExecutionKey) {
      return customExecutionKey;
    }

    const webKey = this.normalizeSheetCellText(huydev?.web) || "unknown_web";
    const typeKey = this.normalizeSheetCellText(huydev?.type) || "default";
    const gidList = Array.isArray(huydev?.list_address)
      ? huydev.list_address
          .map((gid) => this.normalizeSheetCellText(gid))
          .filter(Boolean)
      : [];
    const toKeyPart = (value) =>
      this.normalizeSheetCellText(
        value !== undefined && value !== null ? value : "",
      );
    const toJoinedKey = (value) => {
      if (!Array.isArray(value) || value.length === 0) {
        return "";
      }
      return value.map((item) => toKeyPart(item)).join(",");
    };
    const configSignatureParts = [
      `addr:${toJoinedKey(huydev?.address_column)}`,
      `room:${toJoinedKey(huydev?.room_column)}`,
      `code:${toJoinedKey(huydev?.building_code_column)}`,
      `price:${toJoinedKey(huydev?.price_column)}`,
      `exitCol:${toKeyPart(huydev?.exitColumn)}`,
      `exitDriver:${toKeyPart(huydev?.exitLinkDriver)}`,
      `header:${toKeyPart(huydev?.header)}`,
    ];
    const configSignature = configSignatureParts.join("|");

    if (gidList.length === 1) {
      return `${webKey}|${typeKey}|gid:${gidList[0]}|${configSignature}`;
    }

    return `${webKey}|${typeKey}|${configSignature}`;
  }

  async replaceAbbreviations(text, type = "chdv") {
    if (type === "du_lich") {
      return this.extractDuLichRoomNames(text);
    }

    if (type === "hybrid") {
      const normalizedText = this.normalizeSheetCellText(text);
      if (
        normalizedText &&
        !/^(?:phong\s*)?[a-z]?\d{2,5}(?:\.\d+(?:\+\d+)*)?[a-jl-z]?\b/i.test(
          normalizedText,
        ) &&
        /[a-z]/i.test(this.normalizeComparableText(normalizedText))
      ) {
        return [normalizedText];
      }
      return this.extractHybridRoomNames(text);
    }

    return this.extractChdvRoomNames(text);
  }

  async searchRealnew(address) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const searchData = [
        {
          key: "address",
          op: "like",
          firstValue: `${address}`,
          secondValue: "",
        },
      ];

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_REALNEW_SEARCH + `?page=${this.PAGE}&size=${this.SIZE}`,
          searchData,
          { headers: headers, timeout: this.apiRequestTimeoutMs },
        ),
      );
      const responseData = response.data;
      return responseData;
    } catch (error) {
      console.error("Error searchRealnew:", error);
      throw error;
    }
  }

  async searchRealnewByInvestor(investor) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const searchData = [
        {
          key: "chu_dau_tu",
          op: "like",
          firstValue: `${investor}`,
          secondValue: "",
        },
      ];

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_REALNEW_SEARCH + `?page=${this.PAGE}&size=${this.SIZE}`,
          searchData,
          { headers: headers, timeout: this.apiRequestTimeoutMs },
        ),
      );
      const responseData = response.data;
      return responseData;
    } catch (error) {
      console.error("Error searchRealnew:", error);
      throw error;
    }
  }

  async searchRoom(id) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const searchData = {
        real_new_id: id,
      };

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_ROOM_SEARCH + `?page=${this.PAGE}&size=${this.SIZE}`,
          searchData,
          { headers: headers, timeout: this.apiRequestTimeoutMs },
        ),
      );
      const responseData = response.data;
      return responseData;
    } catch (error) {
      console.error("Error searchRoom:", error);
      throw error;
    }
  }

  async unlockRoom(id) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_UNLOCK_ROOM + `?id=${id}`,
          {},
          { headers: headers, timeout: this.apiRequestTimeoutMs },
        ),
      );
      const responseData = response.data;
      if (this.verboseRuntimeLogs) {
        console.log("Data unlock", responseData);
      }
      return responseData;
    } catch (error) {
      console.error("Error unlockRoom:", error);
      throw error;
    }
  }

  async callApi({ domain, path = "", method = "GET", data = {} }) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };
      let url = domain + path;
      const response = await axios({
        url,
        method,
        data,
        headers,
        timeout: this.apiRequestTimeoutMs,
      });

      return response;
    } catch (error) {
      console.error("❌ Lỗi gọi API:", error.response?.data || error.message);
      return error.response?.data || error.message;
    }
  }

  async updateRoomByRealnew(rooms) {
    try {
      const res = await this.callApi({
        domain: `https://api-legacy.sari.vn/v1`,
        path: `/rooms/lockRoomsToDates`,
        method: "POST",
        data: (rooms || []).map((room) => ({
          roomId: room.id,
          endDate: "2099-12-30",
        })),
      });
      if (res.status !== 200) {
        console.log(`Cập nhật kín ${rooms.length} phòng thất bại`);
      } else {
        console.log(`Cập nhật kín ${rooms.length} phòng thành công`);
      }
      const responseData = res.data;
      return responseData;
    } catch (error) {
      console.error("Error updateRoomManyRooms:", error);
    }
  }

  async updateRoom(id, data) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const response = await this.retryRequest(() =>
        axios.patch(this.URL_API_UPDATE_ROOM + id, data, {
          headers: headers,
          timeout: this.apiRequestTimeoutMs,
        }),
      );
      const responseData = response.data;
      if (this.verboseRuntimeLogs) {
        console.log("updateRoom response", responseData);
      }
      return responseData;
    } catch (error) {
      console.error("Error updateRoom:", error);
      throw error;
    }
  }

  async createRealnew(data) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const response = await this.retryRequest(() =>
        axios.post("https://api-legacy.sari.vn/v1/realnews", data, {
          headers: headers,
          timeout: this.apiRequestTimeoutMs,
        }),
      );
      const responseData = response?.data;
      console.log("Tạo thành công tòa mới");
      return responseData;
    } catch (error) {
      console.error("Error updateRoom:", error);
      return null;
    }
  }

  async createRoom(data) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const response = await this.retryRequest(() =>
        axios.post("https://api-legacy.sari.vn/v1/rooms", data, {
          headers: headers,
          timeout: this.apiRequestTimeoutMs,
        }),
      );
      const responseData = response.data;
      console.log("Tạo phòng mới thành công ::", responseData);
      return responseData;
    } catch (error) {
      const { status, code, detail } = this.getRequestErrorSummary(error);
      console.error("Error createRoom:", status || code || "UNKNOWN", detail);
      return {
        __failed: true,
        status,
        code,
        detail,
      };
    }
  }

  stringToSlug(str) {
    return str
      .toLowerCase()
      .replace(/đ/g, "d") // thay đ → d
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // xóa dấu
      .replace(/[^a-z0-9\s-]/g, "") // xóa ký tự đặc biệt
      .replace(/\s+/g, "-") // thay khoảng trắng bằng dấu -
      .replace(/-+/g, "-") // gộp nhiều dấu -
      .replace(/^-+|-+$/g, ""); // xóa - đầu và cuối
  }

  async lockRoom(data) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };
      //https://api-legacy.sari.vn/v1/rooms/lockRoomToDate?id=9347&date=2024-08-23

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_LOCK_ROOM + `id=${data.id}&date=${data.date}`,
          {},
          {
            headers: headers,
            timeout: this.apiRequestTimeoutMs,
          },
        ),
      );
      const responseData = response.data;
      if (this.verboseRuntimeLogs) {
        console.log("lockRoom response", responseData);
      }
      return responseData;
    } catch (error) {
      console.error("Error lockRoom:", error.data);
      throw error;
    }
  }
}

// cái này chạy trực tiếp thì phải tắt hẹn giờ ở trên đi từ 2485--> 2495
async function runMainFlow() {
  const reg = new UpdateRoomSari();
  return reg.run();
}

if (require.main === module) {
  runMainFlow();
}
module.exports = { UpdateRoomSari, runMainFlow };

// ưng chạy cái nào thì mở 1 trong 2 rồi ra lệnh node.ndex.js -> sp cái này lần cuối nhé.
