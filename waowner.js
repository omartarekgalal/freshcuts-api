/* ═══════════════════════════════════════════════════════════════════════════
   مين ماسك محادثة واتساب — سحب / سيبها للبوت / خلصت (waowner.js) — SR2، ١٣/١٠/٢٠٢٦

   طلب عمر: «عايز الموظفين يفتحوا البورتال ويكون فيها سحب الشات او يسيبوه للبوت او يخلصوا يقفلوا».

   • السحب = الكتم اليدوي الموجود عند البوت (wa_bot_chats.muted_until) بس بالدقايق: bot.holdChat. البوت والمساعد
     بيسكتوا من نفس العمود (decide ⇒ manual_mute، والمساعد بيرفض الدور الساكت) — مفيش حالة جديدة بيقروها.
   • المهلة بتتجدد مع كل رد للموظف (بورتال / لوحة / موبايل المطعم = صف source='echo')، ولو عدّت من غير رد
     المحادثة بترجع للبوت لوحدها والتحويل المفتوح **بيفضل** (ترجع «مستنية موظف» مش «اتحلّت»).
   • «سيبها للبوت» و«خلصت» = bot.unmuteChat({release:true}): بيشيل الكتم والتحويل، والبوت يرد على الرسالة الجاية فوراً.
   • الملف ده مابيكتبش في جداول البوت: كل الكتابة هناك من دوال البوت نفسها. جداوله: wa_chat_holds (صف للمحادثة
     المسحوبة أو المقفولة) و wa_chat_owner_log (مين عمل إيه).
   • الكاشير مايقدرش ياخد محادثة ماسكها غيره ولا يسيبها؛ المدير (بورتال) والمالك/العمليات (لوحة) يقدروا (force).
   • الرد مابيسحبش المحادثة ومابيتمنعش بسحب حد تاني (قرار المنسّق ١٣/١٠).
═══════════════════════════════════════════════════════════════════════════ */
export const HOLD = Object.freeze({ def: 20, min: 5, max: 240 });
export const STATES = Object.freeze(["bot", "waiting_staff", "held", "closed"]);
const MANAGER_ROLES = new Set(["manager", "owner", "operations"]);
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const ms = (v) => (v ? new Date(v).getTime() : NaN);
const iso = (v) => (v ? new Date(v).toISOString() : null);

/* settings.waInbox.holdAutoReleaseMin — دقايق من غير رد موظف وبعدها المحادثة ترجع للبوت */
export function holdMinutes(settings) {
  const v = Number(settings && settings.waInbox && settings.waInbox.holdAutoReleaseMin);
  return Number.isFinite(v) ? Math.min(HOLD.max, Math.max(HOLD.min, Math.round(v))) : HOLD.def;
}
/* الحساب اللي ماسك: PIN الكاشير المشترك حساب واحد؛ حسابات اللوحة باسم المستخدم */
export function accountOf(me) {
  if (!me || !me.role) return null;
  const via = me.via === "portal" ? "portal" : "dashboard";
  const id = String(me.id ?? me.username ?? me.name ?? me.role);
  return { key: `${via}:${id}`, id, name: clip(me.name || me.username || me.role, 60), role: String(me.role), via };
}
export const canManage = (me) => Boolean(me && MANAGER_ROLES.has(String(me.role)));

