const fs = require("fs");
const path = require("path");
const { applyRule1Update } = require("./rule1-update");
const { applyRule2MappingError } = require("./rule2-mapping-error");
const { applyRule3RoomStatus } = require("./rule3-room-status");
const { applyRule4NoImage } = require("./rule4-no-image");
const {
  normalizeVietnameseKey,
  repairVietnameseText,
} = require("./text-normalize");
const {
  ROOT_CAUSE,
  applyRootCauseClassification,
  summarizeRootCauses,
} = require("./classify-root-cause");

const BUSINESS_CONCLUSION = ROOT_CAUSE;

function formatLocalDateTime(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function collectErrorDetail(row) {
  return [
    ...(row.rule_1_reason || []),
    ...(row.rule_2_reason || []),
    ...(row.rule_3_reason || []),
    ...(row.rule_4_reason || []),
  ];
}

function normalizeKeyText(value = "") {
  return normalizeVietnameseKey(value);
}

function buildRowBusinessKey(row = {}) {
  return [
    normalizeKeyText(row.cdt_id),
    normalizeKeyText(row.address),
    normalizeKeyText(row.room_name),
  ].join("|");
}

function getDefaultBusinessOverridePath() {
  return path.resolve(
    __dirname,
    "../..",
    "reports",
    "room-audit",
    "business-conclusion-overrides.json",
  );
}

function loadBusinessConclusionOverrides(options = {}) {
  const configuredPath = options.businessOverridePath;
  const overridePath = configuredPath
    ? path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(process.cwd(), configuredPath)
    : getDefaultBusinessOverridePath();

  try {
    if (!fs.existsSync(overridePath)) {
      return new Map();
    }

    const rawContent = fs.readFileSync(overridePath, "utf8");
    const parsed = JSON.parse(rawContent);
    if (!Array.isArray(parsed)) {
      return new Map();
    }

    return new Map(
      parsed
        .filter(
          (item) =>
            item &&
            item.cdt_id !== undefined &&
            item.address &&
            item.room_name &&
            item.business_conclusion,
        )
        .map((item) => [
          buildRowBusinessKey(item),
          {
            business_conclusion: item.business_conclusion,
            business_conclusion_note: item.business_conclusion_note || "",
            business_conclusion_source:
              item.business_conclusion_source || "override",
          },
        ]),
    );
  } catch (error) {
    return new Map();
  }
}

function applyBusinessConclusions(rows = [], options = {}) {
  const overrides = loadBusinessConclusionOverrides(options);
  const classifiedRows = applyRootCauseClassification(rows);

  return classifiedRows.map((row) => {
    const override = overrides.get(buildRowBusinessKey(row));

    if (override) {
      return {
        ...row,
        root_cause: override.business_conclusion || "",
        root_cause_note: override.business_conclusion_note || "",
        root_cause_source: override.business_conclusion_source || "override",
        business_conclusion: override.business_conclusion || "",
        business_conclusion_note: override.business_conclusion_note || "",
        business_conclusion_source:
          override.business_conclusion_source || "override",
      };
    }

    return {
      ...row,
      business_conclusion: row.root_cause || "",
      business_conclusion_note: row.root_cause_note || "",
      business_conclusion_source: row.root_cause_source || "",
    };
  });
}

function hasAnyFail(row) {
  return (
    row.rule_1_status === "FAIL" ||
    row.rule_2_status === "FAIL" ||
    row.rule_3_status === "FAIL" ||
    row.rule_4_status === "FAIL"
  );
}

function hasAnyUpdateFail(row) {
  return row.rule_2_status === "FAIL" || row.rule_3_status === "FAIL";
}

function hasConfirmedNoImage(row) {
  return row.image_count === 0;
}

function hasUnknownImageState(row) {
  return row.image_count === null || row.image_count === undefined;
}

function summarizeRule(rows, fieldName) {
  return rows.reduce(
    (summary, row) => {
      const status = row[fieldName] || "UNKNOWN";
      summary[status] = (summary[status] || 0) + 1;
      return summary;
    },
    { PASS: 0, FAIL: 0, SKIP: 0, PENDING: 0 },
  );
}

function countErrorReasons(rows = []) {
  const counter = new Map();

  rows.forEach((row) => {
    (row.error_detail || []).forEach((reason) => {
      counter.set(reason, (counter.get(reason) || 0) + 1);
    });
  });

  return [...counter.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function countValueOccurrences(values = []) {
  const counter = new Map();

  values.filter(Boolean).forEach((value) => {
    counter.set(value, (counter.get(value) || 0) + 1);
  });

  return [...counter.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function collectUpdateErrorReasons(row) {
  return [...(row.rule_2_reason || []), ...(row.rule_3_reason || [])];
}

function summarizeBusinessConclusions(rows = []) {
  return summarizeRootCauses(rows);
}

function buildCdtWarningGroups(rows = []) {
  const groups = new Map();

  rows.filter(hasAnyFail).forEach((row) => {
    const key = `${row.cdt_id}|${row.cdt_name}`;
    if (!groups.has(key)) {
      groups.set(key, {
        cdt_id: row.cdt_id,
        cdt_name: row.cdt_name,
        total_fail_rows: 0,
        rule1_fail: 0,
        rule2_fail: 0,
        rule3_fail: 0,
        rule4_fail: 0,
      });
    }

    const group = groups.get(key);
    group.total_fail_rows += 1;
    if (row.rule_1_status === "FAIL") group.rule1_fail += 1;
    if (row.rule_2_status === "FAIL") group.rule2_fail += 1;
    if (row.rule_3_status === "FAIL") group.rule3_fail += 1;
    if (row.rule_4_status === "FAIL") group.rule4_fail += 1;
  });

  return [...groups.values()].sort(
    (a, b) => b.total_fail_rows - a.total_fail_rows || a.cdt_id - b.cdt_id,
  );
}

function buildCdtGroupKey(cdtId, cdtName) {
  return [cdtId ?? "unknown", cdtName || ""].join("|");
}

function buildAddressGroupKey(cdtId, address) {
  return [normalizeKeyText(cdtId), normalizeKeyText(address)].join("|");
}

function ensureCdtSummaryGroup(groups, cdtId, cdtName) {
  const key = buildCdtGroupKey(cdtId, cdtName);
  if (!groups.has(key)) {
    groups.set(key, {
      cdt_id: cdtId ?? null,
      cdt_name: cdtName || "",
      total_empty_rooms_today: 0,
      failed_update_rows: 0,
      rule2_fail_rows: 0,
      rule3_fail_rows: 0,
      rooms_without_images: 0,
      rooms_without_images_unknown: 0,
      source_error_count: 0,
      top_update_error_reasons: [],
      source_error_steps: [],
      status: "NO_DATA",
      _updateReasons: [],
      _sourceSteps: [],
    });
  }

  const group = groups.get(key);
  if (!group.cdt_name && cdtName) {
    group.cdt_name = cdtName;
  }
  if (group.cdt_id === null && cdtId !== null && cdtId !== undefined) {
    group.cdt_id = cdtId;
  }

  return group;
}

function deriveCdtStatus(group) {
  if (group.total_empty_rooms_today === 0 && group.source_error_count > 0) {
    return "ERROR";
  }

  if (
    group.total_empty_rooms_today > 0 &&
    group.failed_update_rows === group.total_empty_rooms_today
  ) {
    return "ERROR";
  }

  if (
    group.source_error_count > 0 ||
    group.failed_update_rows > 0 ||
    group.rooms_without_images > 0 ||
    group.rooms_without_images_unknown > 0
  ) {
    return "WARNING";
  }

  if (group.total_empty_rooms_today > 0) {
    return "OK";
  }

  return "NO_DATA";
}

function buildSummaryByCdt(rows = [], sourceErrors = []) {
  const groups = new Map();

  rows.forEach((row) => {
    const group = ensureCdtSummaryGroup(groups, row.cdt_id, row.cdt_name);
    group.total_empty_rooms_today += 1;

    if (hasAnyUpdateFail(row)) {
      group.failed_update_rows += 1;
    }
    if (row.rule_2_status === "FAIL") {
      group.rule2_fail_rows += 1;
    }
    if (row.rule_3_status === "FAIL") {
      group.rule3_fail_rows += 1;
    }
    if (hasConfirmedNoImage(row)) {
      group.rooms_without_images += 1;
    }
    if (hasUnknownImageState(row)) {
      group.rooms_without_images_unknown += 1;
    }

    group._updateReasons.push(...collectUpdateErrorReasons(row));
  });

  sourceErrors.forEach((sourceError) => {
    const group = ensureCdtSummaryGroup(
      groups,
      sourceError?.cdt_id,
      sourceError?.cdt_name || sourceError?.source,
    );
    group.source_error_count += 1;
    group._sourceSteps.push(sourceError?.step || "UNKNOWN");
  });

  return [...groups.values()]
    .map((group) => {
      const topUpdateErrorReasons = countValueOccurrences(group._updateReasons)
        .slice(0, 5)
        .map((item) => ({
          reason: item.value,
          count: item.count,
        }));
      const sourceErrorSteps = countValueOccurrences(group._sourceSteps).map(
        (item) => ({
          step: item.value,
          count: item.count,
        }),
      );

      return {
        cdt_id: group.cdt_id,
        cdt_name: group.cdt_name,
        total_empty_rooms_today: group.total_empty_rooms_today,
        failed_update_rows: group.failed_update_rows,
        rule2_fail_rows: group.rule2_fail_rows,
        rule3_fail_rows: group.rule3_fail_rows,
        rooms_without_images: group.rooms_without_images,
        rooms_without_images_unknown: group.rooms_without_images_unknown,
        source_error_count: group.source_error_count,
        top_update_error_reasons: topUpdateErrorReasons,
        source_error_steps: sourceErrorSteps,
        status: deriveCdtStatus(group),
      };
    })
    .sort((a, b) => {
      const severityOrder = { ERROR: 0, WARNING: 1, OK: 2, NO_DATA: 3 };
      const severityDiff =
        (severityOrder[a.status] ?? 99) - (severityOrder[b.status] ?? 99);
      if (severityDiff !== 0) {
        return severityDiff;
      }

      if (b.failed_update_rows !== a.failed_update_rows) {
        return b.failed_update_rows - a.failed_update_rows;
      }

      if (b.total_empty_rooms_today !== a.total_empty_rooms_today) {
        return b.total_empty_rooms_today - a.total_empty_rooms_today;
      }

      return String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? ""));
    });
}

function buildUpdateErrorsByCdt(summaryByCdt = []) {
  return summaryByCdt.filter(
    (item) => item.failed_update_rows > 0 || item.source_error_count > 0,
  );
}

function buildExecutionSummaryByCdt(executionContext = [], sourceErrors = []) {
  const groups = new Map();

  function ensureGroup(cdtId, cdtName) {
    const key = buildCdtGroupKey(cdtId, cdtName);
    if (!groups.has(key)) {
      groups.set(key, {
        cdt_id: cdtId ?? null,
        cdt_name: cdtName || "",
        configured_sheet_count: 0,
        processed_sheet_count: 0,
        empty_sheet_count: 0,
        row_count: 0,
        source_error_count: 0,
      });
    }

    return groups.get(key);
  }

  executionContext.forEach((item) => {
    const group = ensureGroup(item?.cdt_id, item?.cdt_name);
    group.configured_sheet_count += Number(item?.configured_sheet_count || 0);
    group.processed_sheet_count += Number(item?.processed_sheet_count || 0);
    group.empty_sheet_count += Number(item?.empty_sheet_count || 0);
    group.row_count += Number(item?.row_count || 0);
    group.source_error_count += Number(item?.source_error_count || 0);
  });

  sourceErrors.forEach((sourceError) => {
    const group = ensureGroup(
      sourceError?.cdt_id,
      sourceError?.cdt_name || sourceError?.source,
    );
    if (!executionContext.length) {
      group.source_error_count += 1;
    }
  });

  return [...groups.values()].sort((a, b) => {
    if (a.row_count !== b.row_count) {
      return b.row_count - a.row_count;
    }

    return String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? ""));
  });
}

function buildCode6Candidates(executionSummaryByCdt = []) {
  return executionSummaryByCdt
    .filter(
      (item) =>
        item.configured_sheet_count > 0 &&
        item.processed_sheet_count > 0 &&
        item.row_count === 0 &&
        item.source_error_count === 0,
    )
    .sort((a, b) =>
      String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? "")),
    );
}

