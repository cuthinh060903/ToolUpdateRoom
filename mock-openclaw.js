const fs = require("fs");
const path = require("path");

const summaryPath = path.join(process.cwd(), "latest-room-audit-summary.txt");
const summaryText = fs.readFileSync(summaryPath, "utf8");

function extract(regex, fallback = "Khong phat hien") {
  const match = summaryText.match(regex);
  return match ? match[1].trim() : fallback;
}

const runTime = new Date().toISOString().slice(0, 19).replace("T", " ");

const criticalIssues = extract(/CRITICAL ISSUES:\s*(.*)/);
const warningIssues = extract(/WARNING ISSUES:\s*(.*)/);
const vacantWeb = extract(/VACANT ROOMS \(WEB\):\s*(.*)/);
const vacantSheet = extract(/VACANT ROOMS \(SHEET\):\s*(.*)/);
const vacantLog = extract(/VACANT ROOMS \(LOG\):\s*(.*)/);

const output = {
  run_time: runTime,
  telegram_text: `[OPENCLAW_STAGE_2] ${runTime}
II.A.1: [DO] Tong hop ket qua room-audit da hoan tat, can kiem tra cac muc nghiem trong.
II.A.2: [DO] So lieu phong trong dang co chenh lech giua cac nguon: Web=${vacantWeb}, Sheet=${vacantSheet}, Log=${vacantLog}.
II.A.3: [VANG] Tong so loi critical: ${criticalIssues}.
II.A.4: [VANG] Tong so loi warning: ${warningIssues}.
II.B.1: [DO] Uu tien xu ly cac room thieu vacancy status neu co.
II.B.2: [DO] Rà soát cac link hong va doi chieu nguon web/log.
II.B.3: [VANG] Kiem tra cac room khong co anh.
II.B.4: [VANG] Kiem tra cac listing qua han cap nhat.
II.B.5: [DO] Chot lai nguon so lieu truoc khi cap nhat bao cao cuoi ngay.`,
  sheet_rows: [
    `Muc 1: Tong quan - Da chay room audit, can doi chieu ket qua.`,
    `Muc 2: Chenh lech phong trong - Web=${vacantWeb}, Sheet=${vacantSheet}, Log=${vacantLog}.`,
    `Ma 3: Critical issues = ${criticalIssues}`,
    `Ma 4: Warning issues = ${warningIssues}`,
    `Ma 5: Kiem tra room thieu status / link hong`,
    `Ma 6: Kiem tra room khong co anh / stale listing`,
    `Ma 7: Chot xu ly va cap nhat lai du lieu neu can`,
  ],
};

console.log(JSON.stringify(output, null, 2));
