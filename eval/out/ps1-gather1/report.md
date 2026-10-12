# Assistant evaluation: ps1-gather1

```
conversations 1 · passed 1 · failed 0
customer turns 2: assistant answered 2, rules owned 0, fallbacks {}
validator retries 0 · escalations fast→strong 0 · model calls 3
cost 0.0437 SAR (0.0437 per conversation, 0.0218 per model turn)
latency per answered turn: p50 4209 ms · p90 4209 ms · max 4209 ms (n=2)
by model {"claude-haiku-5-5":{"calls":2,"in":746,"out":290,"cached":27334,"sar":0.0111,"callP50ms":2084,"callP90ms":2084},"claude-sonnet-5-5":{"calls":1,"in":2501,"out":117,"cached":12626,"sar":0.0326,"callP50ms":2003,"callP90ms":2003}}
fail types {}
review flags {"number_not_in_tools":2}
```

## Conversations

### PASS · family-gathering-custom-offer (family gathering) · 0.0437 SAR

Review: number_not_in_tools@0 «25»; number_not_in_tools@0 «25»

- **العميل:** عندنا عزيمة يوم الجمعة لخمسة وعشرين شخص، وش عندكم؟
  - **المساعد** (fast, 4209 ms, 0.0111 SAR, tools: list_packs): أهلاً بك، معك ماجد، المساعد الرقمي لفريش كاتس. لعزيمة ٢٥ شخص عندنا باقات تجمّع: ⏎  ⏎ باقة ١٥ شخصاً وأكثر بـ 595 ر.س: ٤ كيلو مشاوي + دجاجتين كاملتين على الفحم + أرز وبطاطس وكولسلو + ١٢ مشروب. ⏎  ⏎ تبيني أرتب لك عرض مخصص لـ ٢٥ شخص؟ إذا تبي، وش اليوم والوقت، والتوصيل ولا الاستلام؟
- **العميل:** ابي عرض مخصص: 25 شخص، الجمعة الساعة 9 مساء، توصيل
  - **تحويل لموظف** (custom_offer: 25 people, Friday 9 PM, delivery. Showed packs (15+ pack 595 SAR). Customer wants tailored offer.; 2014 ms, tools: handover)
