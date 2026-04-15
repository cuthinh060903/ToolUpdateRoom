function looksLikePriceText(value = "") {
  return /(?:^|\s)(\d+([.,]\d+)?\s*(tr|trieu|triệu|m|k|vnd|d|đ)|\d{6,})(?:\s|$)/i.test(
    value,
  );
}

function isRoomLikeText(value = "") {
  return /^(?:phong\s*)?[a-z]?\d{2,5}(?:\.\d+)?[a-z]?$/i.test(
    value.toString().trim(),
  );
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
  } catch (error) {
    return false;
  }
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function hasAnyLog(lines = []) {
  return Array.isArray(lines) && lines.length > 0;
}

function detectDriverErrorReasons(lines = []) {
  const joined = lines.join(" | ").toLowerCase();
  const reasons = [];

  if (joined.includes("invalid_link")) {
    reasons.push("IMAGE_LINK_INVALID");
  }
  if (joined.includes("unsupported_link")) {
    reasons.push("IMAGE_LINK_UNSUPPORTED");
  }
  if (joined.includes("empty_folder")) {
    reasons.push("IMAGE_SOURCE_EMPTY_FOLDER");
  }
  if (/(?:^|\D)401(?:\D|$)/.test(joined)) {
    reasons.push("IMAGE_LINK_401");
  }
  if (/(?:^|\D)403(?:\D|$)/.test(joined)) {
    reasons.push("IMAGE_LINK_403");
  }
  if (/(?:^|\D)404(?:\D|$)/.test(joined)) {
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

  if (roomName && looksLikePriceText(roomName)) {
    reasons.push("ROOM_NAME_LOOKS_LIKE_PRICE");
  }

  if (roomNameWeb && looksLikePriceText(roomNameWeb)) {
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
