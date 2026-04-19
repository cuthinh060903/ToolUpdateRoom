# OpenClaw Stage 2 Handbook

## 1. Chot lai cach viet bao cao

- `II.A.x`, `II.B.x` la ma muc bao cao, KHONG PHAI ma loi.
- `Ma 1` den `Ma 7` moi la bo ma loi de nguoi doc nhin vao la biet van de va cach xu ly.
- Giai doan II = OpenClaw.
- `II.A` = dieu kien can: tool phai chay va lay duoc tong so phong.
- `II.B` = dieu kien du: sau khi co tong phong thi moi audit chi tiet tung phong/CDT.
- Bao cao Telegram va bao cao copy vao Google Sheet phai viet ngan, tung dong mot ket luan + mot huong xu ly.

## 2. So tay 7 ma loi

### Ma 1 - Loi link bang hang

- Dau hieu: Google Sheet/link nguon het han, bi khoa, khong truy cap duoc, hoac tool doc sheet fail.
- Nguon phat hien: Telegram/log nguon, `source_errors`, buoc `processCsvData`.
- Huong xu ly: kiem tra lai link o cac nguon cap, copy link moi nhat va dan de vao tool.

### Ma 2 - Sai lech tong so luong phong

- Dau hieu: tong phong tool dem duoc khac tong phong thuc te can co.
- Huong xu ly: doi chieu tong phong tren he thong voi tong dong hop le trong sheet goc.
- Luu y: room-audit hien tai CHUA tu dong doi chieu duoc ma nay neu khong co so tong tham chieu.

### Ma 3 - Trung phong / dong rac / du lieu lap

- Dau hieu: cung mot phong bi lap lai, co dong rong, hoac co dong rac lam sai tong so phong.
- Huong xu ly: ra soat sheet goc, xoa dong trung, dong rong, dong sai cau truc.
- Luu y: can them rule tach rieng neu muon tool tu dong bat ma nay on dinh.

### Ma 4 - Toa moi / thieu toa moi tren DB

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
  - Liet ke danh sach CDT + dia chi/toa nha moi.
  - Doi chieu xem day la toa moi that hay chi la lech alias/dia chi.
  - Neu la toa moi that thi bao dev/doi van hanh tao toa hoac bo sung metadata building/alias tren DB truoc khi chay lai.
- Luu y quan trong:
  - Logic tu dong trong `room-audit` DA tach `Ma 4` khoi `Ma 5` theo cum dia chi.
  - Rule hien tai chi day vao `Ma 4` khi cum dia chi do khong co tin hieu building da ton tai, hoac co log `khong co du lieu toa tren web`.
  - Neu cum dia chi van co dau hieu toa da ton tai tren he thong thi se giu o `Ma 5` de tranh tach nham.

### Ma 5 - Lech truong du lieu / lech mapping

- Dau hieu: cot du lieu bi lech, dia chi vao sai cot, ten phong vao sai cot, room name trong giong gia, gia khong parse duoc, tool doc sai vi tri field.
- Dau hieu ky thuat hien co: `ROOM_NOT_MATCHED_POSSIBLE_WRONG_COLUMN`, `ADDRESS_MISSING`, `ROOM_NAME_MISSING`, `PRICE_LOOKS_LIKE_ROOM_NAME`, `ADDRESS_MISMATCH_LOGGED`, `BUILDING_NOT_MATCHED`.
- Huong xu ly: vao phan mapping cua tool va setup lai vi tri cot ADDRESS / ROOMS / PRICE / IMAGE_DRIVER / cac cot lien quan.

### Ma 6 - CDT khong co phong trong

- Dau hieu: tool chay binh thuong nhung tong phong trong cua CDT = 0.
- Huong xu ly: phan biet ro 2 truong hop: CDT thuc su het phong trong, hoac tool khong quet duoc du lieu.
- Luu y: muon ket luan chinh xac theo tung CDT thi report can co day du danh sach CDT duoc chay, ke ca CDT co 0 phong.

### Ma 7 - Loi metadata toa nha va anh

- Dau hieu: co phong nhung khong co anh, link anh loi quyen, `IMAGE_DRIVER` thieu/sai, ten toa nha/alias khong khop DB.
- Dau hieu ky thuat hien co: `IMAGE_DRIVER_MISSING`, `IMAGE_COUNT_NOT_CHECKED`, `IMAGE_LINK_401`, `IMAGE_LINK_403`, `IMAGE_LINK_404`, `BUILDING_NOT_FOUND`.
- Huong xu ly: kiem tra quyen link anh, bo sung anh tu Zalo/Telegram, ra soat building/alias va metadata can doi chieu voi DB.

## 3. Mau bao cao chot

```text
[OPENCLAW_STAGE_2] YYYY-MM-DD HH:mm:ss
II.A.1: Dieu kien can = DAT/CHUA DAT. Tool co lay duoc tong so phong hay khong.
II.A.2: Tong hop nhanh = X CDT canh bao; Y phong khong cap nhat; Z phong chua kiem tra duoc anh.
II.A.3: Ma 1 = ...
II.A.4: Ma 6 = ...
II.B.1: CDT <id> (<ten>) = MA 4 x<n> toa moi. Dau hieu: ...
II.B.2: CDT <id> (<ten>) = MA 5 x<n> phong. Dau hieu: ...
II.B.3: CDT <id> (<ten>) = MA 7 x<n> phong. Dau hieu: ...
II.B.4: CDT <id> (<ten>) = CANH BAO VANG x<n> phong. Dau hieu: ...
II.B.5: Huong xu ly uu tien = ...
```

## 4. Nhung diem sai va thieu trong ban nhap cu

- Dang tron "so thu tu cau hoi" voi "ma loi".
- Chua tach ro giai doan II la OpenClaw.
- Chua tach ro `dieu kien can` va `dieu kien du`.
- Chua co so tay 7 ma loi de AI va nhan vien moi cung dung mot cach hieu.
- `Ma 4` tren sheet la nhom `toa moi / thieu toa moi`, va code hien tai da tach tu dong nhom nay khoi `Ma 5` theo heuristic dia chi.
- Bao cao van con dai dong, chua dat dang "nhin vao la xu ly duoc ngay".
- Chua danh dau ro muc nao la do, muc nao la vang.
