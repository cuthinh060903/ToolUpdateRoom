# Mẫu Setup Fallback Theo ID 3

Mục tiêu: dùng ID `3` làm mẫu để các trợ lý copy setup cho CDT khác.

Thứ tự tool đọc nguồn:

1. `AI0` = `link` + `list_address` hiện có
2. `AI1`
3. `AI2`
4. `MANUAL3`

Nếu nguồn trước lỗi mới rơi sang nguồn sau.

## Mẫu 1: Cách nhanh (legacy key)

Copy block này vào đúng object CDT trong `constants.js`, rồi thay link/gid thật:

```js
{
  id: 3,
  type: "chdv",
  address_column: [2],
  room_column: [3],
  building_code_column: [null],
  price_column: [4],
  name: "link3 4ps",
  if: "caocap",
  web: "3 4ps",

  // AI0 (nguồn chính)
  link: "https://docs.google.com/spreadsheets/d/AI0_FILE_ID/edit#gid=2091330969",
  list_address: [2091330969],

  // AI1 (fallback 1)
  link_ai1: "https://docs.google.com/spreadsheets/d/AI1_FILE_ID/edit?gid=111111111#gid=111111111",
  list_address_ai1: [111111111], // hoặc gid_ai1: 111111111

  // AI2 (fallback 2)
  link_ai2: "https://docs.google.com/spreadsheets/d/AI2_FILE_ID/edit?gid=222222222#gid=222222222",
  list_address_ai2: [222222222], // hoặc gid_ai2: 222222222

  // MANUAL3 (fallback 3)
  link_manual3: "https://docs.google.com/spreadsheets/d/MANUAL3_FILE_ID/edit?gid=333333333#gid=333333333",
  list_address_manual3: [333333333], // hoặc gid_manual3: 333333333

  exit: [],
  exitColumn: 6,
  exitLinkDriver: 7,
  column: [2, 3, null, 4],
  hesogia: 1,
  mota: [5, 6, 8, 9, 10],
  header: 2,
}
```

## Mẫu 2: Cách chuẩn (khuyên dùng)

Dùng `sheet_source_priority` để quản lý fallback rõ ràng:

```js
{
  id: 3,
  type: "chdv",
  address_column: [2],
  room_column: [3],
  building_code_column: [null],
  price_column: [4],
  name: "link3 4ps",
  if: "caocap",
  web: "3 4ps",

  // AI0
  link: "https://docs.google.com/spreadsheets/d/AI0_FILE_ID/edit#gid=2091330969",
  list_address: [2091330969],

  // AI1 -> AI2 -> MANUAL3
  sheet_source_priority: [
    {
      label: "AI1",
      link: "https://docs.google.com/spreadsheets/d/AI1_FILE_ID/edit?gid=111111111#gid=111111111",
      list_address: [111111111],
    },
    {
      label: "AI2",
      link: "https://docs.google.com/spreadsheets/d/AI2_FILE_ID/edit?gid=222222222#gid=222222222",
      list_address: [222222222],
    },
    {
      label: "MANUAL3",
      link: "https://docs.google.com/spreadsheets/d/MANUAL3_FILE_ID/edit?gid=333333333#gid=333333333",
      list_address: [333333333],
    },
  ],

  exit: [],
  exitColumn: 6,
  exitLinkDriver: 7,
  column: [2, 3, null, 4],
  hesogia: 1,
  mota: [5, 6, 8, 9, 10],
  header: 2,
}
```

## Rule Cho Trợ Lý Khi Copy Sang CDT Khác

1. Giữ nguyên logic cột của CDT đích (`address_column`, `room_column`, `price_column`, `mota`, `exitColumn`, `exitLinkDriver`), không copy cứng từ ID 3 nếu cấu trúc khác.
2. Chỉ thay phần nguồn sheet: `link`, `list_address`, `AI1/AI2/MANUAL3`.
3. Ưu tiên để `list_address` trùng `gid` thật trên link.
4. Không dùng `gid` placeholder (`246641757`) nếu đã biết `gid` thật.
5. Sau khi setup, test nhanh 1 CDT bằng `RUN_ONLY_IDS` trước khi chạy full.

## Lệnh Test Nhanh

```powershell
$env:RUN_ONLY_IDS="3"
Remove-Item Env:START_ID -ErrorAction SilentlyContinue
node index.js
```

