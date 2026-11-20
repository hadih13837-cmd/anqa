# عنقا (ANQA)

## اجرا روی کامپیوتر
    cp .env.example .env      # کلید را داخلش بگذار
    node server.js            # سپس باز کن: http://localhost:3000

## آنلاین کردن
سرور بدون وابستگی است (فقط Node 18+ یا Docker).

**Render.com** — مخزن را در GitHub بگذار (`.env` در `.gitignore` است و آپلود نمی‌شود) ← New → Blueprint ← `DEEPSEEK_API_KEY` را در پنل وارد کن. (دیسک ۱ گیگ برای نگه‌داشتن کاربران و تصاویر.)

**VPS (هر سرور خارج از ایران)**

    docker build -t anqa .
    docker run -d --restart=always -p 80:3000 -v anqa-data:/data -e DEEPSEEK_API_KEY=sk-... anqa

برای HTTPS جلویش Caddy یا Cloudflare بگذار.

## امنیت
- کلید فقط روی سرور است و به مرورگر نمی‌رسد.
- رمزها با scrypt هش می‌شوند؛ توکن ورود امضاشده ۳۰ روزه است.
- محدودیت: ۴۰ پیام در دقیقه، ۳۰۰ پیام در روز برای هر کاربر (`DAILY_LIMIT`)، ۸ ثبت‌نام در ساعت برای هر IP.
- گفتگوها فقط در مرورگر هر کاربر ذخیره می‌شود، نه روی سرور.
