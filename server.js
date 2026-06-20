/**
 * Career OS — Job Aggregation Proxy
 * --------------------------------------------------------------------------
 * Why this exists: browsers (and the artifact sandbox) block direct calls to
 * most job APIs via CORS, and keyed sources (Adzuna, USAJobs) must NEVER expose
 * their keys in client code. This small server fetches from approved/compliant
 * sources, dedupes, normalizes to ONE shape, and returns it to the app.
 *
 * The front-end calls:  GET {JOB_PROXY_URL}?titles=&city=&state=&remote=&radius=
 * and expects:          { jobs: [ <NormalizedJob>, ... ] }
 *
 * NormalizedJob = {
 *   title, company, location, workType,        // "Remote" | "Hybrid" | "On-Site"
 *   salary, description, source, posted, url, applyUrl
 * }
 *
 * Deploy anywhere Node runs (Express shown). Set env vars for keyed sources.
 * Run:  ADZUNA_APP_ID=.. ADZUNA_APP_KEY=.. node career-os-job-proxy.js
 * Then in career-os-v5.jsx set:  const JOB_PROXY_URL = "https://your-host/jobs";
 *
 * COMPLIANCE: only official APIs / public job-board endpoints below.
 * Do NOT add scrapers for LinkedIn/Indeed/etc. — their ToS forbid it. To include
 * LinkedIn/Workday listings, use an official partner feed or the employer's
 * Greenhouse/Lever/Ashby board (added per-company in BOARDS).
 */

const express = require("express");
const app = express();

/* --- CORS so the app (any origin) can call this --- */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* --- per-company public boards (compliant). Add tokens you care about. --- */
const BOARDS = {
  greenhouse: [/* "stripe", "airbnb" */],
  lever: [/* "netflix", "palantir" */],
  ashby: [/* "ramp" */],
};

const strip = (s = "") => s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
const classifyWorkType = (loc = "", remoteFlag) => {
  const l = loc.toLowerCase();
  if (remoteFlag || l.includes("remote")) return "Remote";
  if (l.includes("hybrid")) return "Hybrid";
  return "On-Site";
};

/* ---------- SOURCES ---------- */