function buildToolStatus({
  totalEmptyRoomsToday = 0,
  totalFailedUpdateRows = 0,
  totalRoomsWithoutImages = 0,
  totalRoomsWithoutImagesUnknown = 0,
  sourceErrors = [],
  executionSummaryByCdt = [],
  summary = {},
} = {}) {
  const sourceErrorCount = Array.isArray(sourceErrors)
    ? sourceErrors.length
    : 0;
  const hasExecutionSummary =
    Array.isArray(executionSummaryByCdt) && executionSummaryByCdt.length > 0;
  const ran =
    totalEmptyRoomsToday > 0 || sourceErrorCount > 0 || hasExecutionSummary;
  let status = "OK";
  let message = "Tool đã chạy bình thường.";

  if (!ran) {
    status = "NO_DATA";
    message = "Tool đã chạy nhưng không có phòng trống nào trong report.";
  } else if (totalEmptyRoomsToday === 0 && sourceErrorCount === 0) {
    status = "NO_DATA";
    message =
      "Tool đã chạy và không ghi nhận phòng trống nào trong lần chạy này.";
  } else if (totalEmptyRoomsToday === 0 && sourceErrorCount > 0) {
    status = "ERROR";
    message = "Tool đã chạy nhưng không đọc được dữ liệu phòng trống.";
  } else if (
    totalEmptyRoomsToday > 0 &&
    totalFailedUpdateRows === totalEmptyRoomsToday
  ) {
    status = "ERROR";
    message = `Tool đã chạy nhưng ${totalFailedUpdateRows}/${totalEmptyRoomsToday} phòng đều gặp lỗi cập nhật.`;
  } else if (
    sourceErrorCount > 0 ||
    totalFailedUpdateRows > 0 ||
    totalRoomsWithoutImages > 0 ||
    totalRoomsWithoutImagesUnknown > 0 ||
    (summary?.rule1?.FAIL || 0) > 0
  ) {
    status = "WARNING";
    message = `Tool đã chạy, audit ${totalEmptyRoomsToday} phòng. Có ${totalFailedUpdateRows} phòng lỗi cập nhật, ${totalRoomsWithoutImages} phòng không có ảnh, ${totalRoomsWithoutImagesUnknown} phòng chưa xác định ảnh.`;
  } else {
    status = "OK";
    message = `Tool đã chạy, audit ${totalEmptyRoomsToday} phòng và không ghi nhận lỗi business.`;
  }

  return {
    ran,
    status,
    message,
    total_source_errors: sourceErrorCount,
    total_failed_update_rows: totalFailedUpdateRows,
  };
}

function buildOverviewLines(report) {
  const warningRows = report.rows.filter(hasAnyFail);

  return [
    `[ROOM_AUDIT] ${report.generated_at}`,
    `Tổng phòng: ${report.total_rows} | Có cảnh báo: ${warningRows.length} | Lỗi nguồn: ${report.source_errors.length}`,
    `Rule1 stale: ${report.summary.rule1.FAIL} | Rule2 mapping: ${report.summary.rule2.FAIL} | Rule3 status: ${report.summary.rule3.FAIL} | Rule4 image: ${report.summary.rule4.FAIL}`,
  ];
}

function buildTopReasonLines(report, options = {}) {
  const reasonLimit = Number.isFinite(options?.reasonLimit)
    ? options.reasonLimit
    : 5;
  const topReasons = report.reason_summary.slice(0, reasonLimit);

  if (topReasons.length === 0) {
    return [];
  }

  return [
    "Top lỗi:",
    ...topReasons.map((item) => `- ${item.reason}: ${item.count}`),
  ];
}

function buildBusinessConclusionLines(report) {
  const summary =
    report.root_cause_summary || report.business_conclusion_summary || {};
  const entries = Object.entries(summary).filter(([, count]) => count > 0);

  if (entries.length === 0) {
    return [];
  }

  return [
    "Nguyên nhân gốc:",
    ...entries.map(([key, count]) => `- ${key}: ${count}`),
  ];
}

function buildCdtLines(report, options = {}) {
  const cdtLimit = Number.isFinite(options?.cdtLimit) ? options.cdtLimit : 8;
  const groups = report.cdt_warning_groups.slice(0, cdtLimit);

  if (groups.length === 0) {
    return [];
  }

  return [
    "CDT cảnh báo:",
    ...groups.map(
      (group) =>
        `- CDT ${group.cdt_id} (${repairVietnameseText(group.cdt_name)}): ${group.total_fail_rows} phòng | R1:${group.rule1_fail} R2:${group.rule2_fail} R3:${group.rule3_fail} R4:${group.rule4_fail}`,
    ),
  ];
}

function buildTechnicalReport(report, options = {}) {
  const lines = [
    ...buildOverviewLines(report),
    ...buildTopReasonLines(report, options),
    ...buildBusinessConclusionLines(report),
    ...buildCdtLines(report, options),
  ];

  return lines.join("\n");
}

function formatToolStatusLabel(status = "", ran = true) {
  if (!ran) {
    return "CHƯA GHI NHẬN TOOL ĐÃ CHẠY";
  }

  if (status === "OK") {
    return "ĐÃ CHẠY, BÌNH THƯỜNG";
  }

  if (status === "WARNING") {
    return "ĐÃ CHẠY, CÓ CẢNH BÁO";
  }

  if (status === "ERROR") {
    return "ĐÃ CHẠY, CÓ LỖI";
  }

  if (status === "NO_DATA") {
    return "ĐÃ CHẠY, KHÔNG CÓ DỮ LIỆU";
  }

  return "ĐÃ CHẠY, CHƯA XÁC ĐỊNH";
}

function formatCdtStatusLabel(status = "") {
  if (status === "OK") {
    return "ON";
  }

  if (status === "WARNING") {
    return "CÓ CẢNH BÁO";
  }

  if (status === "ERROR") {
    return "LỖI";
  }

  if (status === "NO_DATA") {
    return "KHÔNG CÓ DỮ LIỆU";
  }

  return "CHƯA XÁC ĐỊNH";
}

const BUSINESS_REASON_LABELS = {
  ADDRESS_MISMATCH_LOGGED: "Lệch địa chỉ",
  BUILDING_NOT_FOUND: "Không tìm thấy tòa nhà",
  BUILDING_NOT_MATCHED: "Không match được tòa nhà",
  BUILDING_MISSING_ON_WEB_LOGGED: "Thiếu tòa trên web",
  IMAGE_COUNT_NOT_CHECKED: "Chưa kiểm tra được ảnh",
  IMAGE_COUNT_ZERO: "Không có ảnh",
  IMAGE_DRIVER_MISSING: "Thiếu IMAGE_DRIVER",
  IMAGE_SOURCE_MISSING: "Thiếu nguồn ảnh",
  IMAGE_DRIVER_INVALID_URL: "Link IMAGE_DRIVER không hợp lệ",
  ORIGIN_LINK_INVALID_URL: "Link ảnh gốc không hợp lệ",
  UPDATED_AT_MISSING: "Thiếu thời gian cập nhật",
  UPDATED_AT_INVALID: "updated_at không hợp lệ",
  SHEET_ROOM_NOT_UPDATED_TO_EMPTY: "Phòng chưa cập nhật được trạng thái trống",
  ROOM_NOT_FOUND: "Không tìm thấy phòng",
  ROOM_NOT_MATCHED_POSSIBLE_WRONG_COLUMN:
    "Không match được tên phòng hoặc có thể lệch cột",
  ADDRESS_MISSING: "Thiếu địa chỉ",
  ROOM_NAME_MISSING: "Thiếu tên phòng",
  ROOM_NAME_LOOKS_LIKE_PRICE: "Tên phòng giống giá",
  WEB_ROOM_NAME_LOOKS_LIKE_PRICE: "Tên phòng web giống giá",
  PRICE_UNPARSEABLE: "Giá không parse được",
  PRICE_LOOKS_LIKE_ROOM_NAME: "Giá giống tên phòng",
  CAPNHATTRONG_LOG_MISSING: "Thiếu log cập nhật trống",
  CREATE_ROOM_FAILED_LOGGED: "Tạo phòng lỗi",
  SEARCH_ROOM_API_ERROR: "API tìm phòng lỗi",
};

function formatBusinessReasonLabel(reason = "") {
  if (!reason) {
    return "";
  }

  return BUSINESS_REASON_LABELS[reason] || reason;
}

function formatReasonList(reasonList = []) {
  if (!Array.isArray(reasonList) || reasonList.length === 0) {
    return "Không ghi nhận lỗi nổi bật";
  }

  return reasonList
    .map(
      (item) =>
        `${formatBusinessReasonLabel(item.reason || item.step)} (${item.count})`,
    )
    .join(", ");
}

const BUSINESS_SUGGESTED_ACTIONS = [
  {
    key: "ADDRESS_BUILDING",
    label: "Lệch địa chỉ / Không tìm thấy tòa nhà / Không match được tòa nhà",
    summaryText:
      "Rà soát địa chỉ nguồn trong sheet, đối chiếu building trên web, kiểm tra số nhà / ngõ / ngách / alias",
    cdtText: "Rà soát địa chỉ/building/alias",
  },
  {
    key: "ROOM_STATUS_UPDATE",
    label: "Phòng chưa cập nhật được trạng thái trống",
    summaryText:
      "Sau khi match đúng building, kiểm tra tiếp mapping tên phòng và flow cập nhật status",
    cdtText: "Kiểm tra mapping tên phòng + flow status",
  },
  {
    key: "NO_IMAGE_CONFIRMED",
    label: "Phòng không có ảnh",
    summaryText: "Kiểm tra link ảnh nguồn, IMAGE_DRIVER và kết quả upload",
    cdtText: "Kiểm tra link ảnh + IMAGE_DRIVER + upload",
  },
  {
    key: "IMAGE_CHECK_UNKNOWN",
    label: "Phòng chưa kiểm tra được ảnh",
    summaryText: "Kiểm tra quyền truy cập link ảnh, nguồn ảnh và kết nối MinIO",
    cdtText: "Kiểm tra quyền link ảnh + MinIO",
  },
  {
    key: "UPDATED_AT_DATA",
    label: "Thiếu thông tin cập nhật",
    summaryText: "Kiểm tra dữ liệu updated_at từ API/log",
    cdtText: "Kiểm tra updated_at từ API/log",
  },
];

