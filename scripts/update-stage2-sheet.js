require("dotenv").config();
const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || "AI Bao cao";
const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;

function columnToLetter(columnNumber) {
  let temp = "";
  let letter = "";
  while (columnNumber > 0) {
    temp = (columnNumber - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    columnNumber = Math.floor((columnNumber - temp - 1) / 26);
  }
  return letter;
}

function getTodayDayNumber() {
  return String(new Date().getDate());
}

async function getSheetsClient() {
  if (!SERVICE_ACCOUNT_FILE) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_FILE in .env");
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function findOrCreateDayColumn(sheets, dayNumber) {
  // Đọc header row 1, lấy rộng hơn một chút để dư cột
  const headerRange = `${SHEET_NAME}!A1:ZZ1`;
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: headerRange,
  });

  const headerRow = headerRes.data.values?.[0] || [];

  // Theo rule của bạn, first day column là G = cột số 7
  const startColumn = 7;

  let foundColumn = null;

  for (
    let col = startColumn;
    col <= Math.max(headerRow.length, startColumn);
    col++
  ) {
    const cellValue = headerRow[col - 1];
    if (String(cellValue || "").trim() === dayNumber) {
      foundColumn = col;
      break;
    }
  }

  if (foundColumn) {
    return foundColumn;
  }

  // Nếu chưa có, append cột mới bên phải
  const nextColumn = Math.max(headerRow.length + 1, startColumn);
  const nextColumnLetter = columnToLetter(nextColumn);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${nextColumnLetter}1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[dayNumber]],
    },
  });

  return nextColumn;
}

async function clearAndWriteDayColumn(sheetRows) {
  if (!SPREADSHEET_ID) {
    throw new Error("Missing GOOGLE_SHEET_ID in .env");
  }

  if (!Array.isArray(sheetRows) || sheetRows.length !== 7) {
    throw new Error("sheet_rows must be an array of exactly 7 strings");
  }

  const sheets = await getSheetsClient();
  const dayNumber = getTodayDayNumber();
  const targetColumn = await findOrCreateDayColumn(sheets, dayNumber);
  const colLetter = columnToLetter(targetColumn);

  // Clear rows 2..8
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${colLetter}2:${colLetter}8`,
  });

  // Write rows 2..8
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${colLetter}2:${colLetter}8`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: sheetRows.map((value) => [value]),
    },
  });

  return {
    success: true,
    column: colLetter,
    dayNumber,
  };
}

if (require.main === module) {
  (async () => {
    try {
      const raw = process.argv[2];
      if (!raw) {
        throw new Error("Missing JSON input argument");
      }

      const parsed = JSON.parse(raw);
      const result = await clearAndWriteDayColumn(parsed.sheet_rows);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  })();
}

module.exports = {
  clearAndWriteDayColumn,
};
