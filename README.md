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

## Auto Run Every Day On Windows
Recommended approach: keep `index.js` as a one-time runner, then let Windows Task Scheduler call it every day.

Conditions for the task to run automatically:
- The computer must be powered on.
- Windows must not be in sleep mode at the scheduled time.
- The user who owns the task must be logged in, because the current task is `Interactive only`.
- Internet connection is required if the tool needs Google Sheets, API, Telegram, or MinIO.

Run once manually:
```bash
npm run run:daily
```

Register a daily schedule at `05:00`:
```bash
npm run schedule:daily
```

Change the schedule time or task name:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-daily-task.ps1 -Time "09:00" -TaskName "ToolUpdateRoom-9AM"
```

Register multiple run times in one task:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-daily-task.ps1 -Times "12:00","17:30" -TaskName "ToolUpdateRoom-TrongKin-TwiceDaily" -EntryScript "index.js" -LogPrefix "trong-kin-run"
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
- Script arg: `--send-telegram=true`

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

Preset:
- Task name: `ToolUpdateRoom-All-Daily`
- Entry script: `scripts/run-all-daily.js`
- Log prefix: `all-run`
- Flow order: `trong-kin` first, `room audit` second
- Script arg: `--room-audit-send-telegram=true`

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
npm run audit:room -- --send-telegram=true
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
npm run audit:room -- --send-telegram=false
```

```powershell
npm run audit:room -- --send-telegram=false --openclaw-workspace-dir="D:/OpenClaw/workspace"
```

### Common room-audit commands
Run all IDs:
```powershell
npm run audit:room -- --send-telegram=false
```

Run all IDs and send Telegram:
```powershell
npm run audit:room -- --send-telegram=true
```

Run 1 ID:
```powershell
npm run audit:room -- --ids=339 --send-telegram=false
```

Run many IDs:
```powershell
npm run audit:room -- --ids=339,340,341 --send-telegram=false
```

Run all IDs with debug log:
```powershell
npm run audit:room -- --send-telegram=false --debug=true
```

Run 1 ID with debug log:
```powershell
npm run audit:room -- --ids=339 --send-telegram=false --debug=true
```

Run many IDs and send Telegram:
```powershell
npm run audit:room -- --ids=339,340,341 --send-telegram=true
```

Quick smoke test with small scope:
```powershell
npm run audit:room -- --ids=339 --limit=1 --use-api=false --send-telegram=false --sync-report-sheet=false --debug=true
```

Custom Rule 1 threshold:
```powershell
npm run audit:room -- --rule1-hours=12 --send-telegram=false
```

### Supported flags for manual room-audit run
- `--ids=339,340,341`: run only the specified CDT IDs. If omitted, the tool runs all IDs.
- `--send-telegram=true|false`: enable or disable Telegram sending.
- `--telegram-progress=true|false`: send per-CDT progress messages to Telegram. Default is `false`.
- `--detailed-telegram=true|false`: send the old multi-message detailed Telegram breakdown. Default is `false`.
- `--sync-report-sheet=true|false`: write the 7-line daily summary into tab `AI Báo cáo` on the report Google Sheet. Default is `true`.
- `--report-sheet-dry-run=true|false`: resolve the target day column and values for `AI Báo cáo` without writing to the sheet.
- `--report-sheet-spreadsheet-id=...`: override the report spreadsheet id.
- `--report-sheet-gid=297377874`: override the report sheet gid.
- `--report-sheet-header-row=1`: override the header row that contains the day numbers.
- `--report-sheet-first-data-row=2`: override the first answer row in `AI Báo cáo`.
- `--report-sheet-start-column=7`: override the first day column. Default `7` = column `G`.
- `--debug=true|false`: show debug logs.
- `--use-api=true|false`: enable or disable API enrichment.
- `--limit=10`: stop after a specific number of audit rows.
- `--rule1-hours=24`: change the stale threshold for Rule 1.
- `--openclaw-workspace-dir="C:/path/to/workspace"`: override the OpenClaw copy target for this run only.

### AI Báo cáo daily sync
Room audit now prepares:
- Telegram summary in `II.A / II.B` format
- Daily 7-line answer set for tab `AI Báo cáo` in the reporting Google Sheet
- Detailed output in `reports/room-audit/latest-room-audit-summary.txt`

Current default report target:
- Spreadsheet id: `11EyNOVAMn7ei-J8svcMjpvv1B7AashTUDyRB-gUeHho`
- Sheet gid: `297377874`
- Header row: `1`
- Daily columns start at `G`
- Answer rows: `2` to `8`

How the day column is chosen:
- If row `1` already has today’s day number, room audit writes into that existing column.
- If today’s day number is missing, room audit appends the next column to the right and writes the new day header there.
- On rerun in the same day, room audit clears the target day range first, then writes the new values.

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
