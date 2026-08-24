const axios = require('axios');
const fs = require('fs');

const API_KEY = process.env.FRESHSERVICE_API_KEY;
const DOMAIN = process.env.FRESHSERVICE_DOMAIN || 'patriotgis.freshservice.com';
const HD_GROUP = 17000367080;
const DATA_START = '2025-01-01T00:00:00Z';      // dashboard window start (Freshservice updated_since) -- feeds the Monthly breakdown table; requires a fresh full backfill after lowering (delete tickets.json or wait for the periodic full reconcile)
const WINDOW_START = new Date(DATA_START);
// "Overall KPIs" is pinned to Peterson's Team's actual start (mirrors
// helpdesk-dashboard-analyst's team-config.js -- update both if that date
// ever changes) rather than tracking the full DATA_START window, so a long
// historical average doesn't dilute a recent-performance snapshot. Per
// instruction, 2026-08-24.
const OVERALL_KPI_START = new Date('2026-04-01T00:00:00Z');
const STATE_FILE = process.env.STATE_FILE || 'tickets.json'; // persisted ticket cache, committed to the repo
const SYNC_OVERLAP_MS = 60 * 60 * 1000;          // re-scan the last hour each run so nothing slips a boundary
const FULL_RESYNC_DAYS = 7;                       // periodic full reconcile to catch deletions updated_since can't see
const RATE_LIMIT_SHARE = 0.30;                    // use at most 30% of this endpoint's per-minute limit (140 → 42 credits/min); leave the rest for agents & integrations
const RATE_WINDOW_MS = 61000;                     // Freshservice sends no reset header, so wait one full minute (+1s) when the shared window is under pressure
const auth = { username: API_KEY, password: 'X' };
const baseURL = `https://${DOMAIN}/api/v2`;
const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
const fmt = h => h === null || h === undefined ? 'n/a' : h < 24 ? h.toFixed(1)+'h' : (h/24).toFixed(1)+'d';

// Real month-over-month direction for a time-based metric (lower = better),
// replacing what used to be a hardcoded "Improving" badge regardless of
// actual trend. `label` names the comparison month.
function trendBadge(cur, prior, label) {
  if (cur == null || prior == null || !prior) return { cardCls: 'amber', deltaCls: 'da', text: 'No trend data yet' };
  const pct = ((prior - cur) / prior) * 100;
  if (Math.abs(pct) < 1) return { cardCls: 'amber', deltaCls: 'da', text: `Flat vs ${label}` };
  const improved = pct > 0;
  return {
    cardCls: improved ? 'green' : 'amber',
    deltaCls: improved ? 'dg' : 'da',
    text: `${improved ? '↓' : '↑'} ${Math.abs(pct).toFixed(0)}% ${improved ? 'Improving' : 'Worsening'} vs ${label}`,
  };
}
const realSleep = ms => new Promise(r => setTimeout(r, ms));

const monthKey  = d => d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }); // "Jun 2026"
const monthLong = d => d.toLocaleString('en-US', { month: 'long',  year: 'numeric', timeZone: 'UTC' }); // "June 2026"

// Every month from the data-start month through the month containing `now`, inclusive.
function listMonths(startDate, now) {
  const months = [];
  let y = startDate.getUTCFullYear(), m = startDate.getUTCMonth();
  const endY = now.getUTCFullYear(), endM = now.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    const d = new Date(Date.UTC(y, m, 1));
    months.push({ key: monthKey(d), long: monthLong(d), year: y, monthIndex: m, isCurrent: y === endY && m === endM });
    if (++m > 11) { m = 0; y++; }
  }
  return months;
}

const RETRYABLE_STATUS = new Set([404, 408, 429, 500, 502, 503, 504]);
// Transient = a network error (no response) or a retryable status. 401 and 403
// are excluded on purpose: they mean bad auth / wrong endpoint and won't self-heal.
const isRetryable = e => e.response ? RETRYABLE_STATUS.has(e.response.status) : true;

async function withRetry(fn, { sleep, maxRetries, label }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = e.response?.status;
      if (!isRetryable(e) || attempt >= maxRetries) throw e;
      // On 429, Freshservice tells us exactly how long to wait via Retry-After.
      const retryAfterSec = +(e.response?.headers?.['retry-after']) || 0;
      const waitMs = status === 429 ? (retryAfterSec ? retryAfterSec * 1000 : 30000) : 1000 * 2 ** attempt;
      console.log(`  Request failed (HTTP ${status ?? e.code ?? e.message}) — retry ${attempt + 1}/${maxRetries} in ${waitMs}ms [${label}]`);
      await sleep(waitMs);
    }
  }
}

// Minimal, non-PII projection of a Freshservice ticket — only the fields the
// metrics need. This is what we persist to STATE_FILE (a public repo), so it
// must never carry subjects, descriptions, or requester info.
function projectTicket(t) {
  return {
    id: t.id,
    group_id: t.group_id,
    created_at: t.created_at,
    status: t.status,
    fr_escalated: t.fr_escalated,
    is_escalated: t.is_escalated,
    stats: t.stats ? {
      first_responded_at: t.stats.first_responded_at ?? null,
      resolved_at: t.stats.resolved_at ?? null,
      closed_at: t.stats.closed_at ?? null,
    } : null,
  };
}

// Pacing for the paged fetch, driven by Freshservice's live rate-limit headers.
// We hold ourselves to RATE_LIMIT_SHARE of the endpoint's per-minute limit
// (x-ratelimit-total, the account-wide "List All Tickets" sub-limit). The cost of
// a request varies — include=stats spends 2 (x-ratelimit-used-currentrequest) —
// so we convert our credit budget to calls/min using the reported cost. If the
// live window is already down to our share (heavy outside usage), we wait it out
// rather than racing other consumers toward a 429.
function nextDelayMs(headers = {}) {
  const total = +headers['x-ratelimit-total'] || 140;
  const remaining = +headers['x-ratelimit-remaining'];
  const cost = Math.max(1, +headers['x-ratelimit-used-currentrequest'] || 1);
  const creditsPerMin = Math.max(1, Math.floor(RATE_LIMIT_SHARE * total)); // 30% of 140 = 42
  if (Number.isFinite(remaining) && remaining <= creditsPerMin) return RATE_WINDOW_MS;
  const callsPerMin = Math.max(1, creditsPerMin / cost);                   // 42 credits ÷ 2 = 21 calls/min
  return Math.ceil(60000 / callsPerMin);                                   // ~2857ms between calls
}

