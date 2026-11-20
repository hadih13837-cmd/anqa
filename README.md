# عنقا روی GitHub Pages + Cloudflare Workers

صفحه (index.html, config.js) → GitHub Pages
سرور (worker.js) → Cloudflare Workers (رایگان)

1. cloudflare.com ← Workers & Pages ← Create ← Hello World ← نام: anqa ← Deploy ← Edit code ← همه‌ی کد را با worker.js عوض کن ← Deploy
2. Storage & Databases ← KV ← Create (نام: anqa-users)
3. Worker ← Settings ← Bindings ← Add ← KV namespace ← Variable name: USERS ← همان KV
4. Settings ← Variables and Secrets ← Add (نوع Secret):
   DEEPSEEK_API_KEY = کلید DeepSeek (ترجیحاً کلید جدید)
   APP_SECRET = یک رشته‌ی تصادفی طولانی
   (اختیاری، Text) ALLOWED_ORIGIN = https://hadih13837-cmd.github.io
5. آدرس Worker (مثل https://anqa.xxx.workers.dev) را در config.js بگذار و index.html و config.js را در GitHub جایگزین کن.
