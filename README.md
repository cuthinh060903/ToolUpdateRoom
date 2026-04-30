# ToolUpdateRoom

Tool for updating room information from Google Sheets and sending notifications via Telegram.

## Features

- Update room data from Google Sheets.
- Send notifications to Telegram.
- Process price parsing and location data.

## Installation

```bash
npm install
```

## Environment

Create `.env` from `.env.example` and keep all Telegram bot tokens/chat IDs in this one file:

```env
TELEGRAM_BOT_TOKEN=bot_for_main_updater
TELEGRAM_CHAT_ID=chat_id_for_main_updater_group
ROOM_AUDIT_TELEGRAM_BOT_TOKEN=bot_for_assistant_report_group
ROOM_AUDIT_TELEGRAM_CHAT_ID=chat_id_for_assistant_report_group
```

- `TELEGRAM_*` is used by the main room update flow (`index.js`) for trong/kin notifications.
- `ROOM_AUDIT_TELEGRAM_*` is used only by `modules/room-audit`.
- The app reads both targets from `.env`, so you no longer need to search in multiple files for Telegram credentials.
- If `ROOM_AUDIT_TELEGRAM_*` is missing, room audit Telegram sending will be skipped instead of reusing the main updater group.

To get the new assistant report group `chat_id`:

1. Add the new bot into the new Telegram group and give it permission to send messages.
2. Send at least one command such as `/start` in that group so the bot can receive an update.
3. Open `https://api.telegram.org/bot<NEW_BOT_TOKEN>/getUpdates` in the browser.
4. Find the group object and copy `chat.id` such as `-100xxxxxxxxxx`.

## Usage

```bash
node index.js
```

Run all IDs from the beginning:

```powershell
Remove-Item Env:RUN_ONLY_IDS -ErrorAction SilentlyContinue
Remove-Item Env:START_ID -ErrorAction SilentlyContinue
node index.js
```

Run a specific ID or a small set of IDs for testing:

```powershell
$env:RUN_ONLY_IDS="339"
node index.js
```

```powershell
$env:RUN_ONLY_IDS="339,340,341"
node index.js
```

Run from a specific starting ID without editing code:

```powershell
$env:START_ID="8"
Remove-Item Env:RUN_ONLY_IDS -ErrorAction SilentlyContinue
node index.js
```

## Sheet Source Priority (AI0 -> AI1 -> AI2 -> MANUAL3)

Main updater (`index.js`) now reads each CDT source with this priority:

- `AI0`: direct source from current `link` + `list_address` in `constants.js`.
- If `AI0` fails, fallback to `AI1`, then `AI2`, then `MANUAL3` (if configured).

Quick config example in `constants.js` (per CDT item):

```js
{
  id: 339,
  link: "https://docs.google.com/spreadsheets/d/.../edit?gid=111", // AI0
  list_address: [111],

  link_ai1: "https://docs.google.com/spreadsheets/d/.../edit?gid=222",
  list_address_ai1: [222], // or gid_ai1: 222

  link_ai2: "https://docs.google.com/spreadsheets/d/.../edit?gid=333",
  list_address_ai2: [333], // or gid_ai2: 333

  link_manual3: "https://docs.google.com/spreadsheets/d/.../edit?gid=444",
  list_address_manual3: [444], // or gid_manual3: 444
}
```

Advanced option: define explicit fallback order with `sheet_source_priority` for each CDT:

```js
sheet_source_priority: [
  { label: "AI1", link: "...", list_address: [222] },
  { label: "AI2", link: "...", list_address: [333] },
  { label: "MANUAL3", link: "...", list_address: [444] },
];
```

## Auto Run Every Day On Windows

Recommended approach: run the combined flow (`trong-kin` -> `room-audit`) once per trigger, then let Windows Task Scheduler call it every day.

Conditions for the task to run automatically:

- The computer must be powered on.
- Windows must not be in sleep mode at the scheduled time.
- The user who owns the task must be logged in, because the current task is `Interactive only`.
- Internet connection is required if the tool needs Google Sheets, API, Telegram, or MinIO.

Run once manually (combined flow):

```bash
npm run run:daily
```

Register a daily schedule at `05:00` (combined flow):

```bash
npm run schedule:daily
```

