# Note Rule Theo Doi Cap Nhat

## Muc tieu

File nay chot lai cac rule canh bao/bao cao dua tren field va luong xu ly dang co trong repo `ToolUpdateRoom`.

Luu y quan trong:

- Repo hien tai khong co field `last_updated_at` dung ten nay.
- Field thuc te dang co la `updated_at` o room/building API.
- Neu muon thong nhat theo ten bao cao, nen map:
  - `last_updated_at = rooms.updated_at`
  - hoac `last_updated_at = realnews.updated_at`
- Repo hien tai khong co field `image_count` san trong API room.
- `image_count` nen duoc tinh suy ra tu so object anh trong MinIO theo prefix `rooms/{room.id}/photos/`.

## Rule 1: Co cap nhat khong

- Field dung kiem tra:
  - Uu tien: `rooms.updated_at`
  - Bo sung khi can kiem tra theo toa: `realnews.updated_at`
  - Neu can ten chung trong bao cao: tao field suy ra `last_updated_at`
- Dieu kien pass:
  - `updated_at` hop le, parse duoc thanh thoi gian
  - Va `updated_at` cung ngay voi ngay chay bao cao
  - Hoac `now - updated_at <= update_threshold_hours`
- Dieu kien fail:
  - `updated_at` rong, null, sai dinh dang
  - Hoac cu hon nguong canh bao
- De xuat nguong:
  - Neu gui bao cao 1 lan/ngay: canh bao khi `updated_at` cu hon 1 ngay
  - Neu gui bao cao nhieu lan/ngay: dua vao `update_threshold_hours`
- Ghi chu:
  - Trong code hien tai, tool co gui thong diep `Khong co cap nhat moi`, nhung chua co rule stale-data dua truc tiep tren `updated_at`.

## Rule 2: Loi cap nhat

- Dau hieu sai truong la gi:
  - Du lieu sheet sau khi chuan hoa khong tao duoc cac key can thiet nhu `ADDRESS`, `ROOMS`
  - Khong co `IMAGE_DRIVER` khi room can cap nhat anh
  - Gia tri nam sai truong sau map cot, vi du:
    - `ROOMS` trong giong gia tien
    - `PRICE` khong parse duoc thanh so
    - `IMAGE_DRIVER` khong phai URL
  - Loi dang nay hien dang bi day vao `ggsheet.txt`
- Dau hieu lech field la gi:
  - `rooms.name` giong gia tien, vi du `4 trieu`, `4500000`
  - `rooms.price` lai chua text ten phong, vi du `P101`, `101A`
  - `origin_link` khong phai link hop le
  - `ADDRESS` khong fuzzy match duoc sang building tren web
  - Match duoc toa nhung khong match duoc room do sai cot phong
- Dau hieu link loi la gi:
  - `downloadAllFilesFromFolder()` tra ve:
    - `invalid_link`
    - `unsupported_link`
    - `empty_folder`
  - Link Google Drive/Google Photos bi loi quyen:
    - `401`
    - `403`
    - `404`
  - Exception khi tai/upload anh duoc ghi vao `driver_error.txt`
- Cac log nen dung de bat Rule 2:
  - `ggsheet.txt`: sai cot, thieu truong, khong co link driver
  - `driver_error.txt`: link anh loi, quyen loi, upload loi
  - `nhamoi.txt`: lech dia chi, map sai toa
  - `khongcodulieu.txt`: khong co du lieu toa tren web
  - `taophongloi.txt`: tao phong moi that bai

## Rule 3: Phong khong cap nhat duoc

- Field trang thai phong trong la gi:
  - Chinh: `rooms.status`
  - Bo sung: `rooms.empty_room_date`
  - Co the dung them de audit: `rooms.last_status_con_at`, `rooms.last_status_con_source`
- Khi nao coi la khong cap nhat duoc:
  - Tim thay room trong sheet nhung khong match duoc room tren web
  - `searchRoom(real_new_id)` loi hoac khong tra ve `content`
  - Goi `unlockRoom(id)` loi
  - Goi `updateRoom(id, { status: "con" })` loi
  - Tao room moi that bai khi room chua ton tai tren web
  - Room response khong co `status` sau khi doc API
