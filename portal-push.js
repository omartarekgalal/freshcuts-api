/* ═══════════════════════════════════════════════════════════════════════════
   PORTAL PUSH — Web Push لأجهزة الفريق (تابلت الكاشير، أندرويد، آيفون كـPWA).

   - نفس مكتبة web-push ونفس مفاتيح VAPID اللي notify.js بيولّدها ويحفظها في
     settings.webPushKeys — مفيش مفاتيح تانية. بنبعت vapidDetails مع كل
     إرسال بدل setVapidDetails العامة، فمفيش اعتماد على ترتيب الإقلاع.
   - جدول منفصل portal_push_subs (اشتراكات العملاء في push_subs مابتختلطش).
   - كل إشعار لكل طلب مرة واحدة: حجز ذري في portal_push_log(order_no, kind)
     قبل الإرسال — الناقل والاستطلاع الاحتياطي وحاويتين وقت الـrollover
     مايبعتوش مرتين.
   - 404/410 = الاشتراك مات ← بيتمسح. أي خطأ تاني بيتعدّ ومابيوصلش لحد.
   - كل الدوال مابترميش: فشل الإشعار عمره ما يوقف طلب ولا مندوب.
═══════════════════════════════════════════════════════════════════════════ */

import webpushLib from "web-push";
import { pushPayload, pushKindForEvent } from "./portal-core.js";

