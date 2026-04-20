require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = process.env.GHL_BASE || 'https://services.leadconnectorhq.com';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID;
const GHL_API_VERSION = process.env.GHL_API_VERSION || '2021-07-28';
const GHL_CALENDAR_IDS = (process.env.GHL_CALENDAR_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const GHL_QUAL_FIELD_ID = process.env.GHL_QUAL_FIELD_ID || '';
const GHL_QUAL_FIELD_NAME = process.env.GHL_QUAL_FIELD_NAME || 'Qualification Status';
const GHL_QUAL_FIELD_VALUE = process.env.GHL_QUAL_FIELD_VALUE || 'Qualified';
const GHL_PIPELINE_VALUE_STAGE_IDS = (process.env.GHL_PIPELINE_VALUE_STAGE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const GHL_TRIAL_SIGNUP_STAGE_IDS = (process.env.GHL_TRIAL_SIGNUP_STAGE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const GHL_DEMO_EXCLUDE_STAGE_IDS = (process.env.GHL_DEMO_EXCLUDE_STAGE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const COST_BASE = Number(process.env.COST_BASE || 1000);
const COST_BASE_DAILY = Number(process.env.COST_BASE_DAILY || 0);
const COST_BASE_WEEKLY = Number(process.env.COST_BASE_WEEKLY || 0);
const COST_BASE_MONTHLY = Number(process.env.COST_BASE_MONTHLY || 0);
const COSTS_SHEET_URL = process.env.COSTS_SHEET_URL || '';
const COSTS_CACHE_TTL_MS = 5 * 60 * 1000;

if (!GHL_API_KEY || !GHL_LOCATION_ID || !GHL_PIPELINE_ID) {
  console.warn('Missing required GHL env vars. Check .env: GHL_API_KEY, GHL_LOCATION_ID, GHL_PIPELINE_ID');
}

app.use(express.static(__dirname));

app.get('/api/overview', async (req, res) => {
  try {
    const { preset = 'month', start, end } = req.query;
    const { startIso, endIso } = getDateRange(preset, start, end);

    const [events, allOpps] = await Promise.all([
      fetchAllCalendarEvents(startIso, endIso),
      fetchAllOpportunities(),
    ]);

    const opps = filterOppsByCreatedInRange(allOpps, startIso, endIso);

    const qualifiedCompleted = opps.filter(o => {
      const val = getCustomFieldValue(o, GHL_QUAL_FIELD_ID);
      return String(val || '').toLowerCase() === GHL_QUAL_FIELD_VALUE.toLowerCase();
    });

    // Pipeline value should follow period filters by stage movement timing.
    // Use lastStageChangeAt (fallback to updatedAt/createdAt) and sum monetary value.
    const pipelineValueOppsBase = GHL_PIPELINE_VALUE_STAGE_IDS.length
      ? allOpps.filter(o => GHL_PIPELINE_VALUE_STAGE_IDS.includes(String(o.pipelineStageId || '')))
      : allOpps;

    const pipelineValueOpps = pipelineValueOppsBase.filter(o => {
      const stageChangedAt = o.lastStageChangeAt || o.updatedAt || o.createdAt;
      return isInRange(stageChangedAt, startIso, endIso);
    });

    const pipelineValue = pipelineValueOpps.reduce((sum, o) => sum + getMonetaryValue(o), 0);

    // "New Trial Sign-ups" should be stage-entry based, not createdAt based.
    // We count opportunities that are currently in configured trial stages and
    // entered a stage in the selected range via lastStageChangeAt.
    const trialSignupOpps = GHL_TRIAL_SIGNUP_STAGE_IDS.length
      ? allOpps.filter(o => {
        const inTrialStage = GHL_TRIAL_SIGNUP_STAGE_IDS.includes(String(o.pipelineStageId || ''));
        if (!inTrialStage) return false;
        const stageChangedAt = o.lastStageChangeAt || o.updatedAt || o.createdAt;
        return isInRange(stageChangedAt, startIso, endIso);
      })
      : [];

    const oppsByContact = groupOppsByContact(allOpps);
    const excludeStages = new Set(GHL_DEMO_EXCLUDE_STAGE_IDS);
    const demoCompleted = events.filter(e => {
      const opp = matchOpportunityForEvent(e, oppsByContact.get(e.contactId) || []);
      if (!opp) return false;
      return !excludeStages.has(String(opp.pipelineStageId || opp.stageId || ''));
    }).length;

    const trialSignups = new Set(trialSignupOpps.map(o => o.id).filter(Boolean)).size;

    const baseCost = await resolveBaseCost(preset, startIso, endIso);
    const costPerDemo = demoCompleted ? Math.round(baseCost / demoCompleted) : 0;
    const costPerTrial = trialSignups ? Math.round(baseCost / trialSignups) : 0;

    res.json({
      ok: true,
      range: { startIso, endIso },
      data: {
        new_meetings_booked: events.length,
        qualified_completed: qualifiedCompleted.length,
        new_trial_signups: trialSignups,
        cost_per_demo: costPerDemo,
        cost_per_trial_signup: costPerTrial,
        pipeline_value: pipelineValue,
        demos_completed: demoCompleted,
      },
      meta: {
        pipeline_value_stage_ids: GHL_PIPELINE_VALUE_STAGE_IDS,
      },
    });
  } catch (err) {
    console.error('Overview error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/trend', async (req, res) => {
  try {
    const months = Math.max(1, Math.min(12, Number(req.query.months || 6)));
    const { startIso, endIso, labels } = getLastNMonthsRange(months);

    const [events, allOpps] = await Promise.all([
      fetchAllCalendarEvents(startIso, endIso),
      fetchAllOpportunities(),
    ]);

    const meetingBuckets = bucketByMonth(events, startIso, months, e => e.startTime || e.start_time || e.start || e.startDate);
    const trialSignupOpps = GHL_TRIAL_SIGNUP_STAGE_IDS.length
      ? allOpps.filter(o => GHL_TRIAL_SIGNUP_STAGE_IDS.includes(String(o.pipelineStageId || '')))
      : [];
    const signupBuckets = bucketByMonth(trialSignupOpps, startIso, months, o => o.lastStageChangeAt || o.updatedAt || o.createdAt);

    const oppsByContact = groupOppsByContact(allOpps);
    const excludeStages = new Set(GHL_DEMO_EXCLUDE_STAGE_IDS);
    const demoCompletedEvents = events.filter(e => {
      const opp = matchOpportunityForEvent(e, oppsByContact.get(e.contactId) || []);
      if (!opp) return false;
      return !excludeStages.has(String(opp.pipelineStageId || opp.stageId || ''));
    });
    const demoBuckets = bucketByMonth(
      demoCompletedEvents,
      startIso,
      months,
      e => e.startTime || e.start_time || e.start || e.startDate || e.dateAdded
    );

    res.json({
      ok: true,
      range: { startIso, endIso },
      labels,
      meetings: meetingBuckets,
      signups: signupBuckets,
      demos: demoBuckets,
    });
  } catch (err) {
    console.error('Trend error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function authHeaders() {
  return {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Version: GHL_API_VERSION,
    'Content-Type': 'application/json',
  };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL ${res.status}: ${text}`);
  }
  return res.json();
}

function getDateRange(preset, start, end) {
  const now = new Date();
  let s;
  let e;

  if (preset === 'custom' && start && end) {
    s = parseDateBoundary(start, 'start');
    e = parseDateBoundary(end, 'end');
  } else if (preset === 'today') {
    s = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    e = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (preset === 'week') {
    const day = now.getDay() || 7; // Mon=1..Sun=7
    s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day - 1));
    e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6, 23, 59, 59, 999);
  } else if (preset === 'last_month') {
    s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  } else {
    // month
    s = new Date(now.getFullYear(), now.getMonth(), 1);
    e = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  return { startIso: s.toISOString(), endIso: e.toISOString() };
}

function getLastNMonthsRange(n) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const start = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);
  const labels = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    labels.push(d.toLocaleString('en-US', { month: 'short' }) + " '" + String(d.getFullYear()).slice(-2));
  }
  return { startIso: start.toISOString(), endIso: end.toISOString(), labels };
}

function bucketByMonth(items, startIso, months, dateAccessor) {
  const buckets = new Array(months).fill(0);
  const start = new Date(startIso);
  items.forEach(item => {
    const raw = dateAccessor(item);
    if (!raw) return;
    const d = new Date(raw);
    const idx = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
    if (idx >= 0 && idx < months) buckets[idx] += 1;
  });
  return buckets;
}

function parseCostCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const [, ...rows] = lines;
  return rows.map(line => {
    const [month, week, totalCost] = line.split(',');
    return {
      month: (month || '').trim(),
      week: normalizeWeekValue((week || '').trim()),
      totalCost: Number((totalCost || '').trim()),
    };
  });
}

function loadCostRowsLocal() {
  const csvPath = path.join(__dirname, 'costs.csv');
  if (!fs.existsSync(csvPath)) return [];
  return parseCostCsv(fs.readFileSync(csvPath, 'utf8'));
}

let costRowsCache = null;
let costRowsCachedAt = 0;
async function loadCostRows() {
  const fresh = Date.now() - costRowsCachedAt < COSTS_CACHE_TTL_MS;
  if (costRowsCache && fresh) return costRowsCache;

  if (COSTS_SHEET_URL) {
    try {
      const res = await fetch(COSTS_SHEET_URL, { redirect: 'follow' });
      if (res.ok) {
        const text = await res.text();
        costRowsCache = parseCostCsv(text);
        costRowsCachedAt = Date.now();
        return costRowsCache;
      }
      console.warn(`Costs sheet fetch ${res.status}; falling back to local costs.csv`);
    } catch (err) {
      console.warn('Costs sheet fetch failed; falling back to local costs.csv:', err.message);
    }
  }

  costRowsCache = loadCostRowsLocal();
  costRowsCachedAt = Date.now();
  return costRowsCache;
}

async function monthlyCostFor(date) {
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const rows = await loadCostRows();
  const row = rows.find(r => r.month === ym && !r.week && Number.isFinite(r.totalCost));
  return row ? row.totalCost : null;
}

async function weeklyCostFor(date) {
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const weekNo = weekOfMonthMonday(date);
  const rows = await loadCostRows();
  const row = rows.find(r =>
    r.month === ym &&
    Number.isFinite(r.totalCost) &&
    normalizeWeekValue(r.week) === weekNo
  );
  return row ? row.totalCost : null;
}

async function weeklySlotsInMonth(date) {
  const rows = await loadCostRows();
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const slots = new Set(
    rows
      .filter(r => r.month === ym && r.week && Number.isFinite(r.totalCost))
      .map(r => normalizeWeekValue(r.week))
      .filter(Boolean)
  );
  if (slots.size) return slots.size;
  return weekOfMonthMonday(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

async function resolveBaseCost(preset, startIso, endIso) {
  const start = new Date(startIso);
  const monthly = await monthlyCostFor(start);
  const weekly = await weeklyCostFor(start);

  if (preset === 'week' && weekly != null) {
    return weekly;
  }

  if (preset === 'today' && weekly != null) {
    return Math.round(weekly / 7);
  }

  if (monthly != null) {
    const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    const weeklySlots = await weeklySlotsInMonth(start);
    if (preset === 'today') return Math.round(monthly / daysInMonth);
    if (preset === 'week') return Math.round(monthly / Math.max(1, weeklySlots));
    if (preset === 'custom') {
      return Math.round(await costForCustomRange(startIso, endIso));
    }
    return monthly;
  }

  if (preset === 'today' && COST_BASE_DAILY) return COST_BASE_DAILY;
  if (preset === 'week' && COST_BASE_WEEKLY) return COST_BASE_WEEKLY;
  if ((preset === 'month' || preset === 'last_month') && COST_BASE_MONTHLY) return COST_BASE_MONTHLY;
  if (preset === 'custom') {
    return Math.round(await costForCustomRange(startIso, endIso));
  }
  if (preset === 'today') return Math.round(COST_BASE / 30);
  if (preset === 'week') return Math.round(COST_BASE / 4);
  return COST_BASE;
}

async function costForCustomRange(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  let total = 0;
  for (
    let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    d <= end;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  ) {
    total += await costForDay(d);
  }
  return total;
}

async function costForDay(date) {
  const weekly = await weeklyCostFor(date);
  if (weekly != null) return weekly / 7;

  const monthly = await monthlyCostFor(date);
  if (monthly != null) {
    const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return monthly / daysInMonth;
  }

  if (COST_BASE_DAILY) return COST_BASE_DAILY;
  if (COST_BASE_WEEKLY) return COST_BASE_WEEKLY / 7;
  if (COST_BASE_MONTHLY) {
    const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return COST_BASE_MONTHLY / daysInMonth;
  }
  return COST_BASE / 30;
}

function parseDateBoundary(rawDate, boundary) {
  const d = new Date(rawDate);
  if (!Number.isFinite(d.getTime())) return d;
  if (boundary === 'start') {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  d.setHours(23, 59, 59, 999);
  return d;
}

function weekOfMonthMonday(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const firstDow = (first.getDay() || 7); // Mon=1..Sun=7
  const day = date.getDate();
  return Math.ceil((day + (firstDow - 1)) / 7);
}

function normalizeWeekValue(raw) {
  if (raw == null) return '';
  const s = String(raw).trim().toUpperCase();
  if (!s) return '';
  const digits = s.replace(/^W/, '');
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : '';
}

function rangeDaysInclusive(startIso, endIso) {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  return Math.max(1, Math.floor(ms / 86400000) + 1);
}

async function fetchAllCalendarEvents(startIso, endIso) {
  if (!GHL_CALENDAR_IDS.length) return [];
  const results = await Promise.all(GHL_CALENDAR_IDS.map(id => fetchCalendarEvents(id, startIso, endIso)));
  return results.flat();
}

async function fetchCalendarEvents(calendarId, startIso, endIso) {
  const url = new URL(`${GHL_BASE}/calendars/events`);
  url.searchParams.set('calendarId', calendarId);
  url.searchParams.set('startTime', String(Date.parse(startIso)));
  url.searchParams.set('endTime', String(Date.parse(endIso)));
  url.searchParams.set('locationId', GHL_LOCATION_ID);

  const data = await fetchJson(url.toString());
  return data.events || data.appointments || [];
}

async function fetchAllOpportunities() {
  const limit = 100;
  const pagesHardLimit = 50;
  const all = [];

  for (let page = 1; page <= pagesHardLimit; page++) {
    const url = new URL(`${GHL_BASE}/opportunities/search`);
    url.searchParams.set('location_id', GHL_LOCATION_ID);
    url.searchParams.set('pipeline_id', GHL_PIPELINE_ID);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('page', String(page));

    const data = await fetchJson(url.toString());
    const items = data.opportunities || data.items || data || [];
    const batch = Array.isArray(items) ? items : [];
    all.push(...batch);

    if (batch.length < limit) break;
  }

  return all;
}

function filterOppsByCreatedInRange(opps, startIso, endIso) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return opps.filter(o => {
    const raw = o.dateAdded || o.date_added || o.createdAt || o.created_at;
    const t = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(t)) return true;
    return t >= start && t <= end;
  });
}

function groupOppsByContact(opps) {
  const map = new Map();
  for (const o of opps) {
    if (!o || !o.contactId) continue;
    if (!map.has(o.contactId)) map.set(o.contactId, []);
    map.get(o.contactId).push(o);
  }

  for (const [, list] of map) {
    list.sort((a, b) => toMs(b.updatedAt || b.createdAt) - toMs(a.updatedAt || a.createdAt));
  }
  return map;
}

function matchOpportunityForEvent(event, opportunities) {
  if (!Array.isArray(opportunities) || !opportunities.length) return null;

  const eventAnchor = toMs(event.dateAdded || event.startTime || event.dateUpdated);
  if (!Number.isFinite(eventAnchor)) return opportunities[0];

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const o of opportunities) {
    const oppAnchor = toMs(o.createdAt || o.updatedAt || o.lastStageChangeAt);
    if (!Number.isFinite(oppAnchor)) continue;
    const score = Math.abs(eventAnchor - oppAnchor);
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best || opportunities[0];
}

function isInRange(rawDate, startIso, endIso) {
  const t = toMs(rawDate);
  if (!Number.isFinite(t)) return false;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return t >= start && t <= end;
}

function toMs(rawDate) {
  return rawDate ? Date.parse(rawDate) : NaN;
}

function getCustomFieldValue(opportunity, fieldId) {
  const list = opportunity.customFields || opportunity.custom_fields || [];
  if (!Array.isArray(list) || !fieldId) return '';
  const cf = list.find(f => String(f.id) === String(fieldId));
  if (!cf) return '';
  return cf.fieldValueString ?? cf.fieldValue ?? cf.value ?? '';
}

function getMonetaryValue(opportunity) {
  const val = opportunity.monetaryValue ?? opportunity.monetary_value ?? opportunity.amount ?? opportunity.value ?? 0;
  const num = Number(val);
  return Number.isFinite(num) ? num : 0;
}

app.listen(PORT, () => {
  console.log(`LP Dashboard server running on http://localhost:${PORT}`);
});
