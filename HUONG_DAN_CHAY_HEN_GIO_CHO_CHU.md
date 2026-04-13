# Hướng Dẫn Chạy Hẹn Giờ Cho Chú

## Chốt cách đang dùng hiện tại

Hiện tại tool này đang được cài để chạy theo **Windows Task Scheduler**.

Nghĩa là:

- Không cần mở file code rồi bỏ comment `cron.schedule(...)`
- Không cần mở `node index.js` rồi để máy chạy suốt bằng tay
- Windows sẽ tự gọi tool theo giờ đã cài

Hiện đang cài lịch:

- `12:00 trưa`
- `5:30 chiều`

Tên task đang dùng:

- `ToolUpdateRoom-TwiceDaily`

## Vì sao không dùng đoạn `cron.schedule(...)` trong code

Trong `index.js` có đoạn hẹn giờ, nhưng đoạn đó đang comment.

Nếu dùng cách đó thì phải:

- mở `node index.js`
- để tiến trình Node chạy suốt cả ngày
- không được tắt tiến trình đó

Cách đó hợp khi chạy trên server hoặc VPS bật 24/24.

Máy Windows cá nhân thì cách dễ hiểu và ổn định hơn là:

- để `index.js` chỉ chạy 1 lần rồi thoát
- đến giờ thì Windows tự gọi lại

Nên hiện tại chốt là:

- **Dùng Task Scheduler của Windows**
- **Không mở comment `cron.schedule(...)`**

## Cách chạy thủ công 1 lần

Nếu muốn chạy thử ngay:

```powershell
npm run run:daily
```

Lệnh này sẽ chạy tool 1 lần và ghi log vào thư mục `logs`.

## Cách cài lịch chạy tự động

Nếu cần cài lại lịch:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-daily-task.ps1 -Times "12:00","17:30" -TaskName "ToolUpdateRoom-TwiceDaily"
```

## Cách dừng task đang chạy tự động

Nếu task đang chạy và muốn dừng:

```powershell
npm run schedule:stop
```

Hoặc:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-daily-task.ps1 -TaskName "ToolUpdateRoom-TwiceDaily"
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

## Điều kiện để tự chạy đúng giờ

Để đến `12:00` và `17:30` tool tự chạy, cần:

- Máy đang bật
- Máy không ở chế độ sleep đúng giờ đó
- User đang đăng nhập Windows
- Có mạng Internet

## Nếu sau này chuyển sang VPS hoặc server

Khi chuyển sang VPS/server bật 24/24 thì có 2 hướng:

- vẫn dùng scheduler của hệ điều hành
- hoặc dùng `cron` / `pm2`

Nhưng ở máy hiện tại, cách đang dùng là:

- **Windows Task Scheduler**

## Ghi chú để tránh hiểu nhầm

Nếu thấy trong code có đoạn:

- `cron.schedule('0 4 * * *', ...)`
- `cron.schedule('0 5 * * *', ...)`

thì hiểu là:

- đó là **cách cũ / cách khác**
- hiện tại **không dùng cách đó**

Cách đang dùng thực tế là:

- Windows đến giờ sẽ chạy script `scripts/run-daily.ps1`
- script này sẽ gọi `node index.js`

## Kết luận ngắn gọn

Nếu chú hỏi “tool đang chạy theo cách nào”, câu trả lời là:

**Hiện tại tool đang chạy bằng hẹn giờ của Windows, không phải cron trong code.**