export const PUSH_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS portal_push_subs (
    id BIGSERIAL PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    sub JSONB NOT NULL,
    staff_id TEXT NOT NULL,
    staff_name TEXT,
    role TEXT NOT NULL,
    device_name TEXT,
    user_agent TEXT,
    fail_count INT NOT NULL DEFAULT 0,
    last_ok_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS portal_push_subs_staff_idx ON portal_push_subs(staff_id)`,
  `CREATE TABLE IF NOT EXISTS portal_push_log (
    order_no TEXT NOT NULL,
    kind TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent INT,
    targets INT,
    PRIMARY KEY (order_no, kind)
  )`,
]);

const MAX_SUBS = 60;
const SEND_TIMEOUT_MS = 10_000;

export function validSubscription(sub) {
  try {
    if (!sub || typeof sub !== "object") return false;
    const ep = String(sub.endpoint || "");
    if (!/^https:\/\/[^\s]{8,}$/.test(ep) || ep.length > 1000) return false;
    const k = sub.keys || {};
    return typeof k.p256dh === "string" && k.p256dh.length >= 20 && k.p256dh.length <= 200
      && typeof k.auth === "string" && k.auth.length >= 8 && k.auth.length <= 100;
  } catch {
    return false;
  }
}

export function makePortalPush({ pool, getSettingsData, webpush = webpushLib, log = console, baseUrl, subject, allowStaff = null } = {}) {
  const PORTAL_URL = baseUrl || (process.env.PORTAL_PUBLIC_URL || "https://freshcuts-invite.o2m8.me/portal/").trim();
  const SUBJECT = subject || (process.env.PORTAL_VAPID_SUBJECT || "https://freshcuts.sa").trim();
  const stats = { sent: 0, failed: 0, removed: 0, skipped: 0 };
  let ready = null;

  function ensureSchema() {
    if (!ready) {
      ready = (async () => {
        for (const sql of PUSH_DDL) await pool.query(sql);
        return true;
      })().catch((e) => {
        ready = null;
        try { log.error(`[portal-push] schema failed: ${e?.message || e}`); } catch {}
        return false;
      });
    }
    return ready;
  }

  async function vapid() {
    const s = await getSettingsData();
    const k = s?.webPushKeys;
    if (!k?.publicKey || !k?.privateKey) return null;
    return { settings: s, keys: k };
  }

  async function publicKey() {
    try { return (await vapid())?.keys.publicKey || null; } catch { return null; }
  }

  async function subscribe({ subscription, deviceName, userAgent, user }) {
    await ensureSchema();
    await pool.query(
      `INSERT INTO portal_push_subs(endpoint, sub, staff_id, staff_name, role, device_name, user_agent)
       VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7)
       ON CONFLICT (endpoint) DO UPDATE SET sub=EXCLUDED.sub, staff_id=EXCLUDED.staff_id,
         staff_name=EXCLUDED.staff_name, role=EXCLUDED.role,
         device_name=COALESCE(EXCLUDED.device_name, portal_push_subs.device_name),
         user_agent=EXCLUDED.user_agent, fail_count=0, last_error=NULL, updated_at=NOW()`,
      [String(subscription.endpoint), JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys }),
        String(user.id), user.name || null, user.role,
        deviceName ? String(deviceName).slice(0, 60) : null, userAgent ? String(userAgent).slice(0, 200) : null]);
    return true;
  }

  /* staffId (اختياري): الموظف يمسح اشتراكات أجهزته بس — المدير يمرّر null */
  async function unsubscribe(endpoint, staffId = null) {
    await ensureSchema();
    const r = staffId
      ? await pool.query("DELETE FROM portal_push_subs WHERE endpoint=$1 AND staff_id=$2", [String(endpoint || ""), String(staffId)])
      : await pool.query("DELETE FROM portal_push_subs WHERE endpoint=$1", [String(endpoint || "")]);
    return r.rowCount || 0;
  }

  async function sendOne(row, payload, keys) {
    const body = JSON.stringify({
      title: payload.title, body: payload.body, url: payload.url, tag: payload.tag,
      orderNo: payload.orderNo, kind: payload.kind, requireInteraction: Boolean(payload.requireInteraction),
      renotify: payload.renotify !== false, at: new Date().toISOString(),
    });
    try {
      const p = webpush.sendNotification(row.sub, body, {
        TTL: payload.ttl ?? 600,
        urgency: payload.urgency || "normal",
        timeout: SEND_TIMEOUT_MS,
        vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
      });
      await p;
      stats.sent++;
      pool.query("UPDATE portal_push_subs SET last_ok_at=NOW(), fail_count=0, last_error=NULL WHERE id=$1", [row.id]).catch(() => {});
      return true;
    } catch (e) {
      const code = Number(e?.statusCode);
      if (code === 404 || code === 410) {
        stats.removed++;
        pool.query("DELETE FROM portal_push_subs WHERE id=$1", [row.id]).catch(() => {});
      } else {
        stats.failed++;
        pool.query("UPDATE portal_push_subs SET fail_count=fail_count+1, last_error=$2 WHERE id=$1",
          [row.id, String(e?.statusCode || e?.code || e?.message || "error").slice(0, 120)]).catch(() => {});
      }
      return false;
    }
  }

  /* يبعت لكل الاشتراكات (أو لموظف/endpoint بعينه). بيرجّع {sent, of}. */
  async function sendToSubs(payload, { staffId = null, endpoint = null } = {}) {
    try {
      await ensureSchema();
      const v = await vapid();
      if (!v) { stats.skipped++; return { sent: 0, of: 0, reason: "no_vapid" }; }
      if (v.settings?.portal?.pushEnabled === false && payload.kind !== "test") {
        stats.skipped++;
        return { sent: 0, of: 0, reason: "disabled" };
      }
      const where = [], vals = [];
      if (staffId) { vals.push(String(staffId)); where.push(`staff_id=$${vals.length}`); }
      if (endpoint) { vals.push(String(endpoint)); where.push(`endpoint=$${vals.length}`); }
      let rows = (await pool.query(
        `SELECT id, sub, staff_id FROM portal_push_subs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY id DESC LIMIT ${MAX_SUBS}`, vals)).rows || [];
      /* جهاز موظف اتشال (أو الرقم المشترك اتقفل) مايفضلش يستقبل إشعارات الطلبات */
      if (typeof allowStaff === "function" && rows.length) {
        let allowed = null;
        try { allowed = await allowStaff(); } catch { allowed = null; }
        if (allowed instanceof Set) rows = rows.filter((r) => r.staff_id == null || allowed.has(String(r.staff_id)));
      }
      if (!rows.length) return { sent: 0, of: 0 };
      const res = await Promise.allSettled(rows.map((r) => sendOne(r, payload, v.keys)));
      return { sent: res.filter((x) => x.status === "fulfilled" && x.value).length, of: rows.length };
    } catch (e) {
      try { log.error(`[portal-push] send ${payload?.kind} failed: ${e?.message || e}`); } catch {}
      return { sent: 0, of: 0, error: true };
    }
  }

  /* حجز ذري لكل (طلب، نوع) — true = إحنا اللي هنبعت */
  async function claim(orderNo, key) {
    await ensureSchema();
    const r = await pool.query(
      `INSERT INTO portal_push_log(order_no, kind) VALUES ($1,$2)
       ON CONFLICT (order_no, kind) DO NOTHING RETURNING order_no`, [String(orderNo), String(key).slice(0, 60)]);
    return (r.rowCount || 0) > 0;
  }

  /* إشعار لطلب مرة واحدة. info بيتجاب من loadInfo(orderNo) لو محتاجين إجمالي/اسم كابتن. */
  async function notifyOrder(kind, key, orderNo, info = {}) {
    try {
      if (!(await claim(orderNo, key))) return { skipped: "already_sent" };
      const payload = pushPayload(kind, { ...info, orderNo }, PORTAL_URL);
      const res = await sendToSubs(payload);
      pool.query("UPDATE portal_push_log SET sent=$3, targets=$4 WHERE order_no=$1 AND kind=$2",
        [String(orderNo), String(key).slice(0, 60), res.sent, res.of]).catch(() => {});
      return res;
    } catch (e) {
      try { log.error(`[portal-push] ${kind} ${orderNo} failed: ${e?.message || e}`); } catch {}
      return { sent: 0, of: 0, error: true };
    }
  }

  /* مستمع الناقل: fire-and-forget. loadInfo(orderNo) → {total, option, itemsCount, driverName} */
  function onOrderEvent(evt, loadInfo) {
    try {
      const m = pushKindForEvent(evt);
      if (!m) return null;
      const d = evt.data || {};
      return (async () => {
        let info = {};
        try { info = (await loadInfo?.(evt.orderNo)) || {}; } catch { info = {}; }
        if (info.isTest) return { skipped: "test_order" }; // الطلبات الاصطناعية ماترنّش في المطبخ
        if (m.kind === "sla") info = { ...info, code: d.code, message: null };
        if (m.kind === "new" && info.total == null && d.total != null) info.total = d.total;
        if (m.kind === "new" && !info.option && d.option) info.option = d.option;
        return notifyOrder(m.kind, m.key, evt.orderNo, info);
      })().catch(() => null);
    } catch {
      return null;
    }
  }

  /* ربط تاب سينس واقع — مرة في الساعة بالكتير (حجز على مفتاح الساعة) */
  async function tabsenseDown(detail) {
    const hourKey = new Date().toISOString().slice(0, 13);
    return notifyOrder("tabsense_down", `tabsense_down:${hourKey}`, "_system", { detail });
  }

  async function test(user, endpoint) {
    const payload = pushPayload("test", { name: user?.name }, PORTAL_URL);
    return sendToSubs(payload, { staffId: user?.id, endpoint: endpoint || null });
  }

  async function pushLogFor(orderNo) {
    try {
      await ensureSchema();
      return (await pool.query('SELECT kind, at, sent, targets AS "of" FROM portal_push_log WHERE order_no=$1 ORDER BY at', [String(orderNo)])).rows || [];
    } catch { return []; }
  }

  async function devices() {
    await ensureSchema();
    return (await pool.query(
      `SELECT id, staff_id, staff_name, role, device_name, fail_count, last_ok_at, created_at, updated_at
         FROM portal_push_subs ORDER BY updated_at DESC LIMIT 100`)).rows || [];
  }

  return { ensureSchema, publicKey, subscribe, unsubscribe, sendToSubs, notifyOrder, onOrderEvent,
    tabsenseDown, test, claim, pushLogFor, devices, stats, PORTAL_URL };
}
