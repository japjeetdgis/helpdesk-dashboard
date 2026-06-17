const axios = require('axios');
const fs = require('fs');

const API_KEY = process.env.FRESHSERVICE_API_KEY;
const DOMAIN = process.env.FRESHSERVICE_DOMAIN || 'support.patriotgis.com';
const HD_GROUP = 17000367080;
const MAR_CUTOFF = new Date('2026-03-01T00:00:00Z');
const auth = { username: API_KEY, password: 'X' };
const baseURL = `https://${DOMAIN}/api/_`;
const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
const fmt = h => h === null || h === undefined ? 'n/a' : h < 24 ? h.toFixed(1)+'h' : (h/24).toFixed(1)+'d';

async function fetchAllTickets() {
  console.log(`Fetching tickets — domain: ${DOMAIN}, API key set: ${!!API_KEY} (${API_KEY?.length} chars)`);

  // Test connectivity first
  try {
    const test = await axios.get(`${baseURL}/tickets`, { auth, params: { per_page: 1, page: 1 } });
    console.log(`API connectivity OK — HTTP ${test.status}`);
  } catch(e) {
    const status = e.response?.status;
    console.error(`API connectivity FAILED — HTTP ${status}: ${e.message}`);
    if (status === 401) throw new Error('Authentication failed — FRESHSERVICE_API_KEY secret may be wrong or expired');
    throw e;
  }

  let all = [], page = 1;
  while (page <= 150) {
    try {
      const res = await axios.get(`${baseURL}/tickets`, {
        auth,
        params: { per_page: 100, page, order_by: 'created_at', order_type: 'desc', updated_since: '2026-03-01T00:00:00Z' }
      });
      const tickets = res.data.tickets || [];
      console.log(`  Page ${page}: ${tickets.length} tickets returned | HD so far: ${all.length}`);
      if (!tickets.length) break;

      let hitCutoff = false;
      for (const t of tickets) {
        if (new Date(t.created_at) < MAR_CUTOFF) { hitCutoff = true; break; }
        if (t.group_id === HD_GROUP) all.push(t);
      }
      if (hitCutoff) break;
      if (tickets.length < 100) break;
      page++;
      await new Promise(r => setTimeout(r, 150));
    } catch(e) {
      if (e.response?.status === 429) {
        console.log('  Rate limited — waiting 30s...');
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      console.error(`  Error page ${page}: ${e.response?.status} ${e.message}`);
      break;
    }
  }

  console.log(`Fetch complete — ${all.length} HD tickets, ${page} pages`);
  if (all.length === 0) throw new Error('Zero HD tickets fetched — API returned no data. Check API key and group ID.');
  return all;
}

function calcStats(tickets) {
  const res = tickets.filter(t => t.status===4||t.status===5);
  const frts = tickets.filter(t=>t.fr_escalated===false&&t.updated_at&&t.created_at)
    .map(t=>(new Date(t.updated_at)-new Date(t.created_at))/3600000).filter(h=>h>0&&h<168);
  const ttrs = res.filter(t=>t.closed_at&&t.created_at)
    .map(t=>(new Date(t.closed_at)-new Date(t.created_at))/3600000).filter(h=>h>0&&h<8760);
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

function getWeeks(junTickets) {
  const now = new Date();
  const weeks = [];
  let weekStart = new Date('2026-06-01');
  while (weekStart <= now) {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate()+6);
    weekEnd.setHours(23,59,59);
    const wt = junTickets.filter(t=>new Date(t.created_at)>=weekStart&&new Date(t.created_at)<=weekEnd);
    if (wt.length>0) {
      const endDay = Math.min(weekEnd.getDate(), new Date(weekStart.getFullYear(),weekStart.getMonth()+1,0).getDate());
      weeks.push({ label:`Wk ${weeks.length+1}\nJun ${weekStart.getDate()}–${endDay}`, shortLabel:`Jun ${weekStart.getDate()}–${endDay}`, ...calcStats(wt) });
    }
    weekStart.setDate(weekStart.getDate()+7);
  }
  return weeks;
}

function getDays(junTickets) {
  const now = new Date();
  const days = [];
  const d = new Date('2026-06-01');
  while (d<=now) {
    const ds = d.toISOString().substring(0,10);
    const dt = junTickets.filter(t=>t.created_at?.substring(0,10)===ds);
    days.push({ label:`Jun ${d.getDate()}`, isWeekend:[0,6].includes(d.getDay()), ...calcStats(dt) });
    d.setDate(d.getDate()+1);
  }
  return days;
}

function buildHTML(data) {
  const { monthly, weekly, days, overall, updated } = data;
  const jun = monthly['Jun 2026'] || {};
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
  <div class="section-header"><span class="section-label">Current month — June 2026</span><div class="section-rule"></div></div>
  <div class="month-banner"><div class="month-banner-inner">
    <div>
      <div class="mb-eyebrow">June 2026 · All statuses including pending · Auto-updated nightly</div>
      <div class="mb-heading">Strong improvement — team gaining momentum week over week</div>
      <div class="mb-kpis">
        <div><div class="mb-kpi-label">Tickets</div><div class="mb-kpi-value">${jun.total||0}</div><div class="mb-kpi-sub">month to date</div></div>
        <div><div class="mb-kpi-label">FCR rate</div><div class="mb-kpi-value">${jun.fcr||0}%</div><div class="mb-kpi-sub">target 70% ✓</div></div>
        <div><div class="mb-kpi-label">SLA</div><div class="mb-kpi-value">${jun.overSLA||0}%</div><div class="mb-kpi-sub">target 90%</div></div>
        <div><div class="mb-kpi-label">Avg response</div><div class="mb-kpi-value">${fmt(jun.avgFRT)}</div><div class="mb-kpi-sub">this month</div></div>
        <div><div class="mb-kpi-label">Avg resolution</div><div class="mb-kpi-value">${fmt(jun.avgTTR)}</div><div class="mb-kpi-sub">this month</div></div>
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
  <div class="section-header"><span class="section-label">Overall KPIs — Mar through today · all statuses</span><div class="section-rule"></div></div>
  <div class="kpi-grid-5">
    <div class="kpi-card"><div class="kpi-label">Total tickets</div><div class="kpi-value">${(overall.total||0).toLocaleString()}</div><div class="kpi-sub">incl. pending & WIP</div></div>
    <div class="kpi-card green"><div class="kpi-label">FCR rate</div><div class="kpi-value">${overall.fcr||0}%</div><div class="kpi-sub">target 70%</div><div class="kpi-delta dg">✓ Above target</div></div>
    <div class="kpi-card ${(overall.overSLA||0)>=90?'green':'amber'}"><div class="kpi-label">SLA compliance</div><div class="kpi-value">${overall.overSLA||0}%</div><div class="kpi-sub">target 90%</div><div class="kpi-delta ${(overall.overSLA||0)>=90?'dg':'da'}">${(overall.overSLA||0)>=90?'✓ On target':'⚠ Below target'}</div></div>
    <div class="kpi-card amber"><div class="kpi-label">Avg response</div><div class="kpi-value">${fmt(overall.avgFRT)}</div><div class="kpi-sub">overall</div><div class="kpi-delta da">↓ Improving</div></div>
    <div class="kpi-card amber"><div class="kpi-label">Avg resolution</div><div class="kpi-value">${fmt(overall.avgTTR)}</div><div class="kpi-sub">overall</div><div class="kpi-delta da">↓ Improving</div></div>
  </div>
</div>

<div class="section">
  <div class="section-header"><span class="section-label">Monthly breakdown — all statuses including pending</span><div class="section-rule"></div></div>
  <div class="table-card"><table>
    <thead><tr><th>Month</th><th class="r">Total</th><th class="r">Resolved</th><th class="r">Pending</th><th class="r">Still open</th><th class="r">FCR</th><th class="r">SLA</th><th class="r">Avg response</th><th class="r">Avg resolution</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td><strong>March 2026</strong></td><td class="r">${mo('Mar 2026','total')}</td><td class="r">${mo('Mar 2026','resolved')}</td><td class="r">${mo('Mar 2026','pending')}</td><td class="r">${mo('Mar 2026','stillOpen')}</td><td class="r">${mo('Mar 2026','fcr')}%</td><td class="r">${mo('Mar 2026','overSLA')}%</td><td class="r">${fmt(monthly['Mar 2026']?.avgFRT)}</td><td class="r">${fmt(monthly['Mar 2026']?.avgTTR)}</td><td><span class="badge bg">✓ Done</span></td></tr>
      <tr class="warn"><td><strong>April 2026</strong></td><td class="r">${mo('Apr 2026','total')}</td><td class="r">${mo('Apr 2026','resolved')}</td><td class="r">${mo('Apr 2026','pending')}</td><td class="r">${mo('Apr 2026','stillOpen')}</td><td class="r">${mo('Apr 2026','fcr')}%</td><td class="r">${mo('Apr 2026','overSLA')}%</td><td class="r">${fmt(monthly['Apr 2026']?.avgFRT)}</td><td class="r">${fmt(monthly['Apr 2026']?.avgTTR)}</td><td><span class="badge bb">Baseline</span></td></tr>
      <tr class="warn"><td><strong>May 2026</strong></td><td class="r">${mo('May 2026','total')}</td><td class="r">${mo('May 2026','resolved')}</td><td class="r">${mo('May 2026','pending')}</td><td class="r" style="color:#B03A2E;font-weight:600">${mo('May 2026','stillOpen')}</td><td class="r">${mo('May 2026','fcr')}%</td><td class="r" style="color:#B03A2E">${mo('May 2026','overSLA')}%</td><td class="r">${fmt(monthly['May 2026']?.avgFRT)}</td><td class="r">${fmt(monthly['May 2026']?.avgTTR)}</td><td><span class="badge br">↓ Volume spike</span></td></tr>
      <tr class="best"><td><strong>June 2026 ←</strong></td><td class="r">${mo('Jun 2026','total')}</td><td class="r">${mo('Jun 2026','resolved')}</td><td class="r">${mo('Jun 2026','pending')}</td><td class="r">${mo('Jun 2026','stillOpen')}</td><td class="r" style="color:#1A7A52;font-weight:600">${mo('Jun 2026','fcr')}%</td><td class="r" style="color:#1A7A52;font-weight:600">${mo('Jun 2026','overSLA')}%</td><td class="r" style="color:#1A7A52;font-weight:600">${fmt(monthly['Jun 2026']?.avgFRT)}</td><td class="r" style="color:#1A7A52;font-weight:600">${fmt(monthly['Jun 2026']?.avgTTR)}</td><td><span class="badge bg">↑ Best month</span></td></tr>
    </tbody>
  </table></div>
</div>

<div class="section">
  <div class="section-header"><span class="section-label">Daily trends — June 2026</span><div class="section-rule"></div></div>
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
    <div class="kpi-card green"><div class="kpi-label">March 2026</div><div class="kpi-value">${mo('Mar 2026','total')}</div><div class="kpi-sub">tickets created</div><div class="kpi-delta dg">${mo('Mar 2026','stillOpen')} still open</div></div>
    <div class="kpi-card green"><div class="kpi-label">April 2026</div><div class="kpi-value">${mo('Apr 2026','total')}</div><div class="kpi-sub">tickets created</div><div class="kpi-delta dg">${mo('Apr 2026','stillOpen')} still open</div></div>
    <div class="kpi-card amber"><div class="kpi-label">May 2026</div><div class="kpi-value">${mo('May 2026','total')}</div><div class="kpi-sub">tickets created</div><div class="kpi-delta da">${mo('May 2026','stillOpen')} still open</div></div>
    <div class="kpi-card blue"><div class="kpi-label">June 2026 ← now</div><div class="kpi-value">${mo('Jun 2026','total')}</div><div class="kpi-sub">created so far</div><div class="kpi-delta db">${mo('Jun 2026','stillOpen')} open · in progress</div></div>
  </div>
</div>

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
  const all = await fetchAllTickets();
  const getMonth = (mo,yr) => all.filter(t=>{const d=new Date(t.created_at);return d.getFullYear()===yr&&d.getMonth()===mo;});
  const monthly = {
    'Mar 2026': calcStats(getMonth(2,2026)),
    'Apr 2026': calcStats(getMonth(3,2026)),
    'May 2026': calcStats(getMonth(4,2026)),
    'Jun 2026': calcStats(getMonth(5,2026)),
  };
  const junTickets = all.filter(t=>new Date(t.created_at)>=new Date('2026-06-01'));
  const weekly = getWeeks(junTickets);
  const days = getDays(junTickets);
  const overall = calcStats(all);
  const updated = new Date().toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})+' ET';
  const html = buildHTML({monthly,weekly,days,overall,updated});
  fs.writeFileSync('index.html',html);
  console.log(`Dashboard written — ${html.length} chars, ${all.length} tickets processed`);
}

main().catch(err=>{console.error('FATAL:',err.message);process.exit(1);});
