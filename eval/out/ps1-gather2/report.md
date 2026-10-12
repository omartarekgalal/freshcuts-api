# Assistant evaluation: ps1-gather2

```
conversations 1 · passed 1 · failed 0
customer turns 2: assistant answered 2, rules owned 0, fallbacks {}
validator retries 0 · escalations fast→strong 0 · model calls 3
cost 0.0434 SAR (0.0434 per conversation, 0.0217 per model turn)
latency per answered turn: p50 4032 ms · p90 4032 ms · max 4032 ms (n=2)
by model {"claude-haiku-5-5":{"calls":2,"in":689,"out":224,"cached":27334,"sar":0.0109,"callP50ms":2093,"callP90ms":2093},"claude-sonnet-5-5":{"calls":1,"in":2418,"out":130,"cached":12626,"sar":0.0325,"callP50ms":1811,"callP90ms":1811}}
fail types {}
review flags {}
```

## Conversations

### PASS · family-gathering-custom-offer (family gathering) · 0.0434 SAR

- **العميل:** عندنا عزيمة يوم الجمعة لخمسة وعشرين شخص، وش عندكم؟
  - **المساعد** (fast, 4032 ms, 0.0109 SAR, tools: list_packs): أهلاً بك، معك ماجد، المساعد الرقمي لفريش كاتس. لخمسة وعشرين شخص عندنا باقات التجمّع: ⏎  ⏎ باقة ١٥ شخصاً وأكثر بـ 595 ر.س: ٤ كيلو مشاوي + دجاجتين كاملتين على الفحم + أرز وبطاطس وكولسلو + ١٢ مشروب. ⏎  ⏎ تبي أجهّز لك عزيمة الجمعة على هذه الباقة، ولا تحب تشوف خيار ثاني؟
- **العميل:** ابي عرض مخصص: 25 شخص، الجمعة الساعة 9 مساء، توصيل
  - **تحويل لموظف** (custom_offer: عزيمة 25 شخص، الجمعة 9 مساءً، توصيل. العميل يطلب عرضاً مخصصاً بعد عرض الباقات.; 1818 ms, tools: handover)
