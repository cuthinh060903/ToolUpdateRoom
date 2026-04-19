const fs = require("fs").promises;
const path = require("path");
const { UpdateRoomSari } = require("../../index");
const { normalizeRoomReport } = require("./normalize-room-report");
const {
  buildReport,
  buildTelegramProgressMessage,
  formatLocalDateTime,
} = require("./build-report");
const {
  sendAuditTelegram,
  sendAuditTelegramFailure,
  sendAuditTelegramProgress,
  sendAuditTelegramStart,
} = require("./send-telegram");
const { syncRoomAuditReportSheet } = require("./sheet-sync");
const { repairVietnameseText } = require("./text-normalize");

const LOG_FILES = [
  "ggsheet.txt",
  "driver_error.txt",
  "capnhattrong.txt",
  "taophongloi.txt",
  "phongmoi.txt",
  "nhamoi.txt",
  "khongcodulieu.txt",
];
const MAX_ROOM_PROBE_CANDIDATES = 3;
// Change this path (or set ROOM_AUDIT_OPENCLAW_WORKSPACE_DIR) when running on another machine.
const OPENCLAW_WORKSPACE_DIR =
  process.env.ROOM_AUDIT_OPENCLAW_WORKSPACE_DIR ||
  "C:/Users/thinh/.openclaw/workspace";

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

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function debugLog(enabled, message, payload) {
  if (!enabled) {
    return;
  }

  if (payload === undefined) {
    console.log(`[room-audit][debug] ${message}`);
    return;
  }

  console.log(`[room-audit][debug] ${message}:`, payload);
}

function lineContainsAll(line, fragments = []) {
  return fragments.filter(Boolean).every((fragment) => line.includes(fragment));
}