const ADDRESS_BUILDING_REASONS = new Set([
  "ADDRESS_MISMATCH_LOGGED",
  "BUILDING_NOT_FOUND",
  "BUILDING_NOT_MATCHED",
  "BUILDING_MISSING_ON_WEB_LOGGED",
]);

const ROOM_STATUS_REASONS = new Set([
  "SHEET_ROOM_NOT_UPDATED_TO_EMPTY",
  "ROOM_NOT_FOUND",
  "ROOM_NOT_MATCHED_POSSIBLE_WRONG_COLUMN",
  "ROOM_STATUS_MISSING",
  "ROOM_STATUS_HET",
  "ROOM_STILL_HAS_EMPTY_ROOM_DATE",
  "CAPNHATTRONG_LOG_MISSING",
  "CREATE_ROOM_FAILED_LOGGED",
  "SEARCH_ROOM_API_ERROR",
]);

const IMAGE_CHECK_UNKNOWN_REASONS = new Set([
  "IMAGE_COUNT_NOT_CHECKED",
  "IMAGE_COUNT_UNAVAILABLE",
  "IMAGE_SOURCE_MISSING",
  "IMAGE_DRIVER_MISSING",
  "DRIVER_ERROR_LOGGED",
  "IMAGE_LINK_INVALID",
  "IMAGE_LINK_UNSUPPORTED",
  "IMAGE_SOURCE_EMPTY_FOLDER",
  "IMAGE_LINK_401",
  "IMAGE_LINK_403",
  "IMAGE_LINK_404",
]);

const CODE_5_REASONS = new Set([
  ...ADDRESS_BUILDING_REASONS,
  ...ROOM_STATUS_REASONS,
  "ADDRESS_MISSING",
  "ROOM_NAME_MISSING",
  "ROOM_NAME_LOOKS_LIKE_PRICE",
  "WEB_ROOM_NAME_LOOKS_LIKE_PRICE",
  "PRICE_UNPARSEABLE",
  "PRICE_LOOKS_LIKE_ROOM_NAME",
  "GGSHEET_LOGGED_ERROR",
]);

const CODE_7_REASONS = new Set([
  ...IMAGE_CHECK_UNKNOWN_REASONS,
  "IMAGE_COUNT_ZERO",
  "IMAGE_DRIVER_INVALID_URL",
  "ORIGIN_LINK_INVALID_URL",
]);

const CODE_4_SOFT_REJECT_REASONS = new Set([
  "score_below_threshold",
  "keyword_below_threshold",
  "number_below_threshold",
  "address_too_generic",
]);

function matchesAddressBuildingReason(reason = "") {
  return ADDRESS_BUILDING_REASONS.has(reason);
}

function matchesRoomStatusReason(reason = "") {
  return ROOM_STATUS_REASONS.has(reason);
}

function matchesImageCheckUnknownReason(reason = "") {
  return IMAGE_CHECK_UNKNOWN_REASONS.has(reason);
}

function matchesCode5Reason(reason = "") {
  return CODE_5_REASONS.has(reason);
}

function matchesCode7Reason(reason = "") {
  return CODE_7_REASONS.has(reason);
}

function matchesUpdatedAtReason(reason = "") {
  return (
    reason === "UPDATED_AT_MISSING" ||
    reason === "UPDATED_AT_INVALID" ||
    /^STALE_GT_\d+H$/.test(reason)
  );
}

function matchesYellowWarningReason(reason = "") {
  return reason === "UPDATED_AT_MISSING" || reason === "UPDATED_AT_INVALID";
}

const SHEET_ADDRESS_FIELD_REASONS = new Set([
  "ADDRESS_MISMATCH_LOGGED",
  "ADDRESS_MISSING",
]);

const SHEET_ROOM_NAME_FIELD_REASONS = new Set([
  "ROOM_NOT_MATCHED_POSSIBLE_WRONG_COLUMN",
  "ROOM_NAME_MISSING",
  "ROOM_NAME_LOOKS_LIKE_PRICE",
  "WEB_ROOM_NAME_LOOKS_LIKE_PRICE",
  "PRICE_UNPARSEABLE",
  "PRICE_LOOKS_LIKE_ROOM_NAME",
]);

function matchesSheetAddressFieldReason(reason = "") {
  return SHEET_ADDRESS_FIELD_REASONS.has(reason);
}

function matchesSheetRoomNameFieldReason(reason = "") {
  return SHEET_ROOM_NAME_FIELD_REASONS.has(reason);
}

function escapeRegExp(value = "") {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortenDisplayText(value = "", maxLength = 18) {
  const normalizedValue = repairVietnameseText(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedValue || normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  if (maxLength <= 3) {
    return normalizedValue.slice(0, maxLength);
  }

  return `${normalizedValue.slice(0, maxLength - 1)}…`;
}

function simplifyCdtDisplayName(cdtId, cdtName) {
  const normalizedName = repairVietnameseText(cdtName || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedName) {
    return "";
  }

  const normalizedId = cdtId === null || cdtId === undefined ? "" : String(cdtId).trim();
  if (!normalizedId) {
    return normalizedName;
  }

  const withoutIdPrefix = normalizedName
    .replace(new RegExp(`^${escapeRegExp(normalizedId)}\\s*`, "i"), "")
    .trim();

  return withoutIdPrefix || normalizedName;
}

function buildCompactCdtToken(group = {}, options = {}) {
  const idText =
    group?.cdt_id === null || group?.cdt_id === undefined || group?.cdt_id === ""
      ? ""
      : String(group.cdt_id).trim();
  const includeName = Boolean(options?.includeName);
  const countField = options?.countField || "affected_rows";
  const includeCount = Boolean(options?.includeCount);
  const nameText = includeName
    ? shortenDisplayText(
        simplifyCdtDisplayName(group?.cdt_id, group?.cdt_name),
        Number.isFinite(options?.nameMaxLength) ? options.nameMaxLength : 18,
      )
    : "";

  let token = idText || shortenDisplayText(group?.cdt_name || "", 18) || "?";
  if (includeName && nameText && nameText !== token) {
    token = `${token} ${nameText}`.trim();
  }

  if (includeCount) {
    const countValue = Number(group?.[countField] || 0);
    token = `${token}(${countValue})`;
  }

  return token;
}

function buildCompactGroupSummary(groups = [], options = {}) {
  const normalizedGroups = Array.isArray(groups) ? groups.filter(Boolean) : [];
  if (normalizedGroups.length === 0) {
    return "Không";
  }

  const includeAll = Boolean(options?.includeAll);
  const limit = includeAll
    ? normalizedGroups.length
    : Number.isFinite(options?.limit)
      ? options.limit
      : 5;
  const renderedGroups = normalizedGroups
    .slice(0, limit)
    .map((group) => buildCompactCdtToken(group, options))
    .filter(Boolean);

  if (renderedGroups.length === 0) {
    return "Không";
  }

  const remainingCount = normalizedGroups.length - renderedGroups.length;
  if (
    remainingCount <= 0 ||
    includeAll ||
    options?.includeOverflow === false
  ) {
    return renderedGroups.join(", ");
  }

  const overflowLabel = options?.overflowLabel || "CDT khác";
  return `${renderedGroups.join(", ")}, +${remainingCount} ${overflowLabel}`;
}

function collectSuggestedActionKeys({
  reasonEntries = [],
  roomsWithoutImages = 0,
  roomsWithoutImagesUnknown = 0,
  includeUpdatedAt = true,
} = {}) {
  const reasons = Array.isArray(reasonEntries)
    ? reasonEntries
        .map((item) => item?.reason || item?.step || item)
        .filter(Boolean)
    : [];
  const reasonSet = new Set(reasons);
  const actionKeys = [];

  if ([...reasonSet].some((reason) => matchesAddressBuildingReason(reason))) {
    actionKeys.push("ADDRESS_BUILDING");
  }

  if ([...reasonSet].some((reason) => matchesRoomStatusReason(reason))) {
    actionKeys.push("ROOM_STATUS_UPDATE");
  }

  if (roomsWithoutImages > 0 || reasonSet.has("IMAGE_COUNT_ZERO")) {
    actionKeys.push("NO_IMAGE_CONFIRMED");
  }

  if (
    roomsWithoutImagesUnknown > 0 ||
    [...reasonSet].some((reason) => matchesImageCheckUnknownReason(reason))
  ) {
    actionKeys.push("IMAGE_CHECK_UNKNOWN");
  }

  if (
    includeUpdatedAt &&
    [...reasonSet].some((reason) => matchesUpdatedAtReason(reason))
  ) {
    actionKeys.push("UPDATED_AT_DATA");
  }

  return BUSINESS_SUGGESTED_ACTIONS.filter((item) =>
    actionKeys.includes(item.key),
  );
}

function buildSuggestedActionLines(report) {
  const suggestions = collectSuggestedActionKeys({
    reasonEntries: report.reason_summary,
    roomsWithoutImages: report.total_rooms_without_images,
    roomsWithoutImagesUnknown: report.total_rooms_without_images_unknown,
    includeUpdatedAt: true,
  });

  const lines = ["Hướng xử lý đề xuất:"];
  if (suggestions.length === 0) {
    lines.push(
      "- Không có hướng xử lý đề xuất vì không ghi nhận lỗi business nổi bật.",
    );
    return lines;
  }

  suggestions.forEach((item) => {
    lines.push(`- ${item.label}: ${item.summaryText}.`);
  });

  return lines;
}

function buildCdtSuggestedActionText(group) {
  const suggestions = collectSuggestedActionKeys({
    reasonEntries: group.top_update_error_reasons,
    roomsWithoutImages: group.rooms_without_images,
    roomsWithoutImagesUnknown: group.rooms_without_images_unknown,
    includeUpdatedAt: false,
  });

  if (suggestions.length === 0) {
    return "";
  }

  return suggestions
    .slice(0, 3)
    .map((item) => item.cdtText)
    .join("; ");
}

function buildIssueGroupsByCdt(rows = [], matcher = () => false) {
  const groups = new Map();

  rows.forEach((row) => {
    const matchedReasons = (row.error_detail || []).filter((reason) =>
      matcher(reason, row),
    );
    if (matchedReasons.length === 0) {
      return;
    }

    const key = buildCdtGroupKey(row.cdt_id, row.cdt_name);
    if (!groups.has(key)) {
      groups.set(key, {
        cdt_id: row.cdt_id,
        cdt_name: row.cdt_name,
        affected_rows: 0,
        reasons: [],
      });
    }

    const group = groups.get(key);
    group.affected_rows += 1;
    group.reasons.push(...matchedReasons);
  });

  return [...groups.values()]
    .map((group) => ({
      cdt_id: group.cdt_id,
      cdt_name: group.cdt_name,
      affected_rows: group.affected_rows,
      reasons: countValueOccurrences(group.reasons).map((item) => ({
        reason: item.value,
        count: item.count,
      })),
    }))
    .sort((a, b) => {
      if (b.affected_rows !== a.affected_rows) {
        return b.affected_rows - a.affected_rows;
      }

      return String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? ""));
    });
}