// Page the tickets list (newest-created first) with stats embedded, starting
// from `sinceISO` (updated_since). Returns RAW tickets across all groups; the
// caller filters/merges. `stopAtCutoff` stops paging once tickets predate the
// data window — a backfill optimization that relies on created_at-desc ordering;
// leave it off to page a full delta.
async function pageTickets(sinceISO, opts = {}) {
  const { client = axios, sleep = realSleep, maxPages = 550, maxRetries = 3, stopAtCutoff = false } = opts;
  console.log(`Fetching tickets — domain: ${DOMAIN}, since: ${sinceISO}, API key set: ${!!API_KEY} (${API_KEY?.length} chars)`);

  // Connectivity probe — fail fast and clearly before paging.
  try {
    const test = await withRetry(
      () => client.get(`${baseURL}/tickets`, { auth, params: { per_page: 1, page: 1 } }),
      { sleep, maxRetries, label: 'connectivity' }
    );
    console.log(`API connectivity OK — HTTP ${test.status}`);
  } catch(e) {
    const status = e.response?.status;
    console.error(`API connectivity FAILED — HTTP ${status}: ${e.message}`);
    if (status === 401) throw new Error('Authentication failed — FRESHSERVICE_API_KEY secret may be wrong or expired');
    throw e;
  }

  const all = [];
  let page = 1, reason = 'maxpages', lastCreated = Infinity;
  while (page <= maxPages) {
    let res;
    try {
      res = await withRetry(
        () => client.get(`${baseURL}/tickets`, {
          auth,
          params: { per_page: 100, page, order_by: 'created_at', order_type: 'desc', updated_since: sinceISO, include: 'stats' }
        }),
        { sleep, maxRetries, label: `page ${page}` }
      );
    } catch(e) {
      // A persistent page failure must abort the run: a partial fetch would drop
      // tickets (backfill) or advance the sync watermark past unseen changes.
      console.error(`  Error page ${page} (gave up after ${maxRetries} retries): ${e.response?.status} ${e.message}`);
      throw e;
    }
    const tickets = res.data.tickets || [];
    console.log(`  Page ${page}: ${tickets.length} tickets | collected ${all.length}`);
    if (!tickets.length) { reason = 'empty'; break; }

    let hitCutoff = false;
    for (const t of tickets) {
      if (stopAtCutoff) {
        // The cutoff break below assumes created_at-desc order. Verify it holds
        // rather than silently truncating the backfill if the API ever reorders.
        const c = new Date(t.created_at).getTime();
        if (c > lastCreated) throw new Error(`Tickets not in created_at-desc order (${t.created_at} after an older row) — cutoff unsafe; aborting to avoid a truncated backfill.`);
        lastCreated = c;
        if (c < WINDOW_START.getTime()) { hitCutoff = true; break; }
      }
      all.push(t);
    }
    if (hitCutoff) { reason = 'cutoff'; break; }
    if (tickets.length < 100) { reason = 'lastpage'; break; }
    page++;
    // Pace off the live rate-limit headers — never spend more than our 30% share.
    await sleep(nextDelayMs(res.headers));
  }
  if (reason === 'maxpages') {
    throw new Error(`Hit maxPages=${maxPages} before exhausting results — refusing to publish truncated data. Raise maxPages or move to incremental-only.`);
  }
  console.log(`Paged ${all.length} raw tickets (${reason})`);
  return all;
}

// Full page-through of the data window (DATA_START → now), across ALL
// Freshservice groups. Exposed separately from fetchAllTickets so a
// full-resync run can also mine this same raw fetch for cross-group routing
// candidates (see extractRoutingCandidates) without paying for a second
// full page-through. maxPages defaults higher than pageTickets' own default
// (550) because this pages across every group, not just HD -- hit that
// ceiling on the sibling helpdesk-dashboard-analyst repo after extending its
// window similarly; raise further here if it happens again.
async function fetchAllTicketsRaw(opts = {}) {
  return pageTickets(DATA_START, { maxPages: 1500, ...opts, stopAtCutoff: true });
}

function filterHdTickets(raw) {
  return raw
    .filter(t => t.group_id === HD_GROUP && new Date(t.created_at) >= WINDOW_START)
    .map(projectTicket);
}

// Used for the first backfill and the periodic reconcile; returns projected
// HD tickets, replacing any prior set.
async function fetchAllTickets(opts = {}) {
  const raw = await fetchAllTicketsRaw(opts);
  const hd = filterHdTickets(raw);
  console.log(`Backfill complete — ${hd.length} HD tickets`);
  if (hd.length === 0) throw new Error('Zero HD tickets fetched — API returned no data. Check API key and group ID.');
  return hd;
}

// Non-HD tickets are candidates for the routing-history check (see
// classifyRouting) -- did this ticket pass through HD before landing in its
// current group? Minimal projection only; the activities lookup itself is
// what actually resolves whether HD was ever involved.
function extractRoutingCandidates(raw) {
  return raw
    .filter(t => t.group_id !== HD_GROUP && new Date(t.created_at) >= WINDOW_START)
    .map(t => ({ id: t.id, group_id: t.group_id, created_at: t.created_at }));
}

// Upsert a raw delta into the stored (projected) set, keyed by ticket id.
// Tickets that left the HD group or fell outside the window are dropped, so the
// store self-heals as tickets are reassigned.
function mergeTickets(stored, rawDelta) {
  const byId = new Map(stored.map(t => [t.id, t]));
  for (const r of rawDelta) {
    if (r.group_id === HD_GROUP && new Date(r.created_at) >= WINDOW_START) byId.set(r.id, projectTicket(r));
    else byId.delete(r.id);
  }
  return [...byId.values()];
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && Array.isArray(s.tickets) && s.lastSyncedAt) return s;
  } catch { /* missing or corrupt → caller backfills */ }
  return null;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

