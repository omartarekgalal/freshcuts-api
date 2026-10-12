# Assistant evaluation: gl1-as3b

```
conversations 3 · passed 3 · failed 0
customer turns 4: assistant answered 4, rules owned 0, fallbacks {}
validator retries 0 · escalations fast→strong 0 · model calls 7
cost 0.0281 SAR (0.0094 per conversation, 0.007 per model turn)
latency per answered turn: p50 2955 ms · p90 2961 ms · max 2961 ms (n=4)
by model {"claude-haiku-5-5":{"calls":7,"in":2205,"out":899,"cached":68161,"sar":0.0281,"callP50ms":1457,"callP90ms":2930}}
fail types {}
review flags {}
```

## Conversations

### PASS · as3-salt (fewer handovers) · 0.0078 SAR

- **العميل:** عندكم ملح ؟
  - **المساعد** (fast, 2955 ms, 0.0078 SAR, tools: ask_knowledge): ما عندي معلومة مؤكدة عن هذا الموضوع حالياً. تقدر تكتب «موظف» للتواصل مع الفريق. وإذا تبي تطلب، أقدر أساعدك في المنيو والبوكسات.

### PASS · as3-beef-allergy-general (allergy, open answers) · 0.0127 SAR

- **العميل:** عندي حساسية من اللحم البقري
  - **المساعد** (fast, 2961 ms, 0.0042 SAR): ما عندنا تفاصيل المكونات لكل صنف هنا بشكل عام، لذلك أحتاج أعرف الصنف اللي تبيه بالتحديد. أي صنف تفكر فيه؟ أتأكد لك منه قبل ما أقترح عليك شي.
- **العميل:** طيب كريب هوت دوج فيه لحم؟
  - **المساعد** (fast, 2848 ms, 0.0085 SAR, tools: dish_fact, search_menu): نعم، يوجد لحم في «كريب هوت دوج»، ولا يمكن تجهيز الطلب بدون لحم.

### PASS · as3-do-dishes-cause-allergy (allergy, open answers) · 0.0075 SAR

- **العميل:** هل الاصناف تسبب الحساسية
  - **المساعد** (fast, 2914 ms, 0.0075 SAR, tools: faq): ما عندي معلومات مؤكدة عن هذا الموضوع الحين. تقدر تكتب «موظف» عشان يرد عليك أحد من الفريق.
