# Assistant evaluation: m3-c

```
conversations 2 · passed 2 · failed 0
customer turns 2: assistant answered 2, rules owned 0, fallbacks {}
validator retries 0 · escalations fast→strong 1 · model calls 5
cost 0.0433 SAR (0.0217 per conversation, 0.0217 per model turn)
latency per answered turn: p50 4530 ms · p90 4530 ms · max 4530 ms (n=2)
by model {"claude-haiku-5-5":{"calls":3,"in":10,"out":472,"cached":34329,"sar":0.0138,"callP50ms":1499,"callP90ms":2238},"claude-sonnet-5-5":{"calls":2,"in":1263,"out":126,"cached":20498,"sar":0.0296,"callP50ms":1203,"callP90ms":1203}}
fail types {}
review flags {}
```

## Conversations

### PASS · m3-price-kebab-en (by weight: price) · 0.0094 SAR

- **العميل:** how much is the grilled kebab by the kilo?
  - **المساعد** (fast, 2625 ms, 0.0094 SAR, tools: search_menu, search_menu): Grilled Kebab (by the kilo): 1/3 Kilo: 47 SAR · 1/2 Kilo: 70 SAR · Kilo: 140 SAR. ⏎  ⏎ Which weight would you like?

### PASS · m3-price-fast-en (by weight: price) · 0.0340 SAR

- **العميل:** what's the price of the special mixed grill?
  - **المساعد** (strong↑, 4530 ms, 0.0340 SAR, tools: search_menu): Special Mixed Grill (by the kilo): 1/3 Kilo: 53 SAR · 1/2 Kilo: 78 SAR · Kilo: 155 SAR. ⏎  ⏎ Which weight would you like?
