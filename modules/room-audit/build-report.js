const fs = require("fs");
const path = require("path");
const { applyRule1Update } = require("./rule1-update");
const { applyRule2MappingError } = require("./rule2-mapping-error");
const { applyRule3RoomStatus } = require("./rule3-room-status");
const { applyRule4NoImage } = require("./rule4-no-image");
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
  return value.toString().trim().toLowerCase();
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
        business_conclusion_source: override.business_conclusion_source || "override",
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
      sourceError?.source,
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

function buildToolStatus({
  totalEmptyRoomsToday = 0,
  totalFailedUpdateRows = 0,
  totalRoomsWithoutImages = 0,
  totalRoomsWithoutImagesUnknown = 0,
  sourceErrors = [],
  summary = {},
} = {}) {
  const sourceErrorCount = Array.isArray(sourceErrors) ? sourceErrors.length : 0;
  const ran = totalEmptyRoomsToday > 0 || sourceErrorCount > 0;
  let status = "OK";
  let message = "Tool da chay binh thuong.";

  if (!ran) {
    status = "NO_DATA";
    message = "Tool da chay nhung khong co phong trong nao trong report.";
  } else if (totalEmptyRoomsToday === 0 && sourceErrorCount > 0) {
    status = "ERROR";
    message = "Tool da chay nhung khong doc duoc du lieu phong trong.";
  } else if (
    totalEmptyRoomsToday > 0 &&
    totalFailedUpdateRows === totalEmptyRoomsToday
  ) {
    status = "ERROR";
    message = `Tool da chay nhung ${totalFailedUpdateRows}/${totalEmptyRoomsToday} phong deu gap loi cap nhat.`;
  } else if (
    sourceErrorCount > 0 ||
    totalFailedUpdateRows > 0 ||
    totalRoomsWithoutImages > 0 ||
    totalRoomsWithoutImagesUnknown > 0 ||
    (summary?.rule1?.FAIL || 0) > 0
  ) {
    status = "WARNING";
    message = `Tool da chay, audit ${totalEmptyRoomsToday} phong. Co ${totalFailedUpdateRows} phong loi cap nhat, ${totalRoomsWithoutImages} phong khong co anh, ${totalRoomsWithoutImagesUnknown} phong chua xac dinh anh.`;
  } else {
    status = "OK";
    message = `Tool da chay, audit ${totalEmptyRoomsToday} phong va khong ghi nhan loi business.`;
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
    `Tong phong: ${report.total_rows} | Co canh bao: ${warningRows.length} | Loi nguon: ${report.source_errors.length}`,
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
    "Top loi:",
    ...topReasons.map((item) => `- ${item.reason}: ${item.count}`),
  ];
}

