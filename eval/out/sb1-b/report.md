# Assistant evaluation: sb1-b

```
conversations 3 · passed 0 · failed 3
customer turns 12: assistant answered 10, rules owned 0, fallbacks {"fallback:validator":2}
validator retries 2 · escalations fast→strong 0 · model calls 24
cost 0.646 SAR (0.2153 per conversation, 0.0538 per model turn)
latency per answered turn: p50 2964 ms · p90 9792 ms · max 9792 ms (n=10)
by model {"claude-sonnet-5-5":{"calls":24,"in":13124,"out":2728,"cached":593705,"sar":0.646,"callP50ms":1722,"callP90ms":2032}}
fail types {"no_buttons":2,"must_contain":2,"no_cart":1}
review flags {"fallback":2,"slow_turn":1}
```

## Conversations

### FAIL · sb1-real-mashakel-kilo (13/10 9f74e6d5554b) · 0.1081 SAR

**Fails:** no_buttons@2 «توصيل ← none»

- **العميل:** وش عرض أول طلب؟
  - _(أزرار: [توصيل] [استلام من الفرع] [أبغى شي ثاني])_
  - **المساعد** (strong, 3992 ms, 0.0436 SAR, tools: get_offers): معك ماجد، المساعد الرقمي لفريش كاتس. ⏎ أول طلب توصيل توصيله مجاني بالكود FIRST للطلبات من 60 ر.س. ⏎ تكتب الكود في خانة «عندك كود؟» عند إتمام الطلب على موقعنا وتضغط «تطبيق». ⏎  ⏎ بالنسبة لـ مشكل مخصوص على الفحم: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س. تبيه نصف كيلو ولا كيلو؟
- **العميل:** موقعكم وين
  - _(زر «افتح الخريطة» مع الرسالة)_
  - **المساعد** (strong, 2151 ms, 0.0428 SAR, tools: faq): 📍 فرعنا في حي السلامة بجدة، عند دوار رامي.
- **العميل:** مشكل كيلو كم
  - **المساعد** (strong, 1619 ms, 0.0217 SAR): *مشكل مخصوص بالوزن*، الكيلو بـ 155 ر.س. يجي مع السلطة والطحينة والخبز. تجهّزه لك كيلو؟

### FAIL · sb1-buyer-first-timer-threshold (first-timer, 50 SAR delivery basket ⇒ one item to 60 = free delivery with FIRST) · 0.3168 SAR

**Fails:** must_contain «التوصيل: مجاني بكود FIRST»; must_contain «الإجمالي: 60 ر.س»; no_cart «»

Review: fallback@2 «fallback:validator»; fallback@3 «fallback:validator»

- **العميل:** السلام عليكم
  - **المساعد** (strong, 2145 ms, 0.0194 SAR): وعليكم السلام، حيّاك الله 👋 معك ماجد، المساعد الرقمي لفريش كاتس. وش تحب تطلب اليوم؟
- **العميل:** ابي ثلث كيلو كفتة مشوية بالوزن وبطاطس محمرة وبيبسي زجاج توصيل
  - _(أزرار: [أضفه ✅] [لا شكراً])_
  - **المساعد** (strong, 5176 ms, 0.1103 SAR, tools: search_menu, search_menu, search_menu, preview_cart): أبشر، طلبك: *كفتة مشوية بالوزن* (ثلث كيلو) 40 ر.س + *بطاطس محمرة* 6 ر.س + *بيبسي زجاج* 4 ر.س = 50 ر.س. ⏎ لو أضفت *فرايد تشيكن* بـ 10 ر.س، يوصل طلبك 60 ر.س ويصير توصيله مجاني بكود FIRST: الإجمالي 60 ر.س بدل 70 ر.س. أضيفه؟
- **العميل:** أضفه ✅
  - _بوت القواعد_ (fallback:validator)
- **العميل:** ارسل السلة
  - _بوت القواعد_ (fallback:validator)

### FAIL · sb1-buyer-regular-same-then-mashakel (regular: «نفس طلبك؟» with the ready-cart button; then the mashakel by weight with rice (6 SAR, now on the menu)) · 0.2211 SAR

**Fails:** no_buttons@1 «شخص واحد ← ثلث كيلو · 53 ر.س | نصف كيلو · 78 ر.س | كيلو · 155 ر.س»

Review: slow_turn@3 «9792 ms»

- **العميل:** هلا
  - _(أزرار: [🔁 نفس طلبي السابق] [أبغى شي ثاني])_
  - **المساعد** (strong, 2549 ms, 0.0206 SAR): هلا والله أحمد 👋 معك ماجد، المساعد الرقمي لفريش كاتس. آخر طلب لك كان *كريب زنجر سوبريم* ×٢ مع *وجبة كفتة*. نفس الطلب؟
- **العميل:** لا، اليوم ابي مشكل مخصوص
  - _(أزرار: [ثلث كيلو · 53 ر.س] [نصف كيلو · 78 ر.س] [كيلو · 155 ر.س])_
  - **المساعد** (strong, 3153 ms, 0.0469 SAR, tools: search_menu): أبشر، المشكل المخصوص تشكيلة من مشاوينا على الفحم، تُقدَّم مع السلطة والطحينة والخبز، ويُباع بالوزن: ثلث كيلو 53 ر.س · نصف كيلو 78 ر.س · كيلو 155 ر.س. ⏎ كم شخص أنتم؟
- **العميل:** نص كيلو
  - _(أزرار: [أضفه ✅] [لا شكراً])_
  - **المساعد** (strong, 2448 ms, 0.0475 SAR, tools: preview_cart): مشكل مخصوص نصف كيلو بـ 78 ر.س. تحب أضيف لك *طبق أرز بسمتي* بـ 6 ر.س؟
- **العميل:** أضفه ✅
  - _(أزرار: [أضفه ✅] [لا شكراً])_
  - **المساعد** (strong, 9792 ms, 0.0541 SAR, tools: note_suggestion, preview_cart): تمت إضافة *طبق أرز بسمتي*. المجموع 84 ر.س. ⏎ تحب أضيف لك *مشروبات غازية* بـ 3 ر.س؟
- **العميل:** استلام
  - **المساعد** (strong, 2964 ms, 0.0520 SAR, tools: build_cart, cart 84 pickup): 🛒 سلتك (استلام من الفرع): ⏎ • *مشكل مخصوص بالوزن* — نصف كيلو × 1 = 78 ر.س ⏎ • *طبق أرز بسمتي* × 1 = 6 ر.س ⏎ المجموع: 84 ر.س ⏎ استلام من الفرع: بدون رسوم توصيل ⏎ راجع السلة، ولو كل شي تمام اضغط الزر وأكمل الدفع 👇
