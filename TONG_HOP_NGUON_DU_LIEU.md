# Tổng Hợp Nguồn Dữ Liệu ToolUpdateRoom

## 1. Kết luận nhanh

- `tool` hiện tại là một CLI Node.js chạy cục bộ để:
  - đọc dữ liệu phòng từ Google Sheets
  - so khớp địa chỉ/tòa/phòng với dữ liệu trên hệ thống Sari
  - cập nhật trạng thái phòng, giá, mô tả, link ảnh qua API Sari
  - tải ảnh từ Google Drive / Google Photos / direct image rồi upload lên MinIO
  - ghi log nội bộ và gửi báo cáo Telegram
- `DB` không được truy cập trực tiếp bằng SQL trong repo này.
- Repo hiện không có kết nối `mysql`, `postgres`, `mongo`, `prisma`, `sequelize`, `typeorm`.
- Dữ liệu hệ thống đang được đọc/ghi gián tiếp qua REST API của Sari.

## 2. Bảng nhỏ theo đúng yêu cầu

| Mục | Kết quả |
|---|---|
| Nguồn 1: tool | Tool Node.js `index.js`, cấu hình sheet trong `constants.js` |
| Nguồn 2: database | Không thấy DB SQL trực tiếp trong repo; dữ liệu DB hệ thống đang đi qua API Sari |
| Dữ liệu cần lấy | `updated_at`, `origin_link`, `name`, `status`, số ảnh, `chu_dau_tu`, `price` và các field liên quan |
| Thời gian cập nhật cuối | Lấy từ `rooms.updated_at`, `realnews.updated_at`, hoặc log file nội bộ |
| Link nguồn | Từ Google Sheet cột link ảnh, map vào `origin_link` của room |
| Tên phòng | Từ Google Sheet `room_column`, map vào `rooms.name` |
| Trạng thái phòng trống | Từ `rooms.status`, `rooms.empty_room_date` |
| Số ảnh | Không thấy field số ảnh sẵn trong room API đang dùng; phải đếm object MinIO theo prefix ảnh của room |
| CDT | Từ `huydev.id` trong `LIST_GGSHEET`, và field `chu_dau_tu` ở building API |
| Giá / phòng / field liên quan | Từ Google Sheet `price_column`, map vào `rooms.price`; building có `rent_price_month` |

## 3. Tool là tool gì

- Tên project: `ToolUpdateRoom`
- Loại: script Node.js / CLI nội bộ
- Entry point: `index.js`
- Chạy bằng:
  - `node index.js`
  - hoặc `npm start`
- Chức năng chính:
  - đọc cấu hình nguồn sheet từ `constants.js`
  - lấy dữ liệu từ Google Sheets
  - tìm building trên Sari bằng API `realnews/search`
  - tìm room theo building bằng API `rooms/search`
  - mở trạng thái phòng trống bằng `unlockRoom`
  - cập nhật giá / mô tả / link ảnh bằng `PATCH /rooms/{id}`
  - tạo room mới bằng `POST /rooms`
  - gắn tag tiện ích phòng qua `apiv1.sari.vn`
  - upload ảnh lên MinIO bucket `sari`
  - gửi thống kê qua Telegram

## 4. DB là DB gì

### 4.1. Điều đã xác định chắc chắn

- Repo này không truy vấn DB trực tiếp.
- Không thấy file cấu hình kết nối DB.
- Không thấy thư viện ORM / query builder thông dụng.

### 4.2. Kết luận thực tế

- “Database” ở góc nhìn repo này chính là dữ liệu phía hệ thống Sari.
- Repo chỉ truy cập dữ liệu đó qua API:
  - `https://api-legacy.sari.vn/v1/...`
  - `https://apiv1.sari.vn/v1/...`

### 4.3. Suy luận về bảng nghiệp vụ phía hệ thống

Dựa trên API và payload, có thể suy ra hệ thống phía sau ít nhất có 2 nhóm dữ liệu chính:

- `realnews` hoặc bảng tương đương cho tòa / building
- `rooms` hoặc bảng tương đương cho phòng

Lưu ý:

- Đây là suy luận từ endpoint và field trả về.
- Repo không chứa schema SQL nên chưa thể khẳng định tên bảng vật lý trong DB backend.

## 5. Lấy dữ liệu ở đâu

## 5.1. Nguồn đầu vào chính

### A. Google Sheets

