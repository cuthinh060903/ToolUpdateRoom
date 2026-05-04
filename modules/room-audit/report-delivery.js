const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { sendTelegramMessage } = require("../../telegram_bot");
const { LIST_GGSHEET } = require("../../constants");
const { filterCode3SourceErrors } = require("./source-error-filter");

const DEFAULT_REPORT_SHEET = {
  spreadsheetId: "11EyNOVAMn7ei-J8svcMjpvv1B7AashTUDyRB-gUeHho",
  sheetGid: 297377874,
  headerRow: 1,
  firstDataRow: 2,
  lastDataRow: 14,
  firstDayColumn: 7,
  dayColumnWindowSize: 10,
};

const ADDRESS_FIELD_REASONS = new Set(["ADDRESS_MISSING"]);
// II.B.5 = setup "tên phòng" column smells wrong. Do not use ROOM_NOT_MATCHED_* (API/sync)
// or ROOM_NAME_MISSING (empty row) — those are not column-misalignment signals.
const ROOM_NAME_FIELD_REASONS = new Set(["ROOM_NAME_LOOKS_LIKE_PRICE"]);
const PRICE_FIELD_REASONS = new Set([
  "PRICE_UNPARSEABLE",
  "PRICE_LOOKS_LIKE_ROOM_NAME",
]);
const NO_IMAGE_REASONS = new Set(["IMAGE_COUNT_ZERO"]);
const NEW_BUILDING_LOG_FILES = ["nhamoi.txt", "khongcodulieu.txt"];
const CDT_CONFIG_FILE = "constants.js";

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return value.toString().trim();
}

function looksLikePriceText(value = "") {
  const text = normalizeText(value);
  return /(?:^|\s)(\$+\s*\d+([.,]\d+)?|\d+([.,]\d+)?\s*(tr|trieu|triệu|m|k|vnd|usd|d|đ|\$)|\d{6,})(?:\s|$)/i.test(
    text,
  );
}

function looksLikeRoomText(value = "") {
  const text = normalizeText(value);
  return /^(?:phong\s*)?[a-z]?\d{2,5}(?:\.\d+)?[a-z]?$/i.test(text);
}

function isPlainNumberString(value = "") {
  return /^[\d\s.,]+$/.test(normalizeText(value));
}

function stripTrailingCurrencySuffix(value = "") {
  return normalizeText(value)
    .replace(/(?:\s*[d\u0111])+\s*$/i, "")
    .trim();
}

function isLikelyRoomCodeList(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  const tokens = text
    .split(/[\n,;|]+/)
    .map((token) => stripTrailingCurrencySuffix(token))
    .filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }

  return tokens.every((token) => {
    if (looksLikeRoomText(token)) {
      return true;
    }

    return /^\d{2,4}\s*[-/]\s*\d{2,4}$/.test(token);
  });
}

function isNarrativeNoteText(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const letterCount = (text.match(/\p{L}/gu) || []).length;
  return wordCount >= 6 && letterCount >= 12;
}

function isLikelyRoomPriceCombinedCell(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  const segments = text
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    if (!segment.includes("-")) {
      continue;
    }

    const dashIndex = segment.indexOf("-");
    const left = segment.slice(0, dashIndex).trim();
    const right = segment.slice(dashIndex + 1).trim();
    if (!left || !right) {
      continue;
    }
    if (looksLikePriceText(right)) {
      return true;
    }
  }

  return false;
}

function isPriceLikeRoomField(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  if (isLikelyRoomPriceCombinedCell(text)) {
    return false;
  }

  if (isNarrativeNoteText(text)) {
    return false;
  }

  if (isLikelyRoomCodeList(text)) {
    return false;
  }

  const strippedText = stripTrailingCurrencySuffix(text);
  if (looksLikeRoomText(strippedText)) {
    return false;
  }

  return looksLikePriceText(text);
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "y"].includes(value.toString().toLowerCase());
}

function parseNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSheetQuotaError(error) {
  const status = Number(error?.response?.status || 0);
  const message = (error?.message || "").toString();
  const apiMessage = (error?.response?.data?.error?.message || "").toString();
  const combined = `${message} ${apiMessage}`.toLowerCase();

  return (
    status === 429 ||
    combined.includes("quota exceeded") ||
    combined.includes("read requests per minute") ||
    combined.includes("user rate limit exceeded")
  );
}

async function withSheetRetry(action, options = {}) {
  const maxAttempts = parseNumber(options.maxAttempts, 5) || 5;
  const baseDelayMs = parseNumber(options.baseDelayMs, 1500) || 1500;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const shouldRetry = isSheetQuotaError(error) && attempt < maxAttempts;
      if (!shouldRetry) {
        throw error;
      }

      const delayMs = baseDelayMs * attempt;
      console.warn(
        `[room-audit][sheet] quota/rate-limit, retry ${attempt}/${maxAttempts} after ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function getCurrentDateLabels(date = new Date()) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");

  return {
    dayHeader: `${day}-${month}-${year}`,
    timestamp: `${day}-${month}-${year} [${hour}:${minute}:${second}]`,
  };
}

function collectUniqueSortedCdtIds(values = []) {
  const unique = [
    ...new Set(values.filter((value) => value !== null && value !== undefined)),
  ]
    .map((value) => value.toString().trim())
    .filter(Boolean);

  return unique.sort((a, b) => {
    const aNum = Number(a);
    const bNum = Number(b);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      return aNum - bNum;
    }
    return a.localeCompare(b, "vi");
  });
}

function cdtListText(values = []) {
  const ids = collectUniqueSortedCdtIds(values);
  return ids.length > 0 ? ids.join(", ") : "Không phát hiện lỗi";
}

function parseSourceLabelsFromErrorMessage(message = "") {
  const text = normalizeText(message);
  if (!text) {
    return [];
  }

  const labels = new Set();
  const matches = text.match(/\bAI0\b|\bAI1\b|\bAI2\b|\bMANUAL3\b/gi) || [];
  matches.forEach((label) => labels.add(label.toUpperCase()));
  return [...labels];
}

function mapSourceLabelToLinkIndex(label = "") {
  const normalizedLabel = normalizeText(label).toUpperCase();
  if (!normalizedLabel) {
    return null;
  }

  if (normalizedLabel === "AI0") {
    return 1;
  }

  if (["AI1", "AI2", "MANUAL3"].includes(normalizedLabel)) {
    return 2;
  }

  return null;
}

function buildCode3CdtWithLinkText(sourceErrors = []) {
  if (!Array.isArray(sourceErrors) || sourceErrors.length === 0) {
    return "Không phát hiện lỗi";
  }

  const cdtToLinkIndexes = new Map();

  sourceErrors.forEach((sourceError) => {
    const cdtId = normalizeText(sourceError?.cdt_id);
    if (!cdtId) {
      return;
    }

    if (!cdtToLinkIndexes.has(cdtId)) {
      cdtToLinkIndexes.set(cdtId, new Set());
    }

    const linkIndexes = cdtToLinkIndexes.get(cdtId);
    const sourceLabels = parseSourceLabelsFromErrorMessage(sourceError?.message);
    sourceLabels.forEach((label) => {
      const linkIndex = mapSourceLabelToLinkIndex(label);
      if (linkIndex !== null) {
        linkIndexes.add(linkIndex);
      }
    });
  });

  const sortedCdtIds = collectUniqueSortedCdtIds([...cdtToLinkIndexes.keys()]);
  if (sortedCdtIds.length === 0) {
    return "Không phát hiện lỗi";
  }

  return sortedCdtIds
    .map((cdtId) => {
      const linkIndexes = [...(cdtToLinkIndexes.get(cdtId) || [])].sort(
        (a, b) => a - b,
      );
      if (linkIndexes.length === 0) {
        return cdtId;
      }
      return `${cdtId} (${linkIndexes.join(",")})`;
    })
    .join(", ");
}

function collectVacantRoomCountByCdt(rows = []) {
  const countByCdtId = new Map();

  rows.forEach((row) => {
    const cdtId = normalizeText(row?.cdt_id);
    if (!cdtId) {
      return;
    }

    countByCdtId.set(cdtId, (countByCdtId.get(cdtId) || 0) + 1);
  });

  return collectUniqueSortedCdtIds([...countByCdtId.keys()]).map((cdtId) => ({
    cdtId,
    count: countByCdtId.get(cdtId) || 0,
  }));
}

function vacantRoomCountByCdtText(rows = []) {
  const counts = collectVacantRoomCountByCdt(rows).filter(
    (item) => item.count > 0,
  );
  if (counts.length === 0) {
    return "Không có CĐT có phòng trống";
  }

  return counts.map((item) => `${item.cdtId} (${item.count})`).join(", ");
}

function rowHasAnyReason(row = {}, reasonSet = new Set()) {
  return (row.error_detail || []).some((reason) => reasonSet.has(reason));
}

function isAddressColumnError(row = {}) {
  const hasAddressReason = rowHasAnyReason(row, ADDRESS_FIELD_REASONS);
  // Use only explicit mapping/log reasons to avoid over-detecting CDT.
  return hasAddressReason;
}

function isRoomNameColumnError(row = {}) {
  const hasSheetSignal = rowHasAnyReason(row, ROOM_NAME_FIELD_REASONS);
  if (!hasSheetSignal) {
    return false;
  }

  // II.B.5 is only about setup room-column on sheet, not API-side values.
  return isPriceLikeRoomField(row.room_name);
}

function isPriceColumnError(row = {}) {
  const priceRaw = normalizeText(row.price_raw);
  return (
    rowHasAnyReason(row, PRICE_FIELD_REASONS) ||
    (priceRaw && !isPlainNumberString(priceRaw) && looksLikeRoomText(priceRaw))
  );
}

function isImageColumnError(_row = {}) {
  // II.B.7: không suy "lệch cột" từ IMAGE_* / INVALID_URL / text giống số phòng
  // (nhãn ô "304", "Click"...). Thiếu link → II.B.8. Có thể bật lại khi có reason riêng.
  return false;
}

function isMissingImageLinkError(row = {}) {
  const imageDriver = normalizeText(row.image_driver);
  return (
    Number(row?.image_count) === 0 ||
    rowHasAnyReason(row, NO_IMAGE_REASONS) ||
    imageDriver === ""
  );
}

function normalizeComparableText(value = "") {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function collectLikelyNoVacantCdtIds(report = {}) {
  const code6Candidates = Array.isArray(report?.code6_candidates)
    ? report.code6_candidates
    : [];
  return code6Candidates
    .map((item) => item?.cdt_id)
    .filter((value) => value !== null && value !== undefined);
}

function buildNoVacantLine(report = {}) {
  return `II.A.2: Các CĐT có phòng trống bằng 0: ${cdtListText(
    collectLikelyNoVacantCdtIds(report),
  )}`;
}

function extractLogDateParts(line = "") {
  const match = normalizeText(line).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year)
  ) {
    return null;
  }

  return { day, month, year };
}

function resolveReportDateParts(report = {}, now = new Date()) {
  const generatedAt = normalizeText(report?.generated_at);
  const match = generatedAt.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
  }

  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  };
}

function isSameCalendarDate(dateA = null, dateB = null) {
  if (!dateA || !dateB) {
    return false;
  }

  return (
    Number(dateA.day) === Number(dateB.day) &&
    Number(dateA.month) === Number(dateB.month) &&
    Number(dateA.year) === Number(dateB.year)
  );
}

function isLikelyGarbageNewBuildingAddress(address = "") {
  const raw = normalizeText(address);
  if (!raw) {
    return true;
  }

  const normalized = normalizeComparableText(raw);
  if (!normalized) {
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
      /^anh\+?video\b/i,
      /^kinh nho\b/i,
      /\bdoi tac\b/i,
      /\bghep khach\b/i,
      /^hotline\b/i,
      /^sdt\b/i,
      /^lien he\b/i,
      /^cam on ctv\b/i,
      /^danh sach\b/i,
      /\brad apartment\b/i,
    ].some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }

  const compact = normalized.replace(/\s+/g, "");
  if (/^[a-z0-9.+-]{2,8}$/i.test(compact) && !/\s/.test(raw)) {
    return true;
  }

  const digitCount = (normalized.match(/\d/g) || []).length;
  const letterCount = (normalized.match(/[a-z]/g) || []).length;
  const hasAddressKeyword = [
    "so ",
    "ngo ",
    "ngach ",
    "duong ",
    "pho ",
    "hem ",
    "phuong ",
    "quan ",
    "lo ",
    "toa ",
    "khu ",
    "can ",
  ].some((keyword) => normalized.includes(keyword));
  if (digitCount >= 8 && !hasAddressKeyword) {
    return true;
  }
  if (!hasAddressKeyword && digitCount <= 1 && letterCount <= 6) {
    return true;
  }

  return false;
}

function readWorkspaceLogLines(fileName = "") {
  if (!fileName) {
    return [];
  }

  try {
    const fullPath = path.resolve(__dirname, "../..", fileName);
    const content = fs.readFileSync(fullPath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseMissingBuildingLogLine(line = "") {
  const parts = normalizeText(line)
    .split("|")
    .map((value) => value.trim());
  if (parts.length < 2) {
    return {
      sheetKey: "",
      address: "",
      line,
    };
  }

  return {
    sheetKey: parts[0] || "",
    address: parts[1] || "",
    line,
  };
}

function buildSheetKeyToCdtIdMap(rows = []) {
  const mapping = new Map();
  rows.forEach((row) => {
    const sheetKey = `${normalizeText(row?.sheet_link)}${normalizeText(
      row?.sheet_gid,
    )}`.trim();
    if (!sheetKey) {
      return;
    }

    if (row?.cdt_id === null || row?.cdt_id === undefined) {
      return;
    }

    if (!mapping.has(sheetKey)) {
      mapping.set(sheetKey, row.cdt_id);
    }
  });

  return mapping;
}

function collectNewBuildingCdtIds(report = {}, now = new Date()) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const reportDate = resolveReportDateParts(report, now);
  const sheetKeyToCdtId = buildSheetKeyToCdtIdMap(rows);
  const cdtIds = new Set();
  const missingBuildingLogLines = NEW_BUILDING_LOG_FILES.flatMap((fileName) =>
    readWorkspaceLogLines(fileName),
  );

  missingBuildingLogLines.forEach((line) => {
    const dateParts = extractLogDateParts(line);
    if (!isSameCalendarDate(dateParts, reportDate)) {
      return;
    }

    const parsed = parseMissingBuildingLogLine(line);
    if (!parsed.sheetKey) {
      return;
    }

    const address = normalizeText(parsed.address);
    if (!address || isLikelyGarbageNewBuildingAddress(address)) {
      return;
    }

    const cdtId = sheetKeyToCdtId.get(parsed.sheetKey);
    if (cdtId !== null && cdtId !== undefined) {
      cdtIds.add(cdtId);
    }
  });

  return [...cdtIds];
}

function collectClosedToolCdtIds() {
  const lines = readWorkspaceLogLines(CDT_CONFIG_FILE);
  const activeIds = new Set();
  const commentedIds = new Set();

  lines.forEach((line) => {
    const text = normalizeText(line);
    if (!text) {
      return;
    }

    const activeMatch = text.match(/^id\s*:\s*(-?\d+(?:\.\d+)?)/i);
    if (activeMatch) {
      activeIds.add(activeMatch[1]);
      return;
    }

    const commentedMatch = text.match(
      /^\/\/+\s*(?:\/\/+\s*)?id\s*:\s*(-?\d+(?:\.\d+)?)/i,
    );
    if (commentedMatch) {
      commentedIds.add(commentedMatch[1]);
    }
  });

  return [...commentedIds].filter((id) => !activeIds.has(id));
}

function hasConfiguredField(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasConfiguredField(item));
  }
  return normalizeText(value) !== "";
}

function hasLegacyColumnConfig(config = {}, index = -1) {
  const legacyColumns = Array.isArray(config?.column) ? config.column : [];
  if (index < 0 || index >= legacyColumns.length) {
    return false;
  }
  return hasConfiguredField(legacyColumns[index]);
}

function isMissingRequiredSheetStructure(config = {}) {
  const hasVerticalAddressField =
    hasConfiguredField(config?.columnVertical) &&
    hasConfiguredField(config?.colorExitVerticalBg);
  const hasAddressField =
    hasConfiguredField(config?.address_column) ||
    hasLegacyColumnConfig(config, 0) ||
    hasVerticalAddressField;
  const hasRoomField =
    hasConfiguredField(config?.room_column) || hasLegacyColumnConfig(config, 1);
  const hasPriceField =
    hasConfiguredField(config?.price_column) || hasLegacyColumnConfig(config, 3);
  const hasImageField = hasConfiguredField(config?.exitLinkDriver);
  const hasDescriptionField = hasConfiguredField(config?.mota);

  return (
    !hasAddressField ||
    !hasRoomField ||
    !hasPriceField ||
    !hasImageField ||
    !hasDescriptionField
  );
}

function collectIncompleteStructureCdtIds() {
  const cdtIds = new Set();
  const configs = Array.isArray(LIST_GGSHEET) ? LIST_GGSHEET : [];

  configs.forEach((config) => {
    if (config?.id === null || config?.id === undefined) {
      return;
    }

    if (isMissingRequiredSheetStructure(config)) {
      cdtIds.add(config.id);
    }
  });

  return [...cdtIds];
}

function buildTelegramAndSheetLines(report, now = new Date()) {
  const labels = getCurrentDateLabels(now);
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const sourceErrorsRaw = Array.isArray(report?.source_errors)
    ? report.source_errors
    : [];
  const sourceErrors = filterCode3SourceErrors(sourceErrorsRaw);
  const toolRan = Boolean(
    report?.tool_status?.ran || rows.length > 0 || sourceErrorsRaw.length > 0,
  );
  const selectedErrorCodes = new Set(
    Array.isArray(report?.selected_test_errors)
      ? report.selected_test_errors
      : [],
  );
  const isTestFilterEnabled = selectedErrorCodes.size > 0;
  const nonSelectedText = "Không chạy test lỗi này";
  const includeError = (code) =>
    !isTestFilterEnabled || selectedErrorCodes.has(code);

  const lines = [
    includeError(1)
      ? toolRan
        ? `II.A.1: Tool có chạy. Tổng phòng trống: ${Number(
            report?.total_empty_rooms_today ?? report?.total_rows ?? 0,
          )}`
        : "II.A.1: Tool không chạy. Tổng phòng trống: 0"
      : `II.A.1: ${nonSelectedText}`,
    includeError(2) ? buildNoVacantLine(report) : `II.A.2: ${nonSelectedText}`,
    includeError(3)
      ? `II.A.3: Các CĐT bị lỗi link bảng hàng đích: ${buildCode3CdtWithLinkText(
          sourceErrors,
        )}`
      : `II.A.3: ${nonSelectedText}`,
    includeError(4)
      ? `II.B.4: Các CĐT bị lệch cột "địa chỉ" ở setup tool: ${cdtListText(
          rows
            .filter((row) => isAddressColumnError(row))
            .map((row) => row.cdt_id),
        )}`
      : `II.B.4: ${nonSelectedText}`,
    includeError(5)
      ? `II.B.5: Các CĐT bị lệch cột "tên phòng" ở setup tool: ${cdtListText(
          rows
            .filter((row) => isRoomNameColumnError(row))
            .map((row) => row.cdt_id),
        )}`
      : `II.B.5: ${nonSelectedText}`,
    includeError(6)
      ? `II.B.6: Các CĐT bị lệch cột "giá" ở setup tool: ${cdtListText(
          rows
            .filter((row) => isPriceColumnError(row))
            .map((row) => row.cdt_id),
        )}`
      : `II.B.6: ${nonSelectedText}`,
    includeError(7)
      ? `II.B.7: Các CĐT bị lệch cột "link ảnh" ở setup tool: ${cdtListText(
          rows
            .filter((row) => isImageColumnError(row))
            .map((row) => row.cdt_id),
        )}`
      : `II.B.7: ${nonSelectedText}`,
    includeError(8)
      ? `II.B.8: Các CĐT có phòng không có link ảnh ở setup tool: ${cdtListText(
          rows
            .filter((row) => isMissingImageLinkError(row))
            .map((row) => row.cdt_id),
        )}`
      : `II.B.8: ${nonSelectedText}`,
    includeError(9)
      ? `II.B.9: Các CĐT có tòa mới: ${cdtListText(
          collectNewBuildingCdtIds(report, now),
        )}`
      : `II.B.9: ${nonSelectedText}`,
    includeError(10)
      ? `II.B.10: Các CĐT có cấu trúc bảng không đầy đủ: ${cdtListText(
          collectIncompleteStructureCdtIds(),
        )}`
      : `II.B.10: ${nonSelectedText}`,
    includeError(11)
      ? `II.B.11: Các CĐT có phòng trống: ${vacantRoomCountByCdtText(rows)}`
      : `II.B.11: ${nonSelectedText}`,
    includeError(12)
      ? `II.B.12: Các CĐT đóng tool: ${cdtListText(collectClosedToolCdtIds())}`
      : `II.B.12: ${nonSelectedText}`,
  ];

  return {
    dayHeader: labels.dayHeader,
    timestamp: labels.timestamp,
    lines,
    messages: [labels.timestamp, ...lines],
  };
}

function toColumnLetter(index1Based) {
  let result = "";
  let value = Number(index1Based);
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function parseDayHeaderTimestamp(value = "") {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);

  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
    return null;
  }

  if (year < 100) {
    year += 2000;
  }

  const parsed = new Date(year, month - 1, day);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getDate() !== day ||
    parsed.getMonth() !== month - 1 ||
    parsed.getFullYear() !== year
  ) {
    return null;
  }

  return parsed.getTime();
}

async function resolveSheetMetaByGid(sheets, spreadsheetId, sheetGid) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const targetSheet = (meta.data.sheets || []).find(
    (sheet) => Number(sheet?.properties?.sheetId) === Number(sheetGid),
  );

  if (!targetSheet) {
    throw new Error(`ROOM_AUDIT_REPORT_SHEET_GID_NOT_FOUND:${sheetGid}`);
  }

  return {
    sheetTitle: targetSheet.properties.title,
  };
}

async function syncReportSheet(reportPayload, options = {}) {
  if (!toBoolean(options.syncReportSheet, true)) {
    return { synced: false, skipped: true, reason: "SYNC_DISABLED" };
  }

  const spreadsheetId =
    options.reportSheetSpreadsheetId || DEFAULT_REPORT_SHEET.spreadsheetId;
  const sheetGid = parseNumber(
    options.reportSheetGid,
    DEFAULT_REPORT_SHEET.sheetGid,
  );
  const headerRow = parseNumber(
    options.reportSheetHeaderRow,
    DEFAULT_REPORT_SHEET.headerRow,
  );
  const firstDataRow = parseNumber(
    options.reportSheetFirstDataRow,
    DEFAULT_REPORT_SHEET.firstDataRow,
  );
  const lastDataRow = parseNumber(
    options.reportSheetLastDataRow,
    DEFAULT_REPORT_SHEET.lastDataRow,
  );
  const firstDayColumn = parseNumber(
    options.reportSheetStartColumn,
    DEFAULT_REPORT_SHEET.firstDayColumn,
  );
  const dayColumnWindowSize = parseNumber(
    options.reportSheetDayWindowSize,
    DEFAULT_REPORT_SHEET.dayColumnWindowSize,
  );

  const auth = new google.auth.GoogleAuth({
    keyFile: "ggsheets.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const { sheetTitle } = await resolveSheetMetaByGid(
    sheets,
    spreadsheetId,
    sheetGid,
  );

  const headerRange = `${sheetTitle}!${headerRow}:${headerRow}`;
  const headerResponse = await withSheetRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: headerRange,
      }),
    options?.sheetRetry,
  );
  const headerRowValues = headerResponse.data.values?.[0] || [];
  const dayHeader = reportPayload.dayHeader;
  const windowStart = Math.max(1, firstDayColumn);
  const windowEnd = Math.max(
    windowStart,
    windowStart + Math.max(1, dayColumnWindowSize) - 1,
  );

  let targetColumnIndex = -1;
  for (let index = windowStart - 1; index <= windowEnd - 1; index += 1) {
    if ((headerRowValues[index] || "").toString().trim() === dayHeader) {
      targetColumnIndex = index + 1;
      break;
    }
  }

  if (targetColumnIndex < 0) {
    for (let index = windowStart - 1; index <= windowEnd - 1; index += 1) {
      if (!normalizeText(headerRowValues[index])) {
        targetColumnIndex = index + 1;
        break;
      }
    }
  }

  if (targetColumnIndex < 0) {
    const windowHeaders = [];
    for (let index = windowStart - 1; index <= windowEnd - 1; index += 1) {
      const headerText = normalizeText(headerRowValues[index]);
      const timestamp = parseDayHeaderTimestamp(headerText);
      if (!Number.isFinite(timestamp)) {
        continue;
      }

      windowHeaders.push({
        columnIndex: index + 1,
        timestamp,
      });
    }

    if (windowHeaders.length > 0) {
      const newestHeader = windowHeaders.reduce((latest, current) => {
        if (current.timestamp > latest.timestamp) {
          return current;
        }
        if (
          current.timestamp === latest.timestamp &&
          current.columnIndex > latest.columnIndex
        ) {
          return current;
        }
        return latest;
      });

      targetColumnIndex =
        newestHeader.columnIndex >= windowEnd
          ? windowStart
          : newestHeader.columnIndex + 1;
    } else {
      targetColumnIndex = windowStart;
    }
  }

  const existingHeader = normalizeText(headerRowValues[targetColumnIndex - 1]);
  if (existingHeader !== dayHeader) {
    const headerColumnLetter = toColumnLetter(targetColumnIndex);
    await withSheetRetry(
      () =>
        sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetTitle}!${headerColumnLetter}${headerRow}`,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[dayHeader]],
          },
        }),
      options?.sheetRetry,
    );
  }

  const columnLetter = toColumnLetter(targetColumnIndex);
  await withSheetRetry(
    () =>
      sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `${sheetTitle}!${columnLetter}${firstDataRow}:${columnLetter}${lastDataRow}`,
      }),
    options?.sheetRetry,
  );

  const columnValues = [reportPayload.timestamp, ...reportPayload.lines].map(
    (value) => [value],
  );
  await withSheetRetry(
    () =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetTitle}!${columnLetter}${firstDataRow}:${columnLetter}${lastDataRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: columnValues,
        },
      }),
    options?.sheetRetry,
  );

  return {
    synced: true,
    spreadsheetId,
    sheetGid,
    sheetTitle,
    columnLetter,
    dayHeader,
    dayWindow: `${toColumnLetter(windowStart)}:${toColumnLetter(windowEnd)}`,
    range: `${sheetTitle}!${columnLetter}${firstDataRow}:${columnLetter}${lastDataRow}`,
  };
}

