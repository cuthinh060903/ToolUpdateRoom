const fs = require("fs").promises;
const path = require("path");
const csv = require("csvtojson");

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

function formatLocalDateTime(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function sanitizeTimestamp(value = "") {
  return value.toString().trim().replace(/[: ]/g, "-");
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return value.toString().trim();
}

function normalizeLabel(value) {
  const normalized = normalizeText(value).toUpperCase();

  if (!normalized) {
    return "";
  }

  if (["TRUE", "T", "1", "YES", "Y"].includes(normalized)) {
    return "TRUE";
  }

  if (["FALSE", "F", "0", "NO", "N"].includes(normalized)) {
    return "FALSE";
  }

  if (["UNSURE", "UNKNOWN", "?", "NA", "N/A"].includes(normalized)) {
    return "UNSURE";
  }

  return normalized;
}

function toPercent(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }

  return Number(((numerator / denominator) * 100).toFixed(2));
}

function toPositivePrediction(value) {
  return normalizeText(value).toUpperCase() === "TRUE";
}

function toRulePositivePrediction(value) {
  return normalizeText(value).toUpperCase() === "FAIL";
}

function summarizeLabels(rows = [], labelField, isPositivePrediction) {
  const summary = {
    total_rows: rows.length,
    predicted_positive_rows: 0,
    predicted_negative_rows: 0,
    reviewed_rows: 0,
    correct_rows: 0,
    incorrect_rows: 0,
    unsure_rows: 0,
    unlabeled_rows: 0,
    reviewed_positive_rows: 0,
    reviewed_negative_rows: 0,
    positive_correct_rows: 0,
    positive_incorrect_rows: 0,
    negative_correct_rows: 0,
    negative_incorrect_rows: 0,
    decision_accuracy_pct: null,
    positive_decision_accuracy_pct: null,
    negative_decision_accuracy_pct: null,
  };

  rows.forEach((row) => {
    const predictedPositive = isPositivePrediction(row);
    const label = normalizeLabel(row[labelField]);

    if (predictedPositive) {
      summary.predicted_positive_rows += 1;
    } else {
      summary.predicted_negative_rows += 1;
    }

    if (label === "TRUE") {
      summary.reviewed_rows += 1;
      summary.correct_rows += 1;
      if (predictedPositive) {
        summary.reviewed_positive_rows += 1;
        summary.positive_correct_rows += 1;
      } else {
        summary.reviewed_negative_rows += 1;
        summary.negative_correct_rows += 1;
      }
      return;
    }

    if (label === "FALSE") {
      summary.reviewed_rows += 1;
      summary.incorrect_rows += 1;
      if (predictedPositive) {
        summary.reviewed_positive_rows += 1;
        summary.positive_incorrect_rows += 1;
      } else {
        summary.reviewed_negative_rows += 1;
        summary.negative_incorrect_rows += 1;
      }
      return;
    }

    if (label === "UNSURE") {
      summary.unsure_rows += 1;
      return;
    }

    summary.unlabeled_rows += 1;
  });

  summary.decision_accuracy_pct = toPercent(
    summary.correct_rows,
    summary.reviewed_rows,
  );
  summary.positive_decision_accuracy_pct = toPercent(
    summary.positive_correct_rows,
    summary.reviewed_positive_rows,
  );
  summary.negative_decision_accuracy_pct = toPercent(
    summary.negative_correct_rows,
    summary.reviewed_negative_rows,
  );

  return summary;
}

