# Room Audit Review Sample

- Nguon report: D:\ToolUpdateRoomProject\ToolUpdateRoom\reports\room-audit\latest-room-audit.json
- Report generated_at: 2026-04-17 11:19:15
- Tong so dong trong report: 1832
- So dong dua vao review: 1
- Dong co canh bao: 1
- Dong khong canh bao: 0

## Cach review

- Mo file CSV cung ten de dien nhan.
- Dung 1 trong 3 gia tri: `TRUE`, `FALSE`, `UNSURE`.
- `label_warning`: canh bao tong the cua dong co dung hay khong.
- `label_rule_1` ... `label_rule_4`: danh gia tung rule.
- Neu chua du thong tin thi de `UNSURE` va ghi ly do vao `reviewer_notes`.

## Mau review

### 1. CDT 3 | LINK ẢNH & VIDEO

- Dia chi: NGUỒN HÀNG 4PS HOUSING SĐT LIÊN HỆ: 0374.526.184
- Predicted warning: TRUE
- Trang thai web: (trong)
- Rule 1: SKIP | UPDATED_AT_MISSING
- Rule 2: FAIL | IMAGE_DRIVER_MISSING | BUILDING_NOT_MATCHED | ADDRESS_MISMATCH_LOGGED
- Rule 3: FAIL | BUILDING_NOT_FOUND | SHEET_ROOM_NOT_UPDATED_TO_EMPTY
- Rule 4: SKIP | IMAGE_SOURCE_MISSING
- Ket luan business: DOWNSTREAM_BUILDING_UNRESOLVED | Top candidate bi reject cung (house_number_mismatch).
- Freshness source: (trong)
- Freshness age hours: (trong)
- Image count: (trong)
