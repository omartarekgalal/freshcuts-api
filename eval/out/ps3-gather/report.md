# Assistant evaluation: ps3-gather

```
conversations 1 · passed 1 · failed 0
customer turns 2: assistant answered 2, rules owned 0, fallbacks {}
validator retries 0 · escalations fast→strong 0 · model calls 3
cost 0.0167 SAR (0.0167 per conversation, 0.0084 per model turn)
latency per answered turn: p50 4736 ms · p90 4736 ms · max 4736 ms (n=2)
by model {"claude-haiku-5-5":{"calls":3,"in":1197,"out":436,"cached":41175,"sar":0.0167,"callP50ms":1946,"callP90ms":2715}}
fail types {}
review flags {}
```

## Conversations

### PASS · family-gathering-custom-offer (family gathering) · 0.0167 SAR

- **العميل:** عندنا عزيمة يوم الجمعة لخمسة وعشرين شخص، وش عندكم؟
  - **المساعد** (fast, 4736 ms, 0.0109 SAR, tools: list_packs): أبشر، معك ماجد، المساعد الرقمي لفريش كاتس. لخمسة وعشرين شخص عندنا هذي الباقات: ⏎  ⏎ باقة ١٥ شخصاً وأكثر بـ 595 ر.س: ٤ كيلو مشاوي + دجاجتين كاملتين على الفحم + أرز وبطاطس وكولسلو + ١٢ مشروب. ⏎  ⏎ تقدر تطلب الباقات من موقعنا. نقدر نجهّز لك عرض مخصص للعزيمة، تبي أحوّلك لفريق المطعم؟
- **العميل:** ابي عرض مخصص: 25 شخص، الجمعة الساعة 9 مساء، توصيل
  - **تحويل لموظف** (custom_offer: عزيمة 25 شخص، يوم الجمعة الساعة 9 مساءً، توصيل. يريدون عرضاً مخصصاً.; 1575 ms, tools: handover)