function buildFollowUpRows(rows = [], limit = 20) {
  return rows
    .filter((row) => {
      const labels = [
        normalizeLabel(row.label_warning),
        normalizeLabel(row.label_rule_1),
        normalizeLabel(row.label_rule_2),
        normalizeLabel(row.label_rule_3),
        normalizeLabel(row.label_rule_4),
      ];

      return labels.some((label) => label === "FALSE" || label === "UNSURE");
    })
    .slice(0, limit)
    .map((row) => ({
      review_id: row.review_id || "",
      cdt_id: row.cdt_id || "",
      cdt_name: row.cdt_name || "",
      room_name: row.room_name || "",
      address: row.address || "",
      predicted_warning: row.predicted_warning || "",
      label_warning: normalizeLabel(row.label_warning),
      label_rule_1: normalizeLabel(row.label_rule_1),
      label_rule_2: normalizeLabel(row.label_rule_2),
      label_rule_3: normalizeLabel(row.label_rule_3),
      label_rule_4: normalizeLabel(row.label_rule_4),
      reviewer_notes: row.reviewer_notes || "",
    }));
}

function buildScoreReport(reviewRows = [], options = {}) {
  return {
    generated_at: formatLocalDateTime(new Date()),
    source_review_file: options.sourceReviewFile || "",
    total_rows: reviewRows.length,
    summary: {
      warning: summarizeLabels(
        reviewRows,
        "label_warning",
        (row) => toPositivePrediction(row.predicted_warning),
      ),
      rule1: summarizeLabels(
        reviewRows,
        "label_rule_1",
        (row) => toRulePositivePrediction(row.rule_1_status),
      ),
      rule2: summarizeLabels(
        reviewRows,
        "label_rule_2",
        (row) => toRulePositivePrediction(row.rule_2_status),
      ),
      rule3: summarizeLabels(
        reviewRows,
        "label_rule_3",
        (row) => toRulePositivePrediction(row.rule_3_status),
      ),
      rule4: summarizeLabels(
        reviewRows,
        "label_rule_4",
        (row) => toRulePositivePrediction(row.rule_4_status),
      ),
    },
    follow_up_rows: buildFollowUpRows(reviewRows, options.followUpLimit || 20),
  };
}

function buildMetricLines(label, metric = {}) {
  return [
    `## ${label}`,
    "",
    `- Reviewed rows: ${metric.reviewed_rows}`,
    `- Correct rows: ${metric.correct_rows}`,
    `- Incorrect rows: ${metric.incorrect_rows}`,
    `- Unsure rows: ${metric.unsure_rows}`,
    `- Unlabeled rows: ${metric.unlabeled_rows}`,
    `- Decision accuracy: ${
      metric.decision_accuracy_pct === null
        ? "N/A"
        : `${metric.decision_accuracy_pct}%`
    }`,
    `- Reviewed predicted positive rows: ${metric.reviewed_positive_rows}`,
    `- Reviewed predicted negative rows: ${metric.reviewed_negative_rows}`,
    `- Positive decision accuracy: ${
      metric.positive_decision_accuracy_pct === null
        ? "N/A"
        : `${metric.positive_decision_accuracy_pct}%`
    }`,
    `- Negative decision accuracy: ${
      metric.negative_decision_accuracy_pct === null
        ? "N/A"
        : `${metric.negative_decision_accuracy_pct}%`
    }`,
    "",
  ];
}

