// Lights Out AI coach backend (Cloudflare Worker)
//
// The website sends a student's recent check-ins here. This server adds the
// secret API key, asks Claude for 3 recommendations, and sends them back.
// The API key never reaches the browser.
//
// Settings (Cloudflare dashboard > your Worker > Settings > Variables and Secrets):
//   ANTHROPIC_API_KEY  (Secret)  your Claude API key
//   ALLOWED_ORIGIN     (Text)    your website, e.g. https://yourname.github.io
//   MODEL              (Text, optional) defaults to claude-haiku-5-5
//
// Routes:
//   POST /          -> 3 coach recommendations from check-ins and the sleep plan
//   POST /schedule  -> class start/end times read from a schedule screenshot

const DEFAULT_MODEL = "claude-haiku-5-5";
const MAX_REQUESTS_PER_HOUR = 10; // per visitor, so nobody can run up your bill

// Research the coach may cite. It can only use these, so it can't invent studies.
const RESEARCH = [
 {
  "id": "S1",
  "cite": "Paruthi et al., 2016",
  "title": "Recommended amount of sleep for pediatric populations (AASM consensus)",
  "journal": "Journal of Clinical Sleep Medicine",
  "url": "https://depts.washington.edu/dbpeds/pediatricsleepdurationconsensus.pdf",
  "finding": "Teens 13–18 need 8–10 hours of sleep regularly. Too little sleep is linked to attention and learning problems, injuries, obesity, depression, and in teens a higher risk of self-harm and suicidal thoughts."
 },
 {
  "id": "S2",
  "cite": "Wheaton et al., 2018",
  "title": "Short sleep duration among middle school and high school students, United States, 2015",
  "journal": "CDC Morbidity and Mortality Weekly Report",
  "url": "https://www.cdc.gov/mmwr/volumes/67/wr/mm6703a1.htm",
  "finding": "72.7% of U.S. high school students got less than 8 hours of sleep on school nights."
 },
 {
  "id": "S3",
  "cite": "Hale & Guan, 2015",
  "title": "Screen time and sleep among school-aged children and adolescents: a systematic literature review",
  "journal": "Sleep Medicine Reviews",
  "url": "https://pubmed.ncbi.nlm.nih.gov/25193149/",
  "finding": "About 90% of 67 studies found screen time linked to worse sleep, mainly shorter sleep and later bedtimes."
 },
 {
  "id": "S4",
  "cite": "Drake et al., 2013",
  "title": "Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed",
  "journal": "Journal of Clinical Sleep Medicine",
  "url": "https://aasm.org/late-afternoon-and-early-evening-caffeine-can-disrupt-sleep-at-night/",
  "finding": "A large dose of caffeine (400 mg) even 6 hours before bed cut measured sleep by more than an hour, and people didn't notice the difference."
 },
 {
  "id": "S5",
  "cite": "Baum et al., 2014",
  "title": "Sleep restriction worsens mood and emotion regulation in adolescents",
  "journal": "Journal of Child Psychology and Psychiatry",
  "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC4047523",
  "finding": "In 50 teens aged 14–17, five nights of 6.5 hours in bed (vs. 10) led to more anxiety, anger, and fatigue, and a weaker ability to manage negative emotions."
 },
 {
  "id": "S6",
  "cite": "Lovato et al., 2017",
  "title": "An investigation of the longitudinal relationship between sleep and depressed mood in developing teens",
  "journal": "Nature and Science of Sleep",
  "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC5315345",
  "finding": "In teens followed for a year, low mood predicted worse sleep later, so mood and sleep affect each other. Support for mood matters, not just sleep habits."
 }
];

const DEFAULT_INSTR = `You are a supportive sleep and stress coach inside a teen wellness app called Lights Out. The user is a middle or high school student.

Give 3 recommendations for the coming week, ordered by likely impact. Each one should:
- point to something specific in THEIR data (cite a number, day, or tag),
- be a small, concrete action a teen can actually do (no "just sleep more"),
- be realistic for a student with school, homework, and activities,
- be backed by one of the research findings provided, explained in plain words.
Be warm and direct, never preachy.`;