- Nằm trong `constants.js` dưới biến `LIST_GGSHEET`
- Đây là nơi định nghĩa:
  - CDT
  - link sheet
  - gid
  - cột địa chỉ
  - cột phòng
  - cột giá
  - cột trạng thái loại trừ
  - cột link ảnh
  - cột mô tả

Ví dụ cấu hình mỗi nguồn gồm:

- `id`
- `type`
- `web`
- `link`
- `list_address`
- `address_column`
- `room_column`
- `price_column`
- `building_code_column`
- `exitColumn`
- `exitLinkDriver`
- `mota`
- `header`
- `hesogia`

### B. Sari API

- Dùng để đọc/ghi dữ liệu building và room trên hệ thống

### C. MinIO

- Dùng để lưu ảnh phòng
- Bucket đang dùng: `sari`
- Prefix ảnh room:
  - `rooms/{room.id}/photos/...`

### D. Telegram

- Dùng để gửi báo cáo sau khi chạy tool

### E. Log file nội bộ

- Dùng để ghi lịch sử cập nhật và tránh xử lý lặp

## 5.2. Nguồn dữ liệu theo từng loại thông tin

| Dữ liệu | Nguồn lấy |
|---|---|
| Địa chỉ | Google Sheets, sau đó đối chiếu với `realnews/search` |
| Tên phòng | Google Sheets |
| Giá phòng | Google Sheets |
| Trạng thái phòng | Sari room API |
| Link ảnh gốc | Google Sheets |
| Ảnh đã upload | MinIO |
| Mã CDT | `LIST_GGSHEET.id` và `realnews.chu_dau_tu` |
| Thời gian cập nhật | Sari API hoặc log local |

## 6. Bảng nào / API nào / file nào

## 6.1. File chính trong repo

| File | Vai trò |
|---|---|
| `index.js` | Luồng xử lý chính |
| `constants.js` | Danh sách nguồn Google Sheets và mapping cột |
| `extension.js` | Mapping tiện ích/phân loại từ mô tả |
| `telegram_bot.js` | Gửi báo cáo Telegram |
| `.env` / `.env.example` | Biến môi trường cho OpenAI / MinIO |
| `ggsheets.json` | Credentials Google API |

## 6.2. API endpoint chính

### A. Building / realnews

- `POST https://api-legacy.sari.vn/v1/realnews/search`
  - Dùng để tìm tòa theo địa chỉ hoặc theo `chu_dau_tu`
- `POST https://api-legacy.sari.vn/v1/realnews`
  - Có hàm tạo tòa mới trong code, nhưng hiện đang comment ở luồng chính

### B. Room

- `POST https://api-legacy.sari.vn/v1/rooms/search`
  - Tìm danh sách phòng theo `real_new_id`
- `POST https://api-legacy.sari.vn/v1/rooms/unlockRoom?id={id}`
  - Mở trạng thái phòng
- `PATCH https://api-legacy.sari.vn/v1/rooms/{id}`
  - Cập nhật phòng
- `POST https://api-legacy.sari.vn/v1/rooms`
  - Tạo phòng mới
- `POST https://api-legacy.sari.vn/v1/rooms/lockRoomToDate?id={id}&date={date}`
  - Khóa phòng tới một ngày
- `POST https://api-legacy.sari.vn/v1/rooms/lockRoomsToDates`
  - Cập nhật kín hàng loạt

### C. Room tags / tiện ích

- `PUT https://apiv1.sari.vn/v1/tag-relations/room/{room.id}`
  - Gắn tag tiện ích dựa trên mô tả

## 6.3. “Bảng” hoặc entity nghiệp vụ suy ra từ API

| Entity suy ra | Endpoint | Ý nghĩa |
|---|---|---|
| `realnews` | `/v1/realnews/search` | Tòa nhà / building |
| `rooms` | `/v1/rooms/search`, `/v1/rooms`, `/v1/rooms/{id}` | Phòng |
| `tag_relations_room` hoặc tương đương | `/v1/tag-relations/room/{id}` | Tiện ích / extension room |

Lưu ý:

- Đây là entity suy ra từ API và payload.
- Chưa có schema DB backend trong repo để xác nhận tên bảng vật lý.

## 7. Tên cột / field đã xác minh

## 7.1. Field trong `LIST_GGSHEET` của tool

Đây là các “cột nguồn” quan trọng phải biết:

