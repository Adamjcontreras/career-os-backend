# AI Career OS — Production Monorepo

Mobile-first AI career platform. Local-first core (works with zero AI credits),
with AI as an optional enhancement layer.

```
career-os-production/
├── frontend/     → Next.js app  → deploy on VERCEL
├── backend/      → job proxy    → deploy on RENDER
├── database/     → Supabase SQL (run in Supabase SQL editor)
└── docs/         → architecture, deploy, integration guides
```

## Deploy order

### 1) Database — Supabase
- Create a project at supabase.com.
- Run `database/schema.sql` in the SQL editor.
- Create a **private** Storage bucket named `resumes`.
- Copy your Project URL + anon public key (Settings → API).

### 2) Backend — Render (job proxy)
- New Web Service from the repo, **Root Directory: `backend`**.
- Build: `npm install` · Start: `npm start` · Free tier.
- Env vars (free keys): `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `USAJOBS_API_KEY`, `USAJOBS_EMAIL`.
- Note the URL, e.g. `https://career-os-backend-xxxx.onrender.com`.
- Test: `…/jobs?titles=Product%20Manager&city=Atlanta&state=GA&remote=1` → real JSON.

### 3) Frontend — Vercel
- New Project from the repo, **Root Directory: `frontend`**.
- Env vars (use these EXACT names — Next.js, not Vite):
  - `NEXT_PUBLIC_SUPABASE_URL` = `https://YOUR-PROJECT.supabase.co` (base origin only)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = anon public key
  - `BACKEND_JOB_URL` = your Render URL + `/jobs`
  - `ANTHROPIC_API_KEY` = `sk-ant-...` (OPTIONAL — app works without it)
- Deploy → live at `https://your-app.vercel.app`.

## Architecture notes
- **Jobs**: frontend → `/api/jobs` (server route) → `BACKEND_JOB_URL` (Render proxy).
  Browser never calls job APIs directly. No sample/mock data anywhere.
- **Apply Now**: every job carries a real `applyUrl`; the backend `dedupe()` drops any
  job without a valid http(s) application link, so no card renders without one.
- **AI**: frontend → `/api/ai` (server route) → Anthropic. Key stays server-side.
  Resume parsing, scoring, salary, and job matching all have LOCAL fallbacks and
  never hard-depend on AI.
- **Auth/persistence**: Supabase (email/password). If unconfigured, the app runs in
  a no-auth demo mode rather than failing.

See `docs/` for the full deploy walkthrough and integration details.