function buildCode4Detection(rows = []) {
  const evidenceByAddress = new Map();

  rows.forEach((row) => {
    const reasons = (row.error_detail || []).filter((reason) =>
      matchesAddressBuildingReason(reason),
    );
    if (reasons.length === 0) {
      return;
    }

    const key = buildAddressGroupKey(row.cdt_id, row.address);
    if (!evidenceByAddress.has(key)) {
      evidenceByAddress.set(key, {
        key,
        cdt_id: row.cdt_id,
        cdt_name: row.cdt_name,
        address: row.address || "",
        reasons: [],
        reject_reasons: [],
        has_building_matched: false,
        has_room_on_any_candidate: false,
        has_top_candidate: false,
        has_missing_on_web_log: false,
      });
    }

    const evidence = evidenceByAddress.get(key);
    evidence.reasons.push(...reasons);
    if (row.top_building_candidate_reject_reason) {
      evidence.reject_reasons.push(row.top_building_candidate_reject_reason);
    }
    if (row.mapping?.building_matched) {
      evidence.has_building_matched = true;
    }
    if (row.room_exists_on_any_candidate === true) {
      evidence.has_room_on_any_candidate = true;
    }
    if (row.top_building_candidate_id) {
      evidence.has_top_candidate = true;
    }
    if ((row.error_detail || []).includes("BUILDING_MISSING_ON_WEB_LOGGED")) {
      evidence.has_missing_on_web_log = true;
    }
  });

  const code4AddressKeys = new Set();
  const groupsByCdt = new Map();

  evidenceByAddress.forEach((evidence) => {
    const rejectReasons = [...new Set(evidence.reject_reasons.filter(Boolean))];
    const onlySoftRejects =
      rejectReasons.length > 0 &&
      rejectReasons.every((reason) => CODE_4_SOFT_REJECT_REASONS.has(reason));
    const isLikelyMissingBuilding =
      evidence.has_missing_on_web_log ||
      (!evidence.has_building_matched &&
        !evidence.has_room_on_any_candidate &&
        (!evidence.has_top_candidate || onlySoftRejects));

    if (!isLikelyMissingBuilding) {
      return;
    }

    code4AddressKeys.add(evidence.key);
    const cdtKey = buildCdtGroupKey(evidence.cdt_id, evidence.cdt_name);
    if (!groupsByCdt.has(cdtKey)) {
      groupsByCdt.set(cdtKey, {
        cdt_id: evidence.cdt_id,
        cdt_name: evidence.cdt_name,
        affected_buildings: 0,
        addresses: [],
        reasons: [],
      });
    }

    const group = groupsByCdt.get(cdtKey);
    group.affected_buildings += 1;
    group.addresses.push(evidence.address);
    group.reasons.push(...evidence.reasons);
  });

  return {
    addressKeys: code4AddressKeys,
    groups: [...groupsByCdt.values()]
      .map((group) => ({
        cdt_id: group.cdt_id,
        cdt_name: group.cdt_name,
        affected_buildings: group.affected_buildings,
        addresses: [...new Set(group.addresses.filter(Boolean))],
        reasons: countValueOccurrences(group.reasons).map((item) => ({
          reason: item.value,
          count: item.count,
        })),
      }))
      .sort((a, b) => {
        if (b.affected_buildings !== a.affected_buildings) {
          return b.affected_buildings - a.affected_buildings;
        }

        return String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? ""));
      }),
  };
}

function buildSummaryDrivenIssueGroups(
  summaryGroups = [],
  rows = [],
  countSelector = () => 0,
  reasonMatcher = () => false,
) {
  const reasonGroups = buildIssueGroupsByCdt(rows, reasonMatcher);
  const reasonMap = new Map(
    reasonGroups.map((group) => [
      buildCdtGroupKey(group.cdt_id, group.cdt_name),
      group,
    ]),
  );

  return summaryGroups
    .map((group) => {
      const affectedRows = Number(countSelector(group) || 0);
      if (affectedRows <= 0) {
        return null;
      }

      const reasonGroup = reasonMap.get(
        buildCdtGroupKey(group.cdt_id, group.cdt_name),
      );
      return {
        cdt_id: group.cdt_id,
        cdt_name: group.cdt_name,
        affected_rows: affectedRows,
        reasons: reasonGroup?.reasons || [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.affected_rows !== a.affected_rows) {
        return b.affected_rows - a.affected_rows;
      }

      return String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? ""));
    });
}

function buildDirectIssueGroupsByCdt(
  rows = [],
  rowPredicate = () => false,
  reasonMatcher = () => false,
) {
  const groups = new Map();

  rows.forEach((row) => {
    if (!rowPredicate(row)) {
      return;
    }

    const key = buildCdtGroupKey(row.cdt_id, row.cdt_name);
    if (!groups.has(key)) {
      groups.set(key, {
        cdt_id: row.cdt_id,
        cdt_name: row.cdt_name,
        affected_rows: 0,
        reasons: [],
      });
    }

    const group = groups.get(key);
    group.affected_rows += 1;
    group.reasons.push(
      ...(row.error_detail || []).filter((reason) =>
        reasonMatcher(reason, row),
      ),
    );
  });

  return [...groups.values()]
    .map((group) => ({
      cdt_id: group.cdt_id,
      cdt_name: group.cdt_name,
      affected_rows: group.affected_rows,
      reasons: countValueOccurrences(group.reasons).map((item) => ({
        reason: item.value,
        count: item.count,
      })),
    }))
    .sort((a, b) => {
      if (b.affected_rows !== a.affected_rows) {
        return b.affected_rows - a.affected_rows;
      }

      return String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? ""));
    });
}

function buildSourceErrorGroups(sourceErrors = []) {
  const groups = new Map();

  sourceErrors.forEach((sourceError) => {
    const cdtId = sourceError?.cdt_id;
    const cdtName = sourceError?.cdt_name || sourceError?.source || "";
    const key = buildCdtGroupKey(cdtId, cdtName);
    if (!groups.has(key)) {
      groups.set(key, {
        cdt_id: cdtId ?? null,
        cdt_name: cdtName,
        source_error_count: 0,
        steps: [],
      });
    }

    const group = groups.get(key);
    group.source_error_count += 1;
    group.steps.push(sourceError?.step || "UNKNOWN");
  });

  return [...groups.values()]
    .map((group) => ({
      cdt_id: group.cdt_id,
      cdt_name: group.cdt_name,
      source_error_count: group.source_error_count,
      steps: countValueOccurrences(group.steps).map((item) => ({
        step: item.value,
        count: item.count,
      })),
    }))
    .sort((a, b) => {
      if (b.source_error_count !== a.source_error_count) {
        return b.source_error_count - a.source_error_count;
      }

      return String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? ""));
    });
}

function formatCdtRef(cdtId, cdtName) {
  const displayName = repairVietnameseText(cdtName);
  if (cdtId === null || cdtId === undefined || cdtId === "") {
    return displayName || "CDT chưa xác định";
  }

  return displayName ? `CDT ${cdtId} (${displayName})` : `CDT ${cdtId}`;
}

function formatRawReasonSummary(reasonEntries = [], limit = 4) {
  if (!Array.isArray(reasonEntries) || reasonEntries.length === 0) {
    return "Không có signal rõ";
  }

  return reasonEntries
    .slice(0, limit)
    .map((item) => `${item.reason} ${item.count}`)
    .join("; ");
}

function formatAddressSummary(addresses = [], limit = 2) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return "chưa có địa chỉ cụ thể";
  }

  const selectedAddresses = addresses
    .slice(0, limit)
    .map((address) => repairVietnameseText(address));
  const suffix =
    addresses.length > limit
      ? `; +${addresses.length - limit} địa chỉ khác`
      : "";
  return `${selectedAddresses.join("; ")}${suffix}`;
}

function formatStepSummary(stepEntries = [], limit = 2) {
  if (!Array.isArray(stepEntries) || stepEntries.length === 0) {
    return "không rõ bước lỗi";
  }

  return stepEntries
    .slice(0, limit)
    .map((item) => `${item.step} ${item.count}`)
    .join("; ");
}

function formatLabelList(values = []) {
  const uniqueValues = [...new Set(values.filter(Boolean))];
  if (uniqueValues.length === 0) {
    return "";
  }

  if (uniqueValues.length === 1) {
    return uniqueValues[0];
  }

  if (uniqueValues.length === 2) {
    return `${uniqueValues[0]} và ${uniqueValues[1]}`;
  }

  return `${uniqueValues.slice(0, -1).join(", ")} và ${uniqueValues.at(-1)}`;
}

function buildNeedConditionLine(report, code6Groups = []) {
  const sourceErrorCount = report.source_errors.length;
  const executionSummaryByCdt = Array.isArray(report.execution_summary_by_cdt)
    ? report.execution_summary_by_cdt
    : [];

  if (report.total_empty_rooms_today > 0 && sourceErrorCount === 0) {
    return `II.A.1: Điều kiện cần = ĐẠT. Tool đã chạy và lấy được tổng ${report.total_empty_rooms_today} phòng trống.`;
  }

  if (report.total_empty_rooms_today > 0) {
    return `II.A.1: Điều kiện cần = ĐẠT, CÓ CẢNH BÁO. Tool đã chạy và tạm ghi nhận tổng ${report.total_empty_rooms_today} phòng trống, nhưng có ${sourceErrorCount} lỗi nguồn cần rà soát thêm.`;
  }

  if (code6Groups.length > 0 && sourceErrorCount === 0) {
    return "II.A.1: Điều kiện cần = ĐẠT. Tool đã chạy và tổng phòng trống hiện tại = 0.";
  }

  if (executionSummaryByCdt.length > 0 && sourceErrorCount === 0) {
    return "II.A.1: Điều kiện cần = ĐẠT. Tool đã chạy và không ghi nhận phòng trống nào trong lần chạy này.";
  }

  if (sourceErrorCount > 0) {
    return `II.A.1: Điều kiện cần = CHƯA ĐẠT. Tool đã chạy nhưng chưa lấy được tổng phòng trống ổn định do có ${sourceErrorCount} lỗi nguồn.`;
  }

  return "II.A.1: Điều kiện cần = CHƯA GHI NHẬN. Chưa có dữ liệu lần chạy để kết luận.";
}

