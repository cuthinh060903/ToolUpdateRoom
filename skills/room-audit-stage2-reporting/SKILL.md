---
name: room-audit-stage2-reporting
description: Read room-audit summary output and generate Stage 2 reports for Google Sheet and Telegram. Use when the user mentions OpenClaw, latest-room-audit-summary.txt, daily audit reporting, II.A/II.B format, or posting room-audit results to sheet/telegram.
---

# Room Audit Stage 2 Reporting

## Purpose

Convert room-audit outputs into:
- daily Google Sheet column updates (`AI Bao cao`), and
- Telegram message in `II.A.x` / `II.B.x` format.

Stage 2 is OpenClaw reporting only. Do not run room-audit logic here.

## Input Files (Read Order)

Always read files in this order:

1. Required:
   - `C:/Users/thinh/.openclaw/workspace/latest-room-audit-summary.txt`
2. Optional enrichment if needed for detail:
   - `<workspace>/reports/room-audit/latest-room-audit.json`
   - `<workspace>/reports/room-audit/latest-room-audit.txt`
3. Reporting rules reference:
   - `<workspace>/reports/room-audit/openclaw-stage-2-handbook.md`

If required file is missing or empty, stop and return a failure note.

## Output Contract

Produce structured data with:
- `run_time`: report timestamp
- `telegram_text`: multiline text in `II.A.x`, `II.B.x`
- `sheet_rows`: exactly 7 strings
  - row 1 -> `Muc 1`
  - row 2 -> `Muc 2`
  - row 3 -> `Ma 3`
  - row 4 -> `Ma 4`
  - row 5 -> `Ma 5`
  - row 6 -> `Ma 6`
  - row 7 -> `Ma 7`

If any section has no finding, write `Khong phat hien`.

## Google Sheet Target Rules

Use:
- Spreadsheet id: `11EyNOVAMn7ei-J8svcMjpvv1B7AashTUDyRB-gUeHho`
- Sheet name: `AI Bao cao`
- Header row: `1`
- Data rows: `2..8`
- First day column: `G`

Column policy (mandatory):
- Each day uses exactly one column.
- Find column where header row equals current day number.
- If day column exists:
  - clear old values in rows `2..8` of that column,
  - write new `sheet_rows` values into the same column.
- If day column does not exist:
  - append next column to the right,
  - write day number in header row,
  - write `sheet_rows` to rows `2..8`.

## Telegram Format Rules

Message must be concise but complete.

Use this exact structure:

```text
[OPENCLAW_STAGE_2] YYYY-MM-DD HH:mm:ss
II.A.1: ...
II.A.2: ...
II.A.3: ...
II.A.4: ...
II.B.1: ...
II.B.2: ...
II.B.3: ...
II.B.4: ...
II.B.5: ...
```

Formatting rules:
- `II.A` = condition/overview conclusions.
- `II.B` = detailed operational findings by CDT/room groups.
- One line = one conclusion + one action.
- Prioritize critical issues first.
- If too long, keep `II.A.*` and highest severity `II.B.*` first.

## Severity and Content Rules

- Do not confuse question index with error code.
- `Muc 1-2` are overview checks, not detailed error codes.
- Detailed business codes are `Ma 3..Ma 7`.
- Include `[DO]` for urgent, `[VANG]` for warning when applicable.

## Failure Handling

If parse fails or output is invalid:
- do not post Telegram or write Sheet,
- return error `STAGE2_PARSE_FAILED`,
- include short hint: `Check latest-room-audit-summary.txt and handbook rules`.

If Sheet write fails but Telegram succeeds:
- prepend telegram with `[CANH BAO] Sheet update fail`.

If Telegram fails but Sheet succeeds:
- mark execution state `partial_success`.

