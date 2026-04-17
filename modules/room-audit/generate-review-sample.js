const fs = require("fs").promises;
const path = require("path");

function parseArgs(argv = []) {
  const parsed = {};

  argv.forEach((arg) => {
    if (!arg.startsWith("--")) {
      return;
    }

    const [rawKey, rawValue] = arg.slice(2).split("=");
    parsed[rawKey] = rawValue === undefined ? true : rawValue;
  });

  return parsed;
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "y"].includes(value.toString().toLowerCase());
}

function parseNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeTimestamp(value = "") {
  return value.toString().trim().replace(/[: ]/g, "-");
}

function hasAnyFail(row = {}) {
  return (
    row.rule_1_status === "FAIL" ||
    row.rule_2_status === "FAIL" ||
    row.rule_3_status === "FAIL" ||
    row.rule_4_status === "FAIL"
  );
}

function formatReasons(reasons = []) {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return "";
  }

  return reasons.join(" | ");
}

function csvEscape(value) {
  const stringValue =
    value === null || value === undefined ? "" : value.toString();

  if (
    stringValue.includes(",") ||
    stringValue.includes('"') ||
    stringValue.includes("\n") ||
    stringValue.includes("\r")
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function escapeTableCell(value) {
  return (value === null || value === undefined ? "" : value.toString())
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function buildReviewRows(report, options = {}) {
  const sampleSize = Number.isFinite(options.sampleSize)
    ? options.sampleSize
    : 50;
  const includePassRows = toBoolean(options.includePassRows, true);
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const warningRows = rows.filter(hasAnyFail);
  const cleanRows = rows.filter((row) => !hasAnyFail(row));
  const orderedRows = includePassRows
    ? [...warningRows, ...cleanRows]
    : warningRows;

  return orderedRows.slice(0, sampleSize).map((row, index) => ({
    review_id: index + 1,
    predicted_warning: hasAnyFail(row) ? "TRUE" : "FALSE",
    cdt_id: row.cdt_id ?? "",
    cdt_name: row.cdt_name || "",
    sheet_gid: row.sheet_gid ?? "",
    room_name: row.room_name || "",
    address: row.address || "",
    status: row.status || "",
    rule_1_status: row.rule_1_status || "",
    rule_2_status: row.rule_2_status || "",
    rule_3_status: row.rule_3_status || "",
    rule_4_status: row.rule_4_status || "",
    rule_1_reason: formatReasons(row.rule_1_reason),
    rule_2_reason: formatReasons(row.rule_2_reason),
    rule_3_reason: formatReasons(row.rule_3_reason),
    rule_4_reason: formatReasons(row.rule_4_reason),
    business_conclusion: row.business_conclusion || "",
    business_conclusion_note: row.business_conclusion_note || "",
    last_updated_source: row.last_updated_source || "",
    rule_1_reference_source: row.rule_1_reference_source || "",
    rule_1_age_hours:
      row.rule_1_age_hours === null || row.rule_1_age_hours === undefined
        ? ""
        : row.rule_1_age_hours,
    image_count:
      row.image_count === null || row.image_count === undefined
        ? ""
        : row.image_count,
    label_warning: "",
    label_rule_1: "",
    label_rule_2: "",
    label_rule_3: "",
    label_rule_4: "",
    reviewer_notes: "",
  }));
}

function buildReviewCsv(reviewRows = []) {
  const header = [
    "review_id",
    "predicted_warning",
    "cdt_id",
    "cdt_name",
    "sheet_gid",
    "room_name",
    "address",
    "status",
    "rule_1_status",
    "rule_2_status",
    "rule_3_status",
    "rule_4_status",
    "rule_1_reason",
    "rule_2_reason",
    "rule_3_reason",
    "rule_4_reason",
    "business_conclusion",
    "business_conclusion_note",
    "last_updated_source",
    "rule_1_reference_source",
    "rule_1_age_hours",
    "image_count",
    "label_warning",
    "label_rule_1",
    "label_rule_2",
    "label_rule_3",
    "label_rule_4",
    "reviewer_notes",
  ];

  const lines = [
    header.join(","),
    ...reviewRows.map((row) =>
      header.map((column) => csvEscape(row[column])).join(","),
    ),
  ];

  return lines.join("\n");
}

function buildSummaryLine(label, value) {
  return `- ${label}: ${value}`;
}

function buildReviewMarkdown(report, reviewRows, options = {}) {
  const inputPath = options.inputPath || "";
  const warningCount = reviewRows.filter(
    (row) => row.predicted_warning === "TRUE",
  ).length;
  const cleanCount = reviewRows.length - warningCount;

  const lines = [
    "# Room Audit Review Sample",
    "",
    buildSummaryLine("Nguon report", inputPath || "latest-room-audit.json"),
    buildSummaryLine("Report generated_at", report.generated_at || ""),
    buildSummaryLine("Tong so dong trong report", report.total_rows || 0),
    buildSummaryLine("So dong dua vao review", reviewRows.length),
    buildSummaryLine("Dong co canh bao", warningCount),
    buildSummaryLine("Dong khong canh bao", cleanCount),
    "",
    "## Cach review",
    "",
    "- Mo file CSV cung ten de dien nhan.",
    "- Dung 1 trong 3 gia tri: `TRUE`, `FALSE`, `UNSURE`.",
    "- `label_warning`: canh bao tong the cua dong co dung hay khong.",
    "- `label_rule_1` ... `label_rule_4`: danh gia tung rule.",
    "- Neu chua du thong tin thi de `UNSURE` va ghi ly do vao `reviewer_notes`.",
    "",
    "## Mau review",
    "",
  ];

  reviewRows.forEach((row) => {
    lines.push(`### ${row.review_id}. CDT ${row.cdt_id} | ${row.room_name || "(khong co ten phong)"}`);
    lines.push("");
    lines.push(buildSummaryLine("Dia chi", row.address || "(trong)"));
    lines.push(buildSummaryLine("Predicted warning", row.predicted_warning));
    lines.push(buildSummaryLine("Trang thai web", row.status || "(trong)"));
    lines.push(buildSummaryLine("Rule 1", `${row.rule_1_status} ${row.rule_1_reason ? `| ${row.rule_1_reason}` : ""}`.trim()));
    lines.push(buildSummaryLine("Rule 2", `${row.rule_2_status} ${row.rule_2_reason ? `| ${row.rule_2_reason}` : ""}`.trim()));
    lines.push(buildSummaryLine("Rule 3", `${row.rule_3_status} ${row.rule_3_reason ? `| ${row.rule_3_reason}` : ""}`.trim()));
    lines.push(buildSummaryLine("Rule 4", `${row.rule_4_status} ${row.rule_4_reason ? `| ${row.rule_4_reason}` : ""}`.trim()));
    lines.push(
      buildSummaryLine(
        "Ket luan business",
        row.business_conclusion
          ? `${row.business_conclusion}${row.business_conclusion_note ? ` | ${row.business_conclusion_note}` : ""}`
          : "(trong)",
      ),
    );
    lines.push(buildSummaryLine("Freshness source", row.rule_1_reference_source || row.last_updated_source || "(trong)"));
    lines.push(buildSummaryLine("Freshness age hours", row.rule_1_age_hours || "(trong)"));
    lines.push(buildSummaryLine("Image count", row.image_count || "(trong)"));
    lines.push("");
  });

  return lines.join("\n");
}

function buildWarningBusinessReviewMarkdown(report, reviewRows = []) {
  const warningRows = reviewRows.filter((row) => row.predicted_warning === "TRUE");
  const lines = [
    "# Room Audit Warning Review",
    "",
    buildSummaryLine("Report generated_at", report.generated_at || ""),
    buildSummaryLine("Warning rows", warningRows.length),
    "",
  ];

  if (warningRows.length === 0) {
    lines.push("- Khong co row canh bao.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| # | CDT | Room | Address | Rule 2 | Rule 3 | Business | Note |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  warningRows.forEach((row) => {
    lines.push(
      `| ${escapeTableCell(row.review_id)} | ${escapeTableCell(row.cdt_id)} | ${escapeTableCell(row.room_name || "(trong)")} | ${escapeTableCell(row.address || "(trong)")} | ${escapeTableCell(row.rule_2_reason || "(trong)")} | ${escapeTableCell(row.rule_3_reason || "(trong)")} | ${escapeTableCell(row.business_conclusion || "(trong)")} | ${escapeTableCell(row.business_conclusion_note || "(trong)")} |`,
    );
  });
  lines.push("");

  return lines.join("\n");
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function generateReviewSample(options = {}) {
  const rootDir = path.resolve(__dirname, "../..");
  const reportDir = path.join(rootDir, "reports", "room-audit");
  const inputPath = path.resolve(
    rootDir,
    options.inputPath || path.join("reports", "room-audit", "latest-room-audit.json"),
  );
  const outputDir = path.resolve(rootDir, options.outputDir || reportDir);
  const content = await fs.readFile(inputPath, "utf8");
  const report = JSON.parse(content);
  const reviewRows = buildReviewRows(report, options);
  const timestamp = sanitizeTimestamp(report.generated_at || new Date().toISOString());
  const csvPath = path.join(outputDir, `room-audit-review-${timestamp}.csv`);
  const mdPath = path.join(outputDir, `room-audit-review-${timestamp}.md`);
  const warningMdPath = path.join(
    outputDir,
    `room-audit-warning-review-${timestamp}.md`,
  );
  const latestCsvPath = path.join(outputDir, "latest-room-audit-review.csv");
  const latestMdPath = path.join(outputDir, "latest-room-audit-review.md");
  const latestWarningMdPath = path.join(
    outputDir,
    "latest-room-audit-warning-review.md",
  );
  const csvContent = buildReviewCsv(reviewRows);
  const markdownContent = buildReviewMarkdown(report, reviewRows, { inputPath });
  const warningMarkdownContent = buildWarningBusinessReviewMarkdown(
    report,
    reviewRows,
  );

  await ensureDirectory(outputDir);
  await Promise.all([
    fs.writeFile(csvPath, csvContent, "utf8"),
    fs.writeFile(mdPath, markdownContent, "utf8"),
    fs.writeFile(warningMdPath, warningMarkdownContent, "utf8"),
    fs.writeFile(latestCsvPath, csvContent, "utf8"),
    fs.writeFile(latestMdPath, markdownContent, "utf8"),
    fs.writeFile(latestWarningMdPath, warningMarkdownContent, "utf8"),
  ]);

  return {
    report,
    reviewRows,
    output: {
      csvPath,
      mdPath,
      warningMdPath,
      latestCsvPath,
      latestMdPath,
      latestWarningMdPath,
    },
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  generateReviewSample({
    inputPath: args.input,
    outputDir: args["output-dir"],
    sampleSize: parseNumber(args.limit, 50),
    includePassRows: toBoolean(args["include-pass-rows"], true),
  })
    .then(({ reviewRows, output, report }) => {
      console.log(`[room-audit-review] Source report: ${report.generated_at}`);
      console.log(`[room-audit-review] Rows in sample: ${reviewRows.length}`);
      console.log(`[room-audit-review] CSV: ${output.csvPath}`);
      console.log(`[room-audit-review] Markdown: ${output.mdPath}`);
      console.log(`[room-audit-review] Warning Markdown: ${output.warningMdPath}`);
      console.log(`[room-audit-review] Latest CSV: ${output.latestCsvPath}`);
      console.log(`[room-audit-review] Latest Markdown: ${output.latestMdPath}`);
      console.log(
        `[room-audit-review] Latest Warning Markdown: ${output.latestWarningMdPath}`,
      );
    })
    .catch((error) => {
      console.error(
        "[room-audit-review] Generate failed:",
        error?.message || error,
      );
      process.exitCode = 1;
    });
}

module.exports = {
  buildReviewRows,
  buildReviewCsv,
  buildReviewMarkdown,
  buildWarningBusinessReviewMarkdown,
  generateReviewSample,
};
