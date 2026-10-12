/* Set "ch1" (12/10): the WhatsApp channel invite. world.channel = the invite is allowed in the context (until it was shown once). */
const out = [];
const S = (id, group, turns, expect = {}, world = { profile: "new", channel: true }) => out.push({ id, group, sets: ["ch1", "full"], world, turns, expect });
const LINK = "whatsapp\\.com/channel";
// allowed, but an ordinary question is not the moment
S("ch1-normal-question", "channel invite", ["كم سعر كريب زنجر سوبريم؟"], { noCart: true, noHandover: true, mustNotContain: [LINK, "قناة"] });
// after helping, the customer thanks ⇒ the invite line as written, once
S("ch1-thanks-after-help", "channel invite", ["كم سعر كريب زنجر سوبريم؟", "تمام شكرا يعطيك العافية", "طيب وكريب ستربس بكم؟"], { noCart: true, noHandover: true, mustContain: ["whatsapp\\.com/channel/0029VaExampleChannel01"] });
// under the cart summary ⇒ allowed; the cart must still be right
S("ch1-after-cart", "channel invite", ["ابي كريب زنجر سوبريم استلام", "لا شكرا بس كذا"], { noHandover: true, cart: { option: "pickup", items: [{ id: 8, qty: 1 }] } });
// an allergy question and an unhappy customer: never
S("ch1-allergy", "channel invite", ["وجبة كفتة فيها سمسم؟ عندي حساسية"], { noCart: true, mustNotContain: [LINK, "قناة"] });
S("ch1-unhappy", "channel invite", ["ابي بيتزا", "انتم بطيئين مرة وما عجبني الوضع"], { noCart: true, mustNotContain: [LINK, "قناة"] });
// not allowed in the context ⇒ never mentioned, even when the customer asks for offers
S("ch1-not-allowed", "channel invite", ["عندكم عروض؟", "شكرا"], { noCart: true, mustNotContain: [LINK] }, { profile: "new" });
export const CH1 = out;
