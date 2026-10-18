/* ═══════════════════════════════════════════════════════════════════════════
   🧪 «طلب تجريبي» — المدير يختبر إن بورتال الكاشير بيرنّ (عمر ١٨/١٠)

   «اعمل عند المدير خاصية طلب تجريبي دايماً يختبر إن البورتال شغال عند الكاشير
    ويختفي بعدها بدقيقة وملوش علاقة بتاب سينس».

   المسارات:
     POST /api/portal/test-order            (المدير بس) ⇒ رنّة اختبار لأجهزة الكاشير: حدث SSE «test_order» لدور الكاشير
                                            + push لأجهزة الكاشير (kind test_order) + صف في portal_audit. سقف: مرة كل ٣٠ ث.
     POST /api/portal/test-order/:id/ack    (أي دور) ⇒ الكاشير ضغط «وصلني ✅» — بيتسجّل مرة واحدة (أول ضغطة)، وحدث
                                            «test_order_ack» للمدير والكاشير (الأجهزة التانية تشيل الكارت).
     GET  /api/portal/test-order/active     (أي دور) ⇒ الرنّات اللي لسه عايشة (< ٦٠ ث) — للجهاز اللي البث عنده وقع ورجع،
                                            أو اللي صحي من إشعار.
     GET  /api/portal/test-order/:id        (المدير) ⇒ حالة رنّة (لو حدث «وصلني» ضاع على جهاز المدير).

   الحدود (مقصودة): **مفيش أي لمس** لتاب سينس ولا shop_orders ولا التقارير ولا العملاء ولا مؤشرات الأداء. الرنّة في الذاكرة بس
   (بتتمسح بعد ٥ دقايق)، والأثر الوحيد في القاعدة صف portal_audit بأكشن «portal_test_order» / «portal_test_ack» من غير رقم طلب
   (staffkpi.js بيعدّ أكشنات بعينها بس — دول مش منهم، والتايم لاين بتاع الطلب بيقرا بالـorder_no فمش هيشوفهم).
═══════════════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";

export const TEST_ORDER_TTL_MS = 60_000;        // الكارت بيختفي من عند الكاشير بعد دقيقة
export const TEST_ORDER_RATE_MS = 30_000;       // مرة كل ٣٠ ث (لكل المطعم — مش لكل مدير)
export const TEST_ORDER_KEEP_MS = 5 * 60_000;   // الحالة بتفضل للمدير ٥ دقايق بعدين بتتمسح
export const TEST_ORDER_TITLE = "🧪 طلب تجريبي — لاختبار الرنة";

/* المخزن — صافي، متجرّب لوحده. now() بيتحقن عشان الاختبارات. */
export function makeTestPings({ now = () => Date.now(), idOf = () => crypto.randomBytes(6).toString("hex") } = {}) {
  const pings = new Map();
  let lastAt = 0;
  const sweep = () => { const t = now(); for (const [k, p] of pings) if (t - p.atMs > TEST_ORDER_KEEP_MS) pings.delete(k); };
  const out = (p) => {
    const t = now();
    return {
      id: p.id, kind: "test_order", title: TEST_ORDER_TITLE,
      at: new Date(p.atMs).toISOString(), expiresAt: new Date(p.atMs + TEST_ORDER_TTL_MS).toISOString(),
      by: p.by, live: t - p.atMs < TEST_ORDER_TTL_MS,
      msLeft: Math.max(0, TEST_ORDER_TTL_MS - (t - p.atMs)),      // الجهاز بيحسب الاختفاء من ده مش من ساعته (ممكن تكون غلط)
      acks: p.acks.map((a) => ({ name: a.name, role: a.role, at: new Date(a.atMs).toISOString(), ms: a.atMs - p.atMs })),
      firstAckMs: p.acks.length ? p.acks[0].atMs - p.atMs : null,
    };
  };
  return {
    create(user) {
      sweep();
      const t = now();
      if (lastAt && t - lastAt < TEST_ORDER_RATE_MS) {
        return { ok: false, error: "rate_limited", retryInSec: Math.ceil((TEST_ORDER_RATE_MS - (t - lastAt)) / 1000) };
      }
      lastAt = t;
      const p = { id: idOf(), atMs: t, by: String(user?.name || "المدير").slice(0, 60), byId: user?.id || null, acks: [] };
      pings.set(p.id, p);
      return { ok: true, ping: out(p) };
    },
    /* أول «وصلني» من كل جهاز/موظف بيتسجّل؛ نفس الموظف تاني = نفس الرد (idempotent). بعد الدقيقة بيتسجّل برضه (متأخر) — المدير يعرف. */
    ack(id, user) {
      sweep();
      const p = pings.get(String(id || ""));
      if (!p) return { ok: false, error: "not_found" };
      const who = String(user?.id || user?.name || "?");
      let a = p.acks.find((x) => x.who === who);
      const first = !a;
      if (!a) { a = { who, name: String(user?.name || "الكاشير").slice(0, 60), role: user?.role || null, atMs: now() }; p.acks.push(a); }
      return { ok: true, first, ms: a.atMs - p.atMs, late: a.atMs - p.atMs > TEST_ORDER_TTL_MS, ping: out(p) };
    },
    get(id) { sweep(); const p = pings.get(String(id || "")); return p ? out(p) : null; },
    active() { sweep(); const t = now(); return [...pings.values()].filter((p) => t - p.atMs < TEST_ORDER_TTL_MS).map(out); },
    _reset() { pings.clear(); lastAt = 0; },
  };
}

