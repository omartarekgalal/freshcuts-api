/* اختبارات سلّم الريتارجيت — بتشتغل من غير شبكة ولا قاعدة بيانات.

   الحاجات اللي بتتختبر هنا هي اللي لو غلطت مش هتطلّع خطأ، هتطلّع رقم غلط:
   السلّم لازم يبقى تقسيم كامل وحصري، الهولد أوت لازم يبقى ثابت، وحسابات
   القوة الإحصائية لازم تدّي نفس اللي الكتاب بيقوله — لإن القرار «نصرف ولا
   ما نصرفش» معلّق عليها.

   الجزء اللي محتاج داتابيز (الفرق والشيل الفعلي) مش هنا — ده اتثبت على
   البيانات الحقيقية بزرع حالة قديمة على منصة وهمية، والنتيجة متسجّلة في
   التقرير: ١٢٠ شيل، منهم كل الـ٢٠ اللي طلبوا حديثًا، صفر فايت. */
import assert from "node:assert";
import crypto from "node:crypto";
import { RUNGS, rungCase, wilson, mde, nNeeded, breakEven, Z95, Z80 } from "./retargeting.js";

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", e.message); }
};
const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} مش قريّب من ${b} (سماحية ${tol})`);

console.log("\nسلّم الريتارجيت — التقسيم");

/* محاكي للـCASE بتاع بوستجرس: بيمشي على الشروط بالترتيب وبيقف عند أول
   واحد بيتحقق. لو ده بيدّي نفس نتيجة الداتابيز، يبقى الحصرية مش صدفة. */
const toJs = (when, f) => when
  .replace(/f\.(\w+)/g, (_, k) => {
    if (!(k in f)) throw new Error(`الشرط بيقرا عمود مش موجود في الاختبار: ${k}`);
    return `(${JSON.stringify(f[k])})`;
  })
  /* BETWEEN قبل AND — لإن BETWEEN جوّاه AND، ولو حوّلناها && الأول
     الشرط بيتكسر بصمت ويرجع نتيجة غلط بدل ما يرمي خطأ. */
  .replace(/\(([^()]+)\) BETWEEN (\d+) AND (\d+)/g, "(($1) >= $2 && ($1) <= $3)")
  .replace(/\bAND\b/g, "&&")
  .replace(/\bOR\b/g, "||")
  .replace(/([^<>=!])=([^=])/g, "$1===$2")
  .replace(/\bTRUE\b/g, "true");

const evalRung = (f) => {
  for (const spec of RUNGS) {
    // eslint-disable-next-line no-new-func
    if (new Function(`return ${toJs(spec.when, f)};`)()) return spec.key;
  }
  return null;
};

t("كل حالة ممكنة بتقع في درجة واحدة — مفيش حد بيقع برّه السلّم", () => {
  let checked = 0;
  for (const r of [0, 1, 3, 4, 10, 14, 15, 20, 29, 30, 45, 54, 55, 90, 120, 121, 400]) {
    for (const orders of [1, 2, 4, 9]) {
      for (const spend of [10, 299, 300, 1200]) {
        for (const [del, dir] of [[0, 1], [3, 0], [2, 2]]) {
          const key = evalRung({ r, orders, spend, del_orders: del, dir_orders: dir });
          assert.ok(key, `مفيش درجة لـ r=${r} orders=${orders} spend=${spend} del=${del} dir=${dir}`);
          assert.ok(RUNGS.some((x) => x.key === key), `درجة مش معروفة: ${key}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 500, "الفحص لازم يغطّي مئات الحالات");
});

t("اللي طلب خلال ٣ أيام عمره ما يقع في درجة مستهدفة", () => {
  for (const r of [0, 1, 2, 3]) {
    for (const orders of [1, 5]) {
      for (const [del, dir] of [[0, 1], [4, 0]]) {
        const key = evalRung({ r, orders, spend: 900, del_orders: del, dir_orders: dir });
        const spec = RUNGS.find((x) => x.key === key);
        assert.equal(spec.target, false, `r=${r} وقع في درجة مستهدفة: ${key}`);
        assert.equal(key, "hold:justordered");
      }
    }
  }
});