| Field config | Ý nghĩa |
|---|---|
| `id` | Mã CDT nội bộ |
| `web` | Tên nguồn / tên bảng hàng |
| `link` | Link Google Sheet |
| `list_address` | Danh sách gid / sheet con cần đọc |
| `address_column` | Cột địa chỉ |
| `room_column` | Cột tên phòng |
| `price_column` | Cột giá |
| `building_code_column` | Cột mã tòa nếu có |
| `exitColumn` | Cột trạng thái loại trừ |
| `exitLinkDriver` | Cột chứa link ảnh / driver |
| `mota` | Cột mô tả |
| `header` | Dòng header |
| `hesogia` | Hệ số quy đổi giá |
| `type` | Loại room / loại nguồn |

## 7.2. Field room API đã xác minh bằng request thật

Từ `POST /v1/rooms/search`, room trả về các field:

| Field | Ý nghĩa |
|---|---|
| `id` | ID phòng |
| `real_new_id` | ID tòa chứa phòng |
| `name` | Tên phòng |
| `area` | Diện tích |
| `price` | Giá phòng |
| `rent_price_hour` | Giá theo giờ |
| `rent_price_day` | Giá theo ngày |
| `status` | Trạng thái phòng, ví dụ `con`, `het` |
| `empty_room_date` | Ngày trống / ngày lock |
| `image_link` | Link ảnh hoặc link Facebook đang lưu |
| `origin_link` | Link nguồn ảnh gốc |
| `is_deleted` | Cờ xóa |
| `created_at` | Thời gian tạo |
| `updated_at` | Thời gian cập nhật cuối |
| `description` | Mô tả |
| `last_status_con_at` | Mốc gần nhất về trạng thái còn |
| `last_status_con_source` | Nguồn cập nhật trạng thái |
| `app_display_type` | Kiểu hiển thị app |

## 7.3. Field building API đã xác minh bằng request thật

Từ `POST /v1/realnews/search`, building trả về các field:

| Field | Ý nghĩa |
|---|---|
| `id` | ID tòa |
| `code` | Mã tòa |
| `title` | Tiêu đề tin / tòa |
| `slugname` | Slug |
| `intro` | Mô tả ngắn |
| `content` | Nội dung |
| `service_type` | Loại dịch vụ |
| `type` | Loại tòa, ví dụ `chdv` |
| `status` | Trạng thái |
| `price` | Giá tổng hợp |
| `rent_price_hour` | Giá giờ |
| `rent_price_day` | Giá ngày |
| `rent_price_month` | Giá tháng |
| `is_public` | Public hay không |
| `sale_bonus` | Hoa hồng |
| `province_id` | Tỉnh/thành |
| `district_id` | Quận/huyện |
| `address` | Địa chỉ thô |
| `address_valid` | Địa chỉ chuẩn hóa |
| `fb_page_url` | Link Facebook page/post |
| `owner_name` | Tên chủ |
| `owner_phone` | SĐT chủ |
| `manager_phone` | SĐT quản lý |
| `thumbnail` | Ảnh đại diện |
| `bedroom_number` | Số phòng ngủ |
| `floor_number` | Số tầng |
| `acreage` | Diện tích |
| `activity_time` | Thời gian hoạt động |
| `created_at` | Thời gian tạo |
| `updated_at` | Thời gian cập nhật cuối |
| `chu_dau_tu` | Mã CDT |
| `updated_by` | Người cập nhật |
| `latitude` | Vĩ độ |
| `longitude` | Kinh độ |
| `coordinates_valid` | Cờ hợp lệ tọa độ |

## 8. Mapping dữ liệu cần lấy theo yêu cầu

| Dữ liệu cần lấy | Lấy từ đâu | Field / cột / endpoint |
|---|---|---|
| Thời gian cập nhật cuối của tòa | Sari building API | `realnews.updated_at` từ `POST /v1/realnews/search` |
| Thời gian cập nhật cuối của phòng | Sari room API | `rooms.updated_at` từ `POST /v1/rooms/search` |
| Link nguồn | Google Sheet + room API | cột `exitLinkDriver` -> `row["IMAGE_DRIVER"]` -> `origin_link` |
| Tên phòng | Google Sheet + room API | `room_column` -> `rooms.name` |
| Trạng thái phòng trống | room API | `status`, `empty_room_date` |
| Số ảnh | MinIO | đếm object trong `rooms/{room.id}/photos` |
| CDT | Tool config + building API | `LIST_GGSHEET.id`, `realnews.chu_dau_tu` |
| Giá phòng | Google Sheet + room API | `price_column` -> `row["PRICE"]` -> `rooms.price` |
| Mã tòa | building API | `realnews.code` |
| Địa chỉ chuẩn | building API | `realnews.address_valid` |
| ID tòa | building API | `realnews.id` |
| ID phòng | room API | `rooms.id` |
| Mô tả phòng | Google Sheet + room API | `mota` -> `description` |
| Link Facebook / ảnh đang lưu | room API | `image_link` |

