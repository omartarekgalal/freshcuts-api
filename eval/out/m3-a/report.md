# Assistant evaluation: m3-a

```
conversations 9 · passed 7 · failed 2
customer turns 15: assistant answered 15, rules owned 0, fallbacks {}
validator retries 0 · escalations fast→strong 2 · model calls 33
cost 0.5372 SAR (0.0597 per conversation, 0.0358 per model turn)
latency per answered turn: p50 3673 ms · p90 4266 ms · max 5537 ms (n=15)
by model {"claude-haiku-5-5":{"calls":9,"in":48139,"out":1464,"cached":59945,"sar":0.0433,"callP50ms":2196,"callP90ms":3065},"claude-sonnet-5-5":{"calls":24,"in":29947,"out":2262,"cached":245986,"sar":0.4939,"callP50ms":1446,"callP90ms":2004}}
fail types {"must_not_contain":2}
review flags {}
```

## Conversations

### PASS · m3-price-mashakel (by weight: price) · 0.1181 SAR

- **العميل:** كم كيلو المشكل المخصوص؟
  - **المساعد** (strong↑, 5537 ms, 0.1181 SAR, tools: search_menu): مشكل مخصوص بالوزن متوفر بهذه الأوزان: ⏎ ثلث كيلو: 53 ر.س · نصف كيلو: 78 ر.س · كيلو: 155 ر.س ⏎ تبيه ثلث كيلو، نصف كيلو ولا كيلو؟

### FAIL · m3-price-kebab-en (by weight: price) · 0.0107 SAR

**Fails:** must_not_contain «kilo[^\n]{0,25}\b47\b»

- **العميل:** how much is the grilled kebab by the kilo?
  - **المساعد** (fast, 3868 ms, 0.0107 SAR, tools: search_menu, search_menu): The Grilled Kebab (by the kilo) is priced by weight: 1/3 Kilo: 47 SAR · 1/2 Kilo: 70 SAR · Kilo: 140 SAR. ⏎  ⏎ Which weight would you like?

### FAIL · m3-price-fast-en (by weight: price) · 0.0097 SAR

**Fails:** must_not_contain «kilo[^\n]{0,25}\b53\b(?![^\n]{0,4}\/)»

- **العميل:** what's the price of the special mixed grill?
  - **المساعد** (fast, 4078 ms, 0.0097 SAR, tools: search_menu): The Special Mixed Grill (by the kilo) is priced by weight: ⏎ 1/3 Kilo: 53 SAR · 1/2 Kilo: 78 SAR · Kilo: 155 SAR ⏎  ⏎ Which weight would you like?

### PASS · m3-cart-two-kilos (by weight: cart) · 0.0788 SAR

- **العميل:** ابي ٢ كيلو مشكل مخصوص استلام
  - **المساعد** (strong, 4266 ms, 0.0472 SAR, tools: search_menu, preview_cart): مشكل مخصوص بالوزن، 2 كيلو (كيلو بـ 155 ر.س) = 310 ر.س للاستلام. ⏎ تحب أضيف لك مشروبات غازية بـ 3 ر.س؟
- **العميل:** لا شكرا بس كذا
  - **المساعد** (strong, 3673 ms, 0.0316 SAR, tools: note_suggestion, build_cart, cart 310 pickup): سلتك: مشكل مخصوص بالوزن، كيلو × 2 = 310 ر.س (استلام). اضغط الزر وأكمل طلبك وادفع 👇

### PASS · m3-cart-kilo-and-half (by weight: cart) · 0.0842 SAR

- **العميل:** ابي كيلو ونص كباب مشوي استلام
  - **المساعد** (strong, 4170 ms, 0.0490 SAR, tools: search_menu, preview_cart): كباب مشوي بالوزن: كيلو بـ 140 ر.س + نصف كيلو بـ 70 ر.س = 210 ر.س. ⏎ تحب أضيف لك مشروبات غازية بـ 3 ر.س؟
- **العميل:** لا بس كذا
  - **المساعد** (strong, 3797 ms, 0.0352 SAR, tools: note_suggestion, build_cart, cart 210 pickup): سلتك (استلام): ⏎ كباب مشوي بالوزن كيلو: 140 ر.س ⏎ كباب مشوي بالوزن نصف كيلو: 70 ر.س ⏎ المجموع: 210 ر.س ⏎ اضغط الزر وأكمل طلبك وادفع 👇

### PASS · m3-ask-weight (by weight: cart) · 0.0417 SAR

- **العميل:** ابي كفتة مشوية بالوزن توصيل
  - **المساعد** (strong, 3405 ms, 0.0417 SAR, tools: search_menu): كفتة مشوية بالوزن: ثلث كيلو: 40 ر.س · نصف كيلو: 60 ر.س · كيلو: 120 ر.س. ⏎ تبيها ثلث كيلو ولا نصف كيلو ولا كيلو؟

### PASS · m3-then-weight (by weight: cart) · 0.1046 SAR

- **العميل:** ابي كفتة مشوية بالوزن استلام
  - **المساعد** (strong, 2637 ms, 0.0416 SAR, tools: search_menu): كفتة مشوية بالوزن: ثلث كيلو: 40 ر.س · نصف كيلو: 60 ر.س · كيلو: 120 ر.س. ⏎ تبيه ثلث كيلو، نصف كيلو ولا كيلو؟
- **العميل:** نص كيلو
  - **المساعد** (strong, 2570 ms, 0.0298 SAR, tools: preview_cart): كفتة مشوية بالوزن نصف كيلو بـ 60 ر.س، استلام. ⏎ تحب أضيف لك مشروبات غازية بـ 3 ر.س؟
- **العميل:** لا شكرا
  - **المساعد** (strong, 2745 ms, 0.0332 SAR, tools: note_suggestion, build_cart, cart 60 pickup): سلتك: كفتة مشوية بالوزن نصف كيلو = 60 ر.س (استلام). اضغط الزر وكمّل طلبك وادفع 👇

### PASS · m3-serves-how-many (by weight: owner rule) · 0.0088 SAR

- **العميل:** المشكل المخصوص الكيلو يكفي كم شخص؟
  - **المساعد** (fast, 3574 ms, 0.0088 SAR, tools: search_menu): مشكل مخصوص بالوزن، والأسعار حسب الوزن: ⏎ ثلث كيلو: 53 ر.س · نصف كيلو: 78 ر.س · كيلو: 155 ر.س ⏎  ⏎ ما أقدر أحدد عدد الأشخاص لكل وزن. تبيه نصف كيلو ولا كيلو؟

### PASS · m3-ad-mashakel (by weight: ad) · 0.0807 SAR

- **العميل:** مرحبا
  - **المساعد** (fast, 2301 ms, 0.0046 SAR): أهلاً فيك. مشكل مخصوص على الفحم بالوزن: ثلث كيلو: 53 ر.س · نصف كيلو: 78 ر.س · كيلو: 155 ر.س. ⏎ تبيه أي وزن؟
- **العميل:** نص كيلو استلام
  - **المساعد** (strong↑, 4244 ms, 0.0444 SAR, tools: preview_cart): مشكل مخصوص بالوزن نصف كيلو بـ 78 ر.س، استلام. ⏎ تحب أضيف لك مشروبات غازية بـ 3 ر.س؟
- **العميل:** لا شكراً، ارسل رابط السلة
  - **المساعد** (strong, 2868 ms, 0.0316 SAR, tools: note_suggestion, build_cart, cart 78 pickup): سلتك: مشكل مخصوص بالوزن نصف كيلو = 78 ر.س (استلام). اضغط الزر وادفع 👇
