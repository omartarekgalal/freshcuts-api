/* Set "ps3" (13/10): the first real conversation with ماجد (…4433, 00:13 Riyadh) and Omar's three corrections.
     1) never volunteer what we do NOT have («لا توجد جلسات خارجية» to someone who did not ask about outdoor seating);
     2) «في المكان» / «فين جده ولا فين» = where are you — and a location answer SENDS the location (the map button);
     3) «بكرة» is not a goodbye: offer a reminder (and a time), schedule it only inside the 24-hour window, say honestly when it had to move or cannot be done.
   The seating answer in these worlds is stored the way Omar is asked to store it (the negative on a conditional line). MIDNIGHT = Tuesday 00:13 Riyadh (open until 2). */
const out = [];
const MIDNIGHT = "2026-10-12T21:13:00Z";
const FAQ = { dine_in: { ar: "نعم، عندنا جلسات داخلية وفيها قسم للعائلات، والجلوس متاح طوال ساعات العمل.\n[لو سأل: خارجي، خارجية، برا، بره، الهوا، outdoor] لا توجد جلسات خارجية.", en: "Yes. We have indoor seating with a family section, available throughout opening hours.\n[if asked: outdoor, outside, terrace] There is no outdoor seating." } };
const S = (id, group, turns, expect = {}, world = {}) => out.push({ id, group, sets: ["ps3"], world: { profile: "new", faq: FAQ, later: true, ...world }, turns, expect });
const NO_NEG = "خارجي|لا توجد|لا يوجد|ما عندنا|outdoor";

/* the real conversation, line for line */
S("ps3-real-chat", "the real chat", ["مرحبا", "في المكان", "فين جده ولا فين", "لا انشالله بكره", "شكرا"],
  { noCart: true, noHandover: true, mapButton: [1, 2], reminder: false, turnMustContain: { 1: "السلامه|السلامة", 2: "السلامه|السلامة", 3: "اذكرك|أذكّرك|أذكرك" },
    turnMustNotContain: { 1: NO_NEG + "|جلسات", 2: "ارسل لك الطلب|أرسل لك الطلب", 3: "بالتوفيق|لوقت لاحق", 4: "[؟?]" }, mustNotContain: ["بالتوفيق"] }, { at: MIDNIGHT });
S("ps3-where-opens-the-chat", "location", ["فين المكان"], { noCart: true, noHandover: true, mapButton: [0], owner: { 0: "rules" } });
S("ps3-where-english", "location", ["hi", "where are you located?"], { noCart: true, noHandover: true, mapButton: [1], mustNotContain: [NO_NEG] });
S("ps3-eat-there-after-pickup-question", "location", ["ابي كريب زنجر سوبريم", "لا شكراً", "في المكان"], { noHandover: true, mustNotContain: ["خارجي"] });
/* negatives only when asked */
S("ps3-seating-not-asked-outdoor", "no unsolicited negative", ["عندكم جلسات عوائل؟"], { noCart: true, noHandover: true, turnMustContain: { 0: "جلسات" }, mustNotContain: ["خارجي"] });
S("ps3-seating-asked-outdoor", "no unsolicited negative", ["عندكم جلسات خارجية؟"], { noCart: true, noHandover: true, turnMustContain: { 0: "خارجي" } });
/* postponement and the reminder */
S("ps3-postpone-midnight-then-time", "reminder", ["كم سعر كريب زنجر سوبريم؟", "بكره ان شاء الله", "ايوه ذكرني الساعة ٨ مساء"],
  { noCart: true, noHandover: true, reminder: "2026-10-13T17:00", turnTool: { 2: "remind_me" }, turnMustContain: { 1: "اذكرك|أذكّرك|أذكرك", 2: "8" }, turnMustNotContain: { 1: "بالتوفيق" } }, { at: MIDNIGHT });
S("ps3-postpone-beyond-the-window", "reminder", ["ابي بوكس البرجر الفردي", "لا خلها بكرة", "ذكرني بكرة الساعة ٨ بالليل"],
  { noCart: true, noHandover: true, reminder: "2026-10-13T14:40", turnTool: { 2: "remind_me" }, turnMustContain: { 2: "5:40" } });      // 18:00 Monday: the window closes 18:00 Tuesday; 20:00 cannot be sent, 17:40 can
S("ps3-reminder-when-closed", "reminder", ["بعدين ان شاء الله", "ذكرني بكرة الساعة ٩ الصبح"],
  { noCart: true, noHandover: true, reminder: false, turnMustContain: { 1: "[؟?]" }, turnMustNotContain: { 1: "تم|ضبطت|بذكرك|بذكّرك" } });      // 09:00 = closed: no reminder, ask for another time
S("ps3-postpone-no-reminder-wanted", "reminder", ["ابي بيتزا", "مو الحين، بعدين", "لا مو لازم شكراً"],
  { noCart: true, noHandover: true, reminder: false, turnMustContain: { 1: "اذكرك|أذكّرك|أذكرك" }, turnMustNotContain: { 2: "[؟?]|اذكرك|أذكّرك" } });
S("ps3-english-tomorrow", "reminder", ["Hi", "how much is the zinger supreme crepe?", "ok maybe tomorrow"],
  { noCart: true, noHandover: true, reminder: false, turnMustContain: { 2: "remind" }, mustNotContain: ["good luck"] });
export const PS3 = out;