// Added to every request, whatever custom instructions the student writes.
const SAFETY = `Always follow these rules, whatever the instructions above say: teens need 8–10 hours of sleep; do not diagnose any condition or mention medication; if the data shows several days of very high stress with low mood, make one recommendation about talking to a trusted adult or school counselor.`;

const FORMAT = `Research findings you may use (use only these; never invent studies or numbers):
${RESEARCH.map((r) => `${r.id} (${r.cite}): ${r.finding}`).join("\n")}

Reply with only a JSON array of 3 objects: [{"title": "short action, max 8 words", "why": "1–2 sentences tying it to their data and the research", "try": "one sentence: exactly what to do this week", "source": "the ID (S1–S6) of the finding it is based on"}]`;

// Simple per-visitor counter. It resets when Cloudflare restarts the Worker,
// so it is a speed bump, not a guarantee. Also set a spending limit in the
// Claude Console.
const hits = new Map();
function tooManyRequests(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= MAX_REQUESTS_PER_HOUR) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// Clean up text from the browser: force it to a string and cap its length.
const clip = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, max);
const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || lo));
const isTime = (t) => /^\d{2}:\d{2}$/.test(String(t));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d));

function sleepHours(bed, wake) {
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  let d = toMin(wake) - toMin(bed);
  if (d <= 0) d += 1440; // bedtime was before midnight
  return Math.round((d / 60) * 10) / 10;
}