Change the schedule time or task name:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-daily-task.ps1 -Time "09:00" -TaskName "ToolUpdateRoom-9AM"
```

Register multiple run times in one task (combined flow):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-daily-task.ps1 -Times "12:00","17:30" -TaskName "ToolUpdateRoom-All-TwiceDaily" -EntryScript "scripts/run-all-daily.js" -LogPrefix "all-run"
```

Stop the running scheduled task:

```bash
npm run schedule:stop
```

Stop a specific task by name:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-daily-task.ps1 -TaskName "ToolUpdateRoom-TrongKin-Daily"
```

If a `node` process is still running and you want to stop it manually:

```powershell
Get-Process | Where-Object { $_.ProcessName -like 'node*' }
Stop-Process -Id <PID>
```

If you want Windows to stop the running task instance directly:

```powershell
schtasks /End /TN "ToolUpdateRoom-TrongKin-Daily"
```

Logs are written to `.\logs\<log-prefix>-YYYY-MM-DD_HH-mm-ss.log`.

## Recommended Schedule Commands

Use these 3 command groups from now on:

### 1. Trong-kin only

Create schedule:

```bash
npm run schedule:create:trong-kin
```

Cancel schedule:

```bash
npm run schedule:cancel:trong-kin
```

Run once:

```bash
npm run run:trong-kin
```

Preset:

- Task name: `ToolUpdateRoom-TrongKin-Daily`
- Entry script: `index.js`
- Log prefix: `trong-kin-run`

### 2. Room audit only

Create schedule:

```bash
npm run schedule:create:room-audit
```

Cancel schedule:

```bash
npm run schedule:cancel:room-audit
```

Run once:

```bash
npm run run:room-audit
```

Preset:

- Task name: `ToolUpdateRoom-RoomAudit-Daily`
- Entry script: `modules/room-audit/index.js`
- Log prefix: `room-audit-run`
- Script arg mặc định:
  - `--send-telegram=true`
  - `--sync-report-sheet=true`

### 3. Run both trong-kin and room audit

Create schedule:

```bash
npm run schedule:create:all
```

Cancel schedule:

```bash
npm run schedule:cancel:all
```

Run once:

```bash
npm run run:all
```

Shortcut command (same behavior, easier to remember):

```bash
npm run run:trong-kin-then-room-audit
```

Preset:

- Task name: `ToolUpdateRoom-All-Daily`
- Entry script: `scripts/run-all-daily.js`
- Log prefix: `all-run`
- Flow order: `trong-kin` first, `room audit` second (sequential, not parallel)
- Script arg mặc định:
  - `room-audit` gửi Telegram + sync sheet theo format II.A/II.B

### Change the schedule time

All `schedule:create:*` commands use `05:00` by default because that is the default of `register-daily-task.ps1`.

To use the same twice-daily pattern as the current updater task:

```powershell
npm run schedule:create:trong-kin -- -Times "12:00","17:30"
npm run schedule:create:room-audit -- -Times "12:00","17:30"
npm run schedule:create:all -- -Times "12:00","17:30"
```

### Important note about stop vs cancel

- `schedule:stop*` only ends a running task instance.
- `schedule:cancel:*` removes the schedule from Windows Task Scheduler.

Run room audit directly without scheduler wrapper:

```powershell
npm run audit:room
```

## Room Audit Manual Notes

Use this section for manual `room-audit` runs only, without scheduler commands.

### Change OpenClaw workspace path on another machine

`room-audit` always writes:

- `reports/room-audit/latest-room-audit.json`
- `reports/room-audit/latest-room-audit.txt`
- `reports/room-audit/latest-room-audit-summary.txt`

It also copies `latest-room-audit-summary.txt` into the OpenClaw workspace.

Default OpenClaw workspace path:

- `C:/Users/thinh/.openclaw/workspace`

Where to change it in code:

- File: `modules/room-audit/index.js`
- Constant: `OPENCLAW_WORKSPACE_DIR`

Recommended ways to change path:

1. Change the `OPENCLAW_WORKSPACE_DIR` constant directly when the machine path is fixed.
2. Set env var `ROOM_AUDIT_OPENCLAW_WORKSPACE_DIR` when you want to keep the code unchanged.
3. Pass `--openclaw-workspace-dir=...` for one specific run.

Examples:

```powershell
$env:ROOM_AUDIT_OPENCLAW_WORKSPACE_DIR="D:/OpenClaw/workspace"
npm run audit:room
```

```powershell
npm run audit:room -- --openclaw-workspace-dir="D:/OpenClaw/workspace"
```

### Common room-audit commands

Run all IDs:

```powershell
npm run audit:room
```

Run 1 ID:

```powershell
npm run audit:room -- --ids=339
```

Run many IDs:

```powershell
npm run audit:room -- --ids=339,340,341
```

Run all IDs with debug log:

```powershell
npm run audit:room -- --debug=true
```

Run 1 ID with debug log:

```powershell
npm run audit:room -- --ids=339 --debug=true
```

Quick smoke test with small scope:

```powershell
npm run audit:room -- --ids=339 --limit=1 --use-api=false --debug=true
```

Chỉ test lỗi cụ thể (nhanh hơn):

```powershell
npm run audit:room -- --ids=339 --test-errors=1
npm run audit:room -- --ids=339 --test-errors=2
npm run audit:room -- --ids=339 --test-errors=2,3
```

Custom Rule 1 threshold:

```powershell
npm run audit:room -- --rule1-hours=12
```

### Supported flags for manual room-audit run

- `--ids=339,340,341`: run only the specified CDT IDs. If omitted, the tool runs all IDs.
- `--debug=true|false`: show debug logs.
- `--use-api=true|false`: enable or disable API enrichment.
- `--limit=10`: stop after a specific number of audit rows.
- `--rule1-hours=24`: change the stale threshold for Rule 1.
- `--test-errors=1,2,3...12`: chỉ chạy test các nhóm lỗi được chọn (1=II.A.1, 2=II.A.2, 3=II.A.3, 4=II.B.4, ..., 9=II.B.9, 10=II.B.10, 11=II.B.11, 12=II.B.12).
- `--send-telegram=true|false`: gửi hoặc tắt gửi Telegram room-audit.
- `--sync-report-sheet=true|false`: ghi hoặc tắt ghi Google Sheet báo cáo room-audit.
- `--report-sheet-spreadsheet-id=...`: override spreadsheet báo cáo (mặc định của chú).
- `--report-sheet-gid=297377874`: override sheet gid báo cáo.
- `--report-sheet-header-row=1`: hàng chứa ngày.
- `--report-sheet-first-data-row=2`: hàng bắt đầu ghi dữ liệu.
- `--report-sheet-last-data-row=14`: hàng kết thúc ghi dữ liệu.
- `--report-sheet-start-column=7`: cột ngày đầu tiên (7 = G).
- `--report-sheet-day-window-size=10`: chỉ dùng tối đa 10 cột ngày; đầy vòng sẽ quay về cột bắt đầu để ghi đè.
- `--openclaw-workspace-dir="C:/path/to/workspace"`: override the OpenClaw copy target for this run only.

### Room audit output + report delivery

Room audit keeps local report outputs, OpenClaw summary copy, đồng thời gửi Telegram và ghi Google Sheet:

- `reports/room-audit/latest-room-audit.json`
- `reports/room-audit/latest-room-audit.txt`
- `reports/room-audit/latest-room-audit-summary.txt`

Google Sheet daily report rule:
- Sheet target mặc định: `11EyNOVAMn7ei-J8svcMjpvv1B7AashTUDyRB-gUeHho` (gid `297377874`)
- Mỗi ngày dùng 1 cột, bắt đầu từ cột `G`
- Chỉ dùng tối đa 10 cột ngày (`G -> P`), khi đầy vòng sẽ quay lại `G` để ghi đè báo cáo mới
- Nếu chạy lại trong cùng ngày: xóa nội dung cột ngày hiện tại (`row 2..14`) rồi ghi lại dữ liệu mới
- Nếu sang ngày mới: ghi sang cột kế bên phải

Telegram report rule:
- Gửi `Bắt đầu cập nhật room-audit...` khi bắt đầu chạy
- Gửi từng dòng báo cáo II.A/II.B thành từng message riêng
- Gửi `Hoàn thành cập nhật room-audit.` khi kết thúc

### Expected output after a successful run

- Timestamped files:
  - `reports/room-audit/room-audit-YYYY-MM-DD-HH-mm-ss.json`
  - `reports/room-audit/room-audit-YYYY-MM-DD-HH-mm-ss.txt`
- Latest files:
  - `reports/room-audit/latest-room-audit.json`
  - `reports/room-audit/latest-room-audit.txt`
  - `reports/room-audit/latest-room-audit-summary.txt`
- OpenClaw copy target:
  - `<OpenClaw workspace>/latest-room-audit-summary.txt`