function splitLongTelegramMessage(message = "", maxLength = 3500) {
  const text = normalizeText(message);
  if (!text) {
    return [];
  }

  if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) {
    return [text];
  }

  const labeledListMatch = text.match(/^(II\.[AB]\.\d+:\s*)(.+)$/s);
  if (labeledListMatch) {
    const prefix = labeledListMatch[1];
    const body = labeledListMatch[2];
    const tokens = body
      .split(/,\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (tokens.length > 1) {
      const chunks = [];
      let current = prefix;
      let currentPrefix = prefix;

      tokens.forEach((token) => {
        const addition =
          current === currentPrefix ? token : `, ${token}`;
        if ((current + addition).length > maxLength) {
          chunks.push(current);
          currentPrefix = `${prefix.trim()} (tiếp): `;
          current = `${currentPrefix}${token}`;
          return;
        }

        current += addition;
      });

      if (current) {
        chunks.push(current);
      }
      if (chunks.length > 0) {
        return chunks;
      }
    }
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex < Math.floor(maxLength * 0.5)) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex < Math.floor(maxLength * 0.5)) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [text];
}

async function sendTelegramMessages(reportPayload, options = {}) {
  if (!toBoolean(options.sendTelegram, true)) {
    return {
      sent: false,
      skipped: true,
      reason: "TELEGRAM_DISABLED",
      count: 0,
    };
  }

  const maxTelegramMessageLength = Number.isFinite(options?.telegramMaxLength)
    ? Math.max(500, Number(options.telegramMaxLength))
    : 3500;

  let sentCount = 0;
  for (const message of reportPayload.messages) {
    const messageParts = splitLongTelegramMessage(
      message,
      maxTelegramMessageLength,
    );
    for (const messagePart of messageParts) {
      const result = await sendTelegramMessage(messagePart, {
        targetKey: "roomAudit",
        parseMode: null,
        maxAttempts: 3,
        retryBaseMs: 1500,
      });
      if (!result.sent) {
        return {
          sent: false,
          stage: "report",
          reason: result.reason || "REPORT_MESSAGE_FAILED",
          count: sentCount,
        };
      }
      sentCount += 1;
    }
  }

  return {
    sent: true,
    count: sentCount,
  };
}

