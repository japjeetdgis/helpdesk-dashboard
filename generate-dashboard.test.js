const { test } = require('node:test');
const assert = require('node:assert');
const { fetchAllTickets, pageTickets, nextDelayMs, mergeTickets, projectTicket, calcStats, buildHTML, getDays, getWeeks, listMonths } = require('./generate-dashboard.js');

const HD_GROUP = 17000367080;
const noSleep = () => Promise.resolve();

// --- test doubles -----------------------------------------------------------

// A fake axios-like client. `responder(url, config, callNo)` returns a response
// object or throws (to simulate an HTTP error). Every call is recorded.
function recordingClient(responder) {
  const calls = [];
  return {
    calls,
    async get(url, config) {
      calls.push({ url, config });
      return responder(url, config, calls.length);
    },
  };
}

const ok = (tickets) => ({ status: 200, data: { tickets }, headers: {} });
const isProbe = (config) => config.params.per_page === 1;

function httpError(status) {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status };
  return e;
}

function ticket(over = {}) {
  return {
    group_id: HD_GROUP,
    created_at: '2026-03-15T10:00:00Z',
    updated_at: '2026-03-15T12:00:00Z',
    status: 2,
    fr_escalated: false,
    is_escalated: false,
    ...over,
  };
}

// --- fetchAllTickets --------------------------------------------------------