// Adzuna (official API, keyed). Free tier available. https://developer.adzuna.com
// JSearch (RapidAPI) — PRIMARY. Aggregates Google for Jobs / LinkedIn / Indeed / etc.
async function jsearch({ titles, city, state, remote }) {
  const key = process.env.JSEARCH_API_KEY;
  if (!key) return [];
  const locPart = remote ? "" : [city, state].filter(Boolean).join(", ");
  const query = `${titles || "jobs"}${locPart ? " in " + locPart : " in United States"}`;
  const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&page=1&num_pages=2&country=us${remote ? "&work_from_home=true" : ""}`;
  const r = await fetch(url, { headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": "jsearch.p.rapidapi.com" } });
  if (!r.ok) throw new Error("jsearch " + r.status);
  const d = await r.json();
  return (d.data || []).map(j => {
    const loc = [j.job_city, j.job_state].filter(Boolean).join(", ") || (j.job_country === "US" ? "United States" : j.job_country || "");
    const min = j.job_min_salary, max = j.job_max_salary;
    return {
      title: j.job_title, company: j.employer_name || "",
      location: j.job_is_remote ? "Remote (US)" : loc,
      workType: j.job_is_remote ? "Remote" : classifyWorkType(loc),
      salary: min ? `$${Math.round(min/1000)}k–$${Math.round((max||min)/1000)}k` : "",
      description: strip(j.job_description || "").slice(0, 500),
      source: "JSearch", posted: (j.job_posted_at_datetime_utc || "").slice(0, 10),
      url: j.job_apply_link, applyUrl: j.job_apply_link,
    };
  });
}

// Active Jobs DB (RapidAPI) — SECONDARY. Large fresh board aggregation.
async function activeJobs({ titles, city, state, remote }) {
  const key = process.env.ACTIVE_JOBS_API_KEY;
  if (!key) return [];
  const locPart = remote ? "" : [city, state].filter(Boolean).join(", ");
  const params = new URLSearchParams({ title_filter: titles || "", location_filter: locPart || "United States", limit: "25" });
  const url = `https://active-jobs-db.p.rapidapi.com/active-ats-24h?${params.toString()}`;
  const r = await fetch(url, { headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": "active-jobs-db.p.rapidapi.com" } });
  if (!r.ok) throw new Error("activejobs " + r.status);
  const d = await r.json();
  const arr = Array.isArray(d) ? d : (d.data || d.jobs || []);
  return arr.map(j => {
    const loc = j.locations_derived?.[0] || j.location || [j.city, j.region].filter(Boolean).join(", ") || "United States";
    const link = j.url || j.apply_url || j.job_url;
    return {
      title: j.title || j.job_title, company: j.organization || j.company || j.employer || "",
      location: loc, workType: /remote/i.test(JSON.stringify(j.remote_derived||j.remote||"")) ? "Remote" : classifyWorkType(loc),
      salary: j.salary_raw ? String(j.salary_raw).slice(0,40) : "",
      description: strip(j.description || j.description_text || "").slice(0, 500),
      source: "ActiveJobs", posted: (j.date_posted || j.date_created || "").slice(0, 10),
      url: link, applyUrl: link,
    };
  }).filter(j => j.title && (j.applyUrl || j.url));
}

async function adzuna({ titles, city, state, salaryMin }) {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return [];
  const what = encodeURIComponent(titles || "");
  const where = encodeURIComponent([city, state].filter(Boolean).join(", "));
  const sal = salaryMin ? `&salary_min=${salaryMin}` : "";
  const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${id}&app_key=${key}&results_per_page=25&what=${what}&where=${where}${sal}&content-type=application/json`;
  const r = await fetch(url); if (!r.ok) throw new Error("adzuna " + r.status);
  const d = await r.json();
  return (d.results || []).map(j => ({
    title: j.title, company: j.company?.display_name || "", location: j.location?.display_name || "",
    workType: classifyWorkType(j.location?.display_name), salary: j.salary_min ? `$${Math.round(j.salary_min/1000)}k–$${Math.round((j.salary_max||j.salary_min)/1000)}k` : "",
    description: strip(j.description).slice(0, 500), source: "Adzuna", posted: (j.created || "").slice(0, 10),
    url: j.redirect_url, applyUrl: j.redirect_url,
  }));
}

// USAJobs (official API, keyed — free). https://developer.usajobs.gov
async function usaJobs({ titles, city, state }) {
  const key = process.env.USAJOBS_API_KEY, email = process.env.USAJOBS_EMAIL;
  if (!key || !email) return [];
  const loc = [city, state].filter(Boolean).join(", ");
  const url = `https://data.usajobs.gov/api/search?Keyword=${encodeURIComponent(titles || "")}${loc ? `&LocationName=${encodeURIComponent(loc)}` : ""}&ResultsPerPage=25`;
  const r = await fetch(url, { headers: { "Authorization-Key": key, "User-Agent": email, "Host": "data.usajobs.gov" } });
  if (!r.ok) throw new Error("usajobs " + r.status);
  const d = await r.json();
  return (d.SearchResult?.SearchResultItems || []).map(it => {
    const j = it.MatchedObjectDescriptor || {};
    const pay = j.PositionRemuneration?.[0];
    return { title: j.PositionTitle, company: j.OrganizationName || "U.S. Government",
      location: (j.PositionLocationDisplay || ""), workType: classifyWorkType(j.PositionLocationDisplay),
      salary: pay ? `$${Math.round(pay.MinimumRange/1000)}k–$${Math.round(pay.MaximumRange/1000)}k` : "",
      description: strip(j.UserArea?.Details?.JobSummary || j.QualificationSummary || "").slice(0, 500),
      source: "USAJobs", posted: (j.PublicationStartDate || "").slice(0, 10),
      url: j.PositionURI, applyUrl: j.ApplyURI?.[0] || j.PositionURI };
  });
}

// Remotive (public, keyless).
async function remotive({ titles }) {
  const r = await fetch(`https://remotive.com/api/remote-jobs?limit=40${titles ? `&search=${encodeURIComponent(titles)}` : ""}`);
  if (!r.ok) throw new Error("remotive " + r.status);
  const d = await r.json();
  return (d.jobs || []).map(j => ({ title: j.title, company: j.company_name, location: j.candidate_required_location || "Remote",
    workType: "Remote", salary: j.salary || "", description: strip(j.description).slice(0, 500),
    source: "Remotive", posted: (j.publication_date || "").slice(0, 10), url: j.url, applyUrl: j.url }));
}

// Arbeitnow (public, keyless).
async function arbeitnow() {
  const r = await fetch("https://www.arbeitnow.com/api/job-board-api"); if (!r.ok) throw new Error("arbeitnow " + r.status);
  const d = await r.json();
  return (d.data || []).slice(0, 40).map(j => ({ title: j.title, company: j.company_name, location: j.location || (j.remote ? "Remote" : ""),
    workType: j.remote ? "Remote" : "On-Site", salary: "", description: strip(j.description).slice(0, 500),
    source: "Arbeitnow", posted: j.created_at ? new Date(j.created_at * 1000).toISOString().slice(0, 10) : "", url: j.url, applyUrl: j.url }));
}

// Greenhouse / Lever / Ashby public boards (per company).
async function greenhouse(token) {
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`); if (!r.ok) throw new Error("gh " + token);
  const d = await r.json();
  return (d.jobs || []).slice(0, 20).map(j => ({ title: j.title, company: token, location: j.location?.name || "",
    workType: classifyWorkType(j.location?.name), salary: "", description: "", source: "Greenhouse",
    posted: (j.updated_at || "").slice(0, 10), url: j.absolute_url, applyUrl: j.absolute_url }));
}
async function lever(token) {
  const r = await fetch(`https://api.lever.co/v0/postings/${token}?mode=json`); if (!r.ok) throw new Error("lever " + token);
  const d = await r.json();
  return (d || []).slice(0, 20).map(j => ({ title: j.text, company: token, location: j.categories?.location || "",
    workType: classifyWorkType(j.categories?.location, /remote/i.test(j.categories?.commitment || "")), salary: "",
    description: strip(j.descriptionPlain || "").slice(0, 500), source: "Lever", posted: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : "",
    url: j.hostedUrl, applyUrl: j.applyUrl || j.hostedUrl }));
}
async function ashby(token) {
  const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${token}`); if (!r.ok) throw new Error("ashby " + token);
  const d = await r.json();
  return (d.jobs || []).slice(0, 20).map(j => ({ title: j.title, company: token, location: j.location || "",
    workType: classifyWorkType(j.location, j.isRemote), salary: "", description: strip(j.descriptionPlain || "").slice(0, 500),
    source: "Ashby", posted: (j.publishedAt || "").slice(0, 10), url: j.jobUrl, applyUrl: j.applyUrl || j.jobUrl }));
}

/* ---------- AGGREGATE + DEDUPE ---------- */
const US_STATES = new Set(("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split(" "));
const FOREIGN = ["germany","berlin","munich","united kingdom"," uk ","london","england","france","paris","spain","madrid","netherlands","amsterdam","ireland","dublin","canada","toronto","australia","sydney","india","bangalore","poland","warsaw","portugal","lisbon","sweden","switzerland","zurich","austria","vienna","italy","rome","belgium","brussels","denmark","norway","finland","singapore","dubai","brazil","europe","emea","apac","gmbh"];
function isUSorRemote(job, remoteSearch) {
  const loc = (job.location || "").toLowerCase();
  const remote = loc.includes("remote") || job.workType === "Remote";
  if (remoteSearch && remote) return true;
  if (FOREIGN.some(h => loc.includes(h))) return false;
  if (/\b(usa|united states|u\.s\.)\b/.test(loc)) return true;
  const m = (job.location || "").match(/,\s*([A-Z]{2})\b/);
  if (m && US_STATES.has(m[1])) return true;
  // unknown/blank location: keep only if it's a remote-flagged role
  return remote;
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    if (!j.title || !j.company) return false;
    // Every job MUST have a real application URL — drop any that don't.
    const link = j.applyUrl || j.url;
    if (!link || !/^https?:\/\//i.test(link)) return false;
    j.applyUrl = link; j.url = j.url || link;
    const k = (j.title + "|" + j.company).toLowerCase().replace(/\s+/g, "");
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

// Simple in-memory cache so the dashboard + repeat searches load fast.
// Keyed by the normalized query; 5-minute TTL. Resets on redeploy (fine for our use).
const JOB_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
function cacheGet(key) {
  const hit = JOB_CACHE.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  if (hit) JOB_CACHE.delete(key);
  return null;
}
function cacheSet(key, v) {
  JOB_CACHE.set(key, { t: Date.now(), v });
  if (JOB_CACHE.size > 200) JOB_CACHE.delete(JOB_CACHE.keys().next().value); // cap size
}

app.get("/jobs", async (req, res) => {
  const allTitles = (req.query.titles || "").split(",").map(s => s.trim()).filter(Boolean);
  const q = {
    titles: allTitles[0] || "",
    titleList: allTitles.slice(0, 4),   // search up to 4 roles, not just the first
    city: req.query.city || "", state: req.query.state || "",
    remote: req.query.remote === "1" || req.query.radius === "remote",
    radius: req.query.radius || "50",
    workType: req.query.workType || "Any",
    salaryTarget: req.query.salaryTarget || "",
    clearance: (req.query.clearance || "").toLowerCase(), // secret|top secret|ts/sci|polygraph|none
    country: (req.query.country || "us").toLowerCase(), // default United States
    skills: (req.query.skills || "").split(",").filter(Boolean),
  };
  const tnum = parseInt(String(q.salaryTarget).replace(/[^0-9]/g, "")) || 0;
  q.salaryMin = tnum ? Math.round((tnum < 1000 ? tnum * 1000 : tnum) * 0.7) : 0;

  // Cache: serve recent identical searches instantly (faster dashboard).
  const cacheKey = JSON.stringify([q.titleList, q.city, q.state, q.remote, q.radius, q.workType, q.clearance, q.country]);
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  // Search each requested title across the keyed sources, then merge.
  // Priority: JSearch (primary) → Active Jobs DB (secondary) → Adzuna (backup) → USAJobs (federal).
  const titlesToSearch = q.titleList.length ? q.titleList : [""];
  const tasks = [
    ...titlesToSearch.map(t => ["JSearch:" + t, () => jsearch({ ...q, titles: t })]),
    ...titlesToSearch.map(t => ["ActiveJobs:" + t, () => activeJobs({ ...q, titles: t })]),
    ...titlesToSearch.map(t => ["Adzuna:" + t, () => adzuna({ ...q, titles: t })]),
    ...titlesToSearch.map(t => ["USAJobs:" + t, () => usaJobs({ ...q, titles: t })]),
    ...(q.remote ? [["Remotive", () => remotive(q)]] : []),
    ...BOARDS.greenhouse.map(t => ["Greenhouse:" + t, () => greenhouse(t)]),
    ...BOARDS.lever.map(t => ["Lever:" + t, () => lever(t)]),
    ...BOARDS.ashby.map(t => ["Ashby:" + t, () => ashby(t)]),
  ];
  const settled = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  let jobs = []; const errSet = new Set();
  settled.forEach((r, i) => { if (r.status === "fulfilled") jobs.push(...r.value); else errSet.add(tasks[i][0].split(":")[0]); });
  const errors = [...errSet];
  // SOURCE PRIORITY for dedupe: keep the higher-priority source's copy of a dup.
  const PRIORITY = { JSearch: 1, ActiveJobs: 2, Adzuna: 3, USAJobs: 4, Greenhouse: 5, Lever: 5, Ashby: 5, Remotive: 6 };
  jobs.sort((a, b) => (PRIORITY[a.source] || 9) - (PRIORITY[b.source] || 9));
  jobs = dedupe(jobs);

  // Server-side US location gate (defense-in-depth; the app also filters).
  if (q.country === "us") {
    jobs = jobs.filter(j => isUSorRemote(j, q.remote));
  }
  // optional work-type filter (Any = no filter)
  if (q.workType && !/any/i.test(q.workType)) {
    const wants = q.workType.toLowerCase();
    jobs = jobs.filter(j => wants.includes((j.workType || "").toLowerCase()) || (j.workType || "").toLowerCase().includes("remote") && wants.includes("remote"));
  }
  // Clearance preference: if the user holds a clearance, surface cleared roles first
  // (don't exclude others — just rank cleared/relevant jobs to the top).
  if (q.clearance && !/^(none|any)$/.test(q.clearance)) {
    const cl = q.clearance;
    const matchesClr = (j) => {
      const t = `${j.title} ${j.description}`.toLowerCase();
      if (cl.includes("ts/sci") || cl.includes("sci")) return /ts\/sci|sci|top secret/.test(t);
      if (cl.includes("top secret")) return /top secret|ts\b/.test(t);
      if (cl.includes("poly")) return /polygraph|poly\b/.test(t);
      if (cl.includes("secret")) return /\bsecret\b|clearance/.test(t);
      return /clearance|cleared/.test(t);
    };
    jobs.sort((a, b) => (matchesClr(b) ? 1 : 0) - (matchesClr(a) ? 1 : 0));
  }
  const payload = { jobs, errors, count: jobs.length, filters: { ...q, titleList: undefined } };
  cacheSet(cacheKey, payload);
  res.json(payload);
});

const BACKEND_VERSION = "v9.1.0-master";
const BACKEND_BUILD_TIME = new Date().toISOString();
// Render exposes the deployed commit as RENDER_GIT_COMMIT.
const BACKEND_COMMIT = process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || "unknown";
app.get("/", (_, res) => res.send("Career OS job proxy is running. GET /jobs?titles=&city=&state=&remote=&radius="));
app.get("/health", (_, res) => res.json({ ok: true, version: BACKEND_VERSION, commit: BACKEND_COMMIT, commitShort: String(BACKEND_COMMIT).slice(0,7), buildTime: BACKEND_BUILD_TIME, time: new Date().toISOString() }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Career OS job proxy listening on :${PORT}`));
