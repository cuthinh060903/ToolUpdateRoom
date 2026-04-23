const { google } = require("googleapis");
const { sendTelegramMessage } = require("../../telegram_bot");

const DEFAULT_REPORT_SHEET = {
  spreadsheetId: "11EyNOVAMn7ei-J8svcMjpvv1B7AashTUDyRB-gUeHho",
  sheetGid: 297377874,
  headerRow: 1,
  firstDataRow: 2,
  lastDataRow: 11,
  firstDayColumn: 6,
};

const ADDRESS_FIELD_REASONS = new Set(["ADDRESS_MISMATCH_LOGGED", "ADDRESS_MISSING"]);
const ROOM_NAME_FIELD_REASONS = new Set([
  "ROOM_NOT_MATCHED_POSSIBLE_WRONG_COLUMN",
  "ROOM_NAME_MISSING",
  "ROOM_NAME_LOOKS_LIKE_PRICE",
  "WEB_ROOM_NAME_LOOKS_LIKE_PRICE",
]);
const PRICE_FIELD_REASONS = new Set(["PRICE_UNPARSEABLE", "PRICE_LOOKS_LIKE_ROOM_NAME"]);
const IMAGE_COLUMN_REASONS = new Set([
  "IMAGE_DRIVER_MISSING",
  "IMAGE_DRIVER_INVALID_URL",
  "ORIGIN_LINK_INVALID_URL",
  "DRIVER_ERROR_LOGGED",
  "IMAGE_SOURCE_MISSING",
  "IMAGE_LINK_INVALID",
  "IMAGE_LINK_UNSUPPORTED",
  "IMAGE_LINK_401",
  "IMAGE_LINK_403",
  "IMAGE_LINK_404",
]);
const NO_IMAGE_REASONS = new Set(["IMAGE_COUNT_ZERO"]);

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
  const unique = [...new Set(values.filter((value) => value !== null && value !== undefined))]
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

function rowHasAnyReason(row = {}, reasonSet = new Set()) {
  return (row.error_detail || []).some((reason) => reasonSet.has(reason));
}

function isAddressColumnError(row = {}) {
  const address = normalizeText(row.address);
  const hasAddressReason = rowHasAnyReason(row, ADDRESS_FIELD_REASONS);
  const addressLooksWrongType = looksLikeRoomText(address) || looksLikePriceText(address);

  return hasAddressReason || addressLooksWrongType;
}

function isRoomNameColumnError(row = {}) {
  return rowHasAnyReason(row, ROOM_NAME_FIELD_REASONS);
}

function isPriceColumnError(row = {}) {
  const priceRaw = normalizeText(row.price_raw);
  return (
    rowHasAnyReason(row, PRICE_FIELD_REASONS) ||
    (priceRaw && looksLikeRoomText(priceRaw))
  );
}

function isImageColumnError(row = {}) {
  const imageDriver = normalizeText(row.image_driver);
  return (
    rowHasAnyReason(row, IMAGE_COLUMN_REASONS) ||
    (imageDriver && (looksLikeRoomText(imageDriver) || looksLikePriceText(imageDriver)))
  );
}

function isMissingImageLinkError(row = {}) {
  const imageDriver = normalizeText(row.image_driver);
  return (
    Number(row?.image_count) === 0 ||
    rowHasAnyReason(row, NO_IMAGE_REASONS) ||
    imageDriver === ""
  );
}