function buildCode1Line(sourceErrorGroups = []) {
  if (!Array.isArray(sourceErrorGroups) || sourceErrorGroups.length === 0) {
    return "II.A.3: Mã 1 = KHÔNG GHI NHẬN. Lần chạy này không có source_error hoặc link bảng hàng bị fail.";
  }

  const summaryText = sourceErrorGroups
    .slice(0, 4)
    .map(
      (group) =>
        `${formatCdtRef(group.cdt_id, group.cdt_name)} x${group.source_error_count} lỗi nguồn [${formatStepSummary(group.steps)}]`,
    )
    .join(" | ");

  return `II.A.3: Mã 1 = ${summaryText}.`;
}

function buildCode6Line(code6Groups = [], executionSummaryByCdt = []) {
  if (
    !Array.isArray(executionSummaryByCdt) ||
    executionSummaryByCdt.length === 0
  ) {
    return "II.A.4: Mã 6 = CHƯA ĐỦ DỮ LIỆU ĐỂ KẾT LUẬN.";
  }

  if (!Array.isArray(code6Groups) || code6Groups.length === 0) {
    return "II.A.4: Mã 6 = KHÔNG GHI NHẬN TRONG TẬP DỮ LIỆU HIỆN TẠI. Không có CDT nào trả về tổng phòng trống = 0 sau khi quét xong.";
  }

  const summaryText = code6Groups
    .slice(0, 4)
    .map((group) => `${formatCdtRef(group.cdt_id, group.cdt_name)} x0 phòng`)
    .join(" | ");

  return `II.A.4: Mã 6 = ${summaryText}. Cần xác minh đây là hết phòng thật hay tool không quét đủ dữ liệu.`;
}

function buildPriorityActionText(report) {
  const actions = [];

  if (Array.isArray(report.code4_groups) && report.code4_groups.length > 0) {
    actions.push(
      "Liệt kê CDT/địa chỉ tòa mới, đối chiếu DB và tạo hoặc bổ sung building/alias trên hệ thống",
    );
  }

  const suggestions = collectSuggestedActionKeys({
    reasonEntries: report.reason_summary,
    roomsWithoutImages: report.total_rooms_without_images,
    roomsWithoutImagesUnknown: report.total_rooms_without_images_unknown,
    includeUpdatedAt: true,
  });

  actions.push(...suggestions.map((item) => item.summaryText));

  if (actions.length === 0) {
    return "Không có hướng xử lý ưu tiên.";
  }

  return actions
    .slice(0, 3)
    .map((item, index) => `(${index + 1}) ${item}`)
    .join("; ");
}

function buildConclusionLine({
  sourceErrorGroups = [],
  code4Groups = [],
  code5Groups = [],
  code6Groups = [],
  code7Groups = [],
  yellowGroups = [],
} = {}) {
  const activeCodes = [];
  if (sourceErrorGroups.length > 0) {
    activeCodes.push("Mã 1");
  }
  if (code4Groups.length > 0) {
    activeCodes.push("Mã 4");
  }
  if (code5Groups.length > 0) {
    activeCodes.push("Mã 5");
  }
  if (code6Groups.length > 0) {
    activeCodes.push("Mã 6");
  }
  if (code7Groups.length > 0) {
    activeCodes.push("Mã 7");
  }

  const mainClause = activeCodes.length
    ? `Các nhóm việc chính hiện tại là ${formatLabelList(activeCodes)}.`
    : "Không ghi nhận mã lỗi nghiêm trọng nào ở giai đoạn II.";
  const yellowClause = yellowGroups.length
    ? " Vẫn còn nhóm cảnh báo vàng cần đối chiếu thêm API/log."
    : "";

  return `Kết luận ngắn: ${mainClause}${yellowClause} Khi gửi Telegram và copy sang Google Sheet, chỉ giữ các dòng II.A/II.B ngắn gọn như trên.`;
}

function buildBusinessSummaryLines(report, options = {}) {
  const codeGroupLimit = Number.isFinite(options?.openClawCodeGroupLimit)
    ? options.openClawCodeGroupLimit
    : 5;
  const warningCdtCount = report.summary_by_cdt.filter(
    (group) => group.status === "WARNING" || group.status === "ERROR",
  ).length;
  const sourceErrorGroups = buildSourceErrorGroups(report.source_errors);
  const code6Groups =
    Array.isArray(report.code6_candidates) && report.code6_candidates.length > 0
      ? report.code6_candidates
      : buildCode6Candidates(report.execution_summary_by_cdt);
  const code4Groups =
    Array.isArray(report.code4_groups) && report.code4_groups.length > 0
      ? report.code4_groups
      : [];
  const code4AddressKeys = new Set(
    Array.isArray(report.code4_address_keys) ? report.code4_address_keys : [],
  );
  const nonCode4Rows =
    code4AddressKeys.size === 0
      ? report.rows
      : report.rows.filter(
          (row) =>
            !code4AddressKeys.has(
              buildAddressGroupKey(row.cdt_id, row.address),
            ),
        );
  const code5Groups = buildDirectIssueGroupsByCdt(
    nonCode4Rows,
    hasAnyUpdateFail,
    matchesCode5Reason,
  ).slice(0, codeGroupLimit);
  const code7Groups = buildDirectIssueGroupsByCdt(
    report.rows,
    (row) =>
      (row.error_detail || []).some((reason) => matchesCode7Reason(reason)),
    matchesCode7Reason,
  ).slice(0, codeGroupLimit);
  const yellowGroups = buildDirectIssueGroupsByCdt(
    report.rows,
    (row) =>
      (row.error_detail || []).some((reason) =>
        matchesYellowWarningReason(reason),
      ),
    matchesYellowWarningReason,
  ).slice(0, codeGroupLimit);
  const lines = [
    `[OPENCLAW_STAGE_2] ${report.generated_at}`,
    buildNeedConditionLine(report, code6Groups),
    `II.A.2: Tổng hợp nhanh = ${warningCdtCount} CDT có cảnh báo; ${report.tool_status.total_failed_update_rows} phòng không cập nhật được; ${report.total_rooms_without_images} phòng xác nhận không có ảnh; ${report.total_rooms_without_images_unknown} phòng chưa kiểm tra được ảnh.`,
    buildCode1Line(sourceErrorGroups),
    buildCode6Line(code6Groups, report.execution_summary_by_cdt),
  ];

  let sectionIndex = 1;
  if (code4Groups.length > 0) {
    code4Groups.slice(0, codeGroupLimit).forEach((group) => {
      lines.push(
        `II.B.${sectionIndex}: ${formatCdtRef(group.cdt_id, group.cdt_name)} = Mã 4 x${group.affected_buildings} tòa. Dấu hiệu: ${formatRawReasonSummary(group.reasons, 3)}. Địa chỉ nghi là tòa mới: ${formatAddressSummary(group.addresses)}.`,
      );
      sectionIndex += 1;
    });
  } else {
    lines.push(
      `II.B.${sectionIndex}: Mã 4 = KHÔNG GHI NHẬN. Chưa phát hiện CDT nào có tòa mới / thiếu tòa mới trên DB trong lần chạy này.`,
    );
    sectionIndex += 1;
  }

  code5Groups.forEach((group) => {
    lines.push(
      `II.B.${sectionIndex}: ${formatCdtRef(group.cdt_id, group.cdt_name)} = Mã 5 x${group.affected_rows} phòng. Dấu hiệu: ${formatRawReasonSummary(group.reasons)}.`,
    );
    sectionIndex += 1;
  });

  code7Groups.forEach((group) => {
    lines.push(
      `II.B.${sectionIndex}: ${formatCdtRef(group.cdt_id, group.cdt_name)} = Mã 7 x${group.affected_rows} phòng. Dấu hiệu: ${formatRawReasonSummary(group.reasons)}.`,
    );
    sectionIndex += 1;
  });

  yellowGroups.forEach((group) => {
    lines.push(
      `II.B.${sectionIndex}: ${formatCdtRef(group.cdt_id, group.cdt_name)} = CẢNH BÁO VÀNG x${group.affected_rows} phòng. Dấu hiệu: ${formatRawReasonSummary(group.reasons, 3)}; cần đối chiếu thêm API/log.`,
    );
    sectionIndex += 1;
  });

  if (sectionIndex === 1) {
    lines.push(
      "II.B.1: Không ghi nhận CDT nào có Mã 5, Mã 7 hoặc cảnh báo vàng trong lần chạy này.",
    );
    sectionIndex += 1;
  }

  lines.push(
    `II.B.${sectionIndex}: Hướng xử lý ưu tiên = ${buildPriorityActionText(report)}.`,
  );
  lines.push(
    buildConclusionLine({
      sourceErrorGroups,
      code4Groups,
      code5Groups,
      code6Groups,
      code7Groups,
      yellowGroups,
    }),
  );

  return lines;
}

function buildBusinessSummaryText(report, options = {}) {
  return buildBusinessSummaryLines(report, options).join("\n");
}