## 9. File log nội bộ đang giữ lịch sử chạy

| File | Ý nghĩa |
|---|---|
| `capnhattrong.txt` | Log phòng được mở trống / unlock |
| `capnhatgia.txt` | Log cập nhật giá |
| `capnhatdriver.txt` | Log cập nhật link ảnh / driver |
| `driver_error.txt` | Log lỗi ảnh |
| `phongmoi.txt` | Log tạo phòng mới |
| `taophongloi.txt` | Log tạo phòng thất bại |
| `nhamoi.txt` | Log không match được địa chỉ |
| `khongcodulieu.txt` | Log không có dữ liệu tòa trên web |
| `ggsheet.txt` | Log lỗi dữ liệu sheet |
| `exits.txt` | Đánh dấu source đã chạy |
| `thong_ke.txt` | Tổng hợp thống kê |
| `facebook.txt` | Log phòng chưa có link FB |

## 10. Việc cần làm ngay

### Mục tiêu thực tế ngay lúc này

Phải chốt được đường đi dữ liệu theo từng room:

1. Room này đến từ Google Sheet nào
2. Thuộc CDT nào
3. Match sang building nào trên Sari
4. Match sang room nào trên Sari
5. Giá hiện tại là gì
6. Trạng thái hiện tại là gì
7. Link nguồn ảnh là gì
8. Có bao nhiêu ảnh thật trong MinIO
9. Cập nhật cuối lúc nào

### Thứ tự nên làm

1. Xác định `CDT / source` trong `constants.js`
2. Lấy `link`, `list_address`, `address_column`, `room_column`, `price_column`, `exitLinkDriver`
3. Đọc dữ liệu sheet để ra:
   - địa chỉ
   - tên phòng
   - giá
   - link ảnh
4. Gọi `realnews/search` để tìm:
   - `id`
   - `code`
   - `address_valid`
   - `chu_dau_tu`
   - `updated_at`
5. Gọi `rooms/search` theo `real_new_id` để lấy:
   - `id`
   - `name`
   - `price`
   - `status`
   - `origin_link`
   - `image_link`
   - `updated_at`
6. Đếm ảnh trong MinIO theo prefix:
   - `rooms/{room.id}/photos`
7. Xuất bảng cuối cùng cho từng room / từng CDT

## 11. Nếu chưa rõ thì việc đầu tiên là gì

Theo đúng yêu cầu, nếu chưa rõ thì việc đầu tiên là đi tìm:

- tên endpoint
- field response
- cột sheet
- mapping từ sheet sang API

Hiện tại phần này đã rõ ở mức đủ dùng:

- endpoint đã xác định
- field room đã xác định
- field building đã xác định
- cột sheet đã xác định qua `LIST_GGSHEET`

Phần còn chưa có trong repo:

- tên bảng vật lý thật trong DB backend của Sari
- schema SQL backend

Muốn biết chính xác phần này thì phải:

- có source backend Sari
- hoặc có quyền truy cập DB backend

## 12. Ví dụ mẫu đã xác minh thật

### Building mẫu

- `id`: `40293`
- `code`: `013040293`
- `address`: `18 Hàm Long`
- `address_valid`: `Hàm Long.18`
- `chu_dau_tu`: `13`
- `updated_at`: có tồn tại trong response

### Room mẫu

- `id`: `2463`
- `real_new_id`: `40293`
- `name`: `101`
- `price`: `5700000`
- `status`: `het`
- `origin_link`: có tồn tại trong response
- `image_link`: có tồn tại trong response
- `updated_at`: có tồn tại trong response

## 13. Kết luận cuối cùng

- Tool này đọc dữ liệu từ Google Sheets, không đọc DB SQL trực tiếp.
- Dữ liệu hệ thống được truy cập qua Sari API.
- Muốn lấy đủ các field bạn yêu cầu thì hiện có thể làm bằng:
  - `constants.js`
  - Google Sheets
  - `realnews/search`
  - `rooms/search`
  - MinIO
  - các file log nội bộ
- Nếu cần biết chính xác tên bảng DB vật lý backend thì repo này chưa đủ thông tin.
