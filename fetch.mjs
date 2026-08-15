// Pulls activities + wellness from intervals.icu and writes data.json.
// Runs on GitHub's servers. Your API key comes from repository secrets,
// so it never appears in any file you commit.

import { writeFileSync } from "node:fs";

const ID = process.env.ICU_ATHLETE_ID;
const KEY = process.env.ICU_API_KEY;

if (!ID || !KEY) {
  console.error("Missing ICU_ATHLETE_ID or ICU_API_KEY. Check your repository secrets.");
  process.exit(1);
}

const BASE = "https://intervals.icu/api/v1/athlete/" + ID;

// intervals.icu uses HTTP Basic auth: username is the literal string API_KEY,
// password is your personal key. A few docs describe a different header, so we
// fall back to that if Basic is rejected.
const basic = "Basic " + Buffer.from("API_KEY:" + KEY).toString("base64");
const alt = "ApiKey API_KEY:" + KEY;

async function get(path) {
  for (const auth of [basic, alt]) {
    const res = await fetch(BASE + path, { headers: { Authorization: auth } });
    if (res.ok) return res.json();
    if (res.status !== 401 && res.status !== 403) {
      throw new Error("Request failed " + res.status + " on " + path + ": " + (await res.text()).slice(0, 300));
    }
  }
  throw new Error("Authentication rejected on " + path + ". Check your athlete ID and API key.");
}

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const oldest = new Date(today);
oldest.setDate(oldest.getDate() - 400);

const range = "?oldest=" + iso(oldest) + "&newest=" + iso(today);

console.log("Fetching activities...");
const rawActivities = await get("/activities" + range);

console.log("Fetching wellness...");
let rawWellness = [];
try {
  rawWellness = await get("/wellness" + range);
} catch (e) {
  console.warn("Wellness fetch failed, continuing without it: " + e.message);
}

// Field names can vary. Each helper tries several spellings and returns
// null rather than guessing, so the dashboard can show a gap honestly.
const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
};

const activities = (Array.isArray(rawActivities) ? rawActivities : [])
  .filter((a) => {
    const t = String(pick(a, "type", "activity_type") || "").toLowerCase();
    return t.includes("run");
  })
  .map((a) => {
    const metres = Number(pick(a, "distance", "icu_distance")) || 0;
    const secs = Number(pick(a, "moving_time", "elapsed_time", "icu_moving_time")) || 0;
    const km = metres / 1000;
    return {
      date: String(pick(a, "start_date_local", "start_date") || "").slice(0, 10),
      name: pick(a, "name"),
      km: Math.round(km * 100) / 100,
      minutes: Math.round((secs / 60) * 10) / 10,
      paceSecPerKm: km > 0.3 ? Math.round(secs / km) : null,
      hr: pick(a, "average_heartrate", "icu_average_hr"),
      maxHr: pick(a, "max_heartrate"),
      load: pick(a, "icu_training_load", "training_load"),
    };
  })
  .filter((a) => a.date && a.km > 0)
  .sort((x, y) => (x.date < y.date ? 1 : -1));

const wellness = (Array.isArray(rawWellness) ? rawWellness : [])
  .map((w) => {
    const sleepSecs = Number(pick(w, "sleepSecs", "sleep_secs")) || null;
    return {
      date: String(pick(w, "id", "date") || "").slice(0, 10),
      rhr: pick(w, "restingHR", "resting_hr"),
      hrv: pick(w, "hrv", "hrvSDNN"),
      ctl: pick(w, "ctl"),
      atl: pick(w, "atl"),
      vo2max: pick(w, "vo2max"),
      sleepHours: sleepSecs ? Math.round((sleepSecs / 3600) * 10) / 10 : null,
    };
  })
  .filter((w) => w.date)
  .sort((x, y) => (x.date < y.date ? 1 : -1));

const out = {
  generated: new Date().toISOString(),
  activities,
  wellness,
  // One untouched record of each, so field-mapping problems are diagnosable.
  sample: {
    activity: rawActivities?.[0] ?? null,
    wellness: rawWellness?.[0] ?? null,
  },
};

writeFileSync("data.json", JSON.stringify(out, null, 1));
console.log("Wrote data.json: " + activities.length + " runs, " + wellness.length + " wellness days.");
