# Assistant evaluation: ex6-after

```
conversations 5 · passed 0 · failed 5
customer turns 5: assistant answered 0, rules owned 5, fallbacks {}
validator retries 0 · escalations fast→strong 0 · model calls 0
cost 0 SAR (0 per conversation, null per model turn)
latency per answered turn: p50 null ms · p90 null ms · max null ms (n=0)
by model {}
fail types {"must_contain":5}
review flags {}
```

## Conversations

### FAIL · ex6-half-kofta (by weight) · 0.0000 SAR

**Fails:** must_contain «60»

- **العميل:** عايزه نص كيلو كفته
  - _بوت القواعد_ (rules:weight)

### FAIL · ex6-kilo-mashakel (by weight) · 0.0000 SAR

**Fails:** must_contain «155»

- **العميل:** ابي كيلو مشكل مخصوص
  - _بوت القواعد_ (rules:weight)

### FAIL · ex6-third-tawook (by weight) · 0.0000 SAR

**Fails:** must_contain «37»

- **العميل:** ثلث كيلو شيش طاووق لو سمحت
  - _بوت القواعد_ (rules:weight)

### FAIL · ex6-two-kilos-kebab (by weight) · 0.0000 SAR

**Fails:** must_contain «280»

- **العميل:** ٢ كيلو كباب مشوي
  - _بوت القواعد_ (rules:weight)

### FAIL · ex6-half-kofta-en (by weight) · 0.0000 SAR

**Fails:** must_contain «60»

- **العميل:** half kilo kofta please
  - _بوت القواعد_ (rules:weight)