async function sendRoomAuditTelegramStatus(message, options = {}) {
  if (!toBoolean(options.sendTelegram, true)) {
    return { sent: false, skipped: true, reason: "TELEGRAM_DISABLED" };
  }

  return sendTelegramMessage(message, {
    targetKey: "roomAudit",
    parseMode: null,
    maxAttempts: 3,
    retryBaseMs: 1500,
  });
}

async function deliverRoomAuditReport(report, options = {}) {
  const payload = buildTelegramAndSheetLines(report, new Date());
  let sheetResult = { synced: false, reason: "NOT_RUN" };
  let telegramResult = { sent: false, reason: "NOT_RUN", count: 0 };

  try {
    sheetResult = await syncReportSheet(payload, options);
  } catch (error) {
    sheetResult = {
      synced: false,
      reason: "SHEET_SYNC_FAILED",
      error: error?.message || String(error),
    };
  }

  try {
    telegramResult = await sendTelegramMessages(payload, options);
  } catch (error) {
    telegramResult = {
      sent: false,
      reason: "TELEGRAM_SEND_FAILED",
      error: error?.message || String(error),
      count: 0,
    };
  }

  return {
    payload,
    sheetResult,
    telegramResult,
  };
}

module.exports = {
  buildTelegramAndSheetLines,
  deliverRoomAuditReport,
  sendRoomAuditTelegramStatus,
};

