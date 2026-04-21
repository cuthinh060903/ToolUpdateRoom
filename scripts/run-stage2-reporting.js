require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { clearAndWriteDayColumn } = require("./update-stage2-sheet");
const { sendTelegramMessage } = require("./send-stage2-telegram");

const SUMMARY_PATH = path.join(process.cwd(), "latest-room-audit-summary.txt");
const OPENCLAW_STAGE2_COMMAND = process.env.OPENCLAW_STAGE2_COMMAND;

function runCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
        shell: true,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`Command failed.\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`)
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function validateStage2Output(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Invalid Stage 2 output: output must be an object");
  }

  if (!result.run_time || typeof result.run_time !== "string") {
    throw new Error("Invalid Stage 2 output: missing run_time");
  }

  if (!result.telegram_text || typeof result.telegram_text !== "string") {
    throw new Error("Invalid Stage 2 output: missing telegram_text");
  }

  if (!Array.isArray(result.sheet_rows) || result.sheet_rows.length !== 7) {
    throw new Error(
      "Invalid Stage 2 output: sheet_rows must have exactly 7 strings"
    );
  }

  for (const row of result.sheet_rows) {
    if (typeof row !== "string") {
      throw new Error(
        "Invalid Stage 2 output: every sheet_rows item must be string"
      );
    }
  }
}

async function invokeOpenClaw() {
  if (!OPENCLAW_STAGE2_COMMAND) {
    throw new Error("Missing OPENCLAW_STAGE2_COMMAND in .env");
  }

  const { stdout } = await runCommand(OPENCLAW_STAGE2_COMMAND);

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(
      `OpenClaw output is not valid JSON.\nRaw output:\n${stdout}`
    );
  }

  validateStage2Output(parsed);
  return parsed;
}

async function main() {
  console.log("[Stage2] Starting reporting flow...");

  if (!fs.existsSync(SUMMARY_PATH)) {
    throw new Error(`Summary file not found: ${SUMMARY_PATH}`);
  }

  const summaryText = fs.readFileSync(SUMMARY_PATH, "utf8").trim();
  if (!summaryText) {
    throw new Error("Summary file is empty");
  }

  console.log("[Stage2] Summary file found.");

  // 1. Gọi OpenClaw để sinh output chuẩn
  const stage2Output = await invokeOpenClaw();

  let sheetSuccess = false;
  let telegramSuccess = false;
  let telegramText = stage2Output.telegram_text;

  // 2. Ghi Sheet
  try {
    const sheetResult = await clearAndWriteDayColumn(stage2Output.sheet_rows);
    sheetSuccess = true;
    console.log("[Stage2] Sheet updated:", sheetResult);
  } catch (error) {
    console.error("[Stage2] Sheet update failed:", error.message);
    telegramText = `[CANH BAO] Sheet update fail\n${telegramText}`;
  }

  // 3. Gửi Telegram
  try {
    await sendTelegramMessage(telegramText);
    telegramSuccess = true;
    console.log("[Stage2] Telegram sent successfully.");
  } catch (error) {
    console.error("[Stage2] Telegram send failed:", error.message);
  }

  // 4. Kết luận trạng thái
  let executionState = "success";

  if (!sheetSuccess && !telegramSuccess) {
    executionState = "failed";
  } else if (!sheetSuccess || !telegramSuccess) {
    executionState = "partial_success";
  }

  const result = {
    execution_state: executionState,
    sheet_success: sheetSuccess,
    telegram_success: telegramSuccess,
    run_time: stage2Output.run_time,
  };

  console.log("[Stage2] Final result:");
  console.log(JSON.stringify(result, null, 2));

  if (executionState === "failed") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[Stage2] Fatal error:", error.message);
  process.exit(1);
});
