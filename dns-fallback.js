/* ═══════════════════════════════════════════════════════════════════════════
   DNS احتياطي — لازم يتحمّل قبل أي ملف تاني (أول import في index.js)

   14 سبتمبر 2026: DNS جوّه حاوية الـAPI بقى بيفشل بشكل متقطع (EAI_AGAIN) —
   ٣ من ٢٠ استعلام فشلوا على تقنيات وتاب سينس ولاجلك. النتيجة: رمز دخول
   ماخرجش لعميل، وكان ممكن طلب مايوصلش نقطة البيع أو مندوب مايتطلبش. السبب
   في مسار DNS بتاع السيرفر (Docker ← systemd-resolved ← Tailscale)، وCoolify
   مابيقبلش ‎--dns‎ (بيتجاهلها في صمت، اتجرّبت).

   الحل هنا جوّه التطبيق نفسه، فبيعيش مع أي نشر: بنلف dns.lookup — لو
   الاستعلام العادي فشل بخطأ مؤقت، بنسأل Cloudflare/Google مباشرة. الطريق
   العادي زي ما هو، والاحتياطي بيشتغل بس وقت الفشل. أسماء الخدمات الداخلية
   (اللي مفيهاش نقطة، زي اسم قاعدة البيانات) مابتروحش للاحتياطي أبداً.

   DNS_FALLBACK=0 يقفله، وDNS_FALLBACK_SERVERS يغيّر السيرفرات. */
import dns from "node:dns";
import net from "node:net";

const RETRY_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "ETIMEOUT", "ESERVFAIL", "ECONNREFUSED"]);

export function makeLookup(original, resolver, { log = console.error, servers = [] } = {}) {
  const lastLog = new Map();
  return function lookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    if (typeof options === "number") options = { family: options };
    options = options || {};
    original(hostname, options, (err, address, family) => {
      const host = String(hostname || "");
      if (!err || !RETRY_CODES.has(err.code) || !host.includes(".") || net.isIP(host)) {
        return callback(err, address, family);
      }
      const fam = options.family === 6 ? 6 : 4;
      const resolve = fam === 6 ? resolver.resolve6.bind(resolver) : resolver.resolve4.bind(resolver);
      resolve(host, (err2, addrs) => {
        if (err2 || !addrs || !addrs.length) return callback(err, address, family);
        const now = Date.now();
        if (log && now - (lastLog.get(host) || 0) > 600_000) {
          lastLog.set(host, now);
          log(`[dns-fallback] ${host}: ${err.code} → ${addrs[0]} (${servers.join(",") || "fallback"})`);
        }
        if (options.all) return callback(null, addrs.map((a) => ({ address: a, family: fam })));
        return callback(null, addrs[0], fam);
      });
    });
  };
}

if (process.env.DNS_FALLBACK !== "0" && !dns.lookup.__fcFallback) {
  const servers = String(process.env.DNS_FALLBACK_SERVERS || "1.1.1.1,8.8.8.8")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const resolver = new dns.Resolver({ timeout: 2500, tries: 2 });
  resolver.setServers(servers);
  const patched = makeLookup(dns.lookup, resolver, { servers });
  patched.__fcFallback = true;
  dns.lookup = patched;
}