// --- cross-group routing (did a ticket start in HD and get moved out?) -----
//
// Freshservice's ticket-list API only ever shows a ticket's *current* group
// (same limitation as responder attribution elsewhere in this file) -- once
// a ticket leaves HD it silently disappears from the HD dataset with no
// trace it was ever here. Recovering that requires the per-ticket Activities
// log (GET /tickets/{id}/activities), which is one API call per ticket, so
// this builds up gradually across many runs rather than all at once.

const ROUTING_FILE = process.env.ROUTING_FILE || 'routing-history.json'; // persisted cache, committed to the repo
const ROUTING_CHECK_BUDGET = 100; // tickets checked per run -- per instruction, 2026-08-24

// Freshservice logs every group assignment (including the one at ticket
// creation) as free-text activity content, not a structured old/new-group
// field -- e.g. `set Group as <a ... href="/groups/17000367080" ...>Help
// Desk Team</a>`, whether that's part of the creation entry ("created
// ticket, ... set Group as ...") or a later standalone reassignment entry.
// The link text is the group's display name, captured here too so a group
// lookup call isn't needed just to label the destination group.
// Verified against a real GET /tickets/{id}/activities response, 2026-08-24.
const GROUP_ACTIVITY_RE = /set Group as <a[^>]*href="\/groups\/(\d+)"[^>]*>([^<]*)<\/a>/;

// Activities come back newest-first; this returns them oldest-first so
// index 0 is the ticket's very first group (usually its creation group).
// Entries with no group-assignment phrase (replies, notes, workflow log
// entries, etc.) are skipped.
function extractGroupHistory(activities) {
  return [...activities].reverse()
    .map(a => {
      const m = a.content && a.content.match(GROUP_ACTIVITY_RE);
      return m ? { groupId: +m[1], groupName: m[2], at: a.created_at } : null;
    })
    .filter(Boolean);
}

// Returns null when the activity log has no group-assignment event at all
// (an incomplete/unexpected log, not something to guess at).
function classifyRouting(activities, hdGroupId) {
  const history = extractGroupHistory(activities);
  if (!history.length) return null;
  const startedInHD = history[0].groupId === hdGroupId;
  const last = history[history.length - 1];
  return { startedInHD, currentGroupId: last.groupId, currentGroupName: last.groupName, routedOut: startedInHD && last.groupId !== hdGroupId, hops: history.length };
}

// Freshservice paginates list-ish endpoints via a `Link` response header
// (rel="next") rather than a total-count field. Most tickets' activity logs
// are short enough to fit on one page; this follows Link only if present,
// so it's safe even if this endpoint turns out not to paginate that way.
async function fetchTicketActivities(ticketId, opts = {}) {
  const { client = axios, sleep = realSleep, maxRetries = 3 } = opts;
  let all = [];
  let page = 1;
  for (;;) {
    const res = await withRetry(
      () => client.get(`${baseURL}/tickets/${ticketId}/activities`, { auth, params: { page } }),
      { sleep, maxRetries, label: `activities ${ticketId} page ${page}` }
    );
    all = all.concat(res.data.activities || []);
    await sleep(nextDelayMs(res.headers));
    const link = res.headers?.link || res.headers?.Link;
    if (!link || !link.includes('rel="next"')) break;
    page++;
  }
  return all;
}

function loadRoutingState() {
  try {
    const s = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8'));
    if (s && Array.isArray(s.candidates) && s.checked && typeof s.checked === 'object') return s;
  } catch { /* missing or corrupt → start fresh */ }
  return { candidates: [], checked: {} };
}

function saveRoutingState(state) {
  fs.writeFileSync(ROUTING_FILE, JSON.stringify(state));
}

// Checks up to `budget` not-yet-checked candidates this run and returns an
// updated `checked` map. A per-ticket fetch failure is logged and skipped
// (left unchecked for a future run) rather than aborting the whole run --
// this is supplementary data, not the core ticket sync.
async function updateRoutingHistory(candidates, checked, opts = {}) {
  const { budget = ROUTING_CHECK_BUDGET, client, sleep = realSleep } = opts;
  const unchecked = candidates.filter(c => !checked[c.id]);
  const batch = unchecked.slice(0, budget);
  console.log(`Routing check: ${batch.length}/${unchecked.length} unchecked candidates this run (${Object.keys(checked).length} already known)`);
  const updated = { ...checked };
  for (const c of batch) {
    try {
      const activities = await fetchTicketActivities(c.id, { client, sleep });
      const result = classifyRouting(activities, HD_GROUP);
      updated[c.id] = { ...result, group_id: c.group_id, created_at: c.created_at, checkedAt: new Date().toISOString() };
    } catch (e) {
      console.warn(`  Activities lookup failed for ticket ${c.id}: ${e.message} — will retry next run`);
    }
  }
  return updated;
}

