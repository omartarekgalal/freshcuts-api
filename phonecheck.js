/* ═══════════════════════════════════════════════════════════════════════════
   📵 رقم «حشو» على الفاتورة — القاعدة الواحدة (كانت جوّه wafavpick.js بس؛ مراجعة RV1 ١٥/١٠)

   الكاشير ساعات بيكتب رقم أي كلام عشان يعدّي خانة الجوال: 555555555 / 500000000 / 5 وبعدها نفس الرقم ٨ مرات /
   512345678. الرقم ده مش عميل — ممكن يكون جوال حد غريب عمره ماجه المطعم. فمانبعتلوش رسالة، ومانسجّلش له «موافقة وقت الدفع».

   نفس القاعدة اللي حملة «طبقك المفضل» بتستبعد بيها («bad_number») — من غير imports عشان أي ملف يستخدمها.

   RV5 (١٦/١٠ — قالب النجوم اتفتح لعملاء الكاشير، وميتا صنّفته تسويقي): القاعدة اتوسّعت لكل شكل «كتبه بإيده عشان يعدّي»:
     • ٨ أرقام من التسعة نفس الرقم (555555551 / 555555515 / 515555555)
     • ٧ أرقام ورا بعض نفس الرقم بعد الـ5 (550000000 / 5X0000000 / 5X1111111 / 500000001)
     • الرقم بيخلص بـ000000 (555000000 / 512000000)
     • تسلسل طالع أو نازل ٧ أرقام ورا بعض (512345678 / 501234567 / 5X1234567 / 5X7654321 / 523456789 / 567890123)
     • الـ٨ أرقام بعد الـ5 تكرار نمط: رقمين (512121212 / 505050505) أو تسلسل ٣–٤ أرقام (512312312 / 512341234 / 543214321)
   كل شكل من دول احتمال إن رقم عشوائي يطابقه ≤ ١ في ١٠٠ ألف — الحساب في phonecheck.test.mjs (قايمة أرقام شكلها حقيقي مايتقفلش ولا واحد منها).
   الرقم اللي على فواتير كتير (رقم الكاشير الافتراضي) قاعدة تانية بالعدّ: POS_REVIEW_CONSENT.sharedBills في reviews.js — مكانها هناك (محتاجة القاعدة).
═══════════════════════════════════════════════════════════════════════════ */

/* القاعدة القديمة (RV1) — فضلت زي ما هي؛ isPlaceholderPhone تحت بتشملها */
export const FAKE_PHONE_RE = /^5(\d)\1{7}$|^5?12345678|^500000000$|^555555555$/;

/* أطول تسلسل: كل رقم = اللي قبله +١ (طالع) أو −١ (نازل)، و9→0 / 0→9 بيكمّلوا (زي «7890123» على الكيبورد) */
function longestStraight(d) {
  let best = 1, up = 1, down = 1;
  for (let i = 1; i < d.length; i++) {
    const a = Number(d[i - 1]), b = Number(d[i]);
    up = b === (a + 1) % 10 ? up + 1 : 1;
    down = b === (a + 9) % 10 ? down + 1 : 1;
    best = Math.max(best, up, down);
  }
  return best;
}
const isStraight = (s) => s.length > 1 && longestStraight(s) === s.length;

/* ليه الرقم ده حشو؟ ⇒ اسم القاعدة، أو null (شكله رقم عميل). phoneNorm = 9 أرقام بتبدأ بـ5 (من غير 0 ولا 966). */
export function placeholderWhy(phoneNorm) {
  const d = String(phoneNorm || "");
  if (FAKE_PHONE_RE.test(d)) return "classic";
  if (!/^5\d{8}$/.test(d)) return null;
  const freq = new Map();
  for (const ch of d) freq.set(ch, (freq.get(ch) || 0) + 1);
  if (Math.max(...freq.values()) >= 8) return "eight_same";
  const tail = d.slice(1);
  if (/(\d)\1{6}/.test(tail)) return "seven_run";
  if (/000000$/.test(d)) return "zeros_tail";
  if (longestStraight(d) >= 7) return "straight";
  for (const p of [2, 3, 4]) {
    const block = tail.slice(0, p);
    if (block.repeat(Math.ceil(8 / p)).slice(0, 8) !== tail) continue;
    if (p === 2 || isStraight(block)) return "pattern";
  }
  return null;
}

/* phoneNorm = 9 أرقام بتبدأ بـ5 (من غير 0 ولا 966) */
export const isPlaceholderPhone = (phoneNorm) => placeholderWhy(phoneNorm) !== null;
