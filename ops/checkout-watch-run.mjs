/* ═══════════════════════════════════════════════════════════════════════════
   CHECKOUT WATCH — مشغّل من برّه التطبيق (بدون إعادة نشر)

   ليلة ٢٢/٩ فيه تغييرات env متعلّقة في Coolify، وأي restart هيطلّعها
   وهي مش جاهزة — وكمان restart وسط الذروة ممكن يقطع طلب. فالحارس
   بيشتغل دلوقتي من cron على السيرفر: بيحقن نفس موديول checkoutwatch.js
   جوّه الحاوية الشغّالة وينفّذه بـdocker exec.

   مفيش قناة إرسال جديدة: بيستورد staffalerts.js + accounts.sendSms من
   /app — نفس اللي التطبيق بيستعمله. ولما التطبيق ينزل المرة الجاية،
   register() جوّه checkoutwatch.js بياخد الدور وبنطفّي الـcron.

   بيتنادى من /app جوّه الحاوية: node _checkout_watch_run.mjs [--dry]
═══════════════════════════════════════════════════════════════════════════ */
import pg from "pg";
import { runOnce } from "/app/_checkoutwatch.js";
import { makeStaffNotifier } from "/app/staffalerts.js";
import { sendSms } from "/app/accounts.js";
import { initSmsLog } from "/app/smslog.js";

/* --at <ISO> بيعيد تشغيل نفس القاعدة على لحظة في الماضي (للتحقق والمعايرة).
   بيفرض dry-run دايماً: إعادة التشغيل عمرها ما تبعت رسالة ولا تكتب الحالة. */
const atArg = (process.argv.find((a) => a.startsWith("--at=")) || "").slice(5);
const at = atArg ? new Date(atArg) : null;
if (atArg && Number.isNaN(+at)) { console.error(`FAILED bad --at=${atArg}`); process.exit(1); }
const dryRun = process.argv.includes("--dry") || !!at;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
initSmsLog(pool);                       // الرسالة تتسجّل في سجل الرسايل زي أي رسالة

const getSettingsData = async () =>
  (await pool.query("SELECT data FROM settings WHERE id=1")).rows[0]?.data || {};

const staff = makeStaffNotifier({ getSettingsData, sendSms });

try {
  const r = await runOnce({ pool, getSettingsData, staff }, { dryRun, ...(at ? { now: at } : {}) });
  console.log(`${at ? `REPLAY ${at.toISOString()} ` : dryRun ? "DRY " : ""}${r.line || JSON.stringify(r)}${r.text ? ` | "${r.text}"` : ""}`);
} catch (e) {
  console.error(`FAILED ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
