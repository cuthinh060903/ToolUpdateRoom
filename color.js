const { google } = require("googleapis");

async function spreadsheets(spreadsheetId, range) {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: "ggsheets.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: client });

    const getRows = await googleSheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: range,
    });

    // Lấy thông tin màu nền
    const getFormats = await googleSheets.spreadsheets.get({
      spreadsheetId: spreadsheetId,
      ranges: [range],
      includeGridData: true,
    });
    const rows = getRows.data.values;
    const sheet = getFormats.data.sheets[0];
    const data = sheet.data[0].rowData;

    if (data && data.length && rows.length) {
      const jsonRows = rows.map((row, rowIndex) => {
        const obj = {};
        row.forEach((value, colIndex) => {
          const cell = data[rowIndex]?.values[colIndex];
          const backgroundColor = cell?.effectiveFormat?.backgroundColor;
          const textColor = cell?.effectiveFormat?.textFormat?.foregroundColor;
          // console.log(textColor)
          const backgroundColorHex = backgroundColor
            ? rgbaToHex(
                backgroundColor.red,
                backgroundColor.green,
                backgroundColor.blue,
                backgroundColor.alpha
              )
            : null;
          const textColorHex = textColor
            ? rgbaToHex(
                textColor.red,
                textColor.green,
                textColor.blue,
                textColor.alpha
              )
            : null;

          obj[`field${colIndex}`] = {
            value,
            bgColor: backgroundColorHex,
            textColor: textColorHex,
          };
        });
        return obj;
      });

      return jsonRows;
    } else {
      console.log("No data found in gg sheets.");
      return [];
    }
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

function rgbaToHex(r = 0, g = 0, b = 0, a = 1) {
  const toHex = (c) => {
    const intVal = Math.round(c * 255);
    const hex = intVal.toString(16).padStart(2, "0");
    return hex;
  };

  const hexRed = toHex(r);
  const hexGreen = toHex(g);
  const hexBlue = toHex(b);
  const hexAlpha = a !== undefined ? toHex(a) : "";

  return `#${hexRed}${hexGreen}${hexBlue}${hexAlpha}`;
}

// docs.google.com/spreadsheets/d/19XR8tZOI09FvWyEihNAgVvl53ZBgXPI7jvCpDHSRUV0/edit?gid=357486279#gid=38754548
(async () => {
  const res = await spreadsheets(
    "1JhtBTTPMkrjBnx5aFYmjGco-o-0kvODPUthkKY611ag",
    "5 1!A5:B5"
  );
  console.log(res);
})();