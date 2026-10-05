# مجالس الحرمين — Product Demo

هذه الأدوات منفصلة تمامًا عن التطبيق. حذف مجلد `demo-video/` لا يؤثر في المنصة.

## التشغيل

```powershell
cd demo-video
npm install
npm run dry-run
npm run record
```

يتطلب التسجيل:

- تشغيل التطبيق محليًا على `http://127.0.0.1:8791`.
- Google Chrome مثبت محليًا.
- FFmpeg وFFprobe متاحين في `C:\ffmpeg\ffmpeg\bin` أو في `PATH`.
- ميكروفون متاح لجزء الترجمة الفورية.

الملف النهائي يُكتب إلى `demo-video/output/majalis-alharamain-demo.mp4` بدقة `1920×1080` بنسبة `16:9`، باستخدام Desktop viewport حقيقي `1600×900`.

بيانات لوحة التحكم والملاحظة المعروضة أثناء التصوير تعيش داخل سياق Chrome مؤقت، وطلبات الملاحظات تُعترض داخل الأتمتة؛ لا يجري تعديل قاعدة D1.
