const fs = require("fs").promises;
const path = require("path");
const { UpdateRoomSari } = require("../../index");
const { normalizeRoomReport } = require("./normalize-room-report");
const { buildReport } = require("./build-report");
const { sendAuditTelegram } = require("./send-telegram");

const LOG_FILES = [
  "ggsheet.txt",
  "driver_error.txt",
  "capnhattrong.txt",
  "taophongloi.txt",
  "phongmoi.txt",
  "nhamoi.txt",
  "khongcodulieu.txt",
];

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

function lineContainsAll(line, fragments = []) {
  return fragments.filter(Boolean).every((fragment) => line.includes(fragment));
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readLogLines(rootDir, fileName) {
  try {
    const fullPath = path.join(rootDir, fileName);
    const content = await fs.readFile(fullPath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

async function loadLogSources(rootDir) {
  const result = {};

  for (const fileName of LOG_FILES) {
    const key = fileName.replace(".txt", "");
    result[key] = await readLogLines(rootDir, fileName);
  }

  return result;
}

function pickLogMatches(logSources, config, sheetGid, row) {
  const sheetKey = `${config.link}${sheetGid}`;
  const address = row?.ADDRESS || "";
  const roomName = row?.ROOMS || "";
  const imageDriver = row?.IMAGE_DRIVER || "";

  const selectors = {
    ggsheet: [sheetKey, address],
    driver_error: [sheetKey, address, roomName || imageDriver],
    capnhattrong: [sheetKey, address, roomName],
    taophongloi: [sheetKey, address, roomName],
    phongmoi: [sheetKey, address, roomName],
    nhamoi: [sheetKey, address],
    khongcodulieu: [sheetKey, address],
  };

  return Object.fromEntries(
    Object.entries(selectors).map(([key, fragments]) => [
      key,
      (logSources[key] || []).filter((line) => lineContainsAll(line, fragments)),
    ]),
  );
}

async function countRoomImages(updater, roomId) {
  if (!roomId) {
    return null;
  }

  if (!updater?.hasMinioCredentials) {
    throw new Error("MINIO_CREDENTIALS_MISSING");
  }

  const bucketName = updater.BUCKETNAME || "sari";
  const objectPrefix = `rooms/${roomId}/photos/`;
  let count = 0;

  await new Promise((resolve, reject) => {
    const objectsStream = updater.minioClient.listObjects(
      bucketName,
      objectPrefix,
      true,
    );

    objectsStream.on("data", () => {
      count += 1;
    });
    objectsStream.on("end", resolve);
    objectsStream.on("error", reject);
  });

  return count;
}

async function enrichWithApi(updater, config, row, buildingList, roomCache) {
  const apiErrors = {};
  let building = null;
  let room = null;
  let imageCount = null;

  try {
    building = await updater.fuzzySearch(row.ADDRESS, buildingList, config);
  } catch (error) {
    apiErrors.search_realnew = error?.message || String(error);
  }

  if (building?.id) {
    if (!roomCache.has(building.id)) {
      try {
        const searchRooms = await updater.searchRoom(building.id);
        roomCache.set(building.id, searchRooms?.content || []);
      } catch (error) {
        apiErrors.search_room = error?.message || String(error);
        roomCache.set(building.id, []);
      }
    }

    const roomList = roomCache.get(building.id) || [];
    try {
      const roomCandidates = await updater.replaceAbbreviations(
        row.ROOMS,
        config.type,
      );
      for (const roomCandidate of roomCandidates) {
        room = updater.findMatchedRoom(roomList, roomCandidate, config.type);
        if (room) {
          break;
        }
      }
    } catch (error) {
      apiErrors.search_room = error?.message || String(error);
    }
  }

  if (room?.id) {
    try {
      imageCount = await countRoomImages(updater, room.id);
    } catch (error) {
      apiErrors.count_image = error?.message || String(error);
    }
  }

  return {
    building,
    room,
    imageCount,
    apiErrors,
  };
}

function buildRunOptions(argv = [], env = process.env) {
  const args = parseArgs(argv);
  const onlyIds = (args.ids || env.ROOM_AUDIT_ONLY_IDS || "")
    .toString()
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  return {
    useApi: toBoolean(args["use-api"] ?? env.ROOM_AUDIT_USE_API, true),
    sendTelegram: toBoolean(
      args["send-telegram"] ?? env.ROOM_AUDIT_SEND_TELEGRAM,
      false,
    ),
    limit: parseNumber(args.limit ?? env.ROOM_AUDIT_LIMIT, null),
    onlyIds,
    rule1ThresholdHours: parseNumber(
      args["rule1-hours"] ?? env.ROOM_AUDIT_RULE1_HOURS,
      24,
    ),
  };
}

async function runAuditFlow(options = {}) {
  const rootDir = path.resolve(__dirname, "../..");
  const outputDir = path.join(rootDir, "reports", "room-audit");
  const updater = new UpdateRoomSari();
  const logSources = await loadLogSources(rootDir);
  const sourceErrors = [];
  const rows = [];
  const roomCache = new Map();
  const configs = updater.LIST_GGSHEET.filter((config) => {
    if (!Array.isArray(options.onlyIds) || options.onlyIds.length === 0) {
      return true;
    }

    return options.onlyIds.includes(Number(config.id));
  });

  await ensureDirectory(outputDir);

  for (const config of configs) {
    let buildingList = [];

    if (options.useApi) {
      try {
        const searchRealnews = await updater.searchRealnewByInvestor(config.id);
        buildingList = searchRealnews?.content || [];
      } catch (error) {
        sourceErrors.push({
          cdt_id: config.id,
          source: config.web,
          step: "searchRealnewByInvestor",
          message: error?.message || String(error),
        });
      }
    }

    for (const sheetGid of config.list_address || []) {
      let processedRows = [];

      try {
        processedRows = (await updater.processCsvData(config, sheetGid)) || [];
      } catch (error) {
        sourceErrors.push({
          cdt_id: config.id,
          source: config.web,
          sheet_gid: sheetGid,
          step: "processCsvData",
          message: error?.message || String(error),
        });
        continue;
      }

      for (const row of processedRows) {
        let building = null;
        let room = null;
        let imageCount = null;
        let apiErrors = {};

        if (options.useApi) {
          const apiResult = await enrichWithApi(
            updater,
            config,
            row,
            buildingList,
            roomCache,
          );
          building = apiResult.building;
          room = apiResult.room;
          imageCount = apiResult.imageCount;
          apiErrors = apiResult.apiErrors;
        }

        const logMatches = pickLogMatches(logSources, config, sheetGid, row);
        const normalizedRow = normalizeRoomReport({
          config,
          sheetGid,
          row,
          building,
          room,
          imageCount,
          logMatches,
          apiErrors,
        });

        rows.push(normalizedRow);
        if (Number.isFinite(options.limit) && rows.length >= options.limit) {
          break;
        }
      }

      if (Number.isFinite(options.limit) && rows.length >= options.limit) {
        break;
      }
    }

    if (Number.isFinite(options.limit) && rows.length >= options.limit) {
      break;
    }
  }

  const report = buildReport({
    rows,
    sourceErrors,
    options,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `room-audit-${timestamp}.json`);
  const txtPath = path.join(outputDir, `room-audit-${timestamp}.txt`);

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(txtPath, report.text_report, "utf8");

  const telegramResult = await sendAuditTelegram(report, {
    enabled: options.sendTelegram,
  });

  return {
    report,
    output: {
      jsonPath,
      txtPath,
    },
    telegramResult,
  };
}

if (require.main === module) {
  const options = buildRunOptions(process.argv.slice(2));
  runAuditFlow(options)
    .then(({ output, telegramResult, report }) => {
      console.log(`[room-audit] JSON report: ${output.jsonPath}`);
      console.log(`[room-audit] Text report: ${output.txtPath}`);
      console.log(`[room-audit] Total rows: ${report.total_rows}`);
      console.log(
        `[room-audit] Telegram: ${telegramResult.sent ? "sent" : telegramResult.reason}`,
      );
    })
    .catch((error) => {
      console.error("[room-audit] Run failed:", error?.message || error);
      process.exitCode = 1;
    });
}

module.exports = {
  buildRunOptions,
  runAuditFlow,
};
