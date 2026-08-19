# Google Form Parser NextJS

Web NextJS dùng để nhập link Google Form và hiển thị:

- Section
- Câu hỏi
- Mã entry
- Loại câu hỏi
- Required / không required
- Danh sách options
- `pageHistory`
- Cấu hình tỉ lệ chọn options và gửi payload thử nghiệm
- Nhập nhiều câu trả lời cho Short Answer / Paragraph để random khi gửi
- Import dữ liệu CSV / XLSX và map cột vào entry để gửi theo từng dòng
- Chọn dòng file bắt đầu và xem tiến độ số form đã hoàn tất
- Chạy submit nền bằng Vercel Workflow, không phụ thuộc tab trình duyệt
- Mở lại trang để tiếp tục xem tiến độ hoặc hủy Workflow đang chạy
- Tải kết quả dạng JSON

## Chạy local

Yêu cầu Node.js 20 trở lên.

```bash
npm install
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Mở trình duyệt:

```text
http://localhost:3000
```

Workflow local được lưu trong thư mục `.workflow-data/`. Đây chỉ là môi trường kiểm thử;
nếu tắt server local thì hàng đợi local cũng dừng.

## Chạy nền trên Vercel

1. Push code lên GitHub và để Vercel deploy nhánh `main`.
2. Trong Vercel, mở `Project Settings` -> `Functions` và bật `Fluid Compute`.
3. Không cần tạo database hoặc thêm biến môi trường cho Workflow.
4. Mở website Vercel, lấy dữ liệu form, cấu hình payload rồi bấm `Submit form`.
5. Sau khi giao diện hiển thị mã `wrun_...`, có thể chuyển tab, đóng tab hoặc tắt máy.
6. Khi mở lại website, tiến độ gần nhất được khôi phục từ Workflow bằng `runId` đã lưu trong trình duyệt.

Vercel tự cung cấp storage và queue cho Workflow. Có thể xem từng run trong mục
`Observability` -> `Workflows` của project.

## Cách hoạt động

- Trình duyệt tạo trước payload và delay của từng lượt rồi gọi `/api/submission-jobs` một lần.
- `workflows/submitForms.ts` gửi từng form ở server và dùng durable `sleep()` giữa các lượt.
- API `/api/submission-jobs/[runId]` đọc tiến độ đã lưu trong Workflow stream.
- Nút `Dừng` hủy Workflow; lượt đang POST tại đúng thời điểm bấm hủy có thể vẫn hoàn tất.

## Lưu ý

- Form phải public hoặc có quyền truy cập không cần đăng nhập.
- Hỗ trợ link rút gọn `forms.gle`, link `viewform` và `formResponse`.
- Trình duyệt thường bị CORS khi fetch Google Forms trực tiếp, nên app dùng API route `/api/parse-form` để đọc form ở phía server.
- Chỉ dùng tính năng submit tự động với form bạn sở hữu hoặc có quyền kiểm thử.
- File CSV có thể dùng dấu phẩy, chấm phẩy hoặc tab. File Excel hỗ trợ `.xlsx`; nếu là `.xls`, hãy lưu lại thành `.xlsx` hoặc CSV.
- API tạo Workflow hiện chưa có đăng nhập. Trước khi chia sẻ website công khai, nên bật Vercel Deployment Protection hoặc bổ sung xác thực người dùng.
