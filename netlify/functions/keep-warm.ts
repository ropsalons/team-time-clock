// Keep-warm: every minute, fire a small burst of no-op requests at the hot-path
// functions so several warmed instances stay alive. Incident 2026-10-29: single
// requests were fast (~0.7s) but under concurrency (morning clock-in rush) extra
// requests needed COLD instances that took ~20s and timed out — the app hung on
// "Loading…" and then wrongly showed "No matching employee". Keeping a handful of
// instances hot removes those cold-start stalls. The pings carry no valid auth, so
// each target returns 401 quickly WITHOUT doing DB work — they warm the instance
// (module load + runtime), nothing more. Scheduled; not reachable by users.
const BASE = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://timeclock.example.com';

// Hot path: identity resolution, the clock screen's bootstrap, and punching.
const TARGETS = ['/api/whoami', '/api/clock-bootstrap', '/api/punch'];
// How many instances of each to keep warm (covers a simultaneous clock-in burst).
const WARM_INSTANCES = 4;

export default async (): Promise<Response> => {
  const jobs: Promise<unknown>[] = [];
  for (const path of TARGETS) {
    for (let i = 0; i < WARM_INSTANCES; i++) {
      jobs.push(
        fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer warmup', 'x-warm': '1' },
          body: '{}',
          signal: AbortSignal.timeout(8000),
        }).then((r) => r.status).catch(() => null),
      );
    }
  }
  const results = await Promise.allSettled(jobs);
  const ok = results.filter((r) => r.status === 'fulfilled' && r.value != null).length;
  return new Response(JSON.stringify({ warmed: TARGETS, instances: WARM_INSTANCES, responded: ok, total: jobs.length }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

// Every minute — Netlify's finest supported cadence.
export const config = { schedule: '* * * * *' };