/* row = { muted_until, muted_by, handoff_at, handoff_reason, last_in_at, last_echo_at } · hold = صف wa_chat_holds أو null */
export function ownerOf(row, hold, { now = Date.now(), me = null, handoffOpenHours = 24 } = {}) {
  const r = row || {};
  const acct = accountOf(me);
  const base = { state: "bot", by: null, since: null, waitedMin: null, mine: false, autoReleaseAt: null, reason: null };
  const mins = (from) => (Number.isFinite(ms(from)) ? Math.max(0, Math.floor((now - ms(from)) / 60_000)) : null);
  if (ms(r.muted_until) > now) {
    const held = hold && hold.state === "held";
    const unanswered = Number.isFinite(ms(r.last_in_at)) && !(ms(r.last_echo_at) >= ms(r.last_in_at));
    return { ...base, state: "held",
      by: held ? { id: hold.by_id || null, name: hold.by_name || null, role: hold.role || null, via: hold.via || null } : { id: null, name: r.muted_by || null, role: null, via: "mute" },
      since: held ? iso(hold.since) : null, waitedMin: unanswered ? mins(r.last_in_at) : null,
      mine: Boolean(held && acct && hold.by_key === acct.key), autoReleaseAt: iso(r.muted_until) };
  }
  if (r.handoff_at && now - ms(r.handoff_at) < handoffOpenHours * 3600_000) {
    return { ...base, state: "waiting_staff", since: iso(r.handoff_at), waitedMin: mins(r.handoff_at), reason: r.handoff_reason || "handover" };
  }
  if (hold && hold.state === "closed" && !(ms(r.last_in_at) > ms(hold.since))) {
    return { ...base, state: "closed", by: { id: hold.by_id || null, name: hold.by_name || null, role: hold.role || null, via: hold.via || null }, since: iso(hold.since) };
  }
  return base;
}

const DDL = `CREATE TABLE IF NOT EXISTS wa_chat_holds (
  phone_norm TEXT PRIMARY KEY, state TEXT NOT NULL, by_key TEXT, by_id TEXT, by_name TEXT, role TEXT, via TEXT,
  since TIMESTAMPTZ NOT NULL DEFAULT NOW(), touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS wa_chat_owner_log (
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), phone_norm TEXT NOT NULL, action TEXT NOT NULL,
  by_key TEXT, by_name TEXT, role TEXT, via TEXT, forced BOOLEAN NOT NULL DEFAULT false, prev_by TEXT);
CREATE INDEX IF NOT EXISTS wa_chat_owner_log_phone_at ON wa_chat_owner_log (phone_norm, at DESC)`;

const ROW_SQL = `SELECT t.phone_norm, t.last_in_at, b.muted_until, b.muted_by, b.handoff_at, b.handoff_reason,
    (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = t.phone_norm AND m.source = 'echo') AS last_echo_at
  FROM wa_threads t LEFT JOIN wa_bot_chats b ON b.phone_norm = t.phone_norm WHERE t.phone_norm = $1`;

