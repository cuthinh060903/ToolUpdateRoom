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
powershell -ExecutionPolicy Bypass -File .\scripts\register-daily-task.ps1 -Times "12:00","17:30" -TaskName "ToolUpdateRoom-TwiceDaily"
```

Stop the running scheduled task:
```bash
npm run schedule:stop
```

Stop a specific task by name:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-daily-task.ps1 -TaskName "ToolUpdateRoom-TwiceDaily"
```

If a `node` process is still running and you want to stop it manually:
```powershell
Get-Process | Where-Object { $_.ProcessName -like 'node*' }
Stop-Process -Id <PID>
```

If you want Windows to stop the running task instance directly:
```powershell
schtasks /End /TN "ToolUpdateRoom-TwiceDaily"
```

Logs are written to `.\logs\daily-run-YYYY-MM-DD_HH-mm-ss.log`.

If you want to schedule the room audit module instead of the main updater:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-daily-task.ps1 -EntryScript "modules/room-audit/index.js"
```
