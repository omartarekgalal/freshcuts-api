# Assistant evaluation: gl1-ch1

```
conversations 6 · passed 6 · failed 0
customer turns 11: assistant answered 10, rules owned 1, fallbacks {}
validator retries 0 · escalations fast→strong 0 · model calls 18
cost 0.159 SAR (0.0265 per conversation, 0.0159 per model turn)
latency per answered turn: p50 2727 ms · p90 3867 ms · max 3867 ms (n=10)
by model {"claude-haiku-5-5":{"calls":11,"in":8118,"out":891,"cached":104720,"sar":0.044,"callP50ms":1261,"callP90ms":1499},"claude-sonnet-5-5":{"calls":7,"in":5369,"out":611,"cached":69119,"sar":0.115,"callP50ms":1262,"callP90ms":1567}}
fail types {}
review flags {}
```

## Conversations

### PASS · ch1-normal-question (channel invite) · 0.0079 SAR

- **العميل:** كم سعر كريب زنجر سوبريم؟
  - **المساعد** (fast, 2995 ms, 0.0079 SAR, tools: search_menu): كريب زنجر سوبريم بـ 25 ر.س.

### PASS · ch1-thanks-after-help (channel invite) · 0.0161 SAR

- **العميل:** كم سعر كريب زنجر سوبريم؟
  - **المساعد** (fast, 2668 ms, 0.0079 SAR, tools: search_menu): كريب زنجر سوبريم بـ 25 ر.س.
- **العميل:** تمام شكرا يعطيك العافية
  - **المساعد** (fast, 1270 ms, 0.0041 SAR): الله يعافيك، بالتوفيق. ⏎  ⏎ وتابع قناتنا على واتساب لعروض الطلب من موقعنا: https://whatsapp.com/channel/0029VaExampleChannel01
- **العميل:** طيب وكريب ستربس بكم؟
  - **المساعد** (fast, 1095 ms, 0.0041 SAR): كريب ستربس بـ 25 ر.س.

### PASS · ch1-after-cart (channel invite) · 0.0802 SAR

- **العميل:** ابي كريب زنجر سوبريم استلام
  - **المساعد** (strong, 3867 ms, 0.0481 SAR, tools: search_menu, preview_cart): كريب زنجر سوبريم بـ 25 ر.س، استلام. ⏎ تحب أضيف لك مشروبات غازية بـ 3 ر.س؟
- **العميل:** لا شكرا بس كذا
  - **المساعد** (strong, 2764 ms, 0.0321 SAR, tools: note_suggestion, build_cart, cart 25 pickup): سلتك: كريب زنجر سوبريم = 25 ر.س (استلام). اضغط الزر وكمّل طلبك وادفع 👇 ⏎ وتابع قناتنا على واتساب لعروض الطلب من موقعنا: https://whatsapp.com/channel/0029VaExampleChannel01

### PASS · ch1-allergy (channel invite) · 0.0083 SAR

- **العميل:** وجبة كفتة فيها سمسم؟ عندي حساسية
  - **المساعد** (fast, 2612 ms, 0.0083 SAR, tools: dish_fact): نعم، يوجد سمسم في «وجبة كفتة»، وذلك في الطحينة فقط، والكفتة نفسها بدون سمسم. يمكن تجهيز الطلب بدون الطحينة: اكتبها في ملاحظة الصنف عند الطلب. ⏎ مطبخنا واحد لكل الأصناف وقد يحصل تلامس بين المكونات أثناء التحضير. ⏎ واكتب لنا حساسيتك في ملاحظة الطلب وننتبه لها.

### PASS · ch1-unhappy (channel invite) · 0.0348 SAR

- **العميل:** ابي بيتزا
  - **المساعد** (strong, 2727 ms, 0.0348 SAR, tools: search_menu): عندنا بيتزا مارجريتا بـ 20 ر.س، وكواترو تشيز بـ 25 ر.س، وتشيكن باربكيو بـ 28 ر.س، وبيبروني بـ 29 ر.س. أي وحدة تبي؟
- **العميل:** انتم بطيئين مرة وما عجبني الوضع
  - _بوت القواعد_ (rules:complaint, handover complaint)

### PASS · ch1-not-allowed (channel invite) · 0.0118 SAR

- **العميل:** عندكم عروض؟
  - **المساعد** (fast, 2935 ms, 0.0079 SAR, tools: get_offers): ايوه عندنا عرض لطلبك الأول: توصيل مجاني على الطلبات من 60 ر.س فأكثر، والكود FIRST. ⏎  ⏎ وعندنا باقات تجمّع حتى 15 أكتوبر 2026: ⏎ باقة لـ 4 إلى 6 أشخاص بـ 225 ر.س ⏎ باقة لـ 8 إلى 10 أشخاص بـ 395 ر.س ⏎ باقة لـ 15 شخص فأكثر بـ 595 ر.س ⏎  ⏎ تبي تشوف تفاصيل إحدى هذي الباقات؟
- **العميل:** شكرا
  - **المساعد** (fast, 1201 ms, 0.0039 SAR): العفو، يسعدني خدمتك في أي وقت 👋