function buildDailySheetSummary(report, options = {}) {
  const context = buildTelegramIssueContext(report);
  const code4Total = (context.code4Groups || []).reduce(
    (total, group) => total + Number(group.affected_buildings || 0),
    0,
  );
  const code5Total = (context.code5Groups || []).reduce(
    (total, group) => total + Number(group.affected_rows || 0),
    0,
  );
  const code7Total = (context.code7Groups || []).reduce(
    (total, group) => total + Number(group.affected_rows || 0),
    0,
  );
  const yellowTotal = (context.yellowGroups || []).reduce(
    (total, group) => total + Number(group.affected_rows || 0),
    0,
  );
  const code6Count = Array.isArray(context.code6Groups)
    ? context.code6Groups.length
    : 0;
  const sourceErrorTotal = (context.sourceErrorGroups || []).reduce(
    (total, group) => total + Number(group.source_error_count || 0),
    0,
  );
  const code4AddressKeys = new Set(
    Array.isArray(report.code4_address_keys) ? report.code4_address_keys : [],
  );
  const nonCode4Rows =
    code4AddressKeys.size === 0
      ? report.rows
      : report.rows.filter(
          (row) =>
            !code4AddressKeys.has(buildAddressGroupKey(row.cdt_id, row.address)),
        );
  const addressFieldGroups = buildDirectIssueGroupsByCdt(
    nonCode4Rows,
    (row) =>
      (row.error_detail || []).some((reason) =>
        matchesSheetAddressFieldReason(reason),
      ),
    matchesSheetAddressFieldReason,
  );
  const roomNameFieldGroups = buildDirectIssueGroupsByCdt(
    nonCode4Rows,
    (row) =>
      (row.error_detail || []).some((reason) =>
        matchesSheetRoomNameFieldReason(reason),
      ),
    matchesSheetRoomNameFieldReason,
  );
  const compactGroupLimit = Number.isFinite(options?.dailySummaryGroupLimit)
    ? options.dailySummaryGroupLimit
    : Number.MAX_SAFE_INTEGER;
  const hasAnyIssue =
    sourceErrorTotal > 0 ||
    code4Total > 0 ||
    code5Total > 0 ||
    code6Count > 0 ||
    code7Total > 0 ||
    yellowTotal > 0;

  const answers = [
    report.tool_status?.ran
      ? `Có | Trống: ${report.total_rows} | Không ảnh: ${report.total_rooms_without_images} | Chưa KT ảnh: ${report.total_rooms_without_images_unknown}`
      : "Không",
    hasAnyIssue
      ? [
          "Có",
          sourceErrorTotal > 0 ? `Mã 1:${sourceErrorTotal} lỗi nguồn` : "",
          code4Total > 0 ? `Mã 4:${code4Total} tòa` : "",
          code5Total > 0 ? `Mã 5:${code5Total} phòng` : "",
          code6Count > 0 ? `Mã 6:${code6Count} CDT` : "",
          code7Total > 0 ? `Mã 7:${code7Total} phòng` : "",
          yellowTotal > 0 ? `Vàng:${yellowTotal} phòng` : "",
        ]
          .filter(Boolean)
          .join(" | ")
      : "Không",
    context.sourceErrorGroups.length > 0
      ? `Có | ${buildCompactGroupSummary(context.sourceErrorGroups, {
          limit: compactGroupLimit,
          includeOverflow: false,
          overflowLabel: "CDT khác",
        })}`
      : "Không",
    addressFieldGroups.length > 0
      ? `Có | ${buildCompactGroupSummary(addressFieldGroups, {
          limit: compactGroupLimit,
          includeOverflow: false,
          overflowLabel: "CDT khác",
        })}`
      : "Không",
    roomNameFieldGroups.length > 0
      ? `Có | ${buildCompactGroupSummary(roomNameFieldGroups, {
          limit: compactGroupLimit,
          includeOverflow: false,
          overflowLabel: "CDT khác",
        })}`
      : "Không",
    context.code6Groups.length > 0
      ? `Có | ${buildCompactGroupSummary(context.code6Groups, {
          limit: compactGroupLimit,
          includeOverflow: false,
          overflowLabel: "CDT khác",
        })}`
      : "Không",
    context.code4Groups.length > 0
      ? `Có | ${buildCompactGroupSummary(context.code4Groups, {
          limit: compactGroupLimit,
          includeOverflow: false,
          includeName: true,
          includeCount: true,
          countField: "affected_buildings",
          overflowLabel: "CDT khác",
        })}`
      : "Không",
  ];

  const rowLabels = [
    "1. Chạy",
    "2. Lỗi",
    "3. Link",
    "4. Địa chỉ",
    "5. Tên phòng",
    "6. Hết phòng",
    "7. Tòa mới",
  ];
  const telegramLines = [
    `[ROOM_AUDIT_DAILY] ${report.generated_at}`,
    ...answers.map((answer, index) => `${rowLabels[index]}: ${answer}`),
    "Chi tiết đã lưu trong latest-room-audit-summary.txt",
  ];

  return {
    day_label: String(new Date().getDate()),
    answers,
    rows: answers.map((answer, index) => ({
      question_no: index + 1,
      answer,
    })),
    telegram_lines: telegramLines,
    telegram_text: truncateTelegramText(
      telegramLines.join("\n"),
      Number.isFinite(options?.telegramMaxLength)
        ? options.telegramMaxLength
        : 3500,
    ),
  };
}

function formatDetailedRoomName(item = {}) {
  return (
    repairVietnameseText(item.room_name || "") ||
    (item.room_id ? String(item.room_id) : "(không có tên phòng)")
  );
}

function buildDetailedSummaryText(report, options = {}) {
  const context = buildTelegramIssueContext(report);
  const lines = [...buildBusinessSummaryLines(report, options)];

  function pushSection(title, sectionLines = []) {
    if (!Array.isArray(sectionLines) || sectionLines.length === 0) {
      return;
    }

    lines.push("");
    lines.push(title);
    lines.push(...sectionLines);
  }

  pushSection(
    "MÃ 1 - CDT lỗi link / lỗi nguồn:",
    (context.sourceErrorGroups || []).length > 0
      ? context.sourceErrorGroups.map(
          (group) =>
            `- ${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.source_error_count} lỗi nguồn | Bước lỗi: ${formatStepSummary(group.steps, 5)}`,
        )
      : ["- Không ghi nhận."],
  );

  pushSection(
    "MÃ 6 - CDT không có phòng trống:",
    (context.code6Groups || []).length > 0
      ? context.code6Groups.map(
          (group) =>
            `- ${formatCdtRef(group.cdt_id, group.cdt_name)} | Tổng phòng trống hiện tại = 0`,
        )
      : ["- Không ghi nhận."],
  );

  pushSection(
    "MÃ 4 - Tòa mới / nghi thiếu tòa trên DB:",
    (context.code4Groups || []).length > 0
      ? (context.code4Groups || []).flatMap((group) => [
          `- ${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.affected_buildings} địa chỉ / tòa`,
          ...(group.addresses || []).map(
            (address) => `+ ${repairVietnameseText(address)}`,
          ),
        ])
      : ["- Không ghi nhận."],
  );

  pushSection(
    "MÃ 5 - Phòng lỗi mapping / cập nhật / tên phòng:",
    (context.code5DetailGroups || []).length > 0
      ? (context.code5DetailGroups || []).flatMap((group) => [
          `- ${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.affected_rows} phòng`,
          ...(group.items || []).map(
            (item) =>
              `+ ${repairVietnameseText(item.address || "")} | Phòng: ${formatDetailedRoomName(item)} | Lỗi: ${formatReasonList(item.reasons)}`,
          ),
        ])
      : ["- Không ghi nhận."],
  );

  pushSection(
    "MÃ 7 - Phòng lỗi ảnh / metadata:",
    (context.code7DetailGroups || []).length > 0
      ? (context.code7DetailGroups || []).flatMap((group) => [
          `- ${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.affected_rows} phòng`,
          ...(group.items || []).map(
            (item) =>
              `+ ${repairVietnameseText(item.address || "")} | Phòng: ${formatDetailedRoomName(item)} | Lỗi: ${formatReasonList(item.reasons)}`,
          ),
        ])
      : ["- Không ghi nhận."],
  );

  pushSection(
    "CẢNH BÁO VÀNG - Phòng cần đối chiếu thêm:",
    (context.yellowDetailGroups || []).length > 0
      ? (context.yellowDetailGroups || []).flatMap((group) => [
          `- ${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.affected_rows} phòng`,
          ...(group.items || []).map(
            (item) =>
              `+ ${repairVietnameseText(item.address || "")} | Phòng: ${formatDetailedRoomName(item)} | Cảnh báo: ${formatReasonList(item.reasons)}`,
          ),
        ])
      : ["- Không ghi nhận."],
  );

  return lines.join("\n");
}

function buildTextReport(report, options = {}) {
  const businessSummaryText = buildBusinessSummaryText(report, options);
  const technicalReport = buildTechnicalReport(report, options);

  if (!technicalReport) {
    return businessSummaryText;
  }

  return [businessSummaryText, "", "Chi tiết kỹ thuật:", technicalReport].join(
    "\n",
  );
}

function truncateTelegramText(text = "", maxLength = 3500) {
  if (!text || text.length <= maxLength) {
    return text || "";
  }

  if (maxLength <= 18) {
    return text.slice(0, maxLength);
  }

  return `${text.slice(0, maxLength - 13)}...[rut gon]`;
}

function buildTelegramChunkMessages(header = "", lines = [], options = {}) {
  const maxLength = Number.isFinite(options?.telegramMaxLength)
    ? options.telegramMaxLength
    : 3500;
  const normalizedHeader = header ? header.toString().trim() : "";
  const normalizedLines = lines
    .filter(Boolean)
    .map((line) => line.toString().trim())
    .filter(Boolean);

  if (!normalizedHeader && normalizedLines.length === 0) {
    return [];
  }

  if (normalizedLines.length === 0) {
    return [truncateTelegramText(normalizedHeader, maxLength)];
  }

  const messages = [];
  const maxLineLength = Math.max(
    200,
    maxLength - (normalizedHeader ? normalizedHeader.length + 1 : 0),
  );
  let currentMessage = normalizedHeader;

  normalizedLines.forEach((rawLine) => {
    const line = truncateTelegramText(rawLine, maxLineLength);
    const nextMessage = currentMessage ? `${currentMessage}\n${line}` : line;

    if (nextMessage.length <= maxLength) {
      currentMessage = nextMessage;
      return;
    }

    if (currentMessage && currentMessage !== normalizedHeader) {
      messages.push(currentMessage.trim());
      currentMessage = normalizedHeader ? `${normalizedHeader}\n${line}` : line;
      if (currentMessage.length > maxLength) {
        messages.push(truncateTelegramText(currentMessage, maxLength));
        currentMessage = normalizedHeader;
      }
      return;
    }

    messages.push(truncateTelegramText(nextMessage, maxLength));
    currentMessage = normalizedHeader;
  });

  if (currentMessage && currentMessage !== normalizedHeader) {
    messages.push(currentMessage.trim());
  }

  return messages;
}

function formatTelegramReasonSummary(reasonEntries = [], limit = 3) {
  if (!Array.isArray(reasonEntries) || reasonEntries.length === 0) {
    return "không rõ lỗi";
  }

  const selectedEntries = reasonEntries.slice(0, limit).map((entry) => {
    const label = formatBusinessReasonLabel(entry.reason);
    return entry.count > 1 ? `${label} ${entry.count}` : label;
  });
  const suffix =
    reasonEntries.length > limit
      ? `; +${reasonEntries.length - limit} lỗi khác`
      : "";
  return `${selectedEntries.join("; ")}${suffix}`;
}

function buildDetailedIssueGroupsByCdt(
  rows = [],
  rowPredicate = () => false,
  reasonMatcher = () => false,
) {
  const groups = new Map();

  rows.forEach((row) => {
    if (!rowPredicate(row)) {
      return;
    }

    const matchedReasons = (row.error_detail || []).filter((reason) =>
      reasonMatcher(reason, row),
    );
    if (matchedReasons.length === 0) {
      return;
    }

    const groupKey = buildCdtGroupKey(row.cdt_id, row.cdt_name);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        cdt_id: row.cdt_id,
        cdt_name: row.cdt_name,
        items: new Map(),
      });
    }

    const group = groups.get(groupKey);
    const itemKey = [
      normalizeKeyText(row.address),
      normalizeKeyText(row.room_name || row.room_id || row.room_real_new_id),
    ].join("|");

    if (!group.items.has(itemKey)) {
      group.items.set(itemKey, {
        address: repairVietnameseText(row.address || ""),
        room_name: repairVietnameseText(row.room_name || ""),
        room_id: row.room_id || row.room_real_new_id || "",
        reasons: [],
      });
    }

    const item = group.items.get(itemKey);
    item.reasons.push(...matchedReasons);
  });

  return [...groups.values()]
    .map((group) => ({
      cdt_id: group.cdt_id,
      cdt_name: group.cdt_name,
      affected_rows: group.items.size,
      items: [...group.items.values()]
        .map((item) => ({
          ...item,
          reasons: countValueOccurrences(item.reasons).map((reasonItem) => ({
            reason: reasonItem.value,
            count: reasonItem.count,
          })),
        }))
        .sort((a, b) => {
          const addressDiff = normalizeKeyText(a.address).localeCompare(
            normalizeKeyText(b.address),
          );
          if (addressDiff !== 0) {
            return addressDiff;
          }

          return normalizeKeyText(a.room_name || a.room_id).localeCompare(
            normalizeKeyText(b.room_name || b.room_id),
          );
        }),
    }))
    .sort((a, b) => {
      if (b.affected_rows !== a.affected_rows) {
        return b.affected_rows - a.affected_rows;
      }

      return String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? ""));
    });
}

