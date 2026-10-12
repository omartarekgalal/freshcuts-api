# Assistant evaluation: m45-first

```
conversations 6 · passed 3 · failed 3
customer turns 9: assistant answered 6, rules owned 3, fallbacks {}
validator retries 0 · escalations fast→strong 1 · model calls 14
cost 0.3098 SAR (0.0516 per conversation, 0.0516 per model turn)
latency per answered turn: p50 4437 ms · p90 5655 ms · max 5655 ms (n=6)
by model {"claude-sonnet-5-5":{"calls":11,"in":20894,"out":1329,"cached":117972,"sar":0.295,"callP50ms":1856,"callP90ms":2252},"claude-haiku-5-5":{"calls":3,"in":26929,"out":362,"cached":10627,"sar":0.0148,"callP50ms":1991,"callP90ms":2413}}
fail types {"must_contain":3,"unexpected_cart":1}
review flags {}
```

## Conversations

### FAIL · m45-mecca (another city) · 0.0000 SAR

**Fails:** must_contain «جدة»

- **العميل:** انا في مكة توصلون لي؟
  - _بوت القواعد_ (rules:other_city)

### FAIL · m45-city-mid-order (another city) · 0.1697 SAR

**Fails:** must_contain «جدة»; unexpected_cart@1 «»

- **العميل:** ابي بيتزا تشكن رانش
  - **المساعد** (strong, 4353 ms, 0.1327 SAR, tools: search_menu, preview_cart): بيتزا تشيكن رانش بـ 28 ر.س. تحب أضيف لك مشروبات غازية بـ 3 ر.س؟
- **العميل:** توصيل لو سمحت، انا ساكن في بحرة
  - **المساعد** (strong, 4006 ms, 0.0370 SAR, tools: note_suggestion, build_cart, cart 28 delivery): سلتك: بيتزا تشيكن رانش = 28 ر.س. اضغط الزر، حدّد موقعك وادفع 👇 ⏎ وإذا تبي تعرف رسوم التوصيل لموقعك بالضبط، شاركنا موقعك هنا في الواتساب (📎 ثم «الموقع»).

### PASS · m45-jahzo (no repeated question) · 0.1304 SAR

- **العميل:** ابغى بوكس الكريب لشخصين استلام
  - **المساعد** (strong↑, 5655 ms, 0.0540 SAR, tools: get_box): بوكس الكريب لشخصين بـ 65 ر.س: كريبين من اختيارك + تشيز فرايز + صنف جانبي + مشروبين غازيين. ⏎ الكريبات المتاحة: كريب سوبر كرانشي، كريب زنجر سوبريم، كريب ميكس لحوم، كريب ميكس دجاج، كريب شيش طاووق، كريب ستربس، كريب فاهيتا دجاج. ⏎ أي كريب تبي للأول والثاني؟
- **العميل:** جهزه
  - **المساعد** (strong, 5480 ms, 0.0622 SAR, tools: preview_cart, build_cart, cart 65 pickup): اخترت لك كريب سوبر كرانشي للكريبين وبطاطس محمرة كصنف جانبي. تقدر تغيّرها من الموقع. ⏎ سلتك (استلام): بوكس الكريب لشخصين: كريبين سوبر كرانشي + تشيز فرايز + بطاطس محمرة + مشروبين غازيين = 65 ر.س. ⏎ اضغط الزر وادفع 👇
- **العميل:** لا شكرا بس كذا
  - **المساعد** (strong, 1864 ms, 0.0141 SAR): تمام، بالعافية عليك. إذا احتجت شي ثاني اكتب لنا.

### PASS · m45-coupon-where (coupon only after get_offers) · 0.0097 SAR

- **العميل:** عندي كود خصم، وين اكتبه؟
  - **المساعد** (fast, 4437 ms, 0.0097 SAR, tools: get_offers): عندك عرض أول طلب، والكود هو FIRST. يعطي توصيلاً مجانياً على طلبك الأول بحد أدنى 60 ر.س. ما عندي تفاصيل عن مكان إدخال الكود، فإذا تبي المساعدة فيه اكتب «موظف». تبي تبدأ طلبك؟

### PASS · m45-who-are-you (who are you) · 0.0000 SAR

- **العميل:** انت بوت؟
  - _بوت القواعد_ (rules:whoami)

### FAIL · m45-pay-transfer (payment by transfer) · 0.0000 SAR

**Fails:** must_contain «تحويل»

- **العميل:** ابي ادفع تحويل
  - _بوت القواعد_ (rules:payment)
