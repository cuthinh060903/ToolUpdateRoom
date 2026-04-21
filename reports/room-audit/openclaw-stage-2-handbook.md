# OpenClaw Stage 2 Handbook

## 1. Chot lai cach viet bao cao

- `II.A.x`, `II.B.x` la ma muc bao cao, KHONG PHAI ma loi.
- Theo bo moi cua Chu:
  - `Muc 1-2` trong bang ngay la cau hoi tong quan (trang thai tool), KHONG dung de gan nhan loi chi tiet.
  - Ma loi nghiep vu su dung de xu ly nhanh la `Ma 3` den `Ma 7`.
- Giai doan II = OpenClaw.
- `II.A` = dieu kien can: tool phai chay va lay duoc tong so phong.
- `II.B` = dieu kien du: sau khi co tong phong thi moi audit chi tiet tung phong/CDT.
- Bao cao Telegram va bao cao copy vao Google Sheet phai viet ngan, tung dong mot ket luan + mot huong xu ly.

## 2. So tay 7 ma loi

### Muc 1 - Tool co chay hay khong (khong phai ma loi chi tiet)

- Y nghia: xac nhan he thong co chay room-audit va co ket qua tong quan.
- Cach ghi: Co/Khong + so phong tong hop nhanh.
- Khong dung muc nay de ket luan nguyen nhan goc.

### Muc 2 - Co loi hay khong (khong phai ma loi chi tiet)

- Y nghia: xac nhan dot chay co phat sinh van de can xu ly hay khong.
- Cach ghi: Co/Khong + tom tat cac nhom loi chinh.
- Khong dung muc nay de thay the ma loi chi tiet.

### Ma 3 - Loi link bang hang / loi nguon

- Dau hieu: Google Sheet/link nguon het han, bi khoa, khong truy cap duoc, hoac tool doc sheet fail.
- Nguon phat hien: Telegram/log nguon, `source_errors`, buoc `processCsvData`.
- Huong xu ly: kiem tra lai link o cac nguon cap, copy link moi nhat va dan de vao tool.

### Ma 4 - Lech truong dia chi

- Dau hieu nghiep vu:
  - dia chi khong dung dinh dang hoac vao sai cot.
  - dia chi trong sheet khong doi chieu duoc voi du lieu tren he thong.
- Dau hieu ky thuat hay gap: `ADDRESS_MISSING`, `ADDRESS_MISMATCH_LOGGED`.
- Huong xu ly:
  - ra soat cot dia chi trong sheet goc.
  - chinh lai format dia chi (so nha, ngo/ngach, alias) de map dung.

### Ma 5 - Lech truong ten phong / mapping phong

- Dau hieu: ten phong vao sai cot, ten phong bi trong, room name trong giong gia, gia khong parse duoc do lech mapping.
- Dau hieu ky thuat hien co:
  - `ROOM_NOT_MATCHED_POSSIBLE_WRONG_COLUMN`
  - `ROOM_NAME_MISSING`
  - `ROOM_NAME_LOOKS_LIKE_PRICE`
  - `WEB_ROOM_NAME_LOOKS_LIKE_PRICE`
  - `PRICE_UNPARSEABLE`
  - `PRICE_LOOKS_LIKE_ROOM_NAME`
- Huong xu ly: vao mapping va setup lai vi tri cot `ROOMS`, `PRICE` va cac cot lien quan.

### Ma 6 - CDT khong co phong trong

- Dau hieu: tool chay binh thuong nhung tong phong trong cua CDT = 0.
- Huong xu ly: phan biet ro 2 truong hop: CDT thuc su het phong trong, hoac tool khong quet duoc du lieu.
- Luu y: report can co day du danh sach CDT duoc chay, ke ca CDT co 0 phong.

### Ma 7 - Toa moi / thieu toa moi tren DB

- Cach chot nay duoc SUY RA TU SHEET cua Chu:
  - Dong cau hoi ghi: `Nhung CDT nao co toa moi?`
  - Ghi chu ben phai ghi: `Loi thieu toa moi dung khong?`
- Dau hieu nghiep vu:
  - CDT co dia chi/toa nha moi trong sheet nhung tren he thong chua co toa tuong ung.
  - Tro ly phai liet ke ro `CDT nao`, `dia chi nao`, `toa nao` la toa moi.
- Dau hieu ky thuat co the gap:
  - `BUILDING_NOT_FOUND`
  - `BUILDING_NOT_MATCHED`
  - `BUILDING_MISSING_ON_WEB_LOGGED`
  - truong hop search building khong ra ket qua hoac DB chua co toa.
- Huong xu ly:
  - liet ke danh sach CDT + dia chi/toa nha moi.
  - doi chieu xem day la toa moi that hay chi la lech alias/dia chi.
  - neu la toa moi that thi bao dev/doi van hanh tao toa hoac bo sung metadata building/alias tren DB truoc khi chay lai.

## 3. Mau bao cao chot

```text
[OPENCLAW_STAGE_2] YYYY-MM-DD HH:mm:ss
II.A.1: Dieu kien can = DAT/CHUA DAT. Tool co lay duoc tong so phong hay khong.
II.A.2: Tong hop nhanh = X CDT canh bao; Y phong khong cap nhat; Z phong chua kiem tra duoc anh.
II.A.3: Ma 3 = ...
II.A.4: Ma 6 = ...
II.B.1: CDT <id> (<ten>) = MA 7 x<n> toa moi. Dau hieu: ...
II.B.2: CDT <id> (<ten>) = MA 5 x<n> phong. Dau hieu: ...
II.B.3: CDT <id> (<ten>) = MA 4 x<n> phong. Dau hieu: ...
II.B.4: CDT <id> (<ten>) = CANH BAO VANG x<n> phong. Dau hieu: ...
II.B.5: Huong xu ly uu tien = ...
```

