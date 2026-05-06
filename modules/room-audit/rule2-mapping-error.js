function looksLikePriceText(value = "") {
  return /(?:^|\s)(\$+\s*\d+([.,]\d+)?|\d+([.,]\d+)?\s*(tr|trieu|m|k|vnd|usd|d|\u0111|\$)|\d{6,})(?:\s|$)/i.test(
    value,
  );
}

function normalizeText(value = "") {
  return value.toString().trim().replace(/\s+/g, " ");
}

/** Room + price in one cell (e.g. "402-3tr6", "P20,23-2.5tr") is not a wrong-column signal. */
function isLikelyRoomPriceCombinedCell(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  const segments = text.split(",").map((s) => s.trim()).filter(Boolean);
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

function isRoomLikeText(value = "") {
  return /^(?:phong\s*)?[a-z]?\d{2,5}(?:\.\d+)?[a-z]?$/i.test(
    value.toString().trim(),
  );
}

function stripTrailingCurrencySuffix(value = "") {
  return normalizeText(value).replace(/(?:\s*[d\u0111])+\s*$/i, "").trim();
}

function isLikelyRoomCodeList(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  const tokens = text
    .split(/[,\n;|]+/)
    .map((token) => stripTrailingCurrencySuffix(token))
    .filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }

  return tokens.every((token) => {
    if (isRoomLikeText(token)) {
      return true;
    }

    // Ranges such as "202-402" are still room-like values.
    return /^\d{2,4}\s*[-/]\s*\d{2,4}$/.test(token);
  });
}

function isNarrativeNoteText(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const letterCount = (text.match(/[A-Za-zÀ-ỹ]/g) || []).length;
  return wordCount >= 6 && letterCount >= 12;
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
  if (isRoomLikeText(strippedText)) {
    return false;
  }

  return looksLikePriceText(text);
}

function isPlainNumberString(value = "") {
  return /^[\d\s.,]+$/.test(value.toString().trim());
}

function isValidUrl(value = "") {
  if (!value) {
    return false;
  }

  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function hasAnyLog(lines = []) {
  return Array.isArray(lines) && lines.length > 0;
}

function hasHttpStatusCodeHint(text = "", code = 0) {
  const escapedCode = String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    [
      `\\b(?:status|http|response|code|forbidden|unauthorized|not\\s+found)\\b[^\\n\\r]{0,40}\\b${escapedCode}\\b`,
      `\\b${escapedCode}\\b[^\\n\\r]{0,40}\\b(?:forbidden|unauthorized|not\\s+found)\\b`,
    ].join("|"),
    "i",
  );
  return pattern.test(text);
}

function detectDriverErrorReasons(lines = []) {
  const normalizedLines = lines.map((line) => line.toString().toLowerCase());
  const joined = normalizedLines.join(" | ");
  const reasons = [];

  if (joined.includes("invalid_link") || joined.includes("không hợp lệ")) {
    reasons.push("IMAGE_LINK_INVALID");
  }
  if (
    joined.includes("unsupported_link") ||
    joined.includes("không được hỗ trợ")
  ) {
    reasons.push("IMAGE_LINK_UNSUPPORTED");
  }
  if (
    joined.includes("empty_folder") ||
    joined.includes("không tìm thấy ảnh khả dụng")
  ) {
    reasons.push("IMAGE_SOURCE_EMPTY_FOLDER");
  }
  if (normalizedLines.some((line) => hasHttpStatusCodeHint(line, 401))) {
    reasons.push("IMAGE_LINK_401");
  }
  if (
    normalizedLines.some((line) => hasHttpStatusCodeHint(line, 403)) ||
    joined.includes("access denied") ||
    joined.includes("permission denied") ||
    joined.includes("you need access") ||
    joined.includes("request access")
  ) {
    reasons.push("IMAGE_LINK_403");
  }
  if (normalizedLines.some((line) => hasHttpStatusCodeHint(line, 404))) {
    reasons.push("IMAGE_LINK_404");
  }

  return reasons;
}

function applyRule2MappingError(record) {
  const nextRecord = { ...record };
  const reasons = [];
  const roomName = nextRecord.room_name || "";
  const roomNameWeb = nextRecord.room_name_web || "";
  const imageDriver = nextRecord.image_driver || "";
  const originLink = nextRecord.origin_link || imageDriver;
  const priceRaw =
    nextRecord.price_raw === null || nextRecord.price_raw === undefined
      ? ""
      : nextRecord.price_raw.toString();

  if (!nextRecord.address) {
    reasons.push("ADDRESS_MISSING");
  }

  if (!roomName) {
    reasons.push("ROOM_NAME_MISSING");
  }

  if (roomName && isPriceLikeRoomField(roomName)) {
    reasons.push("ROOM_NAME_LOOKS_LIKE_PRICE");
  }

  if (roomNameWeb && isPriceLikeRoomField(roomNameWeb)) {
    reasons.push("WEB_ROOM_NAME_LOOKS_LIKE_PRICE");
  }

  if (nextRecord.price === null) {
    reasons.push("PRICE_UNPARSEABLE");
  }

  if (
    nextRecord.price === null &&
    typeof nextRecord.price_raw === "string" &&
    priceRaw &&
    !isPlainNumberString(priceRaw) &&
    isRoomLikeText(priceRaw)
  ) {
    reasons.push("PRICE_LOOKS_LIKE_ROOM_NAME");
  }

  if (!imageDriver) {
    reasons.push("IMAGE_DRIVER_MISSING");
  }

  if (imageDriver && !isValidUrl(imageDriver)) {
    reasons.push("IMAGE_DRIVER_INVALID_URL");
  }

  if (originLink && !isValidUrl(originLink)) {
    reasons.push("ORIGIN_LINK_INVALID_URL");
  }

  if (!nextRecord.mapping?.building_matched) {
    reasons.push("BUILDING_NOT_MATCHED");
  }

  if (nextRecord.mapping?.building_matched && !nextRecord.mapping?.room_matched) {
    reasons.push("ROOM_NOT_MATCHED_POSSIBLE_WRONG_COLUMN");
  }

  if (hasAnyLog(nextRecord.log_matches?.ggsheet)) {
    reasons.push("GGSHEET_LOGGED_ERROR");
  }

  if (hasAnyLog(nextRecord.log_matches?.driver_error)) {
    reasons.push("DRIVER_ERROR_LOGGED");
  }

  if (hasAnyLog(nextRecord.log_matches?.nhamoi)) {
    reasons.push("ADDRESS_MISMATCH_LOGGED");
  }

  if (hasAnyLog(nextRecord.log_matches?.khongcodulieu)) {
    reasons.push("BUILDING_MISSING_ON_WEB_LOGGED");
  }

  if (hasAnyLog(nextRecord.log_matches?.taophongloi)) {
    reasons.push("CREATE_ROOM_FAILED_LOGGED");
  }

  reasons.push(
    ...detectDriverErrorReasons(nextRecord.log_matches?.driver_error || []),
  );

  nextRecord.rule_2_reason = unique(reasons);
  nextRecord.rule_2_status =
    nextRecord.rule_2_reason.length > 0 ? "FAIL" : "PASS";
  return nextRecord;
}

module.exports = {
  applyRule2MappingError,
};
