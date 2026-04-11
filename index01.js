const fs = require("fs").promises;
const axios = require("axios");
require("dotenv").config();
const csvtojson = require("csvtojson");
const xlsx = require("xlsx");
const { google } = require("googleapis");
const cron = require("node-cron");
const OpenAI = require("openai");
const Fuse = require("fuse.js");
const { LIST_GGSHEET } = require("./constants");
const { extension } = require("./extension");
const { sendTelegramMessage } = require("./telegram_bot");
const path = require("path");
const dayjs = require("dayjs");
const { Client } = require("minio");
const { time } = require("console");
const mammoth = require("mammoth");

class UpdateRoomSari {
  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.OpenAI = this.apiKey ? new OpenAI({ apiKey: this.apiKey }) : null;
    if (!this.apiKey) {
      console.warn(
        "[config] OPENAI_API_KEY is missing. OpenAI features will be disabled.",
      );
    }
    this.AUTH_USERNAME = "bot2nguon";
    this.AUTH_PASSWORD = "1234567";
    this.PAGE = 0;
    this.SIZE = 1000;
    this.minFileUpload = 3;
    this.baseURL = "https://api-legacy.sari.vn/v1/";
    this.URL_API_REALNEW_SEARCH =
      "https://api-legacy.sari.vn/v1/realnews/search";
    this.URL_API_ROOM_SEARCH = "https://api-legacy.sari.vn/v1/rooms/search";
    this.URL_API_UNLOCK_ROOM = "https://api-legacy.sari.vn/v1/rooms/unlockRoom";
    this.URL_API_UPDATE_ROOM = "https://api-legacy.sari.vn/v1/rooms/";
    this.URL_API_LOCK_ROOM =
      "https://api-legacy.sari.vn/v1/rooms/lockRoomToDate?";
    this.LIST_GGSHEET = LIST_GGSHEET;
    this.START_ID = 62;
    this.API_KEY_GGSHEET = "4f74e1628d70cc3b23f7ad9d1d0a50802d01d1ea";
    this.BUCKETNAME = "sari";
    // Conflict resolution: prefer higher features (e.g., 2N > 1N)
    this.priorityGroups = [
      ["3N", "2N", "1N"],
      ["2WC", "1WC"],
    ];

