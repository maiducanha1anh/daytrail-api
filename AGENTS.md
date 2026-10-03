# Quy ước làm việc trong repo DayTrail API

## Tài liệu và báo cáo

- Viết tiếng Việt đầy đủ dấu và lưu file ở UTF-8.
- Viết ngắn, rõ, phù hợp người đang học backend; giải thích ngắn thuật ngữ kỹ thuật ở lần xuất hiện đầu tiên.
- Giữ nguyên tên file, biến môi trường, endpoint, lệnh, thư viện và giá trị kỹ thuật.
- Hướng dẫn thao tác phải nêu nơi mở terminal hoặc file, lệnh cần chạy, kết quả mong đợi và cách kiểm tra khi lỗi.
- Phân biệt rõ kết quả do người dùng cung cấp, kết quả Codex tự kiểm tra, phần chưa kiểm chứng và phần chưa triển khai.
- Không đưa `.env`, URI thật, mật khẩu, token, cookie hoặc thông tin xác thực vào tài liệu, log hay báo cáo.
- Hạn chế lặp nội dung; dẫn đến README, `docs/OPERATIONS.md` hoặc hợp đồng API khi phù hợp.
- Không sửa lịch sử nghiệm thu và không đánh dấu tính năng chưa làm là hoàn thành.

## Git và phạm vi

- Giữ thay đổi có sẵn, không reset hoặc ghi đè công việc của người dùng.
- Không tự động commit, push hoặc deploy. Chỉ thực hiện khi người dùng yêu cầu và duyệt rõ trong nhiệm vụ hiện tại.
- Trước khi commit, kiểm tra toàn bộ file staged và xác nhận không có bí mật, `.env`, `node_modules`, `dist` hoặc file tạm.
