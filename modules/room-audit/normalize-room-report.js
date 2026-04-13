function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return value.toString().trim();
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalizedValue =
    typeof value === "number"
      ? value
      : Number(value.toString().replace(/[^\d.-]/g, ""));

  return Number.isFinite(normalizedValue) ? normalizedValue : null;
}

function normalizeRoomReport({
  config,
  sheetGid,
  row,
  building = null,
  room = null,
  imageCount = null,
  logMatches = {},
  apiErrors = {},
} = {}) {
  const executionKey =
    typeof config?.execution_key === "string" && config.execution_key.trim()
      ? config.execution_key.trim()
      : [config?.web || "unknown_web", config?.type || "default", `gid:${sheetGid}`]
          .filter(Boolean)
          .join("|");

  return {
    cdt_id: config?.id ?? null,
    cdt_name: normalizeText(config?.web || config?.name),
    source_type: normalizeText(config?.type || "default"),
    sheet_link: normalizeText(config?.link),
    sheet_gid: sheetGid ?? null,
    execution_key: executionKey,
    address: normalizeText(row?.ADDRESS),
    room_name: normalizeText(row?.ROOMS),
    price_raw: row?.PRICE ?? null,
    price: normalizeNumber(row?.PRICE),
    description: normalizeText(row?.DESCRIPTIONS),
    image_driver: normalizeText(row?.IMAGE_DRIVER),
    building_input_code: normalizeText(row?.BUILDING),
    building_id: building?.id ?? null,
    building_code: normalizeText(building?.code),
    building_address: normalizeText(building?.address_valid || building?.address),
    building_updated_at: building?.updated_at || null,
    room_id: room?.id ?? null,
    room_real_new_id: room?.real_new_id ?? building?.id ?? null,
    room_name_web: normalizeText(room?.name),
    room_price_web: normalizeNumber(room?.price),
    room_updated_at: room?.updated_at || null,
    status: normalizeText(room?.status),
    empty_room_date: room?.empty_room_date || null,
    last_updated_at: room?.updated_at || building?.updated_at || null,
    last_updated_source: room?.updated_at
      ? "rooms.updated_at"
      : building?.updated_at
        ? "realnews.updated_at"
        : null,
    last_status_con_at: room?.last_status_con_at || null,
    last_status_con_source: room?.last_status_con_source || null,
    origin_link: normalizeText(room?.origin_link),
    image_link: normalizeText(room?.image_link),
    image_count: imageCount,
    image_count_source: imageCount === null ? null : "minio",
    mapping: {
      building_matched: Boolean(building?.id),
      room_matched: Boolean(room?.id),
    },
    log_matches: {
      ggsheet: Array.isArray(logMatches?.ggsheet) ? logMatches.ggsheet : [],
      driver_error: Array.isArray(logMatches?.driver_error)
        ? logMatches.driver_error
        : [],
      capnhattrong: Array.isArray(logMatches?.capnhattrong)
        ? logMatches.capnhattrong
        : [],
      taophongloi: Array.isArray(logMatches?.taophongloi)
        ? logMatches.taophongloi
        : [],
      phongmoi: Array.isArray(logMatches?.phongmoi) ? logMatches.phongmoi : [],
      nhamoi: Array.isArray(logMatches?.nhamoi) ? logMatches.nhamoi : [],
      khongcodulieu: Array.isArray(logMatches?.khongcodulieu)
        ? logMatches.khongcodulieu
        : [],
    },
    api_errors: {
      search_realnew: apiErrors?.search_realnew || null,
      search_room: apiErrors?.search_room || null,
      count_image: apiErrors?.count_image || null,
    },
    rule_1_status: "PENDING",
    rule_1_reason: [],
    rule_2_status: "PENDING",
    rule_2_reason: [],
    rule_3_status: "PENDING",
    rule_3_reason: [],
    rule_4_status: "PENDING",
    rule_4_reason: [],
    error_detail: [],
  };
}

module.exports = {
  normalizeRoomReport,
};
