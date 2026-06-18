const { test } = require('node:test');
const assert = require('node:assert');
const { fetchAllTickets, calcStats, buildHTML } = require('./generate-dashboard.js');

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

test('F. calcStats computes the current metric definitions', () => {
  const tickets = [
    { status: 4, fr_escalated: false, is_escalated: false, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T02:00:00Z', closed_at: '2026-03-01T10:00:00Z' }, // FRT 2h, TTR 10h
    { status: 5, fr_escalated: false, is_escalated: false, created_at: '2026-03-02T00:00:00Z', updated_at: '2026-03-02T04:00:00Z', closed_at: '2026-03-03T00:00:00Z' }, // FRT 4h, TTR 24h
    { status: 3, fr_escalated: true,  is_escalated: false, created_at: '2026-03-03T00:00:00Z', updated_at: '2026-03-03T06:00:00Z' },
    { status: 2, fr_escalated: false, is_escalated: true,  created_at: '2026-03-04T00:00:00Z', updated_at: '2026-03-04T03:00:00Z' }, // FRT 3h
  ];
  assert.deepEqual(calcStats(tickets), {
    total: 4, resolved: 2, pending: 1, stillOpen: 2,
    frSLA: 75, overSLA: 75, avgFRT: 3, avgTTR: 17, frtToRes: 14, fcr: 100,
  });
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
    weekly: [week],
    days: [],
    overall: calcStats([]),
    updated: 'x',
  });
  assert.match(html, /Jun 1–7/);
});
