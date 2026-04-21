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

function buildCombinedOptions(argv = [], env = process.env) {
  const args = parseArgs(argv);
  const skipAll = toBoolean(args["skip-all"], false);

  return {
    skipMain: skipAll || toBoolean(args["skip-main"], false),
    skipRoomAudit: skipAll || toBoolean(args["skip-room-audit"], false),
    roomAudit: {
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
  if (!options.skipMain) {
    console.log("[combined] Starting trong-kin updater...");
    await runMainFlow();
    console.log("[combined] Trong-kin updater completed.");
  } else {
    console.log("[combined] Skipped trong-kin updater.");
  }

  if (!options.skipRoomAudit) {
    console.log("[combined] Starting room audit...");
    const auditResult = await runAuditFlow(options.roomAudit || {});
    console.log(
      `[combined] Room audit completed. Total rows: ${auditResult.report.total_rows}`,
    );
    return auditResult;
  }

  console.log("[combined] Skipped room audit.");
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