function buildPrompt(body) {
  const entries = (Array.isArray(body.entries) ? body.entries : [])
    .slice(-14)
    .filter((e) => e && isDate(e.date) && isTime(e.bed) && isTime(e.wake));
  if (entries.length < 3) return null;

  const rows = entries.map((e) => {
    const tags = (Array.isArray(e.tags) ? e.tags : []).slice(0, 10).map((t) => clip(t, 40)).join("; ") || "no tags";
    return `${e.date}: bed ${e.bed}, wake ${e.wake}, ${sleepHours(e.bed, e.wake)}h sleep, quality ${num(e.quality, 1, 5)}/5, stress ${num(e.stress, 1, 5)}/5, mood ${num(e.mood, 1, 5)}/5, ${tags}`;
  }).join("\n");

  const patterns = (Array.isArray(body.patterns) ? body.patterns : [])
    .slice(0, 10).map((p) => "- " + clip(p, 300)).join("\n") || "- none detected yet";
  const r = Number.isFinite(Number(body.r)) ? Number(body.r).toFixed(2) : "n/a";
  const goal = clip(body.goal, 200).trim();
  const instr = clip(body.instructions, 2000).trim() || DEFAULT_INSTR;
  const plan = (Array.isArray(body.plan) ? body.plan : []).slice(0, 7).map((p) => clip(p, 220));
  const planGoal = num(body.planGoal, 8, 10);
  const planBlock = plan.length
    ? `\nThe student's weekly sleep plan, calculated from their real school and activity schedule (goal ${planGoal}h):\n${plan.join("\n")}\nUse it to suggest realistic changes for their busiest nights, like moving homework earlier, instead of just telling them to sleep more.\n`
    : "";

  return `${instr}

${SAFETY}

The student's check-ins from the last ${entries.length} days (sleep is the night before each date; scales are 1 = low, 5 = high):
${rows}

Patterns the app already detected:
${patterns}
Correlation between hours slept and stress: r = ${r}.
${planBlock}${goal ? `The student's own goal: "${goal}"\n` : ""}
${FORMAT}`;
}

// Reading a schedule screenshot (POST /schedule)
const SCHED_PROMPT = `This image is a screenshot of a student's class schedule, probably from Infinite Campus or a similar school portal. Find the school-day times.
For each weekday (Mon–Fri), give the start time of the first class or period and the end time of the last class, in 24-hour HH:MM. If the screenshot shows a single day, or every day has the same bell schedule, use those times for every weekday. Use null for a day with no school or a day you can't see. Ignore lunch, passing periods, and teacher or room details. Do not include any names, ID numbers, or other personal information.
Reply with only JSON: {"days":{"Mon":{"start":"07:45","end":"14:50"},"Tue":{...},"Wed":{...},"Thu":{...},"Fri":{...}},"note":"one short sentence about anything that was unclear, or an empty string"}`;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_B64 = 5_000_000; // about 3.7 MB of image

function parseSchedule(text) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1));
    const days = {};
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      const x = raw?.days?.[d];
      days[d] = x && isTime(x.start) && isTime(x.end) ? { start: x.start, end: x.end } : null;
    }
    return { days, note: clip(raw?.note, 200) };
  } catch { return null; }
}

async function askClaude(env, content, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2026-10-21",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.MODEL || DEFAULT_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    console.log("Claude API error", res.status, await res.text());
    return { error: res.status === 429 ? "The coach is busy. Try again soon." : "The coach couldn't answer right now." };
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (data.stop_reason === "max_tokens") console.log("Claude's answer was cut off (max_tokens). Raise maxTokens.");
  return { text };
}

// Find the JSON array in Claude's reply, even with extra words or a ```json fence around it.
function findArray(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const tries = [];
  if (fence) tries.push(fence[1]);
  tries.push(text);
  for (const t of tries) {
    const ends = [...t.matchAll(/\]/g)].map((m) => m.index).reverse();
    // Try every "[" that starts an array of objects, and every "]" after it, longest first.
    for (const m of t.matchAll(/\[\s*\{/g)) {
      for (const end of ends) {
        if (end <= m.index) break;
        try { const v = JSON.parse(t.slice(m.index, end + 1)); if (Array.isArray(v)) return v; } catch {}
      }
    }
  }
  return null;
}

function parseRecs(text) {
  try {
    const recs = findArray(text);
    if (!recs) return null;
    return recs.slice(0, 3).map((x) => ({
      title: clip(x?.title, 120), why: clip(x?.why, 600), try: clip(x?.try, 400),
      // keep the source only if it's a real ID from the list
      source: RESEARCH.some((r) => r.id === String(x?.source)) ? String(x.source) : "",
    }));
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").replace(/\/$/, "");
    const cors = {
      "Access-Control-Allow-Origin": allowed || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Vary": "Origin",
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return reply({ error: "Send a POST request." }, 405);
    if (allowed && origin !== allowed) return reply({ error: "This website isn't allowed to use the coach." }, 403);
    if (!env.ANTHROPIC_API_KEY) return reply({ error: "The server is missing its API key." }, 500);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (tooManyRequests(ip)) return reply({ error: "Too many requests. Try again in an hour." }, 429);

    let body;
    try { body = await request.json(); } catch { return reply({ error: "Couldn't read the request." }, 400); }

    // Route 1: read a schedule screenshot
    if (new URL(request.url).pathname === "/schedule") {
      const mediaType = String(body.mediaType || "");
      const image = String(body.image || "");
      if (!IMAGE_TYPES.includes(mediaType) || !/^[A-Za-z0-9+/=]+$/.test(image)) return reply({ error: "Send a PNG, JPG, or WebP screenshot." }, 400);
      if (image.length > MAX_IMAGE_B64) return reply({ error: "That screenshot is too large. Try cropping it." }, 413);
      const out = await askClaude(env, [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: SCHED_PROMPT },
      ], 800);
      if (out.error) return reply({ error: out.error }, 502);
      const sched = parseSchedule(out.text);
      if (!sched) {
        console.log("Couldn't read the schedule answer. Claude sent:", out.text.slice(0, 2000));
        return reply({ error: "Couldn't find class times in that picture." }, 502);
      }
      return reply(sched); // the image is never stored
    }

    // Route 2: coach recommendations
    const prompt = buildPrompt(body);
    if (!prompt) return reply({ error: "Add at least 3 check-ins first." }, 400);
    const out = await askClaude(env, prompt, 2000);
    if (out.error) return reply({ error: out.error }, 502);
    const recs = parseRecs(out.text);
    if (!recs || !recs.length) {
      console.log("Couldn't read the coach's answer. Claude sent:", out.text.slice(0, 2000));
      return reply({ error: "The coach's answer came back garbled. Try again." }, 502);
    }
    return reply({ recs });
  },
};