test('A. hits the public /api/v2 endpoint, never the internal /api/_', async () => {
  const client = recordingClient(() => ok([ticket()]));
  await fetchAllTickets({ client, sleep: noSleep });
  assert.ok(client.calls.length >= 1, 'should make at least one request');
  for (const c of client.calls) {
    assert.match(c.url, /\/api\/v2\/tickets$/, `unexpected URL: ${c.url}`);
    assert.doesNotMatch(c.url, /\/api\/_\//, `must not use internal endpoint: ${c.url}`);
  }
});

test('A2. requests embedded stats on the page fetch so response/resolution times exist', async () => {
  const client = recordingClient(() => ok([ticket()]));
  await fetchAllTickets({ client, sleep: noSleep });
  const pageCall = client.calls.find((c) => c.config.params.per_page > 1);
  assert.ok(pageCall, 'should make a paged fetch');
  assert.equal(pageCall.config.params.include, 'stats', 'page fetch must request include=stats');
});

test('B. retries transient errors (503 then 404) and then succeeds', async () => {
  let n = 0;
  const client = recordingClient((url, config) => {
    n++;
    if (n === 1) throw httpError(503); // probe attempt 1
    if (n === 2) throw httpError(404); // probe attempt 2
    return ok([ticket()]);             // probe succeeds, then the page
  });
  const all = await fetchAllTickets({ client, sleep: noSleep, maxRetries: 3 });
  assert.equal(all.length, 1);
  assert.ok(n >= 3, 'should have retried before succeeding');
});

test('B2. honors the Retry-After header on 429 instead of the default backoff', async () => {
  const waits = [];
  const recordSleep = (ms) => { waits.push(ms); return Promise.resolve(); };
  let n = 0;
  const client = recordingClient(() => {
    n++;
    if (n === 1) { const e = httpError(429); e.response.headers = { 'retry-after': '7' }; throw e; }
    return ok([ticket()]);
  });
  await fetchAllTickets({ client, sleep: recordSleep, maxRetries: 3 });
  assert.ok(waits.includes(7000), `expected a 7s wait from Retry-After, got ${waits}`);
});

test('C. throws after exhausting retries on persistent transient errors', async () => {
  const client = recordingClient(() => { throw httpError(503); });
  await assert.rejects(fetchAllTickets({ client, sleep: noSleep, maxRetries: 2 }));
});

test('D. fails fast on 403 without retrying', async () => {
  let n = 0;
  const client = recordingClient(() => { n++; throw httpError(403); });
  await assert.rejects(fetchAllTickets({ client, sleep: noSleep, maxRetries: 5 }));
  assert.equal(n, 1, 'a 403 (forbidden) must not be retried');
});

test('D2. fails fast on 401 with an auth-specific message', async () => {
  let n = 0;
  const client = recordingClient(() => { n++; throw httpError(401); });
  await assert.rejects(
    fetchAllTickets({ client, sleep: noSleep, maxRetries: 5 }),
    /Authentication failed/,
  );
  assert.equal(n, 1, 'a 401 must not be retried');
});

test('E. keeps only HD-group tickets and stops at the March cutoff', async () => {
  const page1 = [
    ticket({ id: 1, group_id: HD_GROUP, created_at: '2026-03-20T00:00:00Z' }), // keep
    ticket({ id: 2, group_id: 999,      created_at: '2026-03-19T00:00:00Z' }), // wrong group
    ticket({ id: 3, group_id: HD_GROUP, created_at: '2026-03-18T00:00:00Z' }), // keep
    ticket({ id: 4, group_id: HD_GROUP, created_at: '2026-02-15T00:00:00Z' }), // pre-cutoff -> stop
    ticket({ id: 5, group_id: HD_GROUP, created_at: '2026-02-10T00:00:00Z' }), // never reached
  ];
  const client = recordingClient((url, config) => {
    if (isProbe(config)) return ok([ticket()]);
    if (config.params.page === 1) return ok(page1);
    return ok([]);
  });
  const all = await fetchAllTickets({ client, sleep: noSleep });
  assert.deepEqual(all.map((t) => t.id), [1, 3]);
});

// --- calcStats (characterization: locks current math) -----------------------

test('F. calcStats derives response time from stats.first_responded_at and resolution from stats.resolved_at', () => {
  const tickets = [
    { status: 4, fr_escalated: false, is_escalated: false, created_at: '2026-03-01T00:00:00Z', stats: { first_responded_at: '2026-03-01T02:00:00Z', resolved_at: '2026-03-01T10:00:00Z' } }, // FRT 2h, TTR 10h
    { status: 5, fr_escalated: false, is_escalated: false, created_at: '2026-03-02T00:00:00Z', stats: { first_responded_at: '2026-03-02T04:00:00Z', resolved_at: '2026-03-03T00:00:00Z' } }, // FRT 4h, TTR 24h
    { status: 3, fr_escalated: true,  is_escalated: false, created_at: '2026-03-03T00:00:00Z', stats: { first_responded_at: '2026-03-03T06:00:00Z' } }, // FRT 6h (counted now: not gated on fr_escalated)
    { status: 2, fr_escalated: false, is_escalated: true,  created_at: '2026-03-04T00:00:00Z', stats: { first_responded_at: '2026-03-04T04:00:00Z' } }, // FRT 4h
  ];
  assert.deepEqual(calcStats(tickets), {
    total: 4, resolved: 2, pending: 1, stillOpen: 2,
    frSLA: 75, overSLA: 75, avgFRT: 4, avgTTR: 17, frtToRes: 13, fcr: 100,
  });
});

test('F1. calcStats ignores response/resolution times when stats is absent', () => {
  // A ticket list fetched without include=stats has no timestamps to measure.
  const tickets = [
    { status: 4, fr_escalated: false, is_escalated: false, created_at: '2026-03-01T00:00:00Z', closed_at: '2026-03-01T10:00:00Z' },
  ];
  const s = calcStats(tickets);
  assert.equal(s.avgFRT, null);
  assert.equal(s.avgTTR, null);
});

test('F2. calcStats handles an empty set without dividing by zero', () => {
  assert.deepEqual(calcStats([]), {
    total: 0, resolved: 0, pending: 0, stillOpen: 0,
    frSLA: 0, overSLA: 0, avgFRT: null, avgTTR: null, frtToRes: null, fcr: 0,
  });
});

// --- buildHTML (smoke: must not crash on empty/null data) -------------------

test('G. buildHTML renders a page from empty data without throwing', () => {
  const html = buildHTML({
    monthly: { 'Jun 2026': calcStats([]) },
    months: [{ key: 'Jun 2026', long: 'June 2026', isCurrent: true }],
    current: { key: 'Jun 2026', long: 'June 2026' },
    weekly: [],
    days: [],
    overall: calcStats([]),
    updated: 'Jun 18, 2026, 12:00 PM ET',
  });
  assert.equal(typeof html, 'string');
  assert.match(html, /Help Desk/);
  assert.match(html, /id="slaChart"/);
});

test('G2. buildHTML renders a populated week', () => {
  const week = { label: 'Wk 1', shortLabel: 'Jun 1–7', total: 5, pending: 1, avgFRT: 2, avgTTR: 10, overSLA: 80, frSLA: 80, frtToRes: 8 };
  const html = buildHTML({
    monthly: { 'Jun 2026': calcStats([]) },
    months: [{ key: 'Jun 2026', long: 'June 2026', isCurrent: true }],
    current: { key: 'Jun 2026', long: 'June 2026' },
    weekly: [week],
    days: [],
    overall: calcStats([]),
    updated: 'x',
  });
  assert.match(html, /Jun 1–7/);
});

// --- date-window rollover (PR2): derive the window from "now" ----------------

const dayTicket = (created_at) => ({ created_at, status: 2, fr_escalated: false, is_escalated: false, updated_at: created_at });

test('H. listMonths spans data-start (Mar 2026) through the current month', () => {
  const keys = listMonths(new Date('2026-03-01T00:00:00Z'), new Date('2026-06-18T12:00:00Z')).map(m => m.key);
  assert.deepEqual(keys, ['Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026']);
});

test('H2. listMonths rolls forward into July', () => {
  const months = listMonths(new Date('2026-03-01T00:00:00Z'), new Date('2026-07-15T12:00:00Z'));
  assert.deepEqual(months.map(m => m.key), ['Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026']);
  assert.equal(months.at(-1).long, 'July 2026');
  assert.equal(months.at(-1).isCurrent, true);
  assert.equal(months[0].isCurrent, false);
});

test('H3. listMonths handles the year rollover', () => {
  const keys = listMonths(new Date('2026-03-01T00:00:00Z'), new Date('2027-01-10T12:00:00Z')).map(m => m.key);
  assert.equal(keys[0], 'Mar 2026');
  assert.equal(keys.at(-1), 'Jan 2027');
});

test('I. getDays labels the actual current month, not a hardcoded June', () => {
  const days = getDays([dayTicket('2026-07-03T10:00:00Z')], new Date('2026-07-05T12:00:00Z'));
  assert.equal(days.length, 5);            // Jul 1..5
  assert.equal(days[0].label, 'Jul 1');
  assert.ok(days.every(d => !d.label.includes('Jun')), 'no June labels in July');
});

test('J. getWeeks labels the actual current month', () => {
  const weeks = getWeeks([dayTicket('2026-07-09T10:00:00Z')], new Date('2026-07-15T12:00:00Z'));
  assert.ok(weeks.length >= 1);
  assert.ok(weeks.some(w => w.shortLabel.includes('Jul')), 'a week should be labeled Jul');
  assert.ok(weeks.every(w => !w.shortLabel.includes('Jun')));
});

test('K. buildHTML renders the current month and full history dynamically', () => {
  const monthly = { 'Mar 2026': calcStats([]), 'Jul 2026': calcStats([]) };
  const months = [
    { key: 'Mar 2026', long: 'March 2026', isCurrent: false },
    { key: 'Jul 2026', long: 'July 2026', isCurrent: true },
  ];
  const html = buildHTML({
    monthly, months, current: { key: 'Jul 2026', long: 'July 2026' },
    weekly: [], days: [], overall: calcStats([]), updated: 'Jul 5, 2026, 12:00 PM ET',
  });
  assert.match(html, /Current month — July 2026/);
  assert.match(html, /March 2026/);
  assert.doesNotMatch(html, /Current month — June 2026/);
});

// --- incremental sync -------------------------------------------------------

test('L. projectTicket keeps only the non-PII metric fields', () => {
  const p = projectTicket({
    id: 1, group_id: HD_GROUP, created_at: 'c', status: 2, fr_escalated: false, is_escalated: false,
    subject: 'SECRET', description_text: 'PII', requester_id: 42,
    stats: { first_responded_at: 'a', resolved_at: 'b', closed_at: 'd', agent_responded_at: 'drop' },
  });
  assert.deepEqual(Object.keys(p).sort(), ['created_at', 'fr_escalated', 'group_id', 'id', 'is_escalated', 'stats', 'status']);
  assert.equal(p.subject, undefined);
  assert.equal(p.requester_id, undefined);
  assert.deepEqual(Object.keys(p.stats).sort(), ['closed_at', 'first_responded_at', 'resolved_at']);
});

test('M. mergeTickets upserts changed HD tickets, adds new, drops moved-out and pre-cutoff', () => {
  const stored = [
    projectTicket({ id: 1, group_id: HD_GROUP, created_at: '2026-03-10T00:00:00Z', status: 2, fr_escalated: false, is_escalated: false }),
    projectTicket({ id: 2, group_id: HD_GROUP, created_at: '2026-03-11T00:00:00Z', status: 2, fr_escalated: false, is_escalated: false }),
  ];
  const delta = [
    { id: 1, group_id: HD_GROUP, created_at: '2026-03-10T00:00:00Z', status: 4, fr_escalated: false, is_escalated: false, stats: { first_responded_at: '2026-03-10T01:00:00Z', resolved_at: '2026-03-12T00:00:00Z', closed_at: null } }, // changed → resolved
    { id: 2, group_id: 999, created_at: '2026-03-11T00:00:00Z', status: 2, fr_escalated: false, is_escalated: false }, // moved out of HD → drop
    { id: 3, group_id: HD_GROUP, created_at: '2026-03-15T00:00:00Z', status: 2, fr_escalated: false, is_escalated: false }, // new HD
    { id: 4, group_id: HD_GROUP, created_at: '2026-02-01T00:00:00Z', status: 2, fr_escalated: false, is_escalated: false }, // pre-cutoff → ignore
  ];
  const merged = mergeTickets(stored, delta);
  assert.deepEqual(merged.map(t => t.id).sort((a, b) => a - b), [1, 3]);
  const t1 = merged.find(t => t.id === 1);
  assert.equal(t1.status, 4);                              // upserted in place
  assert.equal(t1.stats.resolved_at, '2026-03-12T00:00:00Z');
});

test('O. nextDelayMs caps throughput at 30% of the live endpoint limit, cost-aware', () => {
  // Enterprise List-All-Tickets limit 140 → 42 credits/min; include=stats costs 2 → 21 calls/min
  assert.equal(nextDelayMs({ 'x-ratelimit-total': '140', 'x-ratelimit-remaining': '138', 'x-ratelimit-used-currentrequest': '2' }), Math.ceil(60000 / 21));
  // a 1-credit call → the full 42 calls/min
  assert.equal(nextDelayMs({ 'x-ratelimit-total': '140', 'x-ratelimit-remaining': '138', 'x-ratelimit-used-currentrequest': '1' }), Math.ceil(60000 / 42));
  // heavy outside usage: remaining at/below our 30% budget → wait out the window
  assert.equal(nextDelayMs({ 'x-ratelimit-total': '140', 'x-ratelimit-remaining': '42', 'x-ratelimit-used-currentrequest': '2' }), 61000);
  // missing headers → assume the 140 limit at cost 1
  assert.equal(nextDelayMs({}), Math.ceil(60000 / 42));
});

test('N. pageTickets(stopAtCutoff=false) pages the whole delta regardless of created_at', async () => {
  const p1 = Array.from({ length: 100 }, (_, i) => ticket({ id: i, created_at: '2026-01-01T00:00:00Z' })); // all pre-cutoff
  const p2 = [ticket({ id: 999, created_at: '2026-05-01T00:00:00Z' })];
  const client = recordingClient((url, config) => {
    if (isProbe(config)) return ok([ticket()]);
    return ok(config.params.page === 1 ? p1 : p2);
  });
  const raw = await pageTickets('2026-04-01T00:00:00Z', { client, sleep: noSleep, stopAtCutoff: false });
  assert.equal(raw.length, 101); // did not stop early on the pre-cutoff page
});

test('P. pageTickets(stopAtCutoff) aborts if results arrive out of created_at-desc order', async () => {
  const outOfOrder = [
    ticket({ id: 1, created_at: '2026-05-10T00:00:00Z' }),
    ticket({ id: 2, created_at: '2026-05-20T00:00:00Z' }), // newer than the previous row → desc order violated
  ];
  const client = recordingClient((url, config) => (isProbe(config) ? ok([ticket()]) : ok(outOfOrder)));
  await assert.rejects(
    pageTickets('2026-03-01T00:00:00Z', { client, sleep: noSleep, stopAtCutoff: true }),
    /created_at-desc order/,
  );
});
