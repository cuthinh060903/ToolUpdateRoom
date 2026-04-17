Chay lenh: npm run audit:room -- --ids=26 --limit=20 --send-telegram=false --debug=true
[ROOM_AUDIT] 2026-04-16 09:01:54
Tong phong: 20 | Co canh bao: 20 | Loi nguon: 0
Rule1 stale: 15 | Rule2 mapping: 5 | Rule3 status: 5 | Rule4 image: 0
Top loi:

- STALE_GT_24H: 15
- ADDRESS_MISMATCH_LOGGED: 5
- BUILDING_NOT_FOUND: 5
- BUILDING_NOT_MATCHED: 5
- IMAGE_COUNT_NOT_CHECKED: 5
  CDT canh bao:
- CDT 26 (26 time): 20 phong | R1:15 R2:5 R3:5 R4:0

Chay lenh: npm run audit:room -- --ids=8 --limit=20 --send-telegram=false --debug=true
[ROOM_AUDIT] 2026-04-16 09:04:12
Tong phong: 20 | Co canh bao: 20 | Loi nguon: 0
Rule1 stale: 17 | Rule2 mapping: 4 | Rule3 status: 4 | Rule4 image: 1
Top loi:

- STALE_GT_24H: 17
- IMAGE_COUNT_NOT_CHECKED: 4
- SHEET_ROOM_NOT_UPDATED_TO_EMPTY: 4
- BUILDING_NOT_FOUND: 3
- BUILDING_NOT_MATCHED: 3
  CDT canh bao:
- CDT 8 (8): 20 phong | R1:17 R2:4 R3:4 R4:1

Chay lenh: npm run audit:room -- --limit=100 --send-telegram=false
[ROOM_AUDIT] 2026-04-16 09:04:43
Tong phong: 100 | Co canh bao: 100 | Loi nguon: 0
Rule1 stale: 47 | Rule2 mapping: 60 | Rule3 status: 54 | Rule4 image: 1
Top loi:

- ADDRESS_MISMATCH_LOGGED: 58
- SHEET_ROOM_NOT_UPDATED_TO_EMPTY: 54
- BUILDING_NOT_FOUND: 53
- BUILDING_NOT_MATCHED: 53
- IMAGE_DRIVER_MISSING: 53
  CDT canh bao:
- CDT 3 (3 4ps): 52 phong | R1:0 R2:52 R3:52 R4:0
- CDT 5 (5 1): 34 phong | R1:34 R2:2 R3:1 R4:1
- CDT 4 (4 hallo): 14 phong | R1:13 R2:6 R3:1 R4:0

Chay lenh: npm run audit:room -- --ids=26 --limit=20 --send-telegram=true
[ROOM_AUDIT] 2026-04-16 09:08:09
Tong phong: 20 | Co canh bao: 20 | Loi nguon: 0
Rule1 stale: 15 | Rule2 mapping: 5 | Rule3 status: 5 | Rule4 image: 0
Top loi:

- STALE_GT_24H: 15
- ADDRESS_MISMATCH_LOGGED: 5
- BUILDING_NOT_FOUND: 5
- BUILDING_NOT_MATCHED: 5
- IMAGE_COUNT_NOT_CHECKED: 5
  CDT canh bao:
- CDT 26 (26 time): 20 phong | R1:15 R2:5 R3:5 R4:0
  Bao tren telegram:
  [ROOM_AUDIT] 2026-04-16 09:08:09
  Tong phong: 20 | Co canh bao: 20 | Loi nguon: 0
  Rule1 stale: 15 | Rule2 mapping: 5 | Rule3 status: 5 | Rule4 image: 0
  Top loi:
- STALE_GT_24H: 15
- ADDRESS_MISMATCH_LOGGED: 5
- BUILDING_NOT_FOUND: 5
- BUILDING_NOT_MATCHED: 5
- IMAGE_COUNT_NOT_CHECKED: 5
  CDT canh bao:
- CDT 26 (26 time): 20 phong | R1:15 R2:5 R3:5 R4:0