    this.minioClient = new Client({
      endPoint: "s3.sari.vn",
      port: 443,
      useSSL: true,
      accessKey: process.env.MINIO_ACCESS_KEY,
      secretKey: process.env.MINIO_SECRET_KEY,
    });
  }

  /**
   * Trích folder ID từ link Google Drnive
   */
  extractFolderId(driveLink) {
    if (!driveLink) return null;
    if (!driveLink.includes("https://drive.google.com/drive")) return null;
    const match = driveLink.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }
  /**
   *
   * @param {*} objectPath
   * @param {*} bucketName
   * @returns
   */
  async checkUploadFile(objectPath, bucketName) {
    const exists = await this.minioClient.bucketExists(bucketName);
    if (!exists) {
      await this.minioClient.makeBucket(bucketName);
      console.log(`✅ Created bucket: ${bucketName}`);
    }
    const objectsStream = this.minioClient.listObjects(
      bucketName,
      objectPath,
      true,
    );
    let found = [];
    await new Promise((resolve, reject) => {
      objectsStream.on("data", (obj) => {
        found.push(obj);
        return;
      });
      objectsStream.on("error", reject);
      objectsStream.on("end", () => resolve(false));
    });

    return found.length > this.minFileUpload;
  }

  /**
   * Upload stream lên MinIO nếu chưa tồn tại
   * @param {Stream} stream - Stream dữ liệu cần upload
   * @param {string} objectName - Tên file (hoặc path + tên file)
   * @param {string} bucketName - Tên bucket
   */
  async uploadToMinIO(stream, objectName, bucketName) {
    // Thư mục rỗng → upload file
    await this.minioClient.putObject(bucketName, objectName, stream);
    console.log(`✅ Uploaded "${objectName}" to bucket "${bucketName}"`);
    return true;
  }

  /**
   * Lấy danh sách ảnh trong folder Google Drive
   */
  async listDriveImagesInFolder(auth, folderId) {
    const drive = google.drive({ version: "v3", auth });

    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "files(id, name, mimeType)",
      pageSize: 1000,
    });

    return res.data.files;
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Tải tất cả file trong folder Google Drive về máy
   * @param {string} driveLink - Link thư mục Google Drive
   * @param {string} localFolder - Tên thư mục local để lưu file
   */
  async downloadAllFilesFromFolder(driveLink, room, localFolder = "downloads") {
    if (
      await this.checkUploadFile(`rooms/${room.id}/photos`, this.BUCKETNAME)
    ) {
      console.log(`Room ${room.id} has been uploaded to minio`);
      return;
    }
    const folderId = this.extractFolderId(driveLink);

    if (!folderId) {
      return;
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: "ggsheets.json",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    // const client = await auth.getClient();
    const drive = google.drive({ version: "v3", auth });
    const dirPath = path.join(__dirname, localFolder); // Đường dẫn đến thư mục bạn muốn kiểm tra
    try {
      await fs.access(dirPath); // Kiểm tra nếu thư mục đã tồn tại
    } catch (err) {
      // Nếu lỗi xảy ra -> thư mục không tồn tại -> tạo mới
      await fs.mkdir(dirPath, { recursive: true });
    }

    // Lấy danh sách ảnh
    const imageFiles = await this.listDriveImagesInFolder(auth, folderId);

    if (imageFiles.length === 0) {
      console.log("📂 Không có ảnh nào trong folder Google Drive.");
      return;
    }
    const delayMs = 1000; // Thời gian chờ giữa các lần tải (1 giây)
    // Upload toàn bộ ảnh (trừ ảnh đầu nếu đã upload ở bước trên)
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const res = await drive.files.get(
        { fileId: file.id, alt: "media" },
        { responseType: "stream" },
      );

      const ext = path.extname(file.name);
      const objectName = `rooms/${room.id}/photos/${room.id}_${i}${ext}`;
      await this.uploadToMinIO(res.data, objectName, this.BUCKETNAME);

      // Sleep sau mỗi lần tải
      console.log(`⏳ Đợi ${delayMs}ms trước khi tải ảnh tiếp theo...`);
      await this.sleep(delayMs); // Dừng 1 giây giữa các lần upload để tránh quá tải
    }

    console.log("✅ Upload hoàn tất!");
  }

  convertDescription2Extension(description) {
    const result = new Set();
    const normalizedDesc = description.toLowerCase();

    // Map to hold matched codes with their priority (higher number = more important)
    const matched = new Map();

    for (const [code, patterns] of Object.entries(extension)) {
      for (const pattern of patterns) {
        const regex = new RegExp(`\\b${pattern}\\b`, "i");
        if (regex.test(normalizedDesc)) {
          matched.set(code, true);
          break;
        }
      }
    }

    for (const group of this.priorityGroups) {
      const found = group.find((code) => matched.has(code));
      if (found) {
        result.add(found);
      } else {
        // If none found, add default
        if (group.includes("1N")) result.add("1N");
        if (group.includes("1WC")) result.add("1WC");
      }
    }

    // Add the rest (e.g., BC, GX, 1K)
    for (const code of matched.keys()) {
      if (!this.priorityGroups.flat().includes(code)) {
        result.add(code);
      }
    }

    return Array.from(result);
  }

  async removeVietnameseTones(str) {
    return str
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/,/g, "")
      .toLowerCase()
      .trim();
  }

  toSlug(str) {
    return str
      .toLowerCase()
      .replace(/đ/g, "d") // chuyển đ → d
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // bỏ dấu
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
  }

  async fuzzySearch(searchTerm, list) {
    // if (searchTerm.includes('Ngõ 52 Quan Nhân')) console.log(searchTerm);

    // Pre-processing to remove text in parentheses to improve match
    let processedSearchTerm = searchTerm.replace(/\s*\(.*?\)\s*/g, "").trim();

    const fuse = new Fuse(list, {
      keys: ["address"],
      includeScore: true,
      threshold: 0.5, // Tăng ngưỡng lệch để tìm kiếm rộng hơn
    });

    // Tìm kiếm với fuse
    const result = fuse.search(processedSearchTerm);
    if (result.length > 0) {
      console.log(
        `Chuỗi gần nhất: ${result[0].item.address} với chuỗi gốc ${searchTerm} (độ chính xác: ${result[0].score.toFixed(2)})`,
      );
      return result[0].item;
    }

    // Fallback: Tìm cứng theo chuỗi slug (giữ lại logic cũ phòng trường hợp fuse không tìm ra)
    for (let item of list) {
      if (
        item.address &&
        this.toSlug(item.address).includes(this.toSlug(processedSearchTerm))
      ) {
        return item;
      }
    }
    return null;
  }

  extractDocumentId(url) {
    const match = url.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  }

  async extractGoogleSheetInfo(url) {
    const regex = /\/spreadsheets\/d\/([^\/]+)\/.*gid=(\d+)/;
    const match = url.match(regex);

    if (match) {
      return {
        spreadsheetId: match[1],
        gid: match[2],
      };
    } else {
      return { spreadsheetId: null, gid: null };
    }
  }

  async convertToCSVLink(editUrl) {
    const spreadsheetMatch = editUrl.match(/\/spreadsheets\/d\/([^\/]+)/);
    const gidMatch = editUrl.match(/gid=(\d+)/);

    if (spreadsheetMatch) {
      let csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetMatch[1]}/export?format=csv`;
      if (gidMatch) {
        csvUrl += `&gid=${gidMatch[1]}`;
      }
      return csvUrl;
    }
    return null;
  }

  async retryRequest(requestFunction, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await requestFunction();
        return response;
      } catch (error) {
        if (error.code == "ECONNRESET" && i < retries - 1) {
          console.warn(`Retrying request (${i + 1}/${retries})...`);
          continue;
        }
        throw error;
      }
    }
  }

  async spreadsheets(spreadsheetId, targetGid) {
    const auth = new google.auth.GoogleAuth({
      keyFile: "ggsheets.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    try {
      const sheets = google.sheets({ version: "v4", auth });
      // 📌 Lấy danh sách sheet để tìm sheet có `gid`
      const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
      const sheet = sheetInfo.data.sheets.find(
        (s) => s.properties.sheetId == targetGid,
      );

      if (!sheet) {
        throw new Error(`Không tìm thấy sheet với gid=${targetGid}`);
      }

      const sheetTitle = sheet.properties.title;
      console.log(`📄 Sheet tìm thấy: ${sheetTitle} (gid: ${targetGid})`);

      // 📌 Lấy thông tin màu nền của từng ô trong sheet
      const response = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`${sheetTitle}`], // Lấy màu từ A1 đến Z100
        includeGridData: true,
        // fields: "sheets.data.rowData.values.effectiveFormat.backgroundColor"
      });
      const getRows = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: sheetTitle,
      });
      const rows = getRows.data.values;
      const data = response.data.sheets[0].data[0].rowData;
      if (data && data.length && rows?.length) {
        const jsonRows = rows.map((row, rowIndex) => {
          const obj = {};
          row.forEach(async (value, colIndex) => {
            const cell = data[rowIndex]?.values[colIndex];
            const backgroundColor = cell?.effectiveFormat?.backgroundColor;
            const textColor =
              cell?.effectiveFormat?.textFormat?.foregroundColor;
            const backgroundColorHex = backgroundColor
              ? this.rgbaToHex(
                  backgroundColor.red,
                  backgroundColor.green,
                  backgroundColor.blue,
                  backgroundColor.alpha,
                )
              : null;
            const textColorHex = textColor
              ? this.rgbaToHex(
                  textColor.red,
                  textColor.green,
                  textColor.blue,
                  textColor.alpha,
                )
              : null;

            const hyperlink =
              cell?.hyperlink ||
              cell?.textFormatRuns?.find((run) => run.format.link)?.format.link
                .uri ||
              null;
            obj[`field${colIndex}`] = {
              value,
              bgColor: backgroundColorHex,
              textColor: textColorHex,
              hyperlink: hyperlink,
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
      console.error(
        `An error occurred in spreadsheets (${spreadsheetId}, ${targetGid}):`,
        error,
      );
    }
  }

  rgbaToHex(r = 0, g = 0, b = 0, a = 1) {
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

  getAllDuplicateIndexes(arr) {
    const map = new Map();

    arr.forEach((item, index) => {
      if (!map.has(item)) {
        map.set(item, []);
      }
      map.get(item).push(index);
    });

    // Lọc ra chỉ những phần tử xuất hiện > 1 lần
    const duplicates = [];
    for (const [key, indexes] of map.entries()) {
      if (indexes.length > 1 && key !== null && key !== undefined) {
        duplicates.push({ value: key, indexes });
      }
    }

    return duplicates;
  }

  getRangeFromSheetData(data, rangeStr) {
    const [start, end] = rangeStr.split(":");

    // Chuyển chữ cột sang số (A => 0, H => 7)
    const colToIndex = (col) => {
      return (
        col
          .toUpperCase()
          .split("")
          .reduce((acc, char) => acc * 26 + (char.charCodeAt(0) - 64), 0) - 1
      );
    };

    const getRowCol = (ref) => {
      const match = ref.match(/^([A-Z]+)(\d+)$/);
      if (!match) throw new Error("Invalid cell ref");
      const [, col, row] = match;
      return { row: parseInt(row, 10) - 1, col: colToIndex(col) };
    };

    const { row: startRow, col: startCol } = getRowCol(start);
    const { row: endRow, col: endCol } = getRowCol(end);

    // Xử lý mảng object
    const result = data.slice(startRow, endRow + 1).map((rowObj) => {
      const row = [];
      for (let i = startCol; i <= endCol; i++) {
        row.push(rowObj[`field${i}`].value || "");
      }
      return row;
    });

    return result.join(". ");
  }

  async readGoogleDocByLink(docUrl) {
    if (docUrl == null || docUrl == undefined) return "";
    if (!docUrl.startsWith("https://docs.google.com/document/d/")) {
      return "";
    }
    const documentId = this.extractDocumentId(docUrl);

    if (!documentId) {
      return "";
    }

    // Xác thực OAuth2
    const auth = new google.auth.GoogleAuth({
      keyFile: "ggsheets.json", // thay bằng path thật
      scopes: [
        "https://www.googleapis.com/auth/documents.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
    });

    try {
      const drive = google.drive({ version: "v3", auth });
      const metadata = await drive.files.get({
        fileId: documentId,
        fields: "mimeType, name",
      });

      let text = "";
      if (metadata.data.mimeType === "application/vnd.google-apps.document") {
        const docs = google.docs({ version: "v1", auth });
        const res = await docs.documents.get({ documentId });
        const content = res.data.body.content;
        for (const element of content) {
          if (element.paragraph) {
            for (const elem of element.paragraph.elements || []) {
              if (elem.textRun) {
                text += elem.textRun.content;
              }
            }
          }
        }
      } else if (
        metadata.data.mimeType ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        metadata.data.mimeType === "application/msword"
      ) {
        // Tải file .docx / .doc về dưới dạng buffer và đọc bằng mammoth
        const res = await drive.files.get(
          { fileId: documentId, alt: "media" },
          { responseType: "arraybuffer" },
        );
        const result = await mammoth.extractRawText({
          buffer: Buffer.from(res.data),
        });
        text = result.value;
      } else {
        console.warn(
          `⚠️ Bỏ qua: File "${metadata.data.name}" (${documentId}) là định dạng ${metadata.data.mimeType}, không hỗ trợ đọc nội dung.`,
        );
        return "";
      }

      return text;
    } catch (error) {
      if (error.code === 403 || error.code === 404) {
        console.error(
          `❌ Không có quyền truy cập hoặc không tìm thấy Doc: ${docUrl}`,
        );
      } else {
        console.error(`❌ Lỗi khi đọc Doc (${docUrl}): ${error.message}`);
      }
      return "";
    }
  }

  isEmpty(value) {
    return (
      value == null || // null hoặc undefined
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    );
  }

  async processCsvData(huydev) {
    try {
      let sheetData;
      if (huydev.if == "caocap") {
        const { spreadsheetId, gid } = await this.extractGoogleSheetInfo(
          huydev.link,
        );
        sheetData = await this.spreadsheets(spreadsheetId, gid);
      }

      if (huydev.if == "binhthuong") {
        const csvUrl = await this.convertToCSVLink(huydev.link);
        const response = await axios.get(csvUrl);
        const data = await csvtojson().fromString(response.data);

        const worksheet = xlsx.utils.json_to_sheet(data);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, "Sheet1");
        sheetData = xlsx.utils.sheet_to_json(worksheet);
      }
      if (!sheetData) {
        return [];
      }
      let results = sheetData;

      let header = [];
      if (huydev.header) {
        header = results[huydev.header];
      }
      // Ghi nhận tổng số phòng ban đầu (trước khi lọc theo trạng thái exit/kín)
      let initialValidRooms = results.filter((row) => {
        let addr = row[`field${huydev.address_column[0]}`]?.value;
        if (!addr || addr.toLowerCase().trim() === "địa chỉ") return false;
        let room = row[`field${huydev.room_column[0]}`]?.value;
        return room ? true : false;
      }).length;
      huydev.totalPhongLayDuoc = initialValidRooms;

      // color
      if (huydev.exitBackgroundColor && huydev.exitColumnColor !== null) {
        results = results.filter(
          (row) =>
            !huydev.exitBackgroundColor.includes(
              row[`field${huydev.exitColumnColor}`]?.bgColor,
            ),
        );
      }
      // text color
      if (huydev.exitTextColor && huydev.exitColumnColor !== null) {
        results = results.filter(
          (row) =>
            !huydev.exitTextColor.includes(
              row[`field${huydev.exitColumnColor}`]?.textColor,
            ),
        );
      }
      // text
      if (huydev.exitColumn !== null && huydev.exit.length > 0) {
        let exit = (huydev.exit || []).map((item) =>
          item?.toLowerCase().trim(),
        );
        results = results.filter((row) => {
          let cellValue = row[`field${huydev.exitColumn}`]?.value;
          let text = cellValue ? cellValue.toString().trim().toLowerCase() : "";
          return !exit.includes(text);
        });
      }

      // address ngang thành dọc
      // if (
      //   huydev.columnVertical !== null &&
      //   huydev.colorExitVerticalBg !== null
      // ) {
      //   this.copyValueToLastField(results, huydev.columnVertical, {
      //     key: "bgColor",
      //     value: huydev.colorExitVerticalBg,
      //   });
      // }

      // if (
      //   huydev.columnVertical !== null &&
      //   huydev.colorExitVerticalText !== null
      // ) {
      //   this.copyValueToLastField(results, huydev.columnVertical, {
      //     key: "textColor",
      //     value: huydev.colorExitVerticalText,
      //   });
      // }
      const combinedColumns = [
        ...huydev.address_column,
        ...huydev.room_column,
        ...huydev.building_code_column,
        ...huydev.price_column,
      ];
      const findDouble = this.getAllDuplicateIndexes(combinedColumns);
      let datas = [];
      let count = 0;
      let address;
      for (let row of results) {
        count++;
        // if(huydev?.header && count <= huydev.header) {
        //   continue; // Bỏ qua các hàng trước header
        // }
        if (
          !this.isEmpty(huydev?.columnVertical) &&
          !this.isEmpty(huydev?.colorExitVerticalBg)
        ) {
          if (
            row[`field${huydev.columnVertical}`]?.bgColor.includes(
              huydev.colorExitVerticalBg,
            )
          ) {
            address = row[`field${huydev.columnVertical}`]?.value;
            if (address.includes(":")) {
              address = address.split(":")[1].trim(); // Lấy phần sau dấu ":"
            }
            continue; // Bỏ qua các hàng có màu nền đã chỉ định
          }
        } else {
          let tempAddr = row[`field${huydev.address_column[0]}`]?.value; // Lấy địa chỉ từ cột đã chỉ định
          if (
            tempAddr !== undefined &&
            tempAddr !== null &&
            tempAddr.toString().trim() !== ""
          ) {
            address = tempAddr;
          }
        }

        if (!address || address.toLowerCase().trim() === "địa chỉ") {
          continue; // Bỏ qua nếu địa chỉ không hợp lệ
        }

        let description = "";
        if (huydev?.mota && huydev?.mota?.length > 0) {
          const docContents = [];
          const textContents = [];

          for (const item of huydev.mota) {
            let cellValue = "";
            let hyperlink = "";

            if (typeof item === "string") {
              cellValue = this.getRangeFromSheetData(results, item);
            } else {
              cellValue = row[`field${item}`]?.value;
              hyperlink = row[`field${item}`]?.hyperlink;
            }

            // Prioritize Google Doc content
            if (
              hyperlink &&
              hyperlink.includes("docs.google.com/document/d/")
            ) {
              const content = await this.readGoogleDocByLink(hyperlink);
              if (content) docContents.push(content);
            } else if (
              cellValue &&
              cellValue.toString().includes("docs.google.com/document/d/")
            ) {
              const urlMatch = cellValue
                .toString()
                .match(
                  /https:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_-]+/,
                );
              if (urlMatch) {
                const content = await this.readGoogleDocByLink(urlMatch[0]);
                if (content) docContents.push(content);
              }
            } else if (cellValue) {
              const headerVal =
                typeof item === "number"
                  ? header[`field${item}`]?.value || ""
                  : "";
              textContents.push(
                headerVal ? `${headerVal}: ${cellValue}` : cellValue,
              );
            }
          }

          description = [...textContents, ...docContents].join(". ");
        }

        const roomCols = huydev.room_column;
        const priceCols = huydev.price_column;
        const bldCol = huydev.building_code_column[0];

        const buildingCode =
          bldCol !== null && row[`field${bldCol}`]?.value
            ? row[`field${bldCol}`]?.value
            : null;

        roomCols.forEach((roomCol, i) => {
          const priceCol =
            priceCols && priceCols[i] !== undefined
              ? priceCols[i]
              : priceCols
                ? priceCols[0]
                : null;
          if (roomCol === null || !row[`field${roomCol}`]?.value) return;

          let roomRaw = row[`field${roomCol}`]?.value;
          let priceRaw =
            priceCol !== null ? row[`field${priceCol}`]?.value : null;

          if (huydev.metadata && roomCol === priceCol) {
            const parts = roomRaw.toString().split(huydev.metadata.split);
            if (parts.length > 1) {
              // Based on old logic: ROOM is at index 1, PRICE is at index 3.
              // If metadata.before === 1, ROOM takes parts[0], PRICE takes parts[1].
              roomRaw = parts[huydev.metadata.before === 1 ? 0 : 1]?.trim();
              priceRaw = parts[huydev.metadata.before === 3 ? 0 : 1]?.trim();
            }
          }

          datas.push({
            ADDRESS: address,
            IMAGE_DRIVER: row[`field${huydev.exitLinkDriver}`]?.hyperlink,
            PRICE: this.convertPrice(priceRaw) * (huydev?.hesogia || 1),
            ROOMS: roomRaw,
            DESCRIPTIONS: description,
            BUILDING: buildingCode,
          });
        });
      }
      datas = datas.filter(
        (row) =>
          !row ||
          !row.ADDRESS ||
          !row.ROOMS ||
          row.ADDRESS.toLowerCase().trim() !== "địa chỉ" ||
          row.ADDRESS.toLowerCase().trim() !== "",
      );

      return datas;
    } catch (error) {
      console.error(`Có lỗi xảy ra: ${error}`);
    }
  }

  // config
  copyValueToLastField(results, column, exitCondition) {
    let copiedValue = null;
    for (let i = 0; i < results.length; i++) {
      const obj = results[i];

      if (
        obj[`field${column}`] &&
        obj[`field${column}`][exitCondition.key] === exitCondition.value
      ) {
        copiedValue = obj[`field${column}`].value;
      } else if (copiedValue) {
        let fieldCount = Object.keys(obj).length;
        obj[`field${fieldCount}`] = { value: copiedValue };
      }
    }
  }

  async run() {
    try {
      this.runStats = {};
      let totalTrong = 0;
      let totalTaoMoi = 0;
      let cdtStats = {};

      await fs.writeFile("thong_ke.txt", "");
      await sendTelegramMessage("Bắt đầu cập nhật...");
      let investors = [];
      let flag = false;
      for (let huydev of this.LIST_GGSHEET) {
        if (flag || huydev.id >= this.START_ID) {
          flag = true;
        } else {
          continue;
        }

        if (!cdtStats[huydev.id]) {
          cdtStats[huydev.id] = {
            trong: 0,
            taoMoi: 0,
            error: false,
            empty: true,
            totalDong: 0,
            link: huydev.link,
          };
        }

        let missingAddresses = new Set();

        console.log(
          `------------------------------------------------------- ${huydev.web} ------------------------------------------------------------------ `,
        );
        const formattedDate = this.getFormattedDate();
        const entryExitsRun = `${huydev.web}|${formattedDate}|TRUE`;
        const exitRunMismatch = await this.checkIfEntryExists(
          "exits.txt",
          entryExitsRun,
        );
        if (!exitRunMismatch) {
          // run
          try {
            for (let idSheetUrl of huydev.list_address) {
              const searchRealnews = await this.searchRealnewByInvestor(
                huydev.id,
              );
              console.log(
                `[DEBUG] CDT ${huydev.id} found ${searchRealnews.content.length} buildings on web.`,
              );
              searchRealnews.content.forEach((b) =>
                console.log(
                  `  - Web Building: ${b.id} | ${b.code} | ${b.address_valid}`,
                ),
              );

              if (huydev?.id && !investors.includes(huydev.id)) {
                // update all room of realnews kín
                for (let item of searchRealnews.content) {
                  const searchRooms = await this.searchRoom(item.id);
                  console.log(
                    `Đang cập nhật phòng kín cho tòa nhà ${item.id} - ${item.code} - ${item.address_valid} - ${searchRooms?.content?.length} phòng`,
                  );
                  await this.updateRoomByRealnew(searchRooms?.content || []);
                }
                investors.push(huydev.id);
              }

              const processedData = await this.processCsvData(huydev);
              if (!processedData) {
                console.log("link bảng hàng::", huydev.link);
                console.log("Bảng hàng này bị lỗi trên ggsheet.");
                cdtStats[huydev.id].error = true;
                break;
              }
              console.log("SỐ LƯỢNG BẢNG HÀNG ", processedData?.length);

              if (processedData?.length > 0) {
                cdtStats[huydev.id].totalDong +=
                  huydev.totalPhongLayDuoc || processedData.length;
                cdtStats[huydev.id].empty = false;
                for (let row of processedData) {
                  if (
                    row.hasOwnProperty("ADDRESS") &&
                    row.hasOwnProperty("ROOMS") &&
                    row["ADDRESS"] !== ""
                  ) {
                    if (row["ADDRESS"] && row["ROOMS"]) {
                      console.log(
                        `[DEBUG] Row processing: ADDRESS="${row["ADDRESS"]}" ROOMS="${row["ROOMS"]}"`,
                      );
                      if (searchRealnews && searchRealnews.content.length > 0) {
                        const item = await this.fuzzySearch(
                          row["ADDRESS"],
                          searchRealnews.content,
                        );
                        if (item) {
                          console.log(
                            `[DEBUG] Matched "${row["ADDRESS"]}" to building ${item.id} (${item.address_valid})`,
                          );
                          const searchRooms = await this.searchRoom(item.id);

                          if (searchRooms?.content) {
                            // cập nhật room
                            const roomsInput = this.convertRoom(row["ROOMS"]);
                            const matchedRoomIds = new Set();
                            for (const roomRef of roomsInput) {
                              const roomNumbersArray =
                                await this.replaceAbbreviations(
                                  roomRef,
                                  huydev.type,
                                );

                              for (const roomNumber of roomNumbersArray) {
                                const room = searchRooms?.content.find(
                                  (room) =>
                                    room.name.trim().toLowerCase() ==
                                    roomNumber.trim().toLowerCase(),
                                );

                                if (room && !matchedRoomIds.has(room.id)) {
                                  matchedRoomIds.add(room.id);
                                  console.log("roomNumber", roomNumber);
                                  // Luôn đếm là phòng trống trong báo cáo nếu thấy trong sheet
                                  this.incrementRunStats(huydev, item, "trong");

                                  const formattedDateIter =
                                    this.getFormattedDate();
                                  const entryContent = `${
                                    huydev.link + idSheetUrl
                                  }|${item.id}|${item.code}|${
                                    row["ADDRESS"]
                                  }|${room.id}|${roomNumber}|${formattedDateIter}`;

                                  const unlockedRoomsContent =
                                    await this.checkIfEntryExists(
                                      "capnhattrong.txt",
                                      entryContent,
                                    );

                                  if (!unlockedRoomsContent) {
                                    console.log(
                                      `Đã tìm thấy phòng ${roomNumber}, đang gọi unlockRoom...`,
                                    );
                                    await this.updateRoom_RONG_PRICE_FB_DRIVER(
                                      room,
                                      row,
                                      item,
                                      huydev,
                                      idSheetUrl,
                                      roomNumber,
                                    );
                                  } else {
                                    console.log(
                                      `Phòng ${roomNumber} có ID ${room.id} đã được mở khóa.`,
                                    );
                                  }
                                } else if (!room) {
                                  // Logic tạo phòng mới nếu không tìm thấy room pattern trên web
                                  // Nhưng chỉ tạo nếu roomNumber này chưa được tạo/xử lý
                                  const formattedDate = this.getFormattedDate();
                                  const entryContentNotRoom = `${
                                    huydev.link + idSheetUrl
                                  }|${item.code}|${
                                    row["ADDRESS"]
                                  }|${roomNumber}|${formattedDate}`;

                                  const notFoundRoom =
                                    await this.checkIfEntryExists(
                                      "phongmoi.txt",
                                      entryContentNotRoom,
                                    );

                                  if (!notFoundRoom) {
                                    // Tạo phòng mới... (Omitted for brevity, but I should keep it)

                                    let data = {
                                      real_new_id: item.id,
                                      name: roomNumber,
                                      price: row["PRICE"] || 0,
                                      rent_price_hour: 0,
                                      rent_price_day: 0,
                                      area: 0,
                                      status: "con",
                                      empty_room_date: dayjs(new Date()).format(
                                        "YYYY-MM-DD",
                                      ),
                                      image_link:
                                        room?.image_link || row["IMAGE_DRIVER"],
                                      origin_link: row["IMAGE_DRIVER"] || "",
                                      is_deleted: false,
                                      description: row["DESCRIPTIONS"] || "",
                                    };
                                    const res = await this.createRoom(data);
                                    if (res) {
                                      this.incrementRunStats(
                                        huydev,
                                        item,
                                        "taoMoi",
                                      );
                                      this.incrementRunStats(
                                        huydev,
                                        item,
                                        "trong",
                                      );
                                    }
                                    await this.updateRoom_RONG_PRICE_FB_DRIVER(
                                      res,
                                      row,
                                      item,
                                      huydev,
                                      idSheetUrl,
                                      roomNumber,
                                    );
                                    await this.appendToFile(
                                      "phongmoi.txt",
                                      `${huydev.link + idSheetUrl}|${item.code}|${
                                        row["ADDRESS"]
                                      }|${res?.id}|${roomNumber}|${formattedDate}|${
                                        huydev.web
                                      } ${res ? "Tạo phòng mới thành công" : "Tạo phòng mới thất bại"}\n`,
                                    );
                                  } else {
                                    console.log(
                                      `Phòng này ${roomNumber} đã tồn tại trong phongmoi.txt`,
                                    );
                                  }
                                }
                              }
                            }
                          } else {
                            console.log(
                              "No rooms found or searchRooms.content is undefined.",
                            );
                          }
                        } else {
                          const formattedDate = this.getFormattedDate();
                          const entryAddressContent = `${
                            huydev.link + idSheetUrl
                          }|${row["ADDRESS"]}|${formattedDate}`;

                          const noAddress = await this.checkIfEntryExists(
                            "nhamoi.txt",
                            entryAddressContent,
                          );

                          if (!noAddress) {
                            const errorMsg = `⚠️ KHÔNG TÌM THẤY ĐỊA CHỈ: ${row["ADDRESS"]} (Bảng hàng: ${huydev.web})`;
                            console.log(`\x1b[31m[DANGER] ${errorMsg}\x1b[0m`);
                            // await sendTelegramMessage(errorMsg);
                            missingAddresses.add(row["ADDRESS"]);
                            await this.appendToFile(
                              "thong_ke.txt",
                              `${this.getFormattedDate()} - KHÔNG TÌM THẤY ĐỊA CHỈ: ${row["ADDRESS"]} - ${huydev.web}\n`,
                            );

                            const formattedDate = this.getFormattedDate();

                            // let data = {
                            //   "code": `${new Date().getTime()}`,
                            //   "title": row["ADDRESS"],
                            //   "slugname": this.stringToSlug(row["ADDRESS"]),
                            //   "intro":  row["DESCRIPTIONS"] || "",
                            //   "content": row["DESCRIPTIONS"] || "",
                            //   "service_type": "string",
                            //   "service_time": new Date(),
                            //   "type": "chdv",
                            //   "status": "con",
                            //   "price": row["PRICE"] || 0,
                            //   "address": row["ADDRESS"],
                            //   "price": 0,
                            //   "rent_price_hour": 0,
                            //   "rent_price_day": 0,
                            //   "rent_price_month":  row["PRICE"] || 0,
                            //   "is_public": true,
                            //   "sale_bonus": 0,
                            //   "province_id": 0,
                            //   "district_id": 0,
                            //   "fb_group_url": "",
                            //   "fb_page_url": "",
                            //   "point": 0,
                            //   "owner_name": "",
                            //   "owner_phone": "",
                            //   "manager_phone": "",
                            //   "created_by": 0,
                            //   "created_time": new Date(),
                            //   "thumbnail": "",
                            //   "rent_time": "",
                            //   "bedroom_number": 0,
                            //   "floor_number": 0,
                            //   "acreage": 0,
                            //   "member_id": 0,
                            //   "rent_enddate": dayjs(new Date()).format('YYYY-MM-DD'),
                            //   "request_id": 0,
                            //   "address_valid": "",
                            //   "activity_time": new Date(),
                            //   "ophone_duplicate": 0,
                            //   "vaddress_duplicate": 0,
                            //   "rooms": `[]`,
                            //   "hide_revenue_expenditure": true,
                            //   "telegram_group": "",
                            //   "email": "",
                            //   "bank_account": "",
                            //   "collaborator_price": "",
                            //   "wholesale_price": "",
                            //   "want_borrow": 0,
                            //   "accountant_phone": "",
                            //   "is_list": true,
                            //   "created_at": new Date(),
                            //   "updated_at": null,
                            //   "is_list": true,
                            //   "updated_by": null,
                            //   "latitude": 0,
                            //   "longitude": 0,
                            //   "coordinates_valid": true,
                            //   "chu_dau_tu":  huydev.id,
                            // }

                            // const res = await this.createRealnew(data);
                            await this.appendToFile(
                              "nhamoi.txt",
                              `${huydev.link + idSheetUrl}|${row["ADDRESS"]}|${formattedDate}|${huydev.web} \n `,
                            );
                          } else {
                            console.log(
                              "Không tìm thấy địa chỉ trùng tên trong web.",
                            );
                          }
                        }
                      } else {
                        console.log(
                          "Tìm kiếm " +
                            row["ADDRESS"] +
                            "phòng " +
                            row["ROOMS"],
                          searchRealnews.content,
                        );

                        const formattedDate = this.getFormattedDate();
                        const entryHollowContent = `${huydev.link + idSheetUrl}|${
                          row["ADDRESS"]
                        }|${row["ROOMS"]}|${formattedDate}`;

                        const arrayHollowAddress =
                          await this.checkIfEntryExists(
                            "khongcodulieu.txt",
                            entryHollowContent,
                          );

                        if (!arrayHollowAddress) {
                          const formattedDate = this.getFormattedDate();
                          await this.appendToFile(
                            "khongcodulieu.txt",
                            `${huydev.link + idSheetUrl}|${row["ADDRESS"]}|${
                              row["ROOMS"]
                            }|${formattedDate}|${huydev.web}\n`,
                          );

                          const errorMsg = `⚠️ KHÔNG CÓ DỮ LIỆU TÒA NHÀ TRÊN WEB: ${row["ADDRESS"]} (Bảng hàng: ${huydev.web})`;
                          console.log(`\x1b[31m[DANGER] ${errorMsg}\x1b[0m`);
                          // await sendTelegramMessage(errorMsg);
                          missingAddresses.add(row["ADDRESS"]);
                          await this.appendToFile(
                            "thong_ke.txt",
                            `${this.getFormattedDate()} - KHÔNG CÓ DỮ LIỆU TÒA NHÀ TRÊN WEB: ${row["ADDRESS"]} - ${huydev.web}\n`,
                          );
                        } else {
                          console.log(
                            `Đã tồn tại dữ liệu trong khongcodulieu.txt`,
                          );
                        }
                      }
                    } else {
                      console.log("Missing data in row:", row);
                      const formattedDate = this.getFormattedDate();
                      const entryContentroomsMismatch = `${
                        huydev.link + idSheetUrl
                      }|${row["BUILDING"]}|${row["ADDRESS"]}|${formattedDate}`;

                      const roomsMismatch = await this.checkIfEntryExists(
                        "ggsheet.txt",
                        entryContentroomsMismatch,
                      );

                      if (!roomsMismatch) {
                        const formattedDate = this.getFormattedDate();
                        await this.appendToFile(
                          "ggsheet.txt",
                          `${huydev.link + idSheetUrl}|${row["BUILDING"]}|${
                            row["ADDRESS"]
                          }|${formattedDate}|${huydev.web}\n`,
                        );
                      } else {
                        console.log(
                          `Đã lưu lỗi phòng trống vào file không có phòng ở google sheet.txt`,
                        );
                      }
                    }
                  } else {
                    console.log(
                      'Missing "ADDRESS" or "ROOMS" property in row:',
                      row,
                    );
                  }
                }

                if (this.runStats) {
                  for (let key in this.runStats) {
                    const stats = this.runStats[key];
                    totalTrong += stats.trong;
                    totalTaoMoi += stats.taoMoi;
                    const text = `Mã cdt: ${stats.cdt} | Mã tòa: ${stats.toa} | Trống: ${stats.trong} | Tạo mới: ${stats.taoMoi} | ${this.getFormattedDate()} | ${stats.bot}`;
                    await this.appendToFile("thong_ke.txt", `${text} \n`);

                    if (!cdtStats[stats.cdt]) {
                      cdtStats[stats.cdt] = {
                        trong: 0,
                        taoMoi: 0,
                        error: false,
                        empty: true,
                        totalDong: 0,
                      };
                    }
                    cdtStats[stats.cdt].trong += stats.trong;
                    cdtStats[stats.cdt].taoMoi += stats.taoMoi;
                  }
                  this.runStats = {}; // clear for next sheet
                }
              } else {
                console.log("Không có dữ liệu để xử lý.");
              }
            }

            // Gửi báo cáo địa chỉ thiếu sau khi chạy xong 1 CDT
            if (missingAddresses.size > 0) {
              const missingList = Array.from(missingAddresses).join("\n+ ");
              const summaryMsg = `❌ DANH SÁCH ĐỊA CHỈ THIẾU (${huydev.web}):\n+ ${missingList}`;
              await sendTelegramMessage(summaryMsg);
            }
            const formattedDate = this.getFormattedDate();
            await this.appendToFile(
              "exits.txt",
              `${huydev.web}|${formattedDate}|TRUE\n`,
            );
          } catch (err) {
            console.error("Lỗi trong quá trình chạy" + huydev.web, err);
            cdtStats[huydev.id].error = true;
            const formattedDate = this.getFormattedDate();
            await this.appendToFile(
              "exits.txt",
              `${huydev.web}|${formattedDate}|FALSE\n`,
            );
          }
          // quit
        } else {
          console.log(
            `Link GGSHEET + ${huydev.web} đã được thực thi. nếu muốn chạy lại vui lòng vào exits.txt để cập nhật thành false hoặc delete.`,
          );
        }
      }

      // Calculate totals and build final message
      let finalMessages = [];
      for (let cdt in cdtStats) {
        let fileLine = `Mã cdt: ${cdt} | Tổng dòng: ${cdtStats[cdt].totalDong}`;
        if (cdtStats[cdt].error && cdtStats[cdt].link) {
          fileLine += ` | Lỗi link: ${cdtStats[cdt].link}`;
        }
        await this.appendToFile("thong_ke.txt", `${fileLine} \n`);

        if (cdtStats[cdt].error || cdtStats[cdt].empty) {
          finalMessages.push(
            `Mã cdt: ${cdt} không có phòng nào hoặc bị lỗi link`,
          );
        } else {
          let message = `Mã cdt: ${cdt} | Tổng dòng: ${cdtStats[cdt].totalDong}`;
          if (cdtStats[cdt].trong > 0 || cdtStats[cdt].taoMoi > 0) {
            message += ` | Trống: ${cdtStats[cdt].trong} | Tạo mới: ${cdtStats[cdt].taoMoi}`;
          }
          finalMessages.push(message);
        }
      }

      if (finalMessages.length > 0) {
        const BATCH_SIZE = 20;
        for (let i = 0; i < finalMessages.length; i += BATCH_SIZE) {
          let chunk = finalMessages.slice(i, i + BATCH_SIZE);
          if (i + BATCH_SIZE >= finalMessages.length) {
            let finalMessageText =
              chunk.join("\n") +
              `\nTổng Trống: ${totalTrong} | Tổng Tạo mới: ${totalTaoMoi} | ${this.getFormattedDate()}`;
            await sendTelegramMessage(finalMessageText);
          } else {
            let finalMessageText = chunk.join("\n");
            await sendTelegramMessage(finalMessageText);
          }
          await this.sleep(1000); // Tránh rate limit telegram khi gửi nhiều
        }
      } else if (totalTrong > 0 || totalTaoMoi > 0) {
        const finalMessage = `Trống: ${totalTrong} | Tạo mới: ${totalTaoMoi} | ${this.getFormattedDate()}`;
        await sendTelegramMessage(finalMessage);
      } else {
        const finalMessage = `Không có cập nhật mới | ${this.getFormattedDate()}`;
        await sendTelegramMessage(finalMessage);
      }

      await sendTelegramMessage("Hoàn thành");
    } catch (error) {
      console.log("Lỗi ngoài cùng", error);
    }
  }

  // update phòng
  async updateRoom_RONG_PRICE_FB_DRIVER(
    room,
    row,
    item,
    huydev,
    idSheetUrl,
    roomNumber,
  ) {
    const formattedDate = this.getFormattedDate();
    await this.unlockRoom(room.id);

    await this.appendToFile(
      "capnhattrong.txt",
      `${huydev.link + idSheetUrl}|${item.id}|${item.code}|${
        row["ADDRESS"]
      }|${room.id}|${roomNumber}|${formattedDate}|${huydev.web}\n`,
    );
    console.log(`Phòng ${roomNumber} với ID ${room.id} đã được mở khóa.`);
    let description = room?.description;
    let price = room?.price;
    if (row["DESCRIPTIONS"]) {
      description = row["DESCRIPTIONS"];
      const extension = this.convertDescription2Extension(description);
      console.log(extension);
      const res = await this.callApi({
        domain: `https://apiv1.sari.vn/v1`,
        path: `/tag-relations/room/${room.id}`,
        method: "PUT",
        data: extension,
      });
      if (res.status !== 200) {
        console.log("Cập nhật trống thất bại");
      } else {
        console.log("room.id=>>>>", room.id);
        console.log("Cập nhật trống thành công");
      }
    }

    const priceConvert = row["PRICE"];
    console.log(
      "Giá CŨ ĐÃ EDIT :",
      priceConvert + " Giá WEB SARI :",
      room.price,
    );

    if (room.price !== priceConvert) {
      price = priceConvert;

      await this.appendToFile(
        "capnhatgia.txt",
        `${huydev.link + idSheetUrl}|${item.code}|${
          row["ADDRESS"]
        }|${room.id}|${roomNumber}|${
          room.price
        }(CŨ)|${priceConvert}(MỚI)|${formattedDate}|${huydev.web}\n`,
      );
    }

    await this.updateRoom(room.id, {
      description: description,
      price: price,
    });
    console.log(
      `Phòng ${roomNumber} với ID ${room.id} và đã được cập nhật giá ${row["PRICE"]} và mô tả ${row["DESCRIPTIONS"]} thành công.`,
    );
  }
  // update price
  async updateAndLogPrice(
    room,
    row,
    roomNumber,
    huydev,
    idSheetUrl,
    item,
    formattedDate,
  ) {
    const priceConvert = this.convertPrice(row["PRICE"]);
    console.log(
      "Giá CŨ ĐÃ EDIT :",
      priceConvert + " Giá WEB SARI :",
      room.price,
    );

    if (room.price !== priceConvert) {
      await this.updateRoom(room.id, { price: priceConvert });

      await this.appendToFile(
        "capnhatgia.txt",
        `${huydev.link + idSheetUrl}|${item.code}|${
          row["ADDRESS"]
        }|${room.id}|${roomNumber}|${
          room.price
        }(CŨ)|${priceConvert}(MỚI)|${formattedDate}|${huydev.web}\n`,
      );
      console.log(
        `Phòng ${roomNumber} với ID ${room.id} và đã được cập nhật giá ${row["PRICE"]}.`,
      );
    }
  }
  // kiểm tra fb có chưa
  async logImageLinkStatus(
    room,
    row,
    roomNumber,
    huydev,
    idSheetUrl,
    item,
    formattedDate,
  ) {
    if (!room.image_link) {
      await this.appendToFile(
        "facebook.txt",
        `${huydev.link + idSheetUrl}|${item.code}|${
          row["ADDRESS"]
        }|${roomNumber}|CHƯA CÓ LINK FB|${formattedDate}|${huydev.web}\n`,
      );
      console.log(`Phòng ${roomNumber} với ID ${room.id} chưa có link FB.`);
    }
  }
  // update link driver
  async updateAndDriver(
    room,
    row,
    roomNumber,
    huydev,
    idSheetUrl,
    item,
    formattedDate,
  ) {
    if (row["IMAGE_DRIVER"]) {
      await this.updateRoom(room.id, { origin_link: row["IMAGE_DRIVER"] });
      await this.downloadAllFilesFromFolder(
        row["IMAGE_DRIVER"],
        room,
        "downloads",
      );

      await this.appendToFile(
        "capnhatdriver.txt",
        `${huydev.link + idSheetUrl}|${item.code}|${
          row["ADDRESS"]
        }|${roomNumber}|${row["IMAGE_DRIVER"]}(MỚI)|${formattedDate}|${
          huydev.web
        }\n`,
      );
      console.log(
        `Phòng ${roomNumber} với ID ${room.id} và đã được cập nhật hình từ driver link ${row["IMAGE_DRIVER"]}.`,
      );
    } else {
      const formattedDate = this.getFormattedDate();
      const entryContentIMAGE_DRIVERMismatch = `${huydev.link + idSheetUrl}|${
        row["BUILDING"]
      }|${row["ADDRESS"]}|KHÔNG CÓ LINK DRIVER|${formattedDate}|${huydev.web}`;

      const driversMismatch = await this.checkIfEntryExists(
        "ggsheet.txt",
        entryContentIMAGE_DRIVERMismatch,
      );

      if (!driversMismatch) {
        const formattedDate = this.getFormattedDate();
        await this.appendToFile(
          "ggsheet.txt",
          `${huydev.link + idSheetUrl}|${row["BUILDING"]}|${
            row["ADDRESS"]
          }|KHÔNG CÓ LINK DRIVER|${formattedDate}|${huydev.web}\n`,
        );
      } else {
        console.log(
          `Đã lưu lỗi driver vào file không có driver ở google sheet.txt`,
        );
      }
    }
  }

  getFormattedDate() {
    const now = new Date();
    return `${now.getDate()}/${
      now.getMonth() + 1
    }/${now.getFullYear()}-${now.getHours()}:${String(
      now.getMinutes(),
    ).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  }

  async appendToFile(fileName, content) {
    await fs.appendFile(fileName, content);
  }

  incrementRunStats(huydev, item, type) {
    if (!this.runStats) this.runStats = {};
    if (!this.runStats[item.code]) {
      this.runStats[item.code] = {
        cdt: huydev.id,
        toa: item.code,
        trong: 0,
        taoMoi: 0,
        bot: huydev.web,
      };
    }
    if (type === "trong") {
      this.runStats[item.code].trong += 1;
    } else if (type === "taoMoi") {
      this.runStats[item.code].taoMoi += 1;
    }
  }

  async checkIfEntryExists(fileName, entryContent) {
    try {
      const fileContent = await fs.readFile(fileName, "utf8");
      return fileContent.includes(entryContent);
    } catch (error) {
      console.error(`Error reading file ${fileName}:`, error);
      return false;
    }
  }

  convertRoom(room) {
    if (!room) {
      return [];
    }
    // Handle multiple delimiters: comma, semicolon, newline
    let data = room.split(/[,\n;]/);
    let separators = ["\\(", "sẵn", "giá"];
    let roomseparate = "+";
    // Tạo biểu thức chính quy từ mảng các separators
    const regex = new RegExp(separators.join("|"), "gi");
    const rooms = [];
    data.forEach((item) => {
      let roomInfo = item.trim();
      if (!roomInfo) return;

      // Tách bỏ phần thông tin phụ sau dấu ( hoặc từ "giá" hoặc từ "sẵn"
      let roomPart = roomInfo.split(regex)[0].trim();
      if (!roomPart) return;

      // Xử lý định dạng 701.1+2+3
      let roomName = roomPart.split(".")[0];
      if (roomPart.split(".").length > 1) {
        roomPart
          .split(".")[1]
          .split(roomseparate)
          .forEach((suffix) => {
            rooms.push(`${roomName}.${suffix.trim()}`);
          });
      } else {
        rooms.push(roomName);
      }
    });
    return rooms;
  }

  convertPrice(priceStr) {
    if (typeof priceStr === "number") {
      return priceStr;
    }
    if (!priceStr) {
      return 0;
    }

    priceStr = priceStr.toLowerCase();

    // Ưu tiên lấy phần sau chữ "giá" nếu có
    if (priceStr.includes("giá")) {
      const parts = priceStr.split("giá");
      priceStr = parts[parts.length - 1];
    }

    // Thay thế dấu phẩy bằng dấu chấm để xử lý số thập phân
    priceStr = priceStr.replace(/,/g, ".");

    if (priceStr.includes("-") || priceStr.includes("–")) {
      return this.handlePriceRange(priceStr);
    }

    let total = 0;
    let unitFound = false;

    // 1. Xử lý các trường hợp có đơn vị (tr, m, k, trieu, ...)
    // Pattern: [Số] [Đơn vị] [Số phụ]
    const unitPatterns = [
      { regex: /(\d+(\.\d+)?)\s*(tr)(?!ieu|iệu)(\d*)/g, unit: 1000000 },
      {
        regex: /(\d+(\.\d+)?)\s*(m|t(?!r)|trieu|triệu|củ)(\d*)/g,
        unit: 1000000,
      },
      { regex: /(\d+(\.\d+)?)\s*k/g, unit: 1000 },
    ];

    unitPatterns.forEach((pattern) => {
      let match;
      while ((match = pattern.regex.exec(priceStr)) !== null) {
        unitFound = true;
        total += parseFloat(match[1]) * pattern.unit;
        if (match[4] && match[4].length > 0) {
          // Xử lý phần số sau đơn vị (ví dụ 3tr450 -> 3.450.000)
          total += parseInt(match[4].padEnd(6, "0"));
        }
      }
    });

    if (unitFound) {
      return total;
    }

    // 2. Nếu không có đơn vị, xử lý định dạng số có dấu chấm (ví dụ 5.000.000)
    const plainNumberWithDots = priceStr.match(/(\d{1,3})(\.\d{3})+/);
    if (plainNumberWithDots) {
      return parseInt(plainNumberWithDots[0].replace(/\./g, ""));
    }

    // 3. Cuối cùng, lấy số cuối cùng xuất hiện trong chuỗi (thường là giá, tránh số phòng ở đầu)
    const allNumbers = priceStr.match(/\d+/g);
    if (allNumbers && allNumbers.length > 0) {
      return parseInt(allNumbers[allNumbers.length - 1]);
    }

    return total;
  }

  handlePriceRange(rangeStr) {
    const [startStr] = rangeStr.split(/[-–]/).map((part) => part.trim());
    return this.convertPrice(startStr);
  }

  async replaceAbbreviations(text, type = "chdv") {
    const result = [];

    if (type === "chdv") {
      // XXX, pXXX, tX, tầng X, sàn X, phòng X, giường X, gác xép
      const chdvPatterns = [
        /\b[pP]?\d{3}[a-zA-Z]?\b/g, // XXX, pXXX, pXXXA
        /\b[tT]\d+[a-zA-Z]?\b/g, // tX, tXA
        /\bCH\d*[a-zA-Z]?\b/gi, // CH, CHXXX, CHXXXA
        /tầng\s*[a-zA-Z0-9]+/gi, // tầng 6A
        /sàn\s*[a-zA-Z0-9]+/gi, // sàn XA
        /phòng\s*[a-zA-Z0-9]+/gi, // phòng 6A
        /giường\s*\d+/gi, // giường X
        /gác\s*xép/gi, // gác xép
      ];

      chdvPatterns.forEach((pattern) => {
        const matches = text.match(pattern);
        if (matches) {
          result.push(...matches);
        }
      });
    }

    // Xử lý dạng "P303.1.3.5" => ["303.1", "303.3", "303.5"]
    const pMatch = text.match(/P?(\d+)\.([\d.]+)/gi);
    if (pMatch) {
      pMatch.forEach((p) => {
        const [, base, rest] = p.match(/P?(\d+)\.([\d.]+)/i);
        const subs = rest.split(".").map((sub) => `${base}.${sub}`);
        result.push(...subs);
      });
    }

    // Xử lý Tầng x-y-z => Tầng x, Tầng y, ...
    const floorRegex = /tầng\s*(\d+([\s,|+-]*\d+)*)/gi;
    text = text.replace(floorRegex, (_, floors) => {
      const expanded = floors
        .split(/[\s,|+-]+/)
        .map((f) => f.trim())
        .filter((f) => f)
        .map((f) => `Tầng ${f}`);
      result.push(...expanded);
      return "";
    });

    // Xử lý các số phòng còn lại: 201, 301.2, v.v.
    const codeRegex = /(\d{3}(?:\.\d+)?)/g;
    const matchesRoom = text.match(codeRegex);
    if (matchesRoom) result.push(...matchesRoom);

    // if (result.length === 0) result.push(text)

    // Loại bỏ trùng và các chuỗi bị bao chứa bởi chuỗi khác
    const uniqueRaw = [
      ...new Set(result.map((r) => r.toString().toLowerCase())),
    ];
    const unique = uniqueRaw.filter((str, index, arr) => {
      return !arr.some((otherStr, otherIndex) => {
        return index !== otherIndex && otherStr.includes(str);
      });
    });

    return unique;
  }

  async searchRealnew(address) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const searchData = [
        {
          key: "address",
          op: "like",
          firstValue: `${address}`,
          secondValue: "",
        },
      ];

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_REALNEW_SEARCH + `?page=${this.PAGE}&size=${this.SIZE}`,
          searchData,
          { headers: headers },
        ),
      );
      const responseData = response.data;
      return responseData;
    } catch (error) {
      console.error("Error searchRealnew:", error);
      throw error;
    }
  }

  async searchRealnewByInvestor(investor) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const searchData = [
        {
          key: "chu_dau_tu",
          op: "like",
          firstValue: `${investor}`,
          secondValue: "",
        },
      ];

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_REALNEW_SEARCH + `?page=${this.PAGE}&size=${this.SIZE}`,
          searchData,
          { headers: headers },
        ),
      );
      const responseData = response.data;
      return responseData;
    } catch (error) {
      console.error("Error searchRealnew:", error);
      throw error;
    }
  }

  async searchRoom(id) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const searchData = {
        real_new_id: id,
      };

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_ROOM_SEARCH + `?page=${this.PAGE}&size=${this.SIZE}`,
          searchData,
          { headers: headers },
        ),
      );
      const responseData = response.data;
      return responseData;
    } catch (error) {
      console.error("Error searchRoom:", error);
      throw error;
    }
  }

  async unlockRoom(id) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_UNLOCK_ROOM + `?id=${id}`,
          {},
          { headers: headers },
        ),
      );
      const responseData = response.data;
      console.log("Data unlock", responseData);
      return responseData;
    } catch (error) {
      console.error("Error unlockRoom:", error);
      throw error;
    }
  }

  async callApi({ domain, path = "", method = "GET", data = {} }) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };
      let url = domain + path;
      const response = await axios({
        url,
        method,
        data,
        headers,
      });

      return response;
    } catch (error) {
      console.error("❌ Lỗi gọi API:", error.response?.data || error.message);
      return error.response?.data || error.message;
    }
  }

  async updateRoomByRealnew(rooms) {
    try {
      const res = await this.callApi({
        domain: `https://api-legacy.sari.vn/v1`,
        path: `/rooms/lockRoomsToDates`,
        method: "POST",
        data: (rooms || []).map((room) => ({
          roomId: room.id,
          endDate: "2099-12-30",
        })),
      });
      if (res.status !== 200) {
        console.log(`Cập nhật kín ${rooms.length} phòng thất bại`);
      } else {
        console.log(`Cập nhật kín ${rooms.length} phòng thành công`);
      }
      const responseData = res.data;
      return responseData;
    } catch (error) {
      console.error("Error updateRoomManyRooms:", error);
    }
  }

  async updateRoom(id, data) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const response = await this.retryRequest(() =>
        axios.patch(this.URL_API_UPDATE_ROOM + id, data, {
          headers: headers,
        }),
      );
      const responseData = response.data;
      console.log(responseData);
      return responseData;
    } catch (error) {
      console.error("Error updateRoom:", error);
      throw error;
    }
  }

  async createRealnew(data) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const response = await this.retryRequest(() =>
        axios.post("https://api-legacy.sari.vn/v1/realnews", data, {
          headers: headers,
        }),
      );
      const responseData = response?.data;
      console.log("Tạo thành công tòa mới::", response);
      return responseData;
    } catch (error) {
      console.error("Error updateRoom:", error);
      return null;
    }
  }

  async createRoom(data) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };

      const response = await this.retryRequest(() =>
        axios.post("https://api-legacy.sari.vn/v1/rooms", data, {
          headers: headers,
        }),
      );
      const responseData = response.data;
      console.log("Tạo phòng mới thành công ::", responseData);
      return responseData;
    } catch (error) {
      console.error("Error updateRoom:", error);
      return null;
    }
  }

  stringToSlug(str) {
    return str
      .toLowerCase()
      .replace(/đ/g, "d") // thay đ → d
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // xóa dấu
      .replace(/[^a-z0-9\s-]/g, "") // xóa ký tự đặc biệt
      .replace(/\s+/g, "-") // thay khoảng trắng bằng dấu -
      .replace(/-+/g, "-") // gộp nhiều dấu -
      .replace(/^-+|-+$/g, ""); // xóa - đầu và cuối
  }

  async lockRoom(data) {
    try {
      const encodedCredentials = Buffer.from(
        `${this.AUTH_USERNAME}:${this.AUTH_PASSWORD}`,
      ).toString("base64");
      const headers = {
        Authorization: `Basic ${encodedCredentials}`,
        "User-Agent": "bot2nguon*",
      };
      //https://api-legacy.sari.vn/v1/rooms/lockRoomToDate?id=9347&date=2024-08-23

      const response = await this.retryRequest(() =>
        axios.post(
          this.URL_API_LOCK_ROOM + `id=${data.id}&date=${data.date}`,
          {},
          {
            headers: headers,
          },
        ),
      );
      const responseData = response.data;
      console.log(responseData);
      return responseData;
    } catch (error) {
      console.error("Error lockRoom:", error.data);
      throw error;
    }
  }
}

function clearFile() {
  fs.writeFile("exits.txt", "", (err) => {
    if (err) {
      console.error("Error clearing file:", err);
      return;
    }
    console.log("Xóa file thành công.");
  });
}

const reg = new UpdateRoomSari();

// // cái này chạy theo thời gian

// Lịch trình để xóa nội dung tệp tin vào lúc 4 giờ sáng
// cron.schedule('0 4 * * *', () => {
//   console.log('Clearing file content at 04:00 AM');
//   clearFile();
// });

// // // Lịch trình để chạy công việc vào lúc 5 giờ sáng
// cron.schedule('0 5 * * *', async () => {
//   console.log('Running task at 5:00 AM');
//   await reg.run();
// });

// cái này chạy trực tiếp thì phải tắt hẹn giờ ở trên đi từ 2485--> 2495
reg.run();

// ưng chạy cái nào thì mở 1 trong 2 rồi ra lệnh node.ndex.js -> sp cái này lần cuối nhé.
