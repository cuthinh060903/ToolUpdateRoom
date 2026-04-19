const { google } = require("googleapis");

const DEFAULT_REPORT_SPREADSHEET_ID =
  "11EyNOVAMn7ei-J8svcMjpvv1B7AashTUDyRB-gUeHho";
const DEFAULT_REPORT_SHEET_GID = 297377874;
const DEFAULT_REPORT_HEADER_ROW = 1;
const DEFAULT_REPORT_FIRST_DATA_ROW = 2;
const DEFAULT_REPORT_START_COLUMN = 7;

function columnToLetter(columnNumber) {
  let dividend = Number(columnNumber || 0);
  let columnName = "";

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return columnName || "A";
}

function normalizeCellValue(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveReportSheetOptions(options = {}) {
  return {
    spreadsheetId:
      options.reportSheetSpreadsheetId || DEFAULT_REPORT_SPREADSHEET_ID,
    sheetGid: parsePositiveNumber(
      options.reportSheetGid,
      DEFAULT_REPORT_SHEET_GID,
    ),
    headerRow: parsePositiveNumber(
      options.reportSheetHeaderRow,
      DEFAULT_REPORT_HEADER_ROW,
    ),
    firstDataRow: parsePositiveNumber(
      options.reportSheetFirstDataRow,
      DEFAULT_REPORT_FIRST_DATA_ROW,
    ),
    startColumn: parsePositiveNumber(
      options.reportSheetStartColumn,
      DEFAULT_REPORT_START_COLUMN,
    ),
    dryRun: Boolean(options.reportSheetDryRun),
  };
}

async function resolveReportSheetMeta(sheets, spreadsheetId, targetGid) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const targetSheet = (meta.data.sheets || []).find(
    (sheet) => Number(sheet?.properties?.sheetId) === Number(targetGid),
  );

  if (!targetSheet) {
    throw new Error(`Không tìm thấy tab report với gid=${targetGid}.`);
  }

  return {
    title: targetSheet.properties.title,
    columnCount: Number(targetSheet.properties?.gridProperties?.columnCount || 0),
  };
}

function findReportDayColumn(headerValues = [], dayLabel, startColumn) {
  let lastNonEmptyOffset = -1;
  let matchingOffset = -1;

  headerValues.forEach((value, index) => {
    const normalizedValue = normalizeCellValue(value);
    if (!normalizedValue) {
      return;
    }

    lastNonEmptyOffset = index;
    if (normalizedValue === dayLabel) {
      matchingOffset = index;
    }
  });

  if (matchingOffset >= 0) {
    return {
      columnIndex: startColumn + matchingOffset,
      existingDayColumn: true,
      lastHeaderOffset: lastNonEmptyOffset,
    };
  }

  return {
    columnIndex:
      lastNonEmptyOffset >= 0
        ? startColumn + lastNonEmptyOffset + 1
        : startColumn,
    existingDayColumn: false,
    lastHeaderOffset: lastNonEmptyOffset,
  };
}

async function ensureColumnCapacity(
  sheets,
  spreadsheetId,
  sheetGid,
  currentColumnCount,
  requiredColumnIndex,
) {
  if (requiredColumnIndex <= currentColumnCount) {
    return currentColumnCount;
  }

  const appendCount = requiredColumnIndex - currentColumnCount;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          appendDimension: {
            sheetId: Number(sheetGid),
            dimension: "COLUMNS",
            length: appendCount,
          },
        },
      ],
    },
  });

  return requiredColumnIndex;
}

async function syncRoomAuditReportSheet(report, options = {}) {
  if (!options?.syncReportSheet) {
    return {
      synced: false,
      skipped: true,
      reason: "SYNC_REPORT_SHEET_DISABLED",
    };
  }

  const summary = report?.daily_sheet_summary;
  if (!summary || !Array.isArray(summary.answers) || summary.answers.length === 0) {
    return {
      synced: false,
      skipped: true,
      reason: "REPORT_SHEET_SUMMARY_EMPTY",
    };
  }

  const settings = resolveReportSheetOptions(options);
  const dayLabel = normalizeCellValue(summary.day_label || new Date().getDate());

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: "ggsheets.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    const meta = await resolveReportSheetMeta(
      sheets,
      settings.spreadsheetId,
      settings.sheetGid,
    );
    const lastKnownColumn = Math.max(settings.startColumn, meta.columnCount || 0);
    const headerRange = `'${meta.title}'!${columnToLetter(
      settings.startColumn,
    )}${settings.headerRow}:${columnToLetter(lastKnownColumn)}${settings.headerRow}`;
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: settings.spreadsheetId,
      range: headerRange,
    });
    const headerValues = headerResponse.data.values?.[0] || [];
    const resolvedColumn = findReportDayColumn(
      headerValues,
      dayLabel,
      settings.startColumn,
    );

    await ensureColumnCapacity(
      sheets,
      settings.spreadsheetId,
      settings.sheetGid,
      meta.columnCount,
      resolvedColumn.columnIndex,
    );

    const targetColumnLetter = columnToLetter(resolvedColumn.columnIndex);
    const targetRange = `'${meta.title}'!${targetColumnLetter}${settings.headerRow}:${targetColumnLetter}${
      settings.firstDataRow + summary.answers.length - 1
    }`;
    const values = [[dayLabel], ...summary.answers.map((answer) => [answer])];

    if (settings.dryRun) {
      return {
        synced: false,
        dryRun: true,
        skipped: true,
        reason: "REPORT_SHEET_DRY_RUN",
        spreadsheetId: settings.spreadsheetId,
        sheetGid: settings.sheetGid,
        sheetTitle: meta.title,
        columnIndex: resolvedColumn.columnIndex,
        columnLetter: targetColumnLetter,
        range: targetRange,
        dayLabel,
        values,
      };
    }

    await sheets.spreadsheets.values.clear({
      spreadsheetId: settings.spreadsheetId,
      range: targetRange,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: settings.spreadsheetId,
      range: targetRange,
      valueInputOption: "RAW",
      requestBody: {
        values,
      },
    });

    return {
      synced: true,
      spreadsheetId: settings.spreadsheetId,
      sheetGid: settings.sheetGid,
      sheetTitle: meta.title,
      columnIndex: resolvedColumn.columnIndex,
      columnLetter: targetColumnLetter,
      range: targetRange,
      dayLabel,
      existingDayColumn: resolvedColumn.existingDayColumn,
    };
  } catch (error) {
    return {
      synced: false,
      skipped: false,
      reason: "REPORT_SHEET_SYNC_FAILED",
      error: error?.message || String(error),
      spreadsheetId: settings.spreadsheetId,
      sheetGid: settings.sheetGid,
      dayLabel,
    };
  }
}

module.exports = {
  DEFAULT_REPORT_FIRST_DATA_ROW,
  DEFAULT_REPORT_HEADER_ROW,
  DEFAULT_REPORT_SHEET_GID,
  DEFAULT_REPORT_SPREADSHEET_ID,
  DEFAULT_REPORT_START_COLUMN,
  columnToLetter,
  syncRoomAuditReportSheet,
};