## 4. Nhung diem sai va thieu trong ban nhap cu

- Dang tron "so thu tu cau hoi" voi "ma loi".
- Chua tach ro giai doan II la OpenClaw.
- Chua tach ro `dieu kien can` va `dieu kien du`.
- Chua chot ro bo moi: `Muc 1-2` la tong quan, ma loi chi tiet la `Ma 3-7`.
- Theo bo moi cua Chu: `Ma 7` la nhom `toa moi / thieu toa moi`.
- Bao cao van con dai dong, chua dat dang "nhin vao la xu ly duoc ngay".
- Chua danh dau ro muc nao la do, muc nao la vang.

## 5. Checklist cau hinh OpenClaw (copy-paste)

### 5.1 Trigger (Doc file summary sau khi room-audit chay xong)

- Ten flow goi y: `room-audit-stage-2-report`.
- Kieu trigger: file watcher hoac scheduler.
- File can doc:
  - `C:/Users/thinh/.openclaw/workspace/latest-room-audit-summary.txt`
- Chu ky goi y neu dung scheduler: moi 5 phut.
- Dieu kien chay:
  - File ton tai.
  - `lastModified` moi hon lan xu ly truoc.
  - Kich thuoc file > 0.

### 5.2 Parser prompt (copy-paste vao OpenClaw)

```text
Ban la tro ly OpenClaw Stage 2 cho room-audit.
Input la noi dung file latest-room-audit-summary.txt.

Muc tieu:
1) Rut gon thanh bao cao thao tac ngay, dung bo ma:
- Muc 1, Muc 2 = tong quan.
- Ma loi chi tiet = Ma 3, Ma 4, Ma 5, Ma 6, Ma 7.
2) Tao 2 dau ra:
- telegram_text: ban ngan gon gui Telegram.
- sheet_rows: dung 7 dong de ghi vao sheet AI Bao cao.

Quy tac:
- Moi dong 1 ket luan + 1 huong xu ly.
- Neu khong co du lieu cho 1 ma, ghi "Khong phat hien".
- Khong viet lan man, uu tien xu ly.
- Co nhan muc do:
  - [DO] loi can xu ly ngay.
  - [VANG] canh bao theo doi.

Output bat buoc theo JSON:
{
  "run_time": "YYYY-MM-DD HH:mm:ss",
  "telegram_text": "string",
  "sheet_rows": [
    "Muc 1: ...",
    "Muc 2: ...",
    "Ma 3: ...",
    "Ma 4: ...",
    "Ma 5: ...",
    "Ma 6: ...",
    "Ma 7: ..."
  ],
  "severity_summary": {
    "do_count": 0,
    "vang_count": 0
  }
}
```

### 5.3 Sheet target (copy-paste tham so)

- Spreadsheet id: `11EyNOVAMn7ei-J8svcMjpvv1B7AashTUDyRB-gUeHho`
- Sheet name: `AI Bao cao`
- Header row: `1`
- Data row: `2 -> 8`
- Bat dau cot ngay: `G`
- Cach ghi:
  - Tim cot co ngay hom nay o header row.
  - Neu chua co, them cot moi ben phai va ghi ngay.
  - Ghi `sheet_rows[0..6]` vao 7 dong tu row 2 den row 8.

### 5.4 Telegram target (copy-paste tham so)

- Bot token: lay tu secret cua OpenClaw (khong hardcode).
- Chat id: nhom bao cao cua Chu.
- Noi dung gui:
  - Header: `[OPENCLAW_STAGE_2] <run_time>`
  - Body: `telegram_text`
- Gioi han:
  - Neu > 3500 ky tu thi cat gon, uu tien giu Muc 1-2 va Ma [DO].

### 5.5 Retry + fail-safe (copy-paste logic)

- Retry:
  - Sheet write retry 3 lan: 2s, 5s, 10s.
  - Telegram send retry 3 lan: 2s, 5s, 10s.
- Idempotent:
  - Dung key `report_date + file_modified_time` de tranh gui trung.
- Neu parse JSON loi:
  - Khong gui ra ngoai.
  - Ghi log `openclaw-stage2-parse-error.log`.
  - Gui 1 canh bao ngan vao nhom ky thuat (neu co):
    - `Stage 2 parse failed, can check latest-room-audit-summary.txt`.
- Neu Sheet loi nhung Telegram thanh cong:
  - Van gui Telegram kem tag `[CANH BAO] Sheet update fail`.
- Neu Telegram loi nhung Sheet thanh cong:
  - Ghi log canh bao, danh dau job `partial_success`.

### 5.6 Van hanh hang ngay

- Buoc 1: Chay `room-audit` theo lich.
- Buoc 2: Kiem tra file da cap nhat:
  - `C:/Users/thinh/.openclaw/workspace/latest-room-audit-summary.txt`
- Buoc 3: OpenClaw doc file va tao JSON output.
- Buoc 4: OpenClaw ghi Sheet + gui Telegram.
- Buoc 5: Neu that bai, xem log retry/fail-safe va chay lai job Stage 2.
