# Hướng Dẫn Chạy Hẹn Giờ Cho Chú

## Chốt cách đang dùng hiện tại

Hiện tại tool này chạy bằng **Windows Task Scheduler**.

Nghĩa là:

- Không cần mở file code rồi bỏ comment `cron.schedule(...)`
- Không cần mở `node index.js` rồi để máy chạy suốt bằng tay
- Đến giờ thì Windows sẽ tự gọi tool chạy

Nói ngắn gọn:

- **Dùng hẹn giờ của Windows**
- **Không dùng cron trong code**

## Hiện tại có 3 nhóm lệnh chính

Từ bây giờ mình chốt dùng đúng 3 nhóm:

1. Chỉ chạy `trống kín`
2. Chỉ chạy `room audit`
3. Chạy `cả 2` chức năng trên cùng lúc

Mỗi nhóm đều có:

- lệnh `tạo lịch`
- lệnh `hủy lịch`
- lệnh `chạy thử 1 lần`

## 1. Nhóm chỉ chạy trống kín

Đây là luồng chính đang cập nhật phòng trống và phòng kín như trước giờ.

### Tạo lịch

```powershell
npm run schedule:create:trong-kin
```

### Hủy lịch

```powershell
npm run schedule:cancel:trong-kin
```

### Chạy thử 1 lần

```powershell
npm run run:trong-kin
```

### Thông tin của nhóm này

- Tên task: `ToolUpdateRoom-TrongKin-Daily`
- File chạy: `index.js`
- Log ghi vào: `logs\trong-kin-run-YYYY-MM-DD_HH-mm-ss.log`

## 2. Nhóm chỉ chạy room audit

Nhóm này chỉ chạy báo cáo `room audit`.

### Tạo lịch

```powershell
npm run schedule:create:room-audit
```

### Hủy lịch

```powershell
npm run schedule:cancel:room-audit
```

### Chạy thử 1 lần

```powershell
npm run run:room-audit
```

### Thông tin của nhóm này

- Tên task: `ToolUpdateRoom-RoomAudit-Daily`
- File chạy: `modules/room-audit/index.js`
- Log ghi vào: `logs\room-audit-run-YYYY-MM-DD_HH-mm-ss.log`
- Khi chạy preset này sẽ gửi Telegram room audit với tham số `--send-telegram=true`

Nếu muốn chạy tay trực tiếp, không qua wrapper hẹn giờ:

```powershell
npm run audit:room -- --send-telegram=true
```

## 3. Nhóm chạy cả 2 chức năng cùng lúc

Nhóm này sẽ chạy theo thứ tự:

1. `trống kín`
2. `room audit`

### Tạo lịch

```powershell
npm run schedule:create:all
```

### Hủy lịch

```powershell
npm run schedule:cancel:all
```

### Chạy thử 1 lần

```powershell
npm run run:all
```

### Thông tin của nhóm này

- Tên task: `ToolUpdateRoom-All-Daily`
- File chạy: `scripts/run-all-daily.js`
- Log ghi vào: `logs\all-run-YYYY-MM-DD_HH-mm-ss.log`

## Nếu muốn đổi giờ chạy

Mặc định các lệnh `schedule:create:*` sẽ cài giờ:

- `05:00 sáng`

Nếu muốn đổi sang giờ khác thì thêm `-- -Times`.

Ví dụ muốn chạy `12:00 trưa` và `17:30 chiều`:

### Trống kín

```powershell
npm run schedule:create:trong-kin -- -Times "12:00","17:30"
```

### Room audit

```powershell
npm run schedule:create:room-audit -- -Times "12:00","17:30"
```

### Cả 2 cùng chạy

```powershell
npm run schedule:create:all -- -Times "12:00","17:30"
```

Nếu muốn cài 1 giờ khác, ví dụ `09:00 sáng`, thì làm tương tự:

```powershell
npm run schedule:create:trong-kin -- -Times "09:00"
```

## Phân biệt rõ: dừng đang chạy và hủy lịch

Hai việc này khác nhau:

- `stop`: chỉ dừng lần chạy đang chạy dở
- `cancel`: xóa lịch khỏi Windows, về sau sẽ không tự chạy nữa

### Lệnh stop nếu cần dừng lần đang chạy

```powershell
npm run schedule:stop
npm run schedule:stop:room-audit
npm run schedule:stop:all
```

### Lệnh cancel nếu muốn hủy lịch hẳn

```powershell
npm run schedule:cancel:trong-kin
npm run schedule:cancel:room-audit
npm run schedule:cancel:all
```

## Nếu có tiến trình Node còn chạy

Có lúc task đã dừng nhưng tiến trình `node` vẫn còn chạy.

Khi đó làm như sau:

### Bước 1: xem PID

```powershell
Get-Process | Where-Object { $_.ProcessName -like 'node*' }
```

### Bước 2: dừng PID cần dừng

```powershell
Stop-Process -Id <PID>
```

Ví dụ:

```powershell
Stop-Process -Id 52860
```

## Điều kiện để tool tự chạy đúng giờ

Để đến giờ Windows tự chạy đúng, cần:

- Máy đang bật
- Máy không ở chế độ sleep đúng giờ đó
- User đang đăng nhập Windows
- Có mạng Internet

## Vì sao không dùng `cron.schedule(...)` trong code

Trong code vẫn có đoạn `cron.schedule(...)`, nhưng đó là cách cũ hoặc cách khác.

Nếu dùng cách đó thì phải:

- mở tiến trình Node suốt cả ngày
- không được tắt tiến trình đó

Cách đó hợp với server hoặc VPS bật 24/24.

Máy Windows cá nhân thì cách ổn hơn là:

- để file chạy xong rồi thoát
- đến giờ Windows tự gọi lại

Nên hiện tại mình chốt:

- **Dùng Windows Task Scheduler**
- **Không dùng cron trong code**

## Kết luận ngắn gọn

Nếu chú hỏi:

“Tool đang chạy theo cách nào?”

Thì câu trả lời là:

**Hiện tại tool đang chạy bằng hẹn giờ của Windows, không phải cron trong code.**
