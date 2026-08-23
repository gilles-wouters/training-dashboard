// Pulls activities + wellness from intervals.icu and writes data.json.
// This is a dumb pipe on purpose: it fetches and flattens, it does not
// calculate anything. All the maths lives in index.html, so when you want
// to change a metric you only ever re-upload that one file.

import { writeFileSync } from "node:fs";

const ID = process.env.ICU_ATHLETE_ID;
const KEY = process.env.ICU_API_KEY;

if (!ID || !KEY) {
  console.error("Missing ICU_ATHLETE_ID or ICU_API_KEY. Check your repository secrets.");
  process.exit(1);
}

const BASE = "https://intervals.icu/api/v1/athlete/" + ID;

// intervals.icu uses HTTP Basic auth: username is the literal string API_KEY,
// password is your personal key. Some docs describe a different header, so we
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
oldest.setDate(oldest.getDate() - 500);
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

// Field names vary between activity types and firmware versions. Each helper
// tries several spellings and returns null rather than guessing, so the
// dashboard shows an honest gap instead of a wrong number.
const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const activities = (Array.isArray(rawActivities) ? rawActivities : [])
  .map((a) => {
    const type = String(pick(a, "type", "activity_type") || "");
    const metres = num(pick(a, "distance", "icu_distance")) || 0;
    const secs = num(pick(a, "moving_time", "icu_moving_time", "elapsed_time")) || 0;
    const km = metres / 1000;
    const hr = num(pick(a, "average_heartrate", "icu_average_hr"));

    // Metres travelled per heartbeat. The cleanest single measure of aerobic
    // efficiency: it rises as you get fitter at the same effort.
    const mpb = hr && secs > 0 ? metres / (hr * (secs / 60)) : null;

    // Garmin and Strava disagree about running cadence: some records report
    // one foot (around 85), others both (around 170). Normalise upward so a
    // single chart never mixes the two scales.
    let cadence = num(pick(a, "average_cadence", "average_run_cadence"));
    if (cadence && cadence < 120) cadence *= 2;

    // Stride length in metres. Use the reported value when present, otherwise
    // derive it: distance divided by total steps taken.
    let strideM = num(pick(a, "average_stride_length", "icu_average_stride_length"));
    if (strideM && strideM > 3) strideM /= 100;          // some sources report centimetres
    if (!strideM && cadence && secs > 0 && metres > 0) {
      strideM = metres / (cadence * (secs / 60));
    }

    return {
      date: String(pick(a, "start_date_local", "start_date") || "").slice(0, 10),
      startLocal: pick(a, "start_date_local"),
      type,
      isRun: type.toLowerCase().includes("run"),
      name: pick(a, "name"),
      km: Math.round(km * 100) / 100,
      minutes: Math.round((secs / 60) * 10) / 10,
      paceSecPerKm: km > 0.3 ? Math.round(secs / km) : null,
      hr,
      maxHr: num(pick(a, "max_heartrate")),
      metresPerBeat: mpb ? Math.round(mpb * 1000) / 1000 : null,
      cadence: cadence ? Math.round(cadence * 10) / 10 : null,
      strideM: strideM ? Math.round(strideM * 1000) / 1000 : null,
      elevation: num(pick(a, "total_elevation_gain", "icu_elevation_gain")),
      load: num(pick(a, "icu_training_load", "training_load")),
      // Heart rate drift across the run. Under 5% means the aerobic base is
      // holding. Above 10% means you outran it. Needs stream data, so it is
      // null or zero for activities imported as summaries only.
      decoupling: num(pick(a, "decoupling", "icu_hr_pace_decoupling", "icu_decoupling")),
      rpe: num(pick(a, "perceived_exertion", "icu_rpe")),
      hrZoneSecs: Array.isArray(a?.icu_hr_zone_times) ? a.icu_hr_zone_times : null,
      gear: pick(a?.gear, "name") || pick(a, "gear_id"),
    };
  })
  .filter((a) => a.date && a.km > 0)
  .sort((x, y) => (x.date < y.date ? 1 : -1));

const wellness = (Array.isArray(rawWellness) ? rawWellness : [])
  .map((w) => {
    const sleepSecs = num(pick(w, "sleepSecs", "sleep_secs"));
    return {
      date: String(pick(w, "id", "date") || "").slice(0, 10),
      rhr: num(pick(w, "restingHR", "resting_hr")),
      hrv: num(pick(w, "hrv", "hrvSDNN")),
      ctl: num(pick(w, "ctl")),
      atl: num(pick(w, "atl")),
      vo2max: num(pick(w, "vo2max")),
      weight: num(pick(w, "weight")),
      steps: num(pick(w, "steps")),
      sleepHours: sleepSecs ? Math.round((sleepSecs / 3600) * 100) / 100 : null,
      sleepScore: num(pick(w, "sleepScore", "sleep_score")),
    };
  })
  .filter((w) => w.date)
  .sort((x, y) => (x.date < y.date ? 1 : -1));

const out = {
  generated: new Date().toISOString(),
  counts: { activities: activities.length, wellness: wellness.length },
  activities,
  wellness,
  // One untouched record of each, so field-mapping problems stay diagnosable.
  sample: { activity: rawActivities?.[0] ?? null, wellness: rawWellness?.[0] ?? null },
};

writeFileSync("data.json", JSON.stringify(out));
console.log("Wrote data.json: " + activities.length + " activities, " + wellness.length + " wellness days.");