function buildScoreMarkdown(report) {
  const lines = [
    "# Room Audit Review Result",
    "",
    `- Generated at: ${report.generated_at}`,
    `- Source review file: ${report.source_review_file || "(trong)"}`,
    `- Total rows in review file: ${report.total_rows}`,
    "",
    ...buildMetricLines("Overall Warning", report.summary.warning),
    ...buildMetricLines("Rule 1", report.summary.rule1),
    ...buildMetricLines("Rule 2", report.summary.rule2),
    ...buildMetricLines("Rule 3", report.summary.rule3),
    ...buildMetricLines("Rule 4", report.summary.rule4),
  ];

  if (report.summary.warning.reviewed_rows === 0) {
    lines.push("## Note");
    lines.push("");
    lines.push("- Chua co dong nao duoc gan nhan TRUE/FALSE. Hay dien CSV roi chay lai script nay.");
    lines.push("");
  }

  lines.push("## Follow-up Rows");
  lines.push("");

  if (!Array.isArray(report.follow_up_rows) || report.follow_up_rows.length === 0) {
    lines.push("- Khong co dong nao bi danh dau FALSE hoac UNSURE.");
    lines.push("");
    return lines.join("\n");
  }

  report.follow_up_rows.forEach((row) => {
    lines.push(
      `- #${row.review_id} | CDT ${row.cdt_id} ${row.cdt_name} | ${row.room_name} | warning=${row.label_warning || "(trong)"} | r1=${row.label_rule_1 || "(trong)"} | r2=${row.label_rule_2 || "(trong)"} | r3=${row.label_rule_3 || "(trong)"} | r4=${row.label_rule_4 || "(trong)"} | note=${row.reviewer_notes || "(trong)"}`,
    );
  });

  lines.push("");
  return lines.join("\n");
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadReviewRows(inputPath) {
  const rows = await csv().fromFile(inputPath);
  return rows.map((row) => ({
    ...row,
    label_warning: normalizeLabel(row.label_warning),
    label_rule_1: normalizeLabel(row.label_rule_1),
    label_rule_2: normalizeLabel(row.label_rule_2),
    label_rule_3: normalizeLabel(row.label_rule_3),
    label_rule_4: normalizeLabel(row.label_rule_4),
  }));
}

async function scoreReviewSample(options = {}) {
  const rootDir = path.resolve(__dirname, "../..");
  const defaultInput = path.join(
    "reports",
    "room-audit",
    "latest-room-audit-review.csv",
  );
  const inputPath = path.resolve(rootDir, options.inputPath || defaultInput);
  const outputDir = path.resolve(
    rootDir,
    options.outputDir || path.join("reports", "room-audit"),
  );
  const reviewRows = await loadReviewRows(inputPath);
  const report = buildScoreReport(reviewRows, {
    sourceReviewFile: inputPath,
    followUpLimit: options.followUpLimit,
  });
  const timestamp = sanitizeTimestamp(report.generated_at);
  const jsonPath = path.join(outputDir, `room-audit-review-result-${timestamp}.json`);
  const mdPath = path.join(outputDir, `room-audit-review-result-${timestamp}.md`);
  const latestJsonPath = path.join(outputDir, "latest-room-audit-review-result.json");
  const latestMdPath = path.join(outputDir, "latest-room-audit-review-result.md");
  const markdownContent = buildScoreMarkdown(report);

  await ensureDirectory(outputDir);
  await Promise.all([
    fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8"),
    fs.writeFile(mdPath, markdownContent, "utf8"),
    fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8"),
    fs.writeFile(latestMdPath, markdownContent, "utf8"),
  ]);

  return {
    report,
    output: {
      jsonPath,
      mdPath,
      latestJsonPath,
      latestMdPath,
    },
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  scoreReviewSample({
    inputPath: args.input,
    outputDir: args["output-dir"],
    followUpLimit: Number.isFinite(Number(args["follow-up-limit"]))
      ? Number(args["follow-up-limit"])
      : 20,
  })
    .then(({ report, output }) => {
      console.log(
        `[room-audit-review-score] Reviewed warning rows: ${report.summary.warning.reviewed_rows}`,
      );
      console.log(
        `[room-audit-review-score] Warning accuracy: ${
          report.summary.warning.decision_accuracy_pct === null
            ? "N/A"
            : `${report.summary.warning.decision_accuracy_pct}%`
        }`,
      );
      console.log(`[room-audit-review-score] JSON: ${output.jsonPath}`);
      console.log(`[room-audit-review-score] Markdown: ${output.mdPath}`);
      console.log(
        `[room-audit-review-score] Latest JSON: ${output.latestJsonPath}`,
      );
      console.log(
        `[room-audit-review-score] Latest Markdown: ${output.latestMdPath}`,
      );
    })
    .catch((error) => {
      console.error(
        "[room-audit-review-score] Score failed:",
        error?.message || error,
      );
      process.exitCode = 1;
    });
}

module.exports = {
  buildScoreReport,
  buildScoreMarkdown,
  loadReviewRows,
  normalizeLabel,
  scoreReviewSample,
  summarizeLabels,
};