- Dieu kien pass:
  - Room xuat hien trong sheet
  - Match duoc room tren web hoac tao moi thanh cong
  - Goi `unlockRoom` thanh cong
  - Sau do cap nhat room thanh cong voi `status = "con"`
- Dieu kien fail:
  - Khong doc duoc `status`
  - Hoac luong unlock/update/create bi throw error
  - Hoac room dang co trong sheet nhung khong co dau vet cap nhat vao `capnhattrong.txt` trong ngay bao cao
- Dau vet hien co trong repo:
  - `capnhattrong.txt`: room da duoc mo trong / unlock
  - `taophongloi.txt`: tao phong that bai
  - `ggsheet.txt`: du lieu sheet khong du de xu ly

## Rule 4: Phong khong co anh

- Field `image_count` la gi:
  - Khong co san trong room API
  - Nen tao field suy ra:
    - `image_count = count(objects under rooms/{room.id}/photos/)`
- Neu `= 0` thi canh bao:
  - Canh bao `PHONG_KHONG_CO_ANH`
  - Dua vao bao cao Telegram hoac file tong hop
- Dieu kien pass:
  - `image_count > 0`
- Dieu kien fail:
  - `image_count = 0`
  - Hoac link anh co nhung `uploadResult.status = "empty_folder"`
  - Hoac co `driver_error.txt`
  - Hoac sheet khong co `IMAGE_DRIVER`
- Field lien quan de doi chieu:
  - `origin_link`: link nguon anh
  - `image_link`: link anh dang luu tren room
- Ghi chu:
  - Neu `origin_link` co gia tri nhung `image_count = 0` thi day la canh bao manh, vi kha nang cao la link anh loi, album rong, hoac upload that bai.

## Rule 5: Gui bao cao co dinh

- Kenh gui:
  - Telegram qua `telegram_bot.js`
- Noi dung hien co trong code:
  - Gui `Bat dau cap nhat...`
  - Gui danh sach dia chi thieu
  - Gui tong ket theo CDT
  - Gui `Hoan thanh`
- Lich co dinh hien trang:
  - Repo co import `node-cron`
  - Co mau lich da viet san nhung dang comment:
    - `04:00`: clear file
    - `05:00`: chay `reg.run()`
- Ket luan:
  - Rule 5 da co kenh gui
  - Lich gui co dinh chua dang active trong `index.js`
  - Neu can chay tu dong, can:
    - mo comment `cron.schedule(...)`
    - hoac dung Windows Task Scheduler / cron ngoai tool

## De xuat output bao cao

Moi room nen co toi thieu cac cot sau:

- `cdt_id`
- `building_id`
- `building_code`
- `room_id`
- `room_name`
- `status`
- `empty_room_date`
- `last_updated_at`
- `origin_link`
- `image_count`
- `rule_1_status`
- `rule_2_status`
- `rule_3_status`
- `rule_4_status`
- `error_detail`

## Chot field dung trong implementation

- Rule 1:
  - `rooms.updated_at`
  - `realnews.updated_at`
- Rule 2:
  - Sheet: `ADDRESS`, `ROOMS`, `PRICE`, `IMAGE_DRIVER`, `DESCRIPTIONS`
  - API room: `name`, `price`, `origin_link`, `image_link`
- Rule 3:
  - `status`
  - `empty_room_date`
  - `last_status_con_at`
  - `last_status_con_source`
- Rule 4:
  - `image_count` suy ra tu MinIO
  - Prefix: `rooms/{room.id}/photos/`

## Ghi chu de trien khai sau note nay

- Neu muon dung dung tu user dang noi, co the dat ten field bao cao la `last_updated_at`.
- Tuy nhien khi code, nen lay tu `updated_at` de tranh nham field.
- Neu muon bat nhanh ban dau, co the lam theo uu tien:
  - Rule 1: canh bao `updated_at` cu
  - Rule 4: canh bao `image_count = 0`
  - Rule 2: bat log `ggsheet.txt` va `driver_error.txt`
  - Rule 3: bat room co trong sheet nhung khong co dau vet `capnhattrong.txt`