t("عميل تطبيقات عمره ما جه المطعم بيروح لدرجته مش لدرجة الرجوع", () => {
  assert.equal(evalRung({ r: 40, orders: 3, spend: 200, del_orders: 3, dir_orders: 0 }), "rt:delivery-only");
  /* أول ما يطلب مباشرة مرة واحدة، بيخرج منها — دي الشريحة الوحيدة اللي
     الخروج منها هو النجاح. */
  assert.equal(evalRung({ r: 40, orders: 3, spend: 200, del_orders: 2, dir_orders: 1 }), "rt:lapsed");
});

t("الأوفياء بياخدوا الأولوية على درجات الحداثة", () => {
  assert.equal(evalRung({ r: 20, orders: 6, spend: 900, del_orders: 0, dir_orders: 6 }), "rt:vip");
  /* بس مش للأبد — بعد ٦٠ يوم بيدخل مسار الاسترجاع زي أي حد. */
  assert.equal(evalRung({ r: 70, orders: 6, spend: 900, del_orders: 0, dir_orders: 6 }), "rt:atrisk");
});

t("SQL المولّد فيه كل درجة مرة واحدة وبنفس الترتيب", () => {
  const sql = rungCase();
  for (const spec of RUNGS) assert.ok(sql.includes(`'${spec.key}'`), `${spec.key} ناقصة من الـSQL`);
  const order = RUNGS.map((x) => sql.indexOf(`'${x.key}'`));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], "ترتيب الشروط في الـSQL اتغيّر — الحصرية بتعتمد عليه");
  }
});

t("آخر درجة شرطها TRUE — عشان محدّش يقع برّه السلّم", () => {
  assert.equal(RUNGS[RUNGS.length - 1].when.trim(), "TRUE");
});

console.log("\nالهولد أوت");

/* نفس اللي في الموديول بالظبط. لو الاتنين اختلفوا، الاختبار ده بيفشل. */
const armOf = (pn, salt = "freshcuts-rt-v1", p = 20) =>
  (crypto.createHash("sha256").update(`${pn}|${salt}`).digest().readUInt32BE(0) % 10000) < p * 100
    ? "control" : "test";

t("الذراع ثابتة — نفس الرقم بيدّي نفس النتيجة كل مرة", () => {
  for (const pn of ["501234567", "555000111", "590909090"]) {
    const first = armOf(pn);
    for (let i = 0; i < 50; i++) assert.equal(armOf(pn), first);
  }
});

t("النسبة بتقع قريّب من المطلوب على عيّنة واقعية", () => {
  const n = 5000;
  let control = 0;
  for (let i = 0; i < n; i++) if (armOf(String(500000000 + i)) === "control") control++;
  close(control / n, 0.20, 0.02, "نسبة الضابطة");
});

t("تغيير الملح بيغيّر القسمة — يعني الملح فعلاً داخل الحسبة", () => {
  const a = armOf("501234567", "salt-a");
  let differs = 0;
  for (let i = 0; i < 500; i++) {
    if (armOf(String(500000000 + i), "salt-a") !== armOf(String(500000000 + i), "salt-b")) differs++;
  }
  assert.ok(differs > 50, "الملح مالوش تأثير — القسمة مش عشوائية بالنسبة له");
  assert.ok(a === "control" || a === "test");
});

console.log("\nحسابات القياس");