/* push لأجهزة الكاشير — شكل pushPayload بالظبط (الـSW بيبعت {type:"push", kind} للصفحة المفتوحة ⇒ بتسحب /active) */
export function testOrderPush(ping, baseUrl = "") {
  return {
    kind: "test_order", orderNo: null, url: baseUrl || "/portal/", tag: `portal-test-order-${ping.id}`, renotify: true,
    urgency: "high", ttl: Math.round(TEST_ORDER_TTL_MS / 1000), requireInteraction: false,
    title: TEST_ORDER_TITLE, body: `من ${ping.by} — افتح البورتال واضغط «وصلني ✅». مش طلب حقيقي.`,
  };
}

/* deps: requirePortal(c, role) ⇒ {res,user} · broadcastTo(event, data, roles) · push.sendToSubs(payload, {role}) ·
   audit(user, action, orderNo, ok, detail, ip, {emit}) · clientIp(fn) · streamsFor(role) ⇒ عدد أجهزة الدور على البث · now */
export function register(app, deps = {}) {
  const { requirePortal, log = console } = deps;
  const store = deps.store || makeTestPings({ now: deps.now });
  const ip = (c) => { try { return deps.clientIp ? deps.clientIp((n) => c.req.header(n)) : null; } catch { return null; } };
  const send = (event, data, roles) => { try { deps.broadcastTo?.(event, data, roles); } catch (e) { try { log.error("[portal-test] broadcast:", e?.message || e); } catch { /* */ } } };
  const audit = (...a) => { try { deps.audit?.(...a); } catch { /* السجل مايوقّفش حاجة */ } };

  app.post("/api/portal/test-order", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    const r = store.create(a.user);
    if (!r.ok) return c.json({ ok: false, error: r.error, retryInSec: r.retryInSec, message: `استنى ${r.retryInSec} ث وجرّب تاني` }, 429);
    let cashiers = null;
    try { cashiers = typeof deps.streamsFor === "function" ? deps.streamsFor("cashier") : null; } catch { cashiers = null; }
    send("test_order", r.ping, ["cashier"]);
    let push = { sent: 0, of: 0 };
    try { if (deps.push?.sendToSubs) push = await deps.push.sendToSubs(testOrderPush(r.ping, deps.push.PORTAL_URL), { role: "cashier" }); }
    catch (e) { push = { sent: 0, of: 0, error: true }; try { log.error("[portal-test] push:", e?.message || e); } catch { /* */ } }
    audit(a.user, "portal_test_order", null, true, { id: r.ping.id, cashierStreams: cashiers, push: { sent: push.sent || 0, of: push.of || 0, reason: push.reason || null } }, ip(c), { emit: false });
    return c.json({ ok: true, ping: r.ping, cashierStreams: cashiers, push: { sent: push.sent || 0, of: push.of || 0, ...(push.reason ? { reason: push.reason } : {}) } });
  });

  app.get("/api/portal/test-order/active", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    return c.json({ ok: true, pings: store.active() });
  });

  app.get("/api/portal/test-order/:id", async (c) => {
    const a = await requirePortal(c, "manager"); if (a.res) return a.res;
    const p = store.get(c.req.param("id"));
    return p ? c.json({ ok: true, ping: p }) : c.json({ ok: false, error: "not_found" }, 404);
  });

  app.post("/api/portal/test-order/:id/ack", async (c) => {
    const a = await requirePortal(c); if (a.res) return a.res;
    const r = store.ack(c.req.param("id"), a.user);
    if (!r.ok) return c.json({ ok: false, error: r.error, message: "الرنّة دي خلصت" }, 404);
    if (r.first) {
      send("test_order_ack", { id: r.ping.id, by: a.user?.name || null, role: a.user?.role || null, ms: r.ms, late: r.late, ping: r.ping }, ["manager", "cashier"]);
      audit(a.user, "portal_test_ack", null, true, { id: r.ping.id, ms: r.ms, late: r.late }, ip(c), { emit: false });
    }
    return c.json({ ok: true, ms: r.ms, late: r.late, ping: r.ping });
  });

  return { store };
}