function buildBusinessConclusionLines(report) {
  const summary = report.root_cause_summary || report.business_conclusion_summary || {};
  const entries = Object.entries(summary).filter(([, count]) => count > 0);

  if (entries.length === 0) {
    return [];
  }

  return [
    "Root cause:",
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
    "CDT canh bao:",
    ...groups.map(
      (group) =>
        `- CDT ${group.cdt_id} (${group.cdt_name}): ${group.total_fail_rows} phong | R1:${group.rule1_fail} R2:${group.rule2_fail} R3:${group.rule3_fail} R4:${group.rule4_fail}`,
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
    return "CHUA GHI NHAN TOOL DA CHAY";
  }

  if (status === "OK") {
    return "DA CHAY, BINH THUONG";
  }

  if (status === "WARNING") {
    return "DA CHAY, CO CANH BAO";
  }

  if (status === "ERROR") {
    return "DA CHAY, CO LOI";
  }

  if (status === "NO_DATA") {
    return "DA CHAY, KHONG CO DU LIEU";
  }

  return "DA CHAY, CHUA XAC DINH";
}

function formatCdtStatusLabel(status = "") {
  if (status === "OK") {
    return "ON";
  }

  if (status === "WARNING") {
    return "CO CANH BAO";
  }

  if (status === "ERROR") {
    return "LOI";
  }

  if (status === "NO_DATA") {
    return "KHONG CO DU LIEU";
  }

  return "CHUA XAC DINH";
}

const BUSINESS_REASON_LABELS = {
  ADDRESS_MISMATCH_LOGGED: "Lech dia chi",
  BUILDING_NOT_FOUND: "Khong tim thay toa nha",
  BUILDING_NOT_MATCHED: "Khong match duoc toa nha",
  IMAGE_COUNT_NOT_CHECKED: "Chua kiem tra duoc anh",
  UPDATED_AT_MISSING: "Thieu thoi gian cap nhat",
  SHEET_ROOM_NOT_UPDATED_TO_EMPTY: "Phong chua cap nhat duoc trang thai trong",
};

function formatBusinessReasonLabel(reason = "") {
  if (!reason) {
    return "";
  }

  return BUSINESS_REASON_LABELS[reason] || reason;
}

function formatReasonList(reasonList = []) {
  if (!Array.isArray(reasonList) || reasonList.length === 0) {
    return "Khong ghi nhan loi noi bat";
  }

  return reasonList
    .map((item) =>
      `${formatBusinessReasonLabel(item.reason || item.step)} (${item.count})`,
    )
    .join(", ");
}

function buildBusinessSummaryLines(report, options = {}) {
  const cdtLimit = Number.isFinite(options?.businessCdtLimit)
    ? options.businessCdtLimit
    : 10;
  const errorCdtLimit = Number.isFinite(options?.businessErrorCdtLimit)
    ? options.businessErrorCdtLimit
    : 10;
  const reasonLimit = Number.isFinite(options?.businessReasonLimit)
    ? options.businessReasonLimit
    : 5;
  const updateErrorGroups = report.update_errors_by_cdt.slice(0, errorCdtLimit);
  const summaryGroups = report.summary_by_cdt.slice(0, cdtLimit);
  const attentionGroups = summaryGroups.filter(
    (group) => group.status === "WARNING" || group.status === "ERROR",
  );
  const topReasons = report.reason_summary.slice(0, reasonLimit);
  const cdtWithUpdateErrors = updateErrorGroups.filter(
    (group) => group.failed_update_rows > 0 || group.source_error_count > 0,
  ).length;
  const totalFailedUpdateRows =
    report.tool_status?.total_failed_update_rows ||
    updateErrorGroups.reduce(
      (total, group) => total + (group.failed_update_rows || 0),
      0,
    );
  const lines = [
    `[ROOM_AUDIT_BUSINESS] ${report.generated_at}`,
    `Trang thai tool: ${formatToolStatusLabel(report.tool_status.status, report.tool_status.ran)}`,
    report.is_partial_run
      ? "Pham vi bao cao: Trong pham vi chay hien tai."
      : "Pham vi bao cao: Toan bo du lieu trong lan chay hien tai.",
    `Tong so phong trong hom nay: ${report.total_empty_rooms_today} phong`,
    `Phong khong co anh: ${report.total_rooms_without_images} phong`,
    `Phong chua kiem tra duoc anh: ${report.total_rooms_without_images_unknown} phong`,
  ];

  if (cdtWithUpdateErrors > 0 || totalFailedUpdateRows > 0) {
    lines.push(
      `Tinh hinh cap nhat: Co ${cdtWithUpdateErrors} CDT co loi, tong cong ${totalFailedUpdateRows} phong khong cap nhat duoc.`,
    );
  } else {
    lines.push(
      "Tinh hinh cap nhat: Khong ghi nhan CDT nao co phong khong cap nhat duoc.",
    );
  }

  lines.push("");
  lines.push("Loi chinh:");
  if (topReasons.length > 0) {
    topReasons.forEach((item) => {
      lines.push(
        `- ${formatBusinessReasonLabel(item.reason)}: ${item.count} phong`,
      );
    });
  } else {
    lines.push("- Khong ghi nhan loi noi bat.");
  }

  lines.push("");
  lines.push("CDT can chu y:");
  if (attentionGroups.length > 0) {
    attentionGroups.forEach((group) => {
      lines.push(
        `- CDT ${group.cdt_id} (${group.cdt_name}): ${formatCdtStatusLabel(group.status)} | ${group.failed_update_rows} phong khong cap nhat duoc | ${group.rooms_without_images} phong khong co anh | ${group.rooms_without_images_unknown} phong chua kiem tra duoc anh | Loi chinh: ${formatReasonList(group.top_update_error_reasons)}`,
      );
    });
  } else {
    lines.push("- Khong co CDT nao can chu y.");
  }

  if (summaryGroups.length > 0) {
    lines.push("");
    lines.push("Tong quan theo CDT:");
    summaryGroups.forEach((group) => {
      lines.push(
        `- CDT ${group.cdt_id} (${group.cdt_name}): ${formatCdtStatusLabel(group.status)} | ${group.total_empty_rooms_today} phong trong | ${group.failed_update_rows} phong khong cap nhat duoc | ${group.rooms_without_images} phong khong co anh | ${group.rooms_without_images_unknown} phong chua kiem tra duoc anh`,
      );
    });
  }

  return lines;
}

function buildBusinessSummaryText(report, options = {}) {
  return buildBusinessSummaryLines(report, options).join("\n");
}

function buildTextReport(report, options = {}) {
  const businessSummaryText = buildBusinessSummaryText(report, options);
  const technicalReport = buildTechnicalReport(report, options);

  if (!technicalReport) {
    return businessSummaryText;
  }

  return [businessSummaryText, "", "Technical detail:", technicalReport].join(
    "\n",
  );
}

function buildTelegramMessage(report, options = {}) {
  const message = buildBusinessSummaryText(report, options);
  const maxLength = Number.isFinite(options?.telegramMaxLength)
    ? options.telegramMaxLength
    : 3500;

  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength - 14)}\n...[truncated]`;
}

function buildReport({ rows = [], sourceErrors = [], options = {} } = {}) {
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
  const totalRoomsWithoutImages = enrichedRows.filter(hasConfirmedNoImage).length;
  const totalRoomsWithoutImagesUnknown = enrichedRows.filter(
    hasUnknownImageState,
  ).length;
  const totalFailedUpdateRows = enrichedRows.filter(hasAnyUpdateFail).length;
  const summary = {
    rule1: summarizeRule(enrichedRows, "rule_1_status"),
    rule2: summarizeRule(enrichedRows, "rule_2_status"),
    rule3: summarizeRule(enrichedRows, "rule_3_status"),
    rule4: summarizeRule(enrichedRows, "rule_4_status"),
  };
  const summaryByCdt = buildSummaryByCdt(enrichedRows, sourceErrors);
  const updateErrorsByCdt = buildUpdateErrorsByCdt(summaryByCdt);
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
      summary,
    }),
    update_errors_by_cdt: updateErrorsByCdt,
    total_empty_rooms_today: totalEmptyRoomsToday,
    total_rooms_without_images: totalRoomsWithoutImages,
    total_rooms_without_images_unknown: totalRoomsWithoutImagesUnknown,
    summary_by_cdt: summaryByCdt,
    is_partial_run: isPartialRun,
    rows: enrichedRows,
  };

  report.business_summary_text = buildBusinessSummaryText(report, options);
  report.technical_report = buildTechnicalReport(report, options);
  report.text_report = buildTextReport(report, options);
  report.telegram_message = buildTelegramMessage(report, options);
  return report;
}

module.exports = {
  BUSINESS_CONCLUSION,
  buildReport,
  formatLocalDateTime,
};