/* deps: { pool, getSettingsData, bot() ⇒ {holdChat, unmuteChat, botConfig}, keyOf(pn) ⇒ مفتاح المحادثة, broadcast?(event, data), log?, now? } */
export function create(deps) {
  const { pool, getSettingsData } = deps;
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());
  const bot = () => (typeof deps.bot === "function" ? deps.bot() : deps.bot) || null;
  const ready = pool.query(DDL).then(() => true).catch((e) => { log.error("[wa-owner] schema:", e.message); return false; });
  const minutes = async () => holdMinutes(await getSettingsData().catch(() => ({})));
  const openHours = async () => { try { return Number((await bot()?.botConfig?.())?.handoffOpenHours) || 24; } catch { return 24; } };
  const say = (pn, owner) => { try { if (deps.broadcast && deps.keyOf) deps.broadcast("wa_chat_owner", { key: deps.keyOf(pn), owner: { ...owner, mine: undefined } }); } catch (e) { log.error("[wa-owner] broadcast:", e.message); } };
  const note = async (pn, action, acct, { forced = false, prev = null } = {}) => {
    try { await pool.query("INSERT INTO wa_chat_owner_log(phone_norm, action, by_key, by_name, role, via, forced, prev_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [pn, action, acct ? acct.key : null, acct ? acct.name : null, acct ? acct.role : null, acct ? acct.via : null, forced === true, clip(prev, 60)]); }
    catch (e) { log.error("[wa-owner] log:", e.message); }
  };
  const holdsOf = async (phones) => {
    if (!phones.length) return new Map();
    const r = await pool.query("SELECT phone_norm, state, by_key, by_id, by_name, role, via, since, touched_at FROM wa_chat_holds WHERE phone_norm = ANY($1::text[])", [phones]);
    return new Map((r.rows || []).map((x) => [x.phone_norm, x]));
  };

  /* owner لكل صف من صفوف القايمة (الصف فيه أعمدة البوت + last_in_at + last_echo_at). الفشل ⇒ null (القايمة ماتقعش). */
  async function ownersFor(rows, me) {
    try {
      await ready;
      const list = (rows || []).filter((r) => r && r.phone_norm);
      const [holds, H] = await Promise.all([holdsOf(list.map((r) => r.phone_norm)), openHours()]);
      const t0 = now();
      return new Map(list.map((r) => [r.phone_norm, ownerOf(r, holds.get(r.phone_norm) || null, { now: t0, me, handoffOpenHours: H })]));
    } catch (e) { log.error("[wa-owner] owners:", e.message); return new Map(); }
  }
  async function ownerFor(pn, me) {
    await ready;
    const row = (await pool.query(ROW_SQL, [pn])).rows[0];
    if (!row) return null;
    return (await ownersFor([row], me)).get(pn) || null;
  }
  /* المحادثات اللي الحساب ده ماسكها دلوقتي */
  async function minePhones(me) {
    const acct = accountOf(me); if (!acct) return [];
    try {
      await ready;
      const r = await pool.query(`SELECT h.phone_norm FROM wa_chat_holds h JOIN wa_bot_chats b ON b.phone_norm = h.phone_norm
                                   WHERE h.state = 'held' AND h.by_key = $1 AND b.muted_until > NOW()`, [acct.key]);
      return (r.rows || []).map((x) => x.phone_norm);
    } catch (e) { log.error("[wa-owner] mine:", e.message); return []; }
  }

  const fail = (error, owner, message, status) => ({ ok: false, error, owner: owner || null, message, status });
  const AR = { held_by_other: (n) => `المحادثة ماسكها ${n || "موظف تاني"}`, not_yours: (n) => `المحادثة ماسكها ${n || "موظف تاني"} — المدير بس يقدر يسيبها أو يقفلها` };

  async function take(pn, me, { force = false } = {}) {
    const acct = accountOf(me); if (!acct) return fail("unauthorized", null, undefined, 401);
    const b = bot(); if (!b || typeof b.holdChat !== "function") return fail("unavailable", null, undefined, 503);
    const cur = await ownerFor(pn, me); if (!cur) return fail("not_found", null, undefined, 404);
    const other = cur.state === "held" && !cur.mine;
    if (other && !(force === true && canManage(me))) return fail("held_by_other", cur, AR.held_by_other(cur.by && cur.by.name), 409);
    await b.holdChat(pn, await minutes(), acct.name);
    await pool.query(`INSERT INTO wa_chat_holds(phone_norm, state, by_key, by_id, by_name, role, via, since, touched_at) VALUES ($1,'held',$2,$3,$4,$5,$6,NOW(),NOW())
                      ON CONFLICT (phone_norm) DO UPDATE SET state='held', by_key=$2, by_id=$3, by_name=$4, role=$5, via=$6,
                        since = CASE WHEN wa_chat_holds.state='held' AND wa_chat_holds.by_key=$2 THEN wa_chat_holds.since ELSE NOW() END, touched_at=NOW()`,
      [pn, acct.key, acct.id, acct.name, acct.role, acct.via]);
    if (!cur.mine) await note(pn, "take", acct, { forced: other, prev: other && cur.by ? cur.by.name : null });
    const owner = await ownerFor(pn, me); say(pn, owner);
    return { ok: true, owner };
  }
  async function end(pn, me, action) {
    const acct = accountOf(me); if (!acct) return fail("unauthorized", null, undefined, 401);
    const b = bot(); if (!b || typeof b.unmuteChat !== "function") return fail("unavailable", null, undefined, 503);
    const cur = await ownerFor(pn, me); if (!cur) return fail("not_found", null, undefined, 404);
    const other = cur.state === "held" && !cur.mine;
    if (other && !canManage(me)) return fail("not_yours", cur, AR.not_yours(cur.by && cur.by.name), 403);
    await b.unmuteChat(pn, { release: true });
    if (action === "done") {
      await pool.query(`INSERT INTO wa_chat_holds(phone_norm, state, by_key, by_id, by_name, role, via, since, touched_at) VALUES ($1,'closed',$2,$3,$4,$5,$6,NOW(),NOW())
                        ON CONFLICT (phone_norm) DO UPDATE SET state='closed', by_key=$2, by_id=$3, by_name=$4, role=$5, via=$6, since=NOW(), touched_at=NOW()`,
        [pn, acct.key, acct.id, acct.name, acct.role, acct.via]);
    } else await pool.query("DELETE FROM wa_chat_holds WHERE phone_norm=$1", [pn]);
    await note(pn, action, acct, { forced: other, prev: other && cur.by ? cur.by.name : null });
    const owner = await ownerFor(pn, me); say(pn, owner);
    return { ok: true, owner };
  }
  const release = (pn, me) => end(pn, me, "release");
  const done = (pn, me) => end(pn, me, "done");

  /* موظف رد (بورتال/لوحة): لو المحادثة مسحوبة، المهلة تبدأ من جديد. مابيسحبش محادثة مش مسحوبة. */
  async function touch(pn) {
    try {
      await ready;
      const h = (await pool.query("SELECT by_name FROM wa_chat_holds WHERE phone_norm=$1 AND state='held'", [pn])).rows[0];
      const b = bot();
      if (!h || !b || typeof b.holdChat !== "function") return false;
      const cur = await ownerFor(pn, null);
      if (!cur || cur.state !== "held") return false;      // المهلة خلصت قبل الرد ⇒ sweep هينضّف
      await b.holdChat(pn, await minutes(), h.by_name);
      await pool.query("UPDATE wa_chat_holds SET touched_at=NOW() WHERE phone_norm=$1", [pn]);
      return true;
    } catch (e) { log.error("[wa-owner] touch:", e.message); return false; }
  }
  /* كل دقيقة: رد من موبايل المطعم بيجدد المهلة؛ والمهلة اللي خلصت ⇒ المحادثة ترجع للبوت والتحويل المفتوح يفضل. */
  async function sweep() {
    const out = { extended: 0, released: 0 };
    try {
      await ready;
      const rows = (await pool.query(`SELECT h.phone_norm, h.by_name, h.touched_at, b.muted_until,
          (SELECT max(m.created_at) FROM wa_messages m WHERE m.phone_norm = h.phone_norm AND m.source = 'echo') AS last_echo_at
        FROM wa_chat_holds h LEFT JOIN wa_bot_chats b ON b.phone_norm = h.phone_norm WHERE h.state = 'held'`)).rows || [];
      const b = bot(); if (!b) return out;
      const t0 = now(), m = await minutes();
      for (const r of rows) {
        if (!(ms(r.muted_until) > t0)) {
          if (typeof b.unmuteChat === "function") await b.unmuteChat(r.phone_norm, { keepHandover: true });
          await pool.query("DELETE FROM wa_chat_holds WHERE phone_norm=$1 AND state='held'", [r.phone_norm]);
          await note(r.phone_norm, "auto_release", null, { prev: r.by_name });
          say(r.phone_norm, await ownerFor(r.phone_norm, null));
          out.released++;
        } else if (ms(r.last_echo_at) > ms(r.touched_at) && typeof b.holdChat === "function") {
          await b.holdChat(r.phone_norm, m, r.by_name);
          await pool.query("UPDATE wa_chat_holds SET touched_at=$2 WHERE phone_norm=$1", [r.phone_norm, iso(r.last_echo_at)]);
          out.extended++;
        }
      }
    } catch (e) { log.error("[wa-owner] sweep:", e.message); }
    return out;
  }
  let timer = null;
  if (!deps.noTimer) { timer = setInterval(() => { sweep().catch(() => {}); }, 60_000); if (timer.unref) timer.unref(); }

  return { ready, take, release, done, touch, sweep, ownersFor, ownerFor, minePhones, minutes, stop: () => { if (timer) clearInterval(timer); } };
}
