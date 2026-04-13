const { applyRule1Update } = require("./rule1-update");
const { applyRule2MappingError } = require("./rule2-mapping-error");
const { applyRule3RoomStatus } = require("./rule3-room-status");
const { applyRule4NoImage } = require("./rule4-no-image");

function collectErrorDetail(row) {
  return [
    ...(row.rule_1_reason || []),
    ...(row.rule_2_reason || []),
    ...(row.rule_3_reason || []),
    ...(row.rule_4_reason || []),
  ];
}

function hasAnyFail(row) {
  return (
    row.rule_1_status === "FAIL" ||
    row.rule_2_status === "FAIL" ||
    row.rule_3_status === "FAIL" ||
    row.rule_4_status === "FAIL"
  );
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

function buildTextReport(report, options = {}) {
  const lines = [
    ...buildOverviewLines(report),
    ...buildTopReasonLines(report, options),
    ...buildCdtLines(report, options),
  ];

  return lines.join("\n");
}

function buildTelegramMessage(report, options = {}) {
  const message = buildTextReport(report, options);
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

  const report = {
    generated_at: new Date().toISOString(),
    total_rows: evaluatedRows.length,
    source_errors: sourceErrors,
    summary: {
      rule1: summarizeRule(evaluatedRows, "rule_1_status"),
      rule2: summarizeRule(evaluatedRows, "rule_2_status"),
      rule3: summarizeRule(evaluatedRows, "rule_3_status"),
      rule4: summarizeRule(evaluatedRows, "rule_4_status"),
    },
    reason_summary: countErrorReasons(evaluatedRows),
    cdt_warning_groups: buildCdtWarningGroups(evaluatedRows),
    rows: evaluatedRows,
  };

  report.text_report = buildTextReport(report, options);
  report.telegram_message = buildTelegramMessage(report, options);
  return report;
}

module.exports = {
  buildReport,
};