function isMissingDriverGgsheetLog(line = "") {
  const normalizedLine = repairVietnameseText(line).toUpperCase();
  return (
    normalizedLine.includes("KHÔNG CÓ LINK DRIVER") ||
    normalizedLine.includes("KHONG CO LINK DRIVER")
  );
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeReportFiles({
  report,
  jsonPath,
  txtPath,
  summaryPath = null,
}) {
  const writeTasks = [
    fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8"),
    fs.writeFile(txtPath, report.text_report, "utf8"),
  ];

  if (summaryPath) {
    writeTasks.push(
      fs.writeFile(
        summaryPath,
        report.openclaw_summary_text || report.business_summary_text || "",
        "utf8",
      ),
    );
  }

  await Promise.all(writeTasks);
}

async function copyLatestSummaryToOpenClaw(
  summaryPath,
  workspaceDir = OPENCLAW_WORKSPACE_DIR,
) {
  const safeWorkspaceDir = workspaceDir?.toString().trim();

  if (!safeWorkspaceDir) {
    const error = "OpenClaw workspace dir is empty.";
    console.warn(
      `[room-audit][warning] Failed to copy latest summary to OpenClaw workspace: ${error}`,
    );
    return {
      copied: false,
      workspaceDir: safeWorkspaceDir || "",
      targetPath: "",
      error,
    };
  }

  const targetPath = path.join(safeWorkspaceDir, path.basename(summaryPath));

  try {
    await ensureDirectory(safeWorkspaceDir);
    await fs.copyFile(summaryPath, targetPath);
    return {
      copied: true,
      workspaceDir: safeWorkspaceDir,
      targetPath,
      error: null,
    };
  } catch (error) {
    const message = error?.message || String(error);
    console.warn(
      `[room-audit][warning] Failed to copy latest summary to OpenClaw workspace (${targetPath}): ${message}`,
    );
    return {
      copied: false,
      workspaceDir: safeWorkspaceDir,
      targetPath,
      error: message,
    };
  }
}

function appendReportDeliverySummary(summaryText = "", reportSheetSync = null) {
  const baseText = (summaryText || "").toString().trim();
  if (!reportSheetSync) {
    return baseText;
  }

  const lines = [];
  if (baseText) {
    lines.push(baseText, "");
  }
  lines.push("[HE_THONG_BAO_CAO]");

  if (reportSheetSync.synced) {
    lines.push(
      `- AI Bao cao: da ghi vao ${reportSheetSync.sheetTitle || "AI Bao cao"}!${
        reportSheetSync.columnLetter || ""
      } (${reportSheetSync.range || ""}) cho ngay ${reportSheetSync.dayLabel || ""}.`,
    );
  } else if (reportSheetSync.dryRun) {
    lines.push(
      `- AI Bao cao: dry-run tai cot ${reportSheetSync.columnLetter || "?"} (${reportSheetSync.range || ""}) cho ngay ${reportSheetSync.dayLabel || ""}.`,
    );
  } else if (reportSheetSync.skipped) {
    lines.push(`- AI Bao cao: bo qua dong bo (${reportSheetSync.reason || "unknown"}).`);
  } else {
    lines.push(
      `- AI Bao cao: loi dong bo (${reportSheetSync.reason || "unknown"}). Chi tiet: ${
        reportSheetSync.error || "khong co"
      }`,
    );
  }

  return lines.join("\n");
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

function pickLogMatches(logSources, config, sheetGid, row, room = null) {
  const sheetKey = `${config.link}${sheetGid}`;
  const address = row?.ADDRESS || "";
  const roomName = row?.ROOMS || "";
  const imageDriver = row?.IMAGE_DRIVER || "";
  const originLink = room?.origin_link || "";
  const hasCurrentImageSource = Boolean(
    imageDriver.toString().trim() || originLink.toString().trim(),
  );

  const selectors = {
    ggsheet: [sheetKey, address],
    driver_error: [sheetKey, address, roomName || imageDriver],
    capnhattrong: [sheetKey, address, roomName],
    taophongloi: [sheetKey, address, roomName],
    phongmoi: [sheetKey, address, roomName],
    nhamoi: [sheetKey, address],
    khongcodulieu: [sheetKey, address],
  };

  const matches = Object.fromEntries(
    Object.entries(selectors).map(([key, fragments]) => [
      key,
      (logSources[key] || []).filter((line) => lineContainsAll(line, fragments)),
    ]),
  );

  if (hasCurrentImageSource) {
    matches.ggsheet = (matches.ggsheet || []).filter(
      (line) => !isMissingDriverGgsheetLog(line),
    );
  }

  return matches;
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

function sortScoredBuildingCandidates(scoredMatches = []) {
  return [...scoredMatches].sort((a, b) => {
    if (a.accepted !== b.accepted) {
      return a.accepted ? -1 : 1;
    }
    if (b.matchScore !== a.matchScore) {
      return b.matchScore - a.matchScore;
    }
    if (b.exactTextScore !== a.exactTextScore) {
      return b.exactTextScore - a.exactTextScore;
    }
    return 0;
  });
}

function buildRankedBuildingCandidates(
  updater,
  searchTerm,
  buildingList,
  config = {},
) {
  const processedSearchTerm = updater.normalizeSheetCellText(searchTerm);
  if (!processedSearchTerm) {
    return [];
  }

  const normalizedSearchKey =
    updater.normalizeComparableText(processedSearchTerm);
  const configuredAliases = config?.address_aliases || {};
  const aliasSearchTerm =
    Object.entries(configuredAliases).find(
      ([alias]) =>
        updater.normalizeComparableText(alias) === normalizedSearchKey,
    )?.[1] || processedSearchTerm;
  const searchableList = updater.filterRealnewsForMatching(
    buildingList,
    config,
  ).map((item) => ({
    ...item,
    address: item?.address || item?.address_valid || item?.name || "",
    searchableAddress: updater.getBuildingSearchAddress(item),
  }));

  const rankedCandidates = sortScoredBuildingCandidates(
    searchableList
      .map((item) => updater.scoreAddressCandidate(aliasSearchTerm, item, config))
      .filter(Boolean),
  );
  const topCandidate = rankedCandidates[0];

  if (!topCandidate?.item) {
    return rankedCandidates;
  }

  const normalizedSearchTerm =
    updater.normalizeComparableText(processedSearchTerm);
  const normalizedCandidateAddress = updater.normalizeComparableText(
    topCandidate.candidateVariant || "",
  );
  const keywordTokens = updater.extractAddressKeywordTokens(processedSearchTerm);

  if (
    config?.require_address_detail_for_match &&
    normalizedSearchTerm &&
    !/\d/.test(normalizedSearchTerm) &&
    keywordTokens.length <= 1 &&
    normalizedSearchTerm !== normalizedCandidateAddress
  ) {
    rankedCandidates[0] = {
      ...topCandidate,
      accepted: false,
      rejectReason: "address_too_generic",
    };
  }

  return rankedCandidates;
}

async function loadRoomListForBuilding(
  updater,
  buildingId,
  roomCache,
  apiErrors = {},
) {
  if (!buildingId) {
    return { loaded: false, rooms: [] };
  }

  if (roomCache.has(buildingId)) {
    return roomCache.get(buildingId);
  }

  try {
    const searchRooms = await updater.searchRoom(buildingId);
    const result = {
      loaded: true,
      rooms: searchRooms?.content || [],
    };
    roomCache.set(buildingId, result);
    return result;
  } catch (error) {
    const result = {
      loaded: false,
      rooms: [],
    };
    roomCache.set(buildingId, result);
    if (!apiErrors.search_room) {
      apiErrors.search_room = error?.message || String(error);
    }
    return result;
  }
}

function findMatchedRoomFromCandidates(
  updater,
  rooms = [],
  roomCandidates = [],
  type = "chdv",
) {
  for (const roomCandidate of roomCandidates) {
    const room = updater.findMatchedRoom(rooms, roomCandidate, type);
    if (room) {
      return room;
    }
  }

  return null;
}

async function probeRoomExistsOnBuilding(
  updater,
  buildingId,
  roomCandidates,
  type,
  roomCache,
  apiErrors = {},
) {
  if (!buildingId || !Array.isArray(roomCandidates) || roomCandidates.length === 0) {
    return null;
  }

  const { loaded, rooms } = await loadRoomListForBuilding(
    updater,
    buildingId,
    roomCache,
    apiErrors,
  );

  if (!loaded) {
    return null;
  }

  return Boolean(findMatchedRoomFromCandidates(updater, rooms, roomCandidates, type));
}

function getRoomProbeCandidateIds(
  rankedCandidates = [],
  limit = MAX_ROOM_PROBE_CANDIDATES,
) {
  const candidateIds = [];

  for (const candidate of rankedCandidates) {
    const buildingId = candidate?.item?.id;
    if (!buildingId || candidateIds.includes(buildingId)) {
      continue;
    }

    candidateIds.push(buildingId);
    if (candidateIds.length >= limit) {
      break;
    }
  }

  return candidateIds;
}

async function probeRoomExistsOnAnyCandidate(
  updater,
  rankedCandidates,
  roomCandidates,
  type,
  roomCache,
  apiErrors = {},
) {
  if (!Array.isArray(roomCandidates) || roomCandidates.length === 0) {
    return null;
  }

  const candidateIds = getRoomProbeCandidateIds(rankedCandidates);
  if (candidateIds.length === 0) {
    return null;
  }

  let hasLoadedCandidate = false;

  for (const buildingId of candidateIds) {
    const exists = await probeRoomExistsOnBuilding(
      updater,
      buildingId,
      roomCandidates,
      type,
      roomCache,
      apiErrors,
    );
    if (exists === true) {
      return true;
    }
    if (exists === false) {
      hasLoadedCandidate = true;
    }
  }

  return hasLoadedCandidate ? false : null;
}

async function enrichWithApi(updater, config, row, buildingList, roomCache) {
  const apiErrors = {};
  let building = null;
  let room = null;
  let imageCount = null;
  let rankedBuildingCandidates = [];
  let roomCandidates = [];

  try {
    rankedBuildingCandidates = buildRankedBuildingCandidates(
      updater,
      row.ADDRESS,
      buildingList,
      config,
    );
    if (rankedBuildingCandidates[0]?.accepted && rankedBuildingCandidates[0]?.item) {
      building = rankedBuildingCandidates[0].item;
    }
  } catch (error) {
    apiErrors.search_realnew = error?.message || String(error);
  }

  try {
    roomCandidates = await updater.replaceAbbreviations(row.ROOMS, config.type);
  } catch (error) {
    apiErrors.search_room = error?.message || String(error);
    roomCandidates = [];
  }

  if (building?.id) {
    const { loaded, rooms } = await loadRoomListForBuilding(
      updater,
      building.id,
      roomCache,
      apiErrors,
    );
    if (loaded) {
      room = findMatchedRoomFromCandidates(
        updater,
        rooms,
        roomCandidates,
        config.type,
      );
    }
  }

  const topBuildingCandidate = rankedBuildingCandidates[0] || null;
  let roomExistsOnTopCandidate = null;
  if (topBuildingCandidate?.item?.id) {
    if (building?.id && topBuildingCandidate.item.id === building.id) {
      roomExistsOnTopCandidate = Boolean(room?.id);
    } else {
      roomExistsOnTopCandidate = await probeRoomExistsOnBuilding(
        updater,
        topBuildingCandidate.item.id,
        roomCandidates,
        config.type,
        roomCache,
        apiErrors,
      );
    }
  }

  let roomExistsOnAnyCandidate = roomExistsOnTopCandidate;
  if (roomExistsOnAnyCandidate !== true) {
    const anyCandidateProbe = await probeRoomExistsOnAnyCandidate(
      updater,
      rankedBuildingCandidates,
      roomCandidates,
      config.type,
      roomCache,
      apiErrors,
    );
    if (anyCandidateProbe !== null) {
      roomExistsOnAnyCandidate = anyCandidateProbe;
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
    matchContext: {
      topBuildingCandidate: topBuildingCandidate?.item || null,
      topBuildingCandidateScore: Number.isFinite(topBuildingCandidate?.matchScore)
        ? topBuildingCandidate.matchScore
        : null,
      topBuildingCandidateRejectReason: topBuildingCandidate?.accepted
        ? ""
        : topBuildingCandidate?.rejectReason || "",
      roomExistsOnTopCandidate: roomExistsOnTopCandidate,
      roomExistsOnAnyCandidate: roomExistsOnAnyCandidate,
    },
  };
}

function buildRunOptions(argv = [], env = process.env) {
  const args = parseArgs(argv);
  const onlyIdsSource =
    args.ids ?? env.ROOM_AUDIT_ONLY_IDS ?? env.npm_config_ids ?? "";
  const onlyIds = onlyIdsSource
    .toString()
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  return {
    useApi: toBoolean(
      args["use-api"] ?? env.ROOM_AUDIT_USE_API ?? env.npm_config_use_api,
      true,
    ),
    sendTelegram: toBoolean(
      args["send-telegram"] ??
        env.ROOM_AUDIT_SEND_TELEGRAM ??
        env.npm_config_send_telegram,
      false,
    ),
    telegramProgress: toBoolean(
      args["telegram-progress"] ??
        env.ROOM_AUDIT_TELEGRAM_PROGRESS ??
        env.npm_config_telegram_progress,
      false,
    ),
    detailedTelegramMessages: toBoolean(
      args["detailed-telegram"] ??
        env.ROOM_AUDIT_DETAILED_TELEGRAM ??
        env.npm_config_detailed_telegram,
      false,
    ),
    telegramProgressMinGapMs: parseNumber(
      args["telegram-progress-gap-ms"] ??
        env.ROOM_AUDIT_TELEGRAM_PROGRESS_GAP_MS ??
        env.npm_config_telegram_progress_gap_ms,
      2500,
    ),
    limit: parseNumber(
      args.limit ?? env.ROOM_AUDIT_LIMIT ?? env.npm_config_limit,
      null,
    ),
    onlyIds,
    rule1ThresholdHours: parseNumber(
      args["rule1-hours"] ??
        env.ROOM_AUDIT_RULE1_HOURS ??
        env.npm_config_rule1_hours,
      24,
    ),
    debug: toBoolean(
      args.debug ?? env.ROOM_AUDIT_DEBUG ?? env.npm_config_debug,
      false,
    ),
    syncReportSheet: toBoolean(
      args["sync-report-sheet"] ??
        env.ROOM_AUDIT_SYNC_REPORT_SHEET ??
        env.npm_config_sync_report_sheet,
      true,
    ),
    reportSheetDryRun: toBoolean(
      args["report-sheet-dry-run"] ??
        env.ROOM_AUDIT_REPORT_SHEET_DRY_RUN ??
        env.npm_config_report_sheet_dry_run,
      false,
    ),
    reportSheetSpreadsheetId:
      args["report-sheet-spreadsheet-id"] ??
      env.ROOM_AUDIT_REPORT_SPREADSHEET_ID ??
      env.npm_config_report_sheet_spreadsheet_id,
    reportSheetGid: parseNumber(
      args["report-sheet-gid"] ??
        env.ROOM_AUDIT_REPORT_SHEET_GID ??
        env.npm_config_report_sheet_gid,
      null,
    ),
    reportSheetHeaderRow: parseNumber(
      args["report-sheet-header-row"] ??
        env.ROOM_AUDIT_REPORT_SHEET_HEADER_ROW ??
        env.npm_config_report_sheet_header_row,
      1,
    ),
    reportSheetFirstDataRow: parseNumber(
      args["report-sheet-first-data-row"] ??
        env.ROOM_AUDIT_REPORT_SHEET_FIRST_DATA_ROW ??
        env.npm_config_report_sheet_first_data_row,
      2,
    ),
    reportSheetStartColumn: parseNumber(
      args["report-sheet-start-column"] ??
        env.ROOM_AUDIT_REPORT_SHEET_START_COLUMN ??
        env.npm_config_report_sheet_start_column,
      7,
    ),
    openClawWorkspaceDir:
      args["openclaw-workspace-dir"] ??
      env.ROOM_AUDIT_OPENCLAW_WORKSPACE_DIR ??
      OPENCLAW_WORKSPACE_DIR,
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

  debugLog(options.debug, "parsed-options", options);
  debugLog(options.debug, "config-count-after-filter", configs.length);
  debugLog(
    options.debug,
    "config-ids-after-filter",
    configs.map((config) => config.id),
  );

  await ensureDirectory(outputDir);
  await sendAuditTelegramStart({
    enabled: options.sendTelegram,
    onlyIds: options.onlyIds,
  });

  try {
    const executionContextByCdt = new Map();
    let lastTelegramProgressSentAt = 0;

    function getExecutionContextForConfig(config = {}) {
      const key = String(config.id ?? "");
      if (!executionContextByCdt.has(key)) {
        executionContextByCdt.set(key, {
          cdt_id: Number.isFinite(Number(config.id)) ? Number(config.id) : config.id,
          cdt_name: config.web || "",
          configured_sheet_count: Array.isArray(config.list_address)
            ? config.list_address.length
            : 0,
          processed_sheet_count: 0,
          empty_sheet_count: 0,
          row_count: 0,
          source_error_count: 0,
        });
      }

      return executionContextByCdt.get(key);
    }

    for (const config of configs) {
      const executionContext = getExecutionContextForConfig(config);
      const configRows = [];
      const configSourceErrors = [];
      let buildingList = [];

      if (options.useApi) {
        try {
          const searchRealnews = await updater.searchRealnewByInvestor(config.id);
          buildingList = searchRealnews?.content || [];
        } catch (error) {
          const sourceError = {
            cdt_id: config.id,
            cdt_name: config.web,
            source: config.web,
            step: "searchRealnewByInvestor",
            message: error?.message || String(error),
          };
          sourceErrors.push(sourceError);
          configSourceErrors.push(sourceError);
          executionContext.source_error_count += 1;
        }
      }

      for (const sheetGid of config.list_address || []) {
        let processedRows = [];

        try {
          processedRows = (await updater.processCsvData(config, sheetGid)) || [];
        } catch (error) {
          const sourceError = {
            cdt_id: config.id,
            cdt_name: config.web,
            source: config.web,
            sheet_gid: sheetGid,
            step: "processCsvData",
            message: error?.message || String(error),
          };
          sourceErrors.push(sourceError);
          configSourceErrors.push(sourceError);
          executionContext.source_error_count += 1;
          continue;
        }

        executionContext.processed_sheet_count += 1;
        executionContext.row_count += processedRows.length;
        if (processedRows.length === 0) {
          executionContext.empty_sheet_count += 1;
        }

        debugLog(
          options.debug,
          `rows-from-sheet cdt=${config.id} gid=${sheetGid}`,
          processedRows.length,
        );

        for (const row of processedRows) {
          let building = null;
          let room = null;
          let imageCount = null;
          let matchContext = {};
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
            matchContext = apiResult.matchContext;
          }

          const logMatches = pickLogMatches(
            logSources,
            config,
            sheetGid,
            row,
            room,
          );
          const normalizedRow = normalizeRoomReport({
            config,
            sheetGid,
            row,
            building,
            room,
            imageCount,
            matchContext,
            logMatches,
            apiErrors,
          });

          rows.push(normalizedRow);
          configRows.push(normalizedRow);
          if (Number.isFinite(options.limit) && rows.length >= options.limit) {
            debugLog(options.debug, "limit-hit-final-row-count", rows.length);
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

      if (options.sendTelegram && options.telegramProgress) {
        const configReport = buildReport({
          rows: configRows,
          sourceErrors: configSourceErrors,
          executionContext: [executionContext],
          options: {
            ...options,
            skipTelegramMessages: true,
          },
        });
        const progressMessage = buildTelegramProgressMessage(configReport);

        if (progressMessage) {
          const waitMs = Math.max(
            0,
            lastTelegramProgressSentAt +
              Number(options.telegramProgressMinGapMs || 0) -
              Date.now(),
          );
          if (waitMs > 0) {
            await sleep(waitMs);
          }

          const progressResult = await sendAuditTelegramProgress(configReport, {
            enabled: options.sendTelegram,
            message: progressMessage,
          });
          if (progressResult?.sent) {
            lastTelegramProgressSentAt = Date.now();
          } else {
            console.warn(
              `[room-audit][warning] Telegram progress for CDT ${config.id} failed: ${
                progressResult?.reason || "unknown error"
              }`,
            );
          }
        }
      }
    }

    const report = buildReport({
      rows,
      sourceErrors,
      executionContext: [...executionContextByCdt.values()],
      options,
    });

    if (options.debug) {
      const rowsByCdt = rows.reduce((accumulator, row) => {
        const key = String(row.cdt_id);
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
      }, {});
      debugLog(options.debug, "final-rows-after-limit", rows.length);
      debugLog(options.debug, "final-rows-by-cdt", rowsByCdt);
    }

    const reportSheetSync = await syncRoomAuditReportSheet(report, options);
    report.report_sheet_sync = reportSheetSync;
    report.openclaw_summary_text = appendReportDeliverySummary(
      report.openclaw_summary_text,
      reportSheetSync,
    );
    if (options.debug) {
      debugLog(options.debug, "report-sheet-sync", reportSheetSync);
    }

    const timestamp = formatLocalDateTime(new Date()).replace(/[: ]/g, "-");
    const jsonPath = path.join(outputDir, `room-audit-${timestamp}.json`);
    const txtPath = path.join(outputDir, `room-audit-${timestamp}.txt`);
    const latestJsonPath = path.join(outputDir, "latest-room-audit.json");
    const latestTxtPath = path.join(outputDir, "latest-room-audit.txt");
    const latestSummaryPath = path.join(
      outputDir,
      "latest-room-audit-summary.txt",
    );

    await writeReportFiles({
      report,
      jsonPath,
      txtPath,
    });
    await writeReportFiles({
      report,
      jsonPath: latestJsonPath,
      txtPath: latestTxtPath,
      summaryPath: latestSummaryPath,
    });
    const openClawSummaryCopy = await copyLatestSummaryToOpenClaw(
      latestSummaryPath,
      options.openClawWorkspaceDir,
    );

    const telegramResult = await sendAuditTelegram(report, {
      enabled: options.sendTelegram,
      message: report.telegram_message,
    });

    return {
      report,
      output: {
        jsonPath,
        txtPath,
        latestJsonPath,
        latestTxtPath,
        latestSummaryPath,
        reportSheetSync,
        openClawWorkspaceDir: openClawSummaryCopy.workspaceDir,
        openClawSummaryPath: openClawSummaryCopy.targetPath,
        openClawSummaryCopied: openClawSummaryCopy.copied,
        openClawSummaryCopyError: openClawSummaryCopy.error,
      },
      telegramResult,
    };
  } catch (error) {
    await sendAuditTelegramFailure(error, {
      enabled: options.sendTelegram,
    });
    throw error;
  }
}

if (require.main === module) {
  const options = buildRunOptions(process.argv.slice(2));
  runAuditFlow(options)
    .then(({ output, telegramResult, report }) => {
      console.log(`[room-audit] JSON report: ${output.jsonPath}`);
      console.log(`[room-audit] Text report: ${output.txtPath}`);
      console.log(`[room-audit] Latest JSON report: ${output.latestJsonPath}`);
      console.log(`[room-audit] Latest text report: ${output.latestTxtPath}`);
      console.log(`[room-audit] Latest summary report: ${output.latestSummaryPath}`);
      console.log(
        `[room-audit] Report sheet: ${
          output.reportSheetSync?.synced
            ? `${output.reportSheetSync.sheetTitle || "AI Báo cáo"}!${
                output.reportSheetSync.columnLetter || "?"
              }`
            : output.reportSheetSync?.reason || "not synced"
        }`,
      );
      console.log(
        `[room-audit] OpenClaw summary copy: ${
          output.openClawSummaryCopied
            ? output.openClawSummaryPath
            : `warning (${output.openClawSummaryCopyError || "unknown error"})`
        }`,
      );
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