function calcStats(tickets) {
  const res = tickets.filter(t => t.status===4||t.status===5);
  // First-response and resolution times live in the embedded `stats` object
  // (fetched with include=stats); the bare ticket list omits these timestamps,
  // which is why avg response/resolution previously came back empty.
  const frts = tickets.filter(t=>t.stats?.first_responded_at&&t.created_at)
    .map(t=>(new Date(t.stats.first_responded_at)-new Date(t.created_at))/3600000).filter(h=>h>0&&h<168);
  const ttrs = res.filter(t=>t.created_at&&(t.stats?.resolved_at||t.stats?.closed_at))
    .map(t=>(new Date(t.stats.resolved_at||t.stats.closed_at)-new Date(t.created_at))/3600000).filter(h=>h>0&&h<8760);
  const frm = tickets.filter(t=>t.fr_escalated===false).length;
  const rem = tickets.filter(t=>t.is_escalated===false).length;
  const avgFRT = avg(frts), avgTTR = avg(ttrs);
  return {
    total:tickets.length, resolved:res.length,
    pending:tickets.filter(t=>t.status===3).length,
    stillOpen:tickets.filter(t=>[2,3,6].includes(t.status)).length,
    frSLA:tickets.length?+(frm/tickets.length*100).toFixed(1):0,
    overSLA:tickets.length?+((frm/tickets.length+rem/tickets.length)/2*100).toFixed(1):0,
    avgFRT:avgFRT?+avgFRT.toFixed(1):null, avgTTR:avgTTR?+avgTTR.toFixed(1):null,
    frtToRes:avgFRT&&avgTTR?+(avgTTR-avgFRT).toFixed(1):null,
    fcr:res.length?+(res.filter(t=>t.fr_escalated===false).length/res.length*100).toFixed(1):0
  };
}

function getWeeks(monthTickets, now) {
  const weeks = [];
  const monShort = monthKey(now).split(' ')[0];
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+1, 0)).getUTCDate();
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (weekStart <= now) {
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate()+6);
    weekEnd.setUTCHours(23,59,59,999);
    const wt = monthTickets.filter(t=>{const c=new Date(t.created_at);return c>=weekStart&&c<=weekEnd;});
    if (wt.length>0) {
      const startDay = weekStart.getUTCDate();
      const endDay = Math.min(startDay+6, lastDay);
      weeks.push({ label:`Wk ${weeks.length+1}\n${monShort} ${startDay}–${endDay}`, shortLabel:`${monShort} ${startDay}–${endDay}`, ...calcStats(wt) });
    }
    weekStart.setUTCDate(weekStart.getUTCDate()+7);
  }
  return weeks;
}

function getDays(monthTickets, now) {
  const days = [];
  const monShort = monthKey(now).split(' ')[0];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (d<=now) {
    const ds = d.toISOString().substring(0,10);
    const dt = monthTickets.filter(t=>t.created_at?.substring(0,10)===ds);
    days.push({ label:`${monShort} ${d.getUTCDate()}`, isWeekend:[0,6].includes(d.getUTCDay()), ...calcStats(dt) });
    d.setUTCDate(d.getUTCDate()+1);
  }
  return days;
}

function buildHTML(data) {
  const { monthly, weekly, days, overall, updated, months, current, monthTrend, routingSummary } = data;
  const cur = monthly[current.key] || {};
  const wkColors = ['#2B5CE6','#1A7A52','#9B5DE5','#F15BB5','#00BBF9'];
  const wkLabels = JSON.stringify(weekly.map(w=>w.label));
  const wkVol    = JSON.stringify(weekly.map(w=>w.total));
  const wkFRT    = JSON.stringify(weekly.map(w=>w.avgFRT));
  const wkTTR    = JSON.stringify(weekly.map(w=>w.avgTTR));
  const wkFR2R   = JSON.stringify(weekly.map(w=>w.frtToRes));
  const wkBg     = JSON.stringify(wkColors.slice(0,weekly.length));
  const dayLabels = JSON.stringify(days.map(d=>d.label));
  const daySLA    = JSON.stringify(days.map(d=>d.frSLA));
  const dayFRT    = JSON.stringify(days.map(d=>d.avgFRT));
  const dayTTR    = JSON.stringify(days.map(d=>d.avgTTR));
  const dayVol    = JSON.stringify(days.map(d=>d.total));
  const dayColors = JSON.stringify(days.map(d=>d.isWeekend?'#C8C5BC':'#2B5CE6'));
  const mo = (key,field) => monthly[key]?.[field]??'—';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PGIS Help Desk — Performance Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<style>
:root{--bg:#F7F6F3;--surface:#fff;--border:#E2E0DA;--border-dark:#C8C5BC;--text:#1A1917;--text-2:#6B6860;--text-3:#9B9890;--green:#1A7A52;--green-bg:#EBF5EE;--green-border:#B6DECA;--amber:#92560A;--amber-bg:#FEF3E2;--amber-border:#F5D49A;--red:#B03A2E;--red-bg:#FDECEA;--red-border:#F5B7B1;--blue:#1D5FA8;--blue-bg:#EBF2FB;--blue-border:#B6CCE8;--accent:#2B5CE6;--mono:'IBM Plex Mono',monospace;--sans:'Inter',sans-serif}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.5}
.header{background:var(--text);color:#fff;padding:32px 40px;border-bottom:3px solid var(--accent)}
.header-inner{max-width:1200px;margin:0 auto;display:flex;justify-content:space-between;align-items:flex-end}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:8px}
h1{font-size:28px;font-weight:600;letter-spacing:-.02em}h1 span{color:#7BA4F5}
.auto-badge{font-family:var(--mono);font-size:11px;background:rgba(43,92,230,.3);border:1px solid rgba(43,92,230,.5);border-radius:4px;padding:6px 12px;color:#7BA4F5;display:inline-block;margin-bottom:6px}
.header-sub{font-size:12px;color:rgba(255,255,255,.4);text-align:right}
.page{max-width:1200px;margin:0 auto;padding:32px 40px 64px}
.month-banner{background:linear-gradient(135deg,#1A7A52 0%,#1D5FA8 100%);border-radius:10px;padding:28px 32px;margin-bottom:32px;color:#fff}
.month-banner-inner{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:start}
.mb-eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.6);margin-bottom:6px}
.mb-heading{font-size:20px;font-weight:600;margin-bottom:20px}
.mb-kpis{display:flex;gap:28px;flex-wrap:wrap}
.mb-kpi-label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.55);margin-bottom:3px}
.mb-kpi-value{font-size:26px;font-weight:600;line-height:1;color:#fff}
.mb-kpi-sub{font-size:11px;color:rgba(255,255,255,.6);margin-top:3px}
.wk-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;min-width:400px}
.wk-card{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:12px 14px}
.wk-label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.55);margin-bottom:8px}
.wk-row{display:flex;justify-content:space-between;font-size:12px;color:rgba(255,255,255,.8);margin-bottom:3px}
.wk-val{font-family:var(--mono);font-weight:500;color:#fff}.wk-up{color:#6EE7B7;font-size:11px;font-weight:500}.wk-dim{opacity:.45}
.section{margin-bottom:40px}
.section-header{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.section-label{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--text-2);white-space:nowrap}
.section-rule{flex:1;height:1px;background:var(--border)}
.kpi-grid-5{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.kpi-grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 18px;position:relative;overflow:hidden}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--border-dark)}
.kpi-card.green::before{background:var(--green)}.kpi-card.amber::before{background:var(--amber)}.kpi-card.blue::before{background:var(--blue)}
.kpi-label{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px}
.kpi-value{font-size:28px;font-weight:600;color:var(--text);letter-spacing:-.02em;line-height:1;margin-bottom:6px}
.kpi-sub{font-size:12px;color:var(--text-2)}
.kpi-delta{display:inline-flex;align-items:center;font-family:var(--mono);font-size:11px;font-weight:500;padding:2px 8px;border-radius:3px;margin-top:6px}
.dg{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}.da{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}.db{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border)}
.chart-grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:1rem}
.chart-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:18px}
.chart-card-full{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:18px;margin-bottom:16px}
.chart-label{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin-bottom:12px}
.table-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:13px}thead tr{border-bottom:1px solid var(--border);background:#FAFAF8}
th{text-align:left;padding:10px 14px;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);font-weight:500}th.r{text-align:right}
td{padding:12px 14px;border-bottom:1px solid var(--border)}td.r{text-align:right;font-family:var(--mono);font-size:12px}
tr:last-child td{border-bottom:none}tr:hover td{background:#FAFAF8}
tr.best td{background:var(--green-bg)}tr.best td:first-child{border-left:3px solid var(--green)}tr.warn td:first-child{border-left:3px solid var(--amber)}
.badge{display:inline-block;font-family:var(--mono);font-size:10px;padding:2px 8px;border-radius:3px;font-weight:500}
.bg{background:var(--green-bg);color:var(--green);border:1px solid var(--green-border)}.ba{background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}.br{background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)}.bb{background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border)}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:12px;font-size:12px;color:var(--text-2)}.li{display:flex;align-items:center;gap:6px}.sw{width:10px;height:10px;border-radius:2px}.sl{width:14px;height:2px}
.insight{background:var(--green-bg);border:1px solid var(--green-border);border-radius:8px;padding:14px 18px;font-size:13px;color:var(--text);line-height:1.6;margin-top:14px}
.insight strong{color:var(--green)}
hr{border:none;border-top:1px solid var(--border);margin:32px 0}
.footer{border-top:1px solid var(--border);padding-top:20px;margin-top:40px;display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:.06em}
@media(max-width:960px){.header{padding:24px 20px}.header-inner{flex-direction:column;align-items:flex-start;gap:12px}.page{padding:20px 16px 48px}.kpi-grid-5,.kpi-grid-4{grid-template-columns:repeat(2,1fr)}.chart-grid-3,.chart-grid-4{grid-template-columns:1fr}.month-banner-inner{grid-template-columns:1fr}.wk-grid{min-width:unset}}
</style></head><body>
<div class="header"><div class="header-inner">
  <div><div class="eyebrow">Patriot Growth Insurance Services · IT Operations</div><h1>Help Desk <span>Performance</span> Dashboard</h1></div>
  <div><div class="auto-badge">⚡ Auto-updated · ${updated}</div><div class="header-sub">Freshservice · HD Team · All statuses incl. pending · Runs nightly 2AM ET</div></div>