function buildTelegramAndSheetLines(report, now = new Date()) {
  const labels = getCurrentDateLabels(now);
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const sourceErrors = Array.isArray(report?.source_errors) ? report.source_errors : [];
  const code6Candidates = Array.isArray(report?.code6_candidates)
    ? report.code6_candidates
    : [];
  const code7Groups = Array.isArray(report?.code4_groups) ? report.code4_groups : [];
  const toolRan = Boolean(report?.tool_status?.ran || rows.length > 0 || sourceErrors.length > 0);

  const lines = [
    toolRan
      ? `II.A.1: Tool có chạy. Tổng phòng trống: ${Number(report?.total_rows || 0)}`
      : "II.A.1: Tool không chạy. Tổng phòng trống: 0",
    `II.A.2: Các CĐT không có phòng trống: ${cdtListText(
      code6Candidates.map((item) => item?.cdt_id),
    )}`,
    `II.A.3: Các CĐT bị lỗi link bảng hàng đích: ${cdtListText(
      sourceErrors.map((item) => item?.cdt_id),
    )}`,
    `II.B.4: Các CĐT bị lệch cột "địa chỉ" ở setup tool: ${cdtListText(
      rows.filter((row) => isAddressColumnError(row)).map((row) => row.cdt_id),
    )}`,
    `II.B.5: Các CĐT bị lệch cột "tên phòng" ở setup tool: ${cdtListText(
      rows.filter((row) => isRoomNameColumnError(row)).map((row) => row.cdt_id),
    )}`,
    `II.B.6: Các CĐT bị lệch cột "giá" ở setup tool: ${cdtListText(
      rows.filter((row) => isPriceColumnError(row)).map((row) => row.cdt_id),
    )}`,
    `II.B.7: Các CĐT bị lệch cột "link ảnh" ở setup tool: ${cdtListText(
      rows.filter((row) => isImageColumnError(row)).map((row) => row.cdt_id),
    )}`,
    `II.B.8: Các CĐT có phòng không có link ảnh ở setup tool: ${cdtListText(
      rows.filter((row) => isMissingImageLinkError(row)).map((row) => row.cdt_id),
    )}`,
    `II.B.9: Các CĐT có tòa mới: ${cdtListText(code7Groups.map((item) => item?.cdt_id))}`,
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
  const sheetGid = parseNumber(options.reportSheetGid, DEFAULT_REPORT_SHEET.sheetGid);
  const headerRow = parseNumber(options.reportSheetHeaderRow, DEFAULT_REPORT_SHEET.headerRow);
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

  const auth = new google.auth.GoogleAuth({
    keyFile: "ggsheets.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const { sheetTitle } = await resolveSheetMetaByGid(sheets, spreadsheetId, sheetGid);

  const headerRange = `${sheetTitle}!${headerRow}:${headerRow}`;
  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: headerRange,
  });
  const headerRowValues = headerResponse.data.values?.[0] || [];
  const dayHeader = reportPayload.dayHeader;

  let targetColumnIndex = -1;
  for (let index = Math.max(0, firstDayColumn - 1); index < headerRowValues.length; index += 1) {
    if ((headerRowValues[index] || "").toString().trim() === dayHeader) {
      targetColumnIndex = index + 1;
      break;
    }
  }

  if (targetColumnIndex < 0) {
    targetColumnIndex = Math.max(firstDayColumn, headerRowValues.length + 1);
    const headerColumnLetter = toColumnLetter(targetColumnIndex);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!${headerColumnLetter}${headerRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[dayHeader]],
      },
    });
  }

  const columnLetter = toColumnLetter(targetColumnIndex);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetTitle}!${columnLetter}${firstDataRow}:${columnLetter}${lastDataRow}`,
  });

  const columnValues = [reportPayload.timestamp, ...reportPayload.lines].map((value) => [value]);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!${columnLetter}${firstDataRow}:${columnLetter}${lastDataRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: columnValues,
    },
  });

  return {
    synced: true,
    spreadsheetId,
    sheetGid,
    sheetTitle,
    columnLetter,
    dayHeader,
    range: `${sheetTitle}!${columnLetter}${firstDataRow}:${columnLetter}${lastDataRow}`,
  };
}

async function sendTelegramMessages(reportPayload, options = {}) {
  if (!toBoolean(options.sendTelegram, true)) {
    return { sent: false, skipped: true, reason: "TELEGRAM_DISABLED", count: 0 };
  }

  let sentCount = 0;
  for (const message of reportPayload.messages) {
    const result = await sendTelegramMessage(message, {
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
  const [sheetResult, telegramResult] = await Promise.all([
    syncReportSheet(payload, options),
    sendTelegramMessages(payload, options),
  ]);

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