function buildTelegramIssueContext(report) {
  const sourceErrorGroups = buildSourceErrorGroups(report.source_errors);
  const code6Groups =
    Array.isArray(report.code6_candidates) && report.code6_candidates.length > 0
      ? report.code6_candidates
      : buildCode6Candidates(report.execution_summary_by_cdt);
  const code4Groups =
    Array.isArray(report.code4_groups) && report.code4_groups.length > 0
      ? report.code4_groups
      : [];
  const code4AddressKeys = new Set(
    Array.isArray(report.code4_address_keys) ? report.code4_address_keys : [],
  );
  const nonCode4Rows =
    code4AddressKeys.size === 0
      ? report.rows
      : report.rows.filter(
          (row) =>
            !code4AddressKeys.has(
              buildAddressGroupKey(row.cdt_id, row.address),
            ),
        );
  const code5Groups = buildDirectIssueGroupsByCdt(
    nonCode4Rows,
    hasAnyUpdateFail,
    matchesCode5Reason,
  );
  const code7Groups = buildDirectIssueGroupsByCdt(
    report.rows,
    (row) =>
      (row.error_detail || []).some((reason) => matchesCode7Reason(reason)),
    matchesCode7Reason,
  );
  const yellowGroups = buildDirectIssueGroupsByCdt(
    report.rows,
    (row) =>
      (row.error_detail || []).some((reason) =>
        matchesYellowWarningReason(reason),
      ),
    matchesYellowWarningReason,
  );

  return {
    sourceErrorGroups,
    code6Groups,
    code4Groups,
    code5Groups,
    code7Groups,
    yellowGroups,
    code5DetailGroups: buildDetailedIssueGroupsByCdt(
      nonCode4Rows,
      hasAnyUpdateFail,
      matchesCode5Reason,
    ),
    code7DetailGroups: buildDetailedIssueGroupsByCdt(
      report.rows,
      (row) =>
        (row.error_detail || []).some((reason) => matchesCode7Reason(reason)),
      matchesCode7Reason,
    ),
    yellowDetailGroups: buildDetailedIssueGroupsByCdt(
      report.rows,
      (row) =>
        (row.error_detail || []).some((reason) =>
          matchesYellowWarningReason(reason),
        ),
      matchesYellowWarningReason,
    ),
  };
}

function buildTelegramOverviewLines(report, context = {}) {
  const code4Total = (context.code4Groups || []).reduce(
    (total, group) => total + Number(group.affected_buildings || 0),
    0,
  );
  const code5Total = (context.code5Groups || []).reduce(
    (total, group) => total + Number(group.affected_rows || 0),
    0,
  );
  const code7Total = (context.code7Groups || []).reduce(
    (total, group) => total + Number(group.affected_rows || 0),
    0,
  );
  const yellowTotal = (context.yellowGroups || []).reduce(
    (total, group) => total + Number(group.affected_rows || 0),
    0,
  );
  const lines = [
    `[OPENCLAW_STAGE_2] ${report.generated_at}`,
    buildNeedConditionLine(report, context.code6Groups || []),
    `II.A.2: Tổng hợp nhanh = ${
      report.summary_by_cdt.filter(
        (group) => group.status === "WARNING" || group.status === "ERROR",
      ).length
    } CDT có cảnh báo; ${report.tool_status.total_failed_update_rows} phòng không cập nhật được; ${report.total_rooms_without_images} phòng xác nhận không có ảnh; ${report.total_rooms_without_images_unknown} phòng chưa kiểm tra được ảnh.`,
    buildCode1Line(context.sourceErrorGroups || []),
    buildCode6Line(context.code6Groups || [], report.execution_summary_by_cdt),
    `Chi tiết Telegram: Mã 4 = ${code4Total} địa chỉ/tòa; Mã 5 = ${code5Total} phòng; Mã 7 = ${code7Total} phòng; Cảnh báo vàng = ${yellowTotal} phòng.`,
    "Các tin nhắn tiếp theo sẽ tách chi tiết theo CDT, địa chỉ và phòng lỗi để tránh giới hạn ký tự.",
  ];

  return lines;
}

function buildTelegramCdtSummaryMessages(context = {}, options = {}) {
  const summaryMap = new Map();

  function ensureSummary(cdtId, cdtName) {
    const key = buildCdtGroupKey(cdtId, cdtName);
    if (!summaryMap.has(key)) {
      summaryMap.set(key, {
        cdt_id: cdtId,
        cdt_name: cdtName,
        code1: 0,
        code4: 0,
        code5: 0,
        code6: false,
        code7: 0,
        yellow: 0,
      });
    }

    return summaryMap.get(key);
  }

  (context.sourceErrorGroups || []).forEach((group) => {
    ensureSummary(group.cdt_id, group.cdt_name).code1 += Number(
      group.source_error_count || 0,
    );
  });
  (context.code4Groups || []).forEach((group) => {
    ensureSummary(group.cdt_id, group.cdt_name).code4 += Number(
      group.affected_buildings || 0,
    );
  });
  (context.code5Groups || []).forEach((group) => {
    ensureSummary(group.cdt_id, group.cdt_name).code5 += Number(
      group.affected_rows || 0,
    );
  });
  (context.code6Groups || []).forEach((group) => {
    ensureSummary(group.cdt_id, group.cdt_name).code6 = true;
  });
  (context.code7Groups || []).forEach((group) => {
    ensureSummary(group.cdt_id, group.cdt_name).code7 += Number(
      group.affected_rows || 0,
    );
  });
  (context.yellowGroups || []).forEach((group) => {
    ensureSummary(group.cdt_id, group.cdt_name).yellow += Number(
      group.affected_rows || 0,
    );
  });

  const lines = [...summaryMap.values()]
    .filter(
      (item) =>
        item.code1 > 0 ||
        item.code4 > 0 ||
        item.code5 > 0 ||
        item.code6 ||
        item.code7 > 0 ||
        item.yellow > 0,
    )
    .sort((a, b) => {
      const scoreA =
        a.code1 + a.code4 + a.code5 + a.code7 + a.yellow + (a.code6 ? 1 : 0);
      const scoreB =
        b.code1 + b.code4 + b.code5 + b.code7 + b.yellow + (b.code6 ? 1 : 0);
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }

      return String(a.cdt_id ?? "").localeCompare(String(b.cdt_id ?? ""));
    })
    .map((item) => {
      const parts = [];
      if (item.code1 > 0) parts.push(`Mã 1:${item.code1} lỗi nguồn`);
      if (item.code4 > 0) parts.push(`Mã 4:${item.code4} tòa`);
      if (item.code5 > 0) parts.push(`Mã 5:${item.code5} phòng`);
      if (item.code6) parts.push("Mã 6:x0 phòng");
      if (item.code7 > 0) parts.push(`Mã 7:${item.code7} phòng`);
      if (item.yellow > 0) parts.push(`Vàng:${item.yellow} phòng`);
      return `- ${formatCdtRef(item.cdt_id, item.cdt_name)} | ${parts.join(" | ")}`;
    });

  if (lines.length === 0) {
    return [];
  }

  return buildTelegramChunkMessages("TỔNG HỢP THEO CDT:", lines, options);
}

function formatTelegramRoomLine(item = {}, issueLabel = "Lỗi") {
  const address =
    repairVietnameseText(item.address || "") || "(không có địa chỉ)";
  const roomName =
    repairVietnameseText(item.room_name || "") ||
    (item.room_id ? String(item.room_id) : "(không có tên phòng)");
  return `+ ${address} | Phòng: ${roomName} | ${issueLabel}: ${formatTelegramReasonSummary(item.reasons)}`;
}

function buildTelegramGroupedDetailMessages(
  groups = [],
  headerBuilder = () => "",
  lineBuilder = () => "",
  options = {},
) {
  return groups.flatMap((group) =>
    buildTelegramChunkMessages(
      headerBuilder(group),
      (group.items || []).map((item) => lineBuilder(item, group)),
      options,
    ),
  );
}