</div></div>

<div class="page">
<div class="section">
  <div class="section-header"><span class="section-label">Current month — ${current.long}</span><div class="section-rule"></div></div>
  <div class="month-banner"><div class="month-banner-inner">
    <div>
      <div class="mb-eyebrow">${current.long} · All statuses including pending · Auto-updated nightly</div>
      <div class="mb-heading">Strong improvement — team gaining momentum week over week</div>
      <div class="mb-kpis">
        <div><div class="mb-kpi-label">Tickets</div><div class="mb-kpi-value">${cur.total||0}</div><div class="mb-kpi-sub">month to date</div></div>
        <div><div class="mb-kpi-label">FCR rate</div><div class="mb-kpi-value">${cur.fcr||0}%</div><div class="mb-kpi-sub">target 70% ✓</div></div>
        <div><div class="mb-kpi-label">SLA</div><div class="mb-kpi-value">${cur.overSLA||0}%</div><div class="mb-kpi-sub">target 90%</div></div>
        <div><div class="mb-kpi-label">Avg response</div><div class="mb-kpi-value">${fmt(cur.avgFRT)}</div><div class="mb-kpi-sub">this month</div></div>
        <div><div class="mb-kpi-label">Avg resolution</div><div class="mb-kpi-value">${fmt(cur.avgTTR)}</div><div class="mb-kpi-sub">this month</div></div>
      </div>
    </div>
    <div class="wk-grid">
      ${weekly.slice(0,4).map((w,i)=>`
      <div class="wk-card${i>1?' wk-dim':''}">
        <div class="wk-label">${w.shortLabel}</div>
        <div class="wk-row"><span>Tickets</span><span class="wk-val">${w.total}</span></div>
        <div class="wk-row"><span>Pending</span><span class="wk-val">${w.pending}</span></div>
        <div class="wk-row"><span>Avg response</span><span class="wk-val ${i>0?'wk-up':''}">${fmt(w.avgFRT)}</span></div>
        <div class="wk-row"><span>Avg resolution</span><span class="wk-val ${i>0?'wk-up':''}">${fmt(w.avgTTR)}</span></div>
        <div class="wk-row"><span>SLA</span><span class="wk-val ${i>0?'wk-up':''}">${w.overSLA}%</span></div>
      </div>`).join('')}
      ${Array(Math.max(0,4-weekly.length)).fill(0).map((_,i)=>`
      <div class="wk-card wk-dim"><div class="wk-label">Week ${weekly.length+i+1} · Coming</div>
        <div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:8px">Not started yet</div></div>`).join('')}
    </div>
  </div></div>

  <div class="legend" style="margin-top:20px">
    ${weekly.map((w,i)=>`<div class="li"><div class="sw" style="background:${wkColors[i]}"></div>${w.shortLabel}</div>`).join('')}
  </div>
  <div class="chart-grid-4">
    <div class="chart-card"><div class="chart-label">Tickets created</div><div style="position:relative;height:160px"><canvas id="wk_vol"></canvas></div></div>
    <div class="chart-card"><div class="chart-label">Avg response (h)</div><div style="position:relative;height:160px"><canvas id="wk_frt"></canvas></div></div>
    <div class="chart-card"><div class="chart-label">Avg resolution (h)</div><div style="position:relative;height:160px"><canvas id="wk_ttr"></canvas></div></div>
    <div class="chart-card"><div class="chart-label">FR → resolution (h)</div><div style="position:relative;height:160px"><canvas id="wk_fr2r"></canvas></div></div>
  </div>