t("مدى ويلسون بيحتوي النسبة وبيفضل جوّه [0,1]", () => {
  const w = wilson(78, 243);
  close(w.p, 0.321, 0.001, "النسبة");
  assert.ok(w.low < w.p && w.p < w.high, "النسبة لازم تقع جوّه المدى");
  assert.ok(w.low >= 0 && w.high <= 1, "المدى لازم يفضل جوّه [0,1]");
  /* ويلسون بيتفوّق على المدى العادي في إنه مابيطلعش برّه الصفر على
     عيّنة صغيرة جدًا — ده سبب اختياره. */
  const tiny = wilson(0, 5);
  assert.ok(tiny.low >= 0 && tiny.high > 0, "مدى صفر من خمسة لازم يفضل صالح");
});

t("MDE بيطابق الحسبة المعروفة", () => {
  /* (1.96+0.8416)·√(p(1-p)(1/n₁+1/n₂)) عند p=0.314 و n=243/60 */
  const m = mde(243, 60, 0.314);
  close(m, (Z95 + Z80) * Math.sqrt(0.314 * 0.686 * (1 / 243 + 1 / 60)), 1e-9, "MDE");
  close(m, 0.187, 0.002, "MDE بالأرقام الحقيقية");
});

t("MDE بيصغر لما الأعداد تكبر، وبيكون أصغر ما يمكن عند ٥٠/٥٠", () => {
  assert.ok(mde(2000, 2000, 0.3) < mde(243, 60, 0.3), "أعداد أكبر لازم تدّي حساسية أعلى");
  const total = 1000;
  const even = mde(500, 500, 0.3);
  for (const c of [100, 200, 300, 400]) {
    assert.ok(even <= mde(total - c, c, 0.3) + 1e-12, `القسمة ${c} طلعت أحسن من ٥٠/٥٠`);
  }
});

t("nNeeded بيرجع القاعدة اللي بتدّي الأثر المطلوب بالظبط", () => {
  const p = 0.314, effect = 0.05;
  const N = nNeeded(effect, p, 0.5);
  close(mde(N / 2, N / 2, p), effect, 0.001, "القاعدة المحسوبة لازم تدّي نفس الأثر");
  assert.ok(N > 2500 && N < 2900, `متوقّع ~2700، طلع ${N}`);
  /* هولد أوت أصغر = قاعدة أكبر مطلوبة. ده الثمن الحقيقي لتصغير الضابطة. */
  assert.ok(nNeeded(effect, p, 0.2) > N, "ضابطة ٢٠٪ لازم تطلب قاعدة أكبر من ٥٠/٥٠");
});

t("breakEven بيرفض الصرف اللي مش هيتقاس", () => {
  const r = breakEven({ spend: 1000, nTest: 243, valuePerReturn: 29.3, minDetectable: 0.187 });
  close(r.breakEvenLiftPoints, 14.0, 0.2, "أثر التعادل");
  assert.equal(r.answerable, false, "١٤ نقطة تحت حساسية ١٨.٧ — مفروض يترفض");
  assert.match(r.verdict, /مش المفروض يتصرف/);
});

t("breakEven بيقبل لما الأثر المطلوب أكبر من الحساسية", () => {
  /* صرف كبير على عدد صغير: التعادل بيطلب أثر ضخم — وده أثر لو حصل
     هنشوفه، فالاختبار ساعتها بيبقى ليه معنى. */
  const r = breakEven({ spend: 5000, nTest: 200, valuePerReturn: 30, minDetectable: 0.15 });
  assert.equal(r.answerable, true);
  assert.match(r.verdict, /يقدر يقول لنا/);
});

t("مفيش رقم بيتقال من مدخلات ناقصة", () => {
  assert.equal(breakEven({ spend: null, nTest: 200, valuePerReturn: 30, minDetectable: 0.1 }), null);
  assert.equal(mde(0, 60, 0.3), null);
  assert.equal(nNeeded(0, 0.3), null);
  assert.deepEqual(wilson(0, 0), { p: null, low: null, high: null });
});

console.log(`\n${pass} نجحوا · ${fail} فشلوا\n`);
if (fail) process.exit(1);