function buildTelegramProgressMessage(report, options = {}) {
  const context = buildTelegramIssueContext(report);
  const summaryEntry =
    (report.summary_by_cdt || [])[0] ||
    (report.execution_summary_by_cdt || [])[0] ||
    (context.code4Groups || [])[0] ||
    (context.code5Groups || [])[0] ||
    (context.code6Groups || [])[0] ||
    (context.code7Groups || [])[0] ||
    (context.yellowGroups || [])[0] ||
    (context.sourceErrorGroups || [])[0];
  if (!summaryEntry) {
    return "";
  }

  const cdtKey = buildCdtGroupKey(summaryEntry.cdt_id, summaryEntry.cdt_name);
  const sourceErrorGroup = (context.sourceErrorGroups || []).find(
    (group) => buildCdtGroupKey(group.cdt_id, group.cdt_name) === cdtKey,
  );
  const code4Group = (context.code4Groups || []).find(
    (group) => buildCdtGroupKey(group.cdt_id, group.cdt_name) === cdtKey,
  );
  const code5Group = (context.code5Groups || []).find(
    (group) => buildCdtGroupKey(group.cdt_id, group.cdt_name) === cdtKey,
  );
  const code6Group = (context.code6Groups || []).find(
    (group) => buildCdtGroupKey(group.cdt_id, group.cdt_name) === cdtKey,
  );
  const code7Group = (context.code7Groups || []).find(
    (group) => buildCdtGroupKey(group.cdt_id, group.cdt_name) === cdtKey,
  );
  const yellowGroup = (context.yellowGroups || []).find(
    (group) => buildCdtGroupKey(group.cdt_id, group.cdt_name) === cdtKey,
  );
  const executionEntry = (report.execution_summary_by_cdt || []).find(
    (group) => buildCdtGroupKey(group.cdt_id, group.cdt_name) === cdtKey,
  );

  const hasIssue = Boolean(
    sourceErrorGroup ||
    code4Group ||
    code5Group ||
    code6Group ||
    code7Group ||
    yellowGroup,
  );
  if (!hasIssue && !options.includeClean) {
    return "";
  }

  const issueParts = [];
  if (sourceErrorGroup) {
    issueParts.push(`Mã 1:${sourceErrorGroup.source_error_count} lỗi nguồn`);
  }
  if (code4Group) {
    issueParts.push(`Mã 4:${code4Group.affected_buildings} tòa`);
  }
  if (code5Group) {
    issueParts.push(`Mã 5:${code5Group.affected_rows} phòng`);
  }
  if (code6Group) {
    issueParts.push("Mã 6:x0 phòng");
  }
  if (code7Group) {
    issueParts.push(`Mã 7:${code7Group.affected_rows} phòng`);
  }
  if (yellowGroup) {
    issueParts.push(`Vàng:${yellowGroup.affected_rows} phòng`);
  }

  const reasonSummary =
    sourceErrorGroup &&
    Array.isArray(sourceErrorGroup.steps) &&
    sourceErrorGroup.steps.length > 0
      ? `Bước lỗi: ${formatStepSummary(sourceErrorGroup.steps, 3)}.`
      : code5Group &&
          Array.isArray(code5Group.reasons) &&
          code5Group.reasons.length > 0
        ? `Dấu hiệu chính: ${formatRawReasonSummary(code5Group.reasons, 3)}.`
        : code7Group &&
            Array.isArray(code7Group.reasons) &&
            code7Group.reasons.length > 0
          ? `Dấu hiệu chính: ${formatRawReasonSummary(code7Group.reasons, 3)}.`
          : code4Group &&
              Array.isArray(code4Group.reasons) &&
              code4Group.reasons.length > 0
            ? `Dấu hiệu chính: ${formatRawReasonSummary(code4Group.reasons, 3)}.`
            : yellowGroup &&
                Array.isArray(yellowGroup.reasons) &&
                yellowGroup.reasons.length > 0
              ? `Dấu hiệu chính: ${formatRawReasonSummary(yellowGroup.reasons, 3)}.`
              : "";

  const processedSheetText = executionEntry
    ? `${executionEntry.processed_sheet_count}/${executionEntry.configured_sheet_count} sheet`
    : "đã quét xong";
  const priorityActionText = code6Group
    ? "Xác minh CDT hết phòng thật hay tool quét thiếu dữ liệu."
    : `${buildPriorityActionText(report)}.`;
  const lines = [
    `[ROOM_AUDIT_PROGRESS] ${formatCdtRef(summaryEntry.cdt_id, summaryEntry.cdt_name)}`,
    `Đã quét xong ${processedSheetText} | Tổng phòng trống: ${report.total_rows}.`,
    hasIssue
      ? `Kết quả: ${issueParts.join(" | ")}.`
      : "Kết quả: Không ghi nhận mã lỗi nổi bật.",
  ];

  if (reasonSummary) {
    lines.push(reasonSummary);
  }
  if (hasIssue) {
    lines.push(`Hướng ưu tiên: ${priorityActionText}`);
  }

  const maxLength = Number.isFinite(options?.telegramProgressMaxLength)
    ? options.telegramProgressMaxLength
    : 1500;
  return truncateTelegramText(lines.join("\n"), maxLength);
}

function buildTelegramMessages(report, options = {}) {
  const context = buildTelegramIssueContext(report);
  const messages = [];

  messages.push(
    ...buildTelegramChunkMessages("", buildTelegramOverviewLines(report, context), options),
  );
  messages.push(...buildTelegramCdtSummaryMessages(context, options));

  if ((context.sourceErrorGroups || []).length > 0) {
    messages.push(
      ...buildTelegramChunkMessages(
        "MÃ 1 - DANH SÁCH CDT LỖI NGUỒN:",
        context.sourceErrorGroups.map(
          (group) =>
            `+ ${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.source_error_count} lỗi nguồn | Bước: ${formatStepSummary(group.steps, 3)}`,
        ),
        options,
      ),
    );
  }

  if ((context.code6Groups || []).length > 0) {
    messages.push(
      ...buildTelegramChunkMessages(
        "MÃ 6 - CDT KHÔNG CÓ PHÒNG TRỐNG:",
        context.code6Groups.map(
          (group) =>
            `+ ${formatCdtRef(group.cdt_id, group.cdt_name)} | Tổng phòng trống hiện tại = 0 | Cần xác minh hết phòng thật hay tool quét thiếu`,
        ),
        options,
      ),
    );
  }

  messages.push(
    ...(context.code4Groups || []).flatMap((group) =>
      buildTelegramChunkMessages(
        `MÃ 4 - DANH SÁCH ĐỊA CHỈ NGHI THIẾU TÒA (${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.affected_buildings} địa chỉ):`,
        (group.addresses || []).map(
          (address) => `+ ${repairVietnameseText(address)}`,
        ),
        options,
      ),
    ),
  );

  messages.push(
    ...buildTelegramGroupedDetailMessages(
      context.code5DetailGroups || [],
      (group) =>
        `MÃ 5 - DANH SÁCH PHÒNG LỖI CẬP NHẬT/MAPPING (${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.affected_rows} phòng):`,
      (item) => formatTelegramRoomLine(item, "Lỗi"),
      options,
    ),
  );

  messages.push(
    ...buildTelegramGroupedDetailMessages(
      context.code7DetailGroups || [],
      (group) =>
        `MÃ 7 - DANH SÁCH PHÒNG LỖI ẢNH/METADATA (${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.affected_rows} phòng):`,
      (item) => formatTelegramRoomLine(item, "Lỗi ảnh"),
      options,
    ),
  );

  messages.push(
    ...buildTelegramGroupedDetailMessages(
      context.yellowDetailGroups || [],
      (group) =>
        `CẢNH BÁO VÀNG - DANH SÁCH PHÒNG CẦN ĐỐI CHIẾU (${formatCdtRef(group.cdt_id, group.cdt_name)} | ${group.affected_rows} phòng):`,
      (item) => formatTelegramRoomLine(item, "Cảnh báo"),
      options,
    ),
  );

  return messages.filter(Boolean);
}

function buildTelegramMessage(report, options = {}) {
  const messages = buildTelegramMessages(report, options);
  if (messages.length > 0) {
    return messages[0];
  }

  const message = buildBusinessSummaryText(report, options);
  const maxLength = Number.isFinite(options?.telegramMaxLength)
    ? options.telegramMaxLength
    : 3500;
  return truncateTelegramText(message, maxLength);
}

function buildReport({
  rows = [],
  sourceErrors = [],
  executionContext = [],
  options = {},
} = {}) {
  const thresholdHours = Number.isFinite(options?.rule1ThresholdHours)
    ? options.rule1ThresholdHours
    : 24;

  const evaluatedRows = rows.map((row) => {
    let nextRow = applyRule1Update(row, { thresholdHours });
    nextRow = applyRule2MappingError(nextRow);
    nextRow = applyRule3RoomStatus(nextRow);
    nextRow = applyRule4NoImage(nextRow);
    nextRow.error_detail = collectErrorDetail(nextRow);
    return nextRow;
  });
  const enrichedRows = applyBusinessConclusions(evaluatedRows, options);
  const rootCauseSummary = summarizeBusinessConclusions(enrichedRows);
  const totalEmptyRoomsToday = enrichedRows.length;
  const totalRoomsWithoutImages =
    enrichedRows.filter(hasConfirmedNoImage).length;
  const totalRoomsWithoutImagesUnknown =
    enrichedRows.filter(hasUnknownImageState).length;
  const totalFailedUpdateRows = enrichedRows.filter(hasAnyUpdateFail).length;
  const summary = {
    rule1: summarizeRule(enrichedRows, "rule_1_status"),
    rule2: summarizeRule(enrichedRows, "rule_2_status"),
    rule3: summarizeRule(enrichedRows, "rule_3_status"),
    rule4: summarizeRule(enrichedRows, "rule_4_status"),
  };
  const summaryByCdt = buildSummaryByCdt(enrichedRows, sourceErrors);
  const updateErrorsByCdt = buildUpdateErrorsByCdt(summaryByCdt);
  const executionSummaryByCdt = buildExecutionSummaryByCdt(
    executionContext,
    sourceErrors,
  );
  const code6Candidates = buildCode6Candidates(executionSummaryByCdt);
  const code4Detection = buildCode4Detection(enrichedRows);
  const isPartialRun = Number.isFinite(options?.limit);

  const report = {
    generated_at: formatLocalDateTime(new Date()),
    total_rows: enrichedRows.length,
    source_errors: sourceErrors,
    summary,
    reason_summary: countErrorReasons(enrichedRows),
    root_cause_summary: rootCauseSummary,
    business_conclusion_summary: rootCauseSummary,
    cdt_warning_groups: buildCdtWarningGroups(enrichedRows),
    tool_status: buildToolStatus({
      totalEmptyRoomsToday,
      totalFailedUpdateRows,
      totalRoomsWithoutImages,
      totalRoomsWithoutImagesUnknown,
      sourceErrors,
      executionSummaryByCdt,
      summary,
    }),
    update_errors_by_cdt: updateErrorsByCdt,
    total_empty_rooms_today: totalEmptyRoomsToday,
    total_rooms_without_images: totalRoomsWithoutImages,
    total_rooms_without_images_unknown: totalRoomsWithoutImagesUnknown,
    summary_by_cdt: summaryByCdt,
    execution_summary_by_cdt: executionSummaryByCdt,
    code6_candidates: code6Candidates,
    code4_groups: code4Detection.groups,
    code4_address_keys: [...code4Detection.addressKeys],
    is_partial_run: isPartialRun,
    rows: enrichedRows,
  };

  report.business_summary_text = buildBusinessSummaryText(report, options);
  report.daily_sheet_summary = buildDailySheetSummary(report, options);
  report.telegram_short_message =
    report.daily_sheet_summary?.telegram_text || "";
  report.telegram_business_message = truncateTelegramText(
    report.business_summary_text || "",
    Number.isFinite(options?.telegramMaxLength)
      ? options.telegramMaxLength
      : 3500,
  );
  report.openclaw_summary_text = buildDetailedSummaryText(report, options);
  report.technical_report = buildTechnicalReport(report, options);
  report.text_report = buildTextReport(report, options);
  if (options.skipTelegramMessages) {
    report.telegram_messages = [];
    report.telegram_message = truncateTelegramText(
      report.telegram_business_message ||
        report.telegram_short_message ||
        report.business_summary_text ||
        "",
      Number.isFinite(options?.telegramMaxLength)
        ? options.telegramMaxLength
        : 3500,
    );
  } else if (options?.detailedTelegramMessages) {
    report.telegram_messages = buildTelegramMessages(report, options);
    report.telegram_message =
      report.telegram_messages[0] || buildTelegramMessage(report, options);
  } else {
    report.telegram_messages = report.telegram_business_message
      ? [report.telegram_business_message]
      : [];
    report.telegram_message =
      report.telegram_messages[0] || buildTelegramMessage(report, options);
  }
  return report;
}

module.exports = {
  BUSINESS_CONCLUSION,
  buildReport,
  buildTelegramProgressMessage,
  formatLocalDateTime,
};