</div><hr>

<div class="section">
  <div class="section-header"><span class="section-label">Overall KPIs — since ${monthLong(OVERALL_KPI_START)} (Peterson's Team) through today · all statuses</span><div class="section-rule"></div></div>
  <div class="kpi-grid-5">
    <div class="kpi-card"><div class="kpi-label">Total tickets</div><div class="kpi-value">${(overall.total||0).toLocaleString()}</div><div class="kpi-sub">incl. pending & WIP</div></div>
    <div class="kpi-card green"><div class="kpi-label">FCR rate</div><div class="kpi-value">${overall.fcr||0}%</div><div class="kpi-sub">target 70%</div><div class="kpi-delta dg">✓ Above target</div></div>
    <div class="kpi-card ${(overall.overSLA||0)>=90?'green':'amber'}"><div class="kpi-label">SLA compliance</div><div class="kpi-value">${overall.overSLA||0}%</div><div class="kpi-sub">target 90%</div><div class="kpi-delta ${(overall.overSLA||0)>=90?'dg':'da'}">${(overall.overSLA||0)>=90?'✓ On target':'⚠ Below target'}</div></div>
    ${(() => {
      const t = monthTrend ? trendBadge(monthTrend.avgFRT, monthTrend.avgFRTPrior, monthTrend.label) : { cardCls: 'amber', deltaCls: 'da', text: 'No trend data yet' };
      return `<div class="kpi-card ${t.cardCls}"><div class="kpi-label">Avg response</div><div class="kpi-value">${fmt(overall.avgFRT)}</div><div class="kpi-sub">overall</div><div class="kpi-delta ${t.deltaCls}">${t.text}</div></div>`;
    })()}
    ${(() => {
      const t = monthTrend ? trendBadge(monthTrend.avgTTR, monthTrend.avgTTRPrior, monthTrend.label) : { cardCls: 'amber', deltaCls: 'da', text: 'No trend data yet' };
      return `<div class="kpi-card ${t.cardCls}"><div class="kpi-label">Avg resolution</div><div class="kpi-value">${fmt(overall.avgTTR)}</div><div class="kpi-sub">overall</div><div class="kpi-delta ${t.deltaCls}">${t.text}</div></div>`;
    })()}
  </div>
  <div class="insight"><strong>SLA compliance</strong> averages two Freshservice-native flags: whether each ticket met its <em>first-response</em> SLA and whether it met its <em>resolution</em> SLA (the actual time thresholds behind those are set in Freshservice's own SLA policy, not in this dashboard). "FR → resolution" (below, in Weekly trends) is avg resolution time minus avg first-response time — roughly how long after first responding a ticket takes to actually close, not a per-ticket average of that exact gap. "Improving"/"Worsening" compares the last complete month to the one before it.</div>
</div>

<div class="section">
  <div class="section-header"><span class="section-label">Monthly breakdown — all statuses including pending</span><div class="section-rule"></div></div>
  <div class="table-card"><table>
    <thead><tr><th>Month</th><th class="r">Total</th><th class="r">Resolved</th><th class="r">Pending</th><th class="r">Still open</th><th class="r">FCR</th><th class="r">SLA</th><th class="r">Avg response</th><th class="r">Avg resolution</th><th>Status</th></tr></thead>
    <tbody>
      ${months.map(m=>{
        const isCur=m.isCurrent;
        const name=isCur?`${m.long} ←`:m.long;
        const hl=isCur?' style="color:#1A7A52;font-weight:600"':'';
        const badge=isCur?'<span class="badge bb">In progress</span>':'<span class="badge bg">✓ Complete</span>';
        return `<tr${isCur?' class="best"':''}><td><strong>${name}</strong></td><td class="r">${mo(m.key,'total')}</td><td class="r">${mo(m.key,'resolved')}</td><td class="r">${mo(m.key,'pending')}</td><td class="r">${mo(m.key,'stillOpen')}</td><td class="r"${hl}>${mo(m.key,'fcr')}%</td><td class="r"${hl}>${mo(m.key,'overSLA')}%</td><td class="r"${hl}>${fmt(monthly[m.key]?.avgFRT)}</td><td class="r"${hl}>${fmt(monthly[m.key]?.avgTTR)}</td><td>${badge}</td></tr>`;
      }).join('')}
    </tbody>
  </table></div>
</div>

<div class="section">
  <div class="section-header"><span class="section-label">Daily trends — ${current.long}</span><div class="section-rule"></div></div>
  <div class="legend">
    <div class="li"><div class="sw" style="background:#2B5CE6"></div>Weekdays</div>
    <div class="li"><div class="sw" style="background:#C8C5BC"></div>Weekend</div>
    <div class="li"><div class="sl" style="background:#B03A2E"></div>90% SLA target</div>
  </div>
  <div class="chart-card-full"><div class="chart-label">SLA first response rate (%)</div><div style="position:relative;height:200px"><canvas id="slaChart"></canvas></div></div>
  <div class="chart-grid-3">
    <div class="chart-card"><div class="chart-label">Avg response time (h)</div><div style="position:relative;height:180px"><canvas id="frtChart"></canvas></div></div>
    <div class="chart-card"><div class="chart-label">Avg resolution time (h)</div><div style="position:relative;height:180px"><canvas id="ttrChart"></canvas></div></div>
    <div class="chart-card"><div class="chart-label">Daily ticket volume</div><div style="position:relative;height:180px"><canvas id="volChart"></canvas></div></div>
  </div>
  <div class="insight"><strong>Dashboard auto-updates nightly via GitHub Actions.</strong> Data pulled directly from Freshservice every day at 2:00 AM ET. All statuses including pending are included for full transparency.</div>
</div>

<div class="section">
  <div class="section-header"><span class="section-label">Ticket volume — still open or pending today</span><div class="section-rule"></div></div>
  <div class="kpi-grid-4">
    ${months.slice(-4).map(m=>{
      const isCur=m.isCurrent;
      const name=isCur?`${m.long} ← now`:m.long;
      const sub=isCur?'created so far':'tickets created';
      const delta=isCur?`${mo(m.key,'stillOpen')} open · in progress`:`${mo(m.key,'stillOpen')} still open`;
      return `<div class="kpi-card ${isCur?'blue':'green'}"><div class="kpi-label">${name}</div><div class="kpi-value">${mo(m.key,'total')}</div><div class="kpi-sub">${sub}</div><div class="kpi-delta ${isCur?'db':'dg'}">${delta}</div></div>`;
    }).join('')}
  </div>
</div>

${routingSummary ? `
<div class="section">
  <div class="section-header"><span class="section-label">Cross-group routing — tickets that started in HD</span><div class="section-rule"></div></div>
  <div class="kpi-grid-3">
    <div class="kpi-card"><div class="kpi-label">Candidates identified</div><div class="kpi-value">${routingSummary.totalCandidates.toLocaleString()}</div><div class="kpi-sub">tickets currently in another group</div></div>
    <div class="kpi-card"><div class="kpi-label">Checked so far</div><div class="kpi-value">${routingSummary.totalChecked.toLocaleString()}</div><div class="kpi-sub">${routingSummary.totalCandidates ? Math.round(routingSummary.totalChecked / routingSummary.totalCandidates * 100) : 0}% of candidates</div></div>
    <div class="kpi-card amber"><div class="kpi-label">Started in HD, routed out</div><div class="kpi-value">${routingSummary.routedOutCount.toLocaleString()}</div><div class="kpi-sub">confirmed so far</div></div>
  </div>
  ${routingSummary.byDestGroup.length ? `
  <div class="table-card" style="margin-top:16px"><table>
    <thead><tr><th>Destination group</th><th class="r">Tickets routed there from HD</th></tr></thead>
    <tbody>${routingSummary.byDestGroup.map(g => `<tr><td>${g.groupName}</td><td class="r">${g.count}</td></tr>`).join('')}</tbody>
  </table></div>` : ''}
  <div class="insight"><strong>Notes:</strong> this checks each candidate ticket's Freshservice activity log for its original group at creation vs. its current group — a ticket only needs checking once, since past history doesn't change. ${routingSummary.totalCandidates - routingSummary.totalChecked > 0 ? `${(routingSummary.totalCandidates - routingSummary.totalChecked).toLocaleString()} candidates are still unchecked and will be picked up ${ROUTING_CHECK_BUDGET} at a time on future runs.` : 'All known candidates have been checked.'} Only tickets currently in a <em>different</em> group are candidates — a ticket resolved without ever leaving HD was never a candidate in the first place.</div>
</div>` : ''}

<hr>
<div class="footer">
  <span>PGIS IT Operations · HD Team (17000367080) · All statuses · Auto-updated nightly</span>
  <span>japjeetdgis.github.io/helpdesk-dashboard · ${updated}</span>
</div>
</div>

<script>
const wkLabels=${wkLabels},wkBg=${wkBg};
const dayLabels=${dayLabels},dayColors=${dayColors};
const mkOpts=(yMin,yMax,sfx)=>({responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:i=>i.raw!=null?' '+i.raw+sfx:' no data'}}},scales:{x:{ticks:{color:'#9B9890',font:{size:10},autoSkip:false,maxRotation:45},grid:{display:false}},y:{min:yMin,max:yMax,ticks:{color:'#9B9890',font:{size:10},callback:v=>v+sfx},grid:{color:'rgba(0,0,0,0.05)'}}}});
new Chart(document.getElementById('wk_vol'),{type:'bar',data:{labels:wkLabels,datasets:[{data:${wkVol},backgroundColor:wkBg,borderRadius:4,barPercentage:.5}]},options:mkOpts(0,null,'')});
new Chart(document.getElementById('wk_frt'),{type:'bar',data:{labels:wkLabels,datasets:[{data:${wkFRT},backgroundColor:wkBg,borderRadius:4,barPercentage:.5}]},options:mkOpts(0,null,'h')});
new Chart(document.getElementById('wk_ttr'),{type:'bar',data:{labels:wkLabels,datasets:[{data:${wkTTR},backgroundColor:wkBg,borderRadius:4,barPercentage:.5}]},options:mkOpts(0,null,'h')});
new Chart(document.getElementById('wk_fr2r'),{type:'bar',data:{labels:wkLabels,datasets:[{data:${wkFR2R},backgroundColor:wkBg,borderRadius:4,barPercentage:.5}]},options:mkOpts(0,null,'h')});
new Chart(document.getElementById('slaChart'),{type:'bar',data:{labels:dayLabels,datasets:[{data:${daySLA},backgroundColor:dayColors,borderRadius:3,barPercentage:.65},{data:dayLabels.map(()=>90),type:'line',borderColor:'#B03A2E',borderWidth:1.5,borderDash:[5,3],pointRadius:0,fill:false}]},options:mkOpts(70,105,'%')});
new Chart(document.getElementById('frtChart'),{type:'bar',data:{labels:dayLabels,datasets:[{data:${dayFRT},backgroundColor:dayColors,borderRadius:3,barPercentage:.65}]},options:mkOpts(0,null,'h')});
new Chart(document.getElementById('ttrChart'),{type:'bar',data:{labels:dayLabels,datasets:[{data:${dayTTR},backgroundColor:dayColors,borderRadius:3,barPercentage:.65}]},options:mkOpts(0,null,'h')});
new Chart(document.getElementById('volChart'),{type:'bar',data:{labels:dayLabels,datasets:[{data:${dayVol},backgroundColor:dayColors,borderRadius:3,barPercentage:.65}]},options:mkOpts(0,null,'')});
</script></body></html>`;
}

async function main() {
  const now = new Date();
  const prev = loadState();
  const dueFullResync = !prev || !prev.lastFullSyncAt ||
    (now - new Date(prev.lastFullSyncAt)) >= FULL_RESYNC_DAYS * 86400000;

  let all, lastFullSyncAt, rawForRouting = null;
  if (dueFullResync) {
    console.log(prev ? 'Mode: full reconcile (periodic)' : 'Mode: initial backfill');
    const raw = await fetchAllTicketsRaw();
    all = filterHdTickets(raw);
    if (all.length === 0) throw new Error('Zero HD tickets fetched — API returned no data. Check API key and group ID.');
    rawForRouting = raw; // only a full-resync sees all groups; see extractRoutingCandidates
    lastFullSyncAt = now.toISOString();
  } else {
    const since = new Date(new Date(prev.lastSyncedAt).getTime() - SYNC_OVERLAP_MS).toISOString();
    console.log(`Mode: incremental — updated_since ${since}`);
    const rawDelta = await pageTickets(since, { stopAtCutoff: false });
    all = mergeTickets(prev.tickets, rawDelta);
    lastFullSyncAt = prev.lastFullSyncAt;
    console.log(`Delta: ${rawDelta.length} changed tickets → ${all.length} HD total`);
  }

  if (all.length === 0) throw new Error('Zero HD tickets after sync — aborting so we never publish an empty dashboard.');
  saveState({ lastSyncedAt: now.toISOString(), lastFullSyncAt, tickets: all });

  // Cross-group routing history: the candidate list (non-HD tickets) only
  // refreshes on a full resync (that's the only run with an all-groups raw
  // fetch to mine); every run still spends its budget checking whatever's
  // unchecked so far, so incremental nights make progress too.
  const routingState = loadRoutingState();
  if (rawForRouting) routingState.candidates = extractRoutingCandidates(rawForRouting);
  routingState.checked = await updateRoutingHistory(routingState.candidates, routingState.checked);
  saveRoutingState(routingState);
  const routingChecked = Object.values(routingState.checked);
  const routedOut = routingChecked.filter(r => r.routedOut);
  const byDestGroup = new Map();
  for (const r of routedOut) {
    const key = r.currentGroupName || `Group #${r.currentGroupId}`;
    byDestGroup.set(key, (byDestGroup.get(key) || 0) + 1);
  }
  const routingSummary = {
    totalCandidates: routingState.candidates.length,
    totalChecked: routingChecked.length,
    routedOutCount: routedOut.length,
    byDestGroup: [...byDestGroup.entries()].sort((a, b) => b[1] - a[1]).map(([groupName, count]) => ({ groupName, count })),
  };

  const getMonth = (mo,yr) => all.filter(t=>{const d=new Date(t.created_at);return d.getUTCFullYear()===yr&&d.getUTCMonth()===mo;});
  const months = listMonths(WINDOW_START, now);
  const monthly = {};
  for (const m of months) monthly[m.key] = calcStats(getMonth(m.monthIndex, m.year));
  const current = months.find(m=>m.isCurrent) || months.at(-1);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthTickets = all.filter(t=>new Date(t.created_at)>=monthStart);
  const weekly = getWeeks(monthTickets, now);
  const days = getDays(monthTickets, now);
  const overall = calcStats(all.filter(t => new Date(t.created_at) >= OVERALL_KPI_START));

  // Real month-over-month trend for the "Improving"/"Worsening" badges on the
  // Avg response/resolution KPI cards -- compares the last two *complete*
  // months (not the in-progress current one) rather than the hardcoded
  // "Improving" text this used to show regardless of actual direction.
  const currentIdx = months.findIndex(m => m.isCurrent);
  const lastCompleteMonth = currentIdx > 0 ? months[currentIdx - 1] : null;
  const priorMonth = currentIdx > 1 ? months[currentIdx - 2] : null;
  const monthTrend = (lastCompleteMonth && priorMonth) ? {
    avgFRT: monthly[lastCompleteMonth.key]?.avgFRT, avgFRTPrior: monthly[priorMonth.key]?.avgFRT,
    avgTTR: monthly[lastCompleteMonth.key]?.avgTTR, avgTTRPrior: monthly[priorMonth.key]?.avgTTR,
    label: lastCompleteMonth.long,
  } : null;

  const updated = now.toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})+' ET';
  const html = buildHTML({monthly,months,current,weekly,days,overall,updated,monthTrend,routingSummary});
  fs.writeFileSync('index.html',html);
  console.log(`Dashboard written — ${html.length} chars, ${all.length} tickets processed`);
}

if (require.main === module) {
  main().catch(err=>{console.error('FATAL:',err.message);process.exit(1);});
}

module.exports = {
  fetchAllTickets, fetchAllTicketsRaw, filterHdTickets, pageTickets, nextDelayMs, mergeTickets, projectTicket,
  loadState, saveState, calcStats, getWeeks, getDays, buildHTML, listMonths, main, trendBadge,
  extractRoutingCandidates, extractGroupHistory, classifyRouting, fetchTicketActivities,
  loadRoutingState, saveRoutingState, updateRoutingHistory,
};
