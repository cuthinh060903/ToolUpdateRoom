const { runMainFlow } = require("../index");
const { runAuditFlow } = require("../modules/room-audit");

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

function parseOnlyIds(value) {
  return (value || "")
    .toString()
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function normalizeRunContext(value = "") {
  return value.toString().trim().toLowerCase() === "manual"
    ? "manual"
    : "daily";
}

function buildCombinedOptions(argv = [], env = process.env) {
  const args = parseArgs(argv);
  const skipAll = toBoolean(args["skip-all"], false);
  const runContext = normalizeRunContext(
    args["run-context"] ??
      env.TOOL_RUN_CONTEXT ??
      env.ROOM_AUDIT_RUN_CONTEXT ??
      "daily",
  );

  return {
    runContext,
    skipMain: skipAll || toBoolean(args["skip-main"], false),
    skipRoomAudit: skipAll || toBoolean(args["skip-room-audit"], false),
    roomAudit: {
      runContext,
      useApi: toBoolean(
        args["room-audit-use-api"] ?? env.ROOM_AUDIT_USE_API,
        true,
      ),
      limit: parseNumber(
        args["room-audit-limit"] ?? env.ROOM_AUDIT_LIMIT,
        null,
      ),
      onlyIds: parseOnlyIds(
        args["room-audit-ids"] ?? env.ROOM_AUDIT_ONLY_IDS,
      ),
      rule1ThresholdHours: parseNumber(
        args["room-audit-rule1-hours"] ?? env.ROOM_AUDIT_RULE1_HOURS,
        24,
      ),
      debug: toBoolean(
        args["room-audit-debug"] ?? env.ROOM_AUDIT_DEBUG,
        false,
      ),
    },
  };
}

async function runAllDailyFlow(options = {}) {
  let mainError = null;
  let roomAuditError = null;
  process.env.TOOL_RUN_CONTEXT = options.runContext || "daily";
  process.env.RUN_CONTEXT = process.env.TOOL_RUN_CONTEXT;

  if (!options.skipMain) {
    console.log("[combined] Starting trong-kin updater...");
    try {
      await runMainFlow();
      console.log("[combined] Trong-kin updater completed.");
    } catch (error) {
      mainError = error;
      console.error(
        `[combined] Trong-kin updater failed: ${error?.message || error}`,
      );
    }
  } else {
    console.log("[combined] Skipped trong-kin updater.");
  }

  if (!options.skipRoomAudit) {
    console.log("[combined] Starting room audit...");
    let auditResult = null;
    try {
      auditResult = await runAuditFlow(options.roomAudit || {});
      console.log(
        `[combined] Room audit completed. Total rows: ${auditResult.report.total_rows}`,
      );
    } catch (error) {
      roomAuditError = error;
      console.error(`[combined] Room audit failed: ${error?.message || error}`);
    }

    if (!roomAuditError) {
      if (mainError) {
        throw new Error(
          `[combined] Completed room audit nhưng bước trong-kin lỗi trước đó: ${
            mainError?.message || mainError
          }`,
        );
      }
      return auditResult;
    }
  } else {
    console.log("[combined] Skipped room audit.");
  }

  if (mainError || roomAuditError) {
    const failures = [];
    if (mainError) {
      failures.push(`trong-kin: ${mainError?.message || mainError}`);
    }
    if (roomAuditError) {
      failures.push(`room-audit: ${roomAuditError?.message || roomAuditError}`);
    }
    throw new Error(`[combined] Run completed with errors | ${failures.join(" | ")}`);
  }

  return null;
}

if (require.main === module) {
  const options = buildCombinedOptions(process.argv.slice(2));
  runAllDailyFlow(options).catch((error) => {
    console.error("[combined] Run failed:", error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCombinedOptions,
  runAllDailyFlow,
};
