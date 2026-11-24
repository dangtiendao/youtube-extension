# TubeVault — YouTube Video, Album/Playlist & Channel Downloader

Hệ thống tải YouTube gồm **Chrome Extension (Manifest V3)** kết hợp **Local Engine (Node.js 24 + `node:sqlite`)**, hỗ trợ chạy trực tiếp bằng **Node.js** hoặc đóng gói thành bộ cài Windows **`TubeVault-Setup.exe`** không cần người dùng cài Node/Python/FFmpeg.

## Tính năng chính
- **Tải Video đơn & Shorts:** Chất lượng lên tới 4K/8K (`MP4`/`MKV`/`WebM`), chỉ âm thanh (`MP3`/`M4A`/`Opus`/`FLAC`), phụ đề (nhúng hoặc `.srt`), cắt đoạn theo khung giờ, bỏ quảng cáo SponsorBlock.
- **Tải Album & Playlist (YouTube + YouTube Music):** Quét nhanh `--flat-playlist`, bảng chọn lọc từng bài (checkbox, tìm kiếm, chọn theo khoảng `1-20`), đánh số thứ tự (`01 - ...`), nhúng ID3 metadata & cắt vuông ảnh bìa Album.
- **Tải Toàn Bộ Kênh (Channel):** Tách tab `/videos`, `/shorts`, `/streams`, bộ lọc độ dài / số lượng mới nhất / ẩn video đã tải, chống tải trùng (`downloaded_archive`), đồng bộ tăng dần (*Quét & Tải video mới*), giới hạn luồng & khoảng nghỉ ngẫu nhiên chống lỗi 429.
- **Tích hợp trực tiếp YouTube + Web UI dự phòng:** Nút tải gắn trực tiếp vào trang Video/Playlist/Channel (Shadow DOM), Chrome Side Panel, Web UI tại `http://127.0.0.1:17890/` và **Cookies Bridge** đọc cookies từ Chrome vượt lỗi App-Bound Encryption.

## Chạy nhanh bằng Node.js (Dev / Kỹ thuật)

Yêu cầu: **Node.js 24+**

```powershell
# 1. Cài dependencies & build toàn bộ workspace
npm install
npm run build:all

# 2. Chạy Local Engine (chế độ dev, mở sẵn Web UI tại http://127.0.0.1:17890/)
npm run dev:engine
```

### Nạp Extension vào Chrome
1. Mở `chrome://extensions` → bật **Developer mode**.
2. Bấm **Load unpacked** → chọn thư mục `packages/extension/dist-ext`.
3. Extension sẽ có ID cố định (tự sinh từ khóa RSA trong `.secrets/extension-key.json`).
4. (Tùy chọn) Đăng ký Chrome Native Messaging để Chrome tự bật Engine nền mà không cần mở terminal:
   ```powershell
   npm run register:native
   ```

## Đóng gói `.exe` cho người dùng cuối (Windows)

### Cách 1: Bộ cài chuẩn `TubeVault-Setup-1.0.0.exe` (Khuyên dùng)
Đóng gói kèm `node.exe` chính chủ (giữ chữ ký số OpenJS, làm luôn JS runtime cho `yt-dlp`), `engine.cjs`, launcher ẩn console `ytdl-host.exe`, `TubeVault.exe`, Web UI và thư mục Extension:

```powershell
# Cài Inno Setup 6 (chỉ cần làm 1 lần trên máy build)
winget install JRSoftware.InnoSetup

# Build trọn gói ra installer\output\TubeVault-Setup-1.0.0.exe
npm run build:installer
```

### Cách 2: Bản Portable 1 file `engine.exe` (Node.js SEA)
```powershell
npm run build:sea
# Đầu ra: release\TubeVault-Engine-Portable.exe
```
