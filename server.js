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
const GHL_CALL_STATUS_FIELD_ID = process.env.GHL_CALL_STATUS_FIELD_ID || 'zTuUVDw4rojZrdnrM0Zq';
const GHL_CALL_PICKUP_VALUES = parseCsvValues(
  process.env.GHL_CALL_PICKUP_VALUES || 'Answered,Interested,Receptionist,Appointment Scheduled,Corporates'
);
const GHL_CALL_POSITIVE_VALUES = parseCsvValues(
  process.env.GHL_CALL_POSITIVE_VALUES || 'Interested,Appointment Scheduled'
);
const GHL_CALL_DEMO_VALUES = parseCsvValues(
  process.env.GHL_CALL_DEMO_VALUES || 'Appointment Scheduled'
);
const GHL_CALL_RECORDING_FIELD_ID = process.env.GHL_CALL_RECORDING_FIELD_ID || '';
const GHL_CALL_FETCH_MAX_CONTACTS = Math.max(50, Number(process.env.GHL_CALL_FETCH_MAX_CONTACTS || 180));
const COLD_CALLING_CACHE_TTL_MS = 2 * 60 * 1000;
const AIMFOX_API_KEY = process.env.AIMFOX_API_KEY || '';
const AIMFOX_BASE = process.env.AIMFOX_BASE || 'https://api.aimfox.com/api/v2';
const AIMFOX_CACHE_TTL_MS = 60 * 1000;
const COST_BASE = Number(process.env.COST_BASE || 1000);
const COST_BASE_DAILY = Number(process.env.COST_BASE_DAILY || 0);
const COST_BASE_WEEKLY = Number(process.env.COST_BASE_WEEKLY || 0);
const COST_BASE_MONTHLY = Number(process.env.COST_BASE_MONTHLY || 0);
const COSTS_SHEET_URL = process.env.COSTS_SHEET_URL || '';
const COSTS_CACHE_TTL_MS = 5 * 60 * 1000;
let coldCallingCache = new Map();
let aimfoxCache = new Map();

if (!GHL_API_KEY || !GHL_LOCATION_ID || !GHL_PIPELINE_ID) {
  console.warn('Missing required GHL env vars. Check .env: GHL_API_KEY, GHL_LOCATION_ID, GHL_PIPELINE_ID');
}

app.use(express.static(__dirname));
app.use((req, res, next) => {
  // Logs removed to reduce clutter
  next();
});

app.get('/api/overview', async (req, res) => {
  try {
    const { preset = 'month', start, end } = req.query;
    const { startIso, endIso } = getDateRange(preset, start, end);

    const [events, allOpps] = await Promise.all([
      fetchAllCalendarEvents(startIso, endIso),
      fetchAllOpportunities(),
    ]);
    const bookedEvents = filterBookedEvents(events);

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
    const demoCompleted = bookedEvents.filter(e => {
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
        new_meetings_booked: bookedEvents.length,
        qualified_completed: qualifiedCompleted.length,
        new_trial_signups: trialSignups,
        cost_per_demo: costPerDemo,
        cost_per_trial_signup: costPerTrial,
        pipeline_value: pipelineValue,
        demos_completed: demoCompleted,
        meetings_booked_list: buildBookedMeetingsList(bookedEvents),
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
    const bookedEvents = filterBookedEvents(events);

    const meetingBuckets = bucketByMonth(bookedEvents, startIso, months, e => e.startTime || e.start_time || e.start || e.startDate);
    const trialSignupOpps = GHL_TRIAL_SIGNUP_STAGE_IDS.length
      ? allOpps.filter(o => GHL_TRIAL_SIGNUP_STAGE_IDS.includes(String(o.pipelineStageId || '')))
      : [];
    const signupBuckets = bucketByMonth(trialSignupOpps, startIso, months, o => o.lastStageChangeAt || o.updatedAt || o.createdAt);

    const oppsByContact = groupOppsByContact(allOpps);
    const excludeStages = new Set(GHL_DEMO_EXCLUDE_STAGE_IDS);
    const demoCompletedEvents = bookedEvents.filter(e => {
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

app.get('/api/cold-calling', async (req, res) => {
  try {
    const { preset = 'month', start, end } = req.query;
    const { startIso, endIso } = getDateRange(preset, start, end);
    const cacheKey = `${preset}|${startIso}|${endIso}`;
    const cached = coldCallingCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < COLD_CALLING_CACHE_TTL_MS) {
      return res.json(cached.payload);
    }

    const contactSummaries = await fetchContactSummariesInRange(startIso, endIso, GHL_CALL_FETCH_MAX_CONTACTS);
    const contacts = await fetchContactsByIds(contactSummaries.map(c => c.id));

    let totalCalls = 0;
    let pickups = 0;
    let positive = 0;
    let demosBooked = 0;
    const recordings = [];

    for (const c of contacts) {
      const statuses = getContactStatuses(c);
      if (!statuses.length) continue;
      totalCalls += 1;

      if (hasAnyStatus(statuses, GHL_CALL_PICKUP_VALUES)) pickups += 1;
      if (hasAnyStatus(statuses, GHL_CALL_POSITIVE_VALUES)) positive += 1;
      if (hasAnyStatus(statuses, GHL_CALL_DEMO_VALUES)) demosBooked += 1;

      const recordingUrl = getRecordingUrl(c);
      if (recordingUrl) {
        recordings.push({
          name: c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown Contact',
          date: c.dateUpdated || c.dateAdded || null,
          url: recordingUrl,
          outcome: statuses.join(', '),
        });
      }
    }

    recordings.sort((a, b) => toMs(b.date) - toMs(a.date));
    const recordingsTop = recordings.slice(0, 10);

    const baseCost = await resolveBaseCost(preset, startIso, endIso);
    const costPerQualifiedDemo = demosBooked ? Math.round(baseCost / demosBooked) : 0;

    const payload = {
      ok: true,
      range: { startIso, endIso },
      cold_calling: {
        total_calls: totalCalls,
        total_pickups: pickups,
        positive_response: positive,
        demos_booked: demosBooked,
        qualified_demos: demosBooked,
        cost_per_qualified_demo: costPerQualifiedDemo,
        total_signups: 0,
        cost_per_trial_signup: 0,
      },
      recordings: recordingsTop,
      meta: {
        call_status_field_id: GHL_CALL_STATUS_FIELD_ID,
      },
    };
    coldCallingCache.set(cacheKey, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    console.error('Cold calling error:', err.message);
    // Keep dashboard functional even when GHL throttles.
    res.json({
      ok: true,
      cold_calling: {
        total_calls: 0,
        total_pickups: 0,
        positive_response: 0,
        demos_booked: 0,
        qualified_demos: 0,
        cost_per_qualified_demo: 0,
        total_signups: 0,
        cost_per_trial_signup: 0,
      },
      recordings: [],
      meta: {
        degraded: true,
        reason: err.message,
      },
    });
  }
});

app.get('/api/linkedin', async (req, res) => {
  try {
    const { preset = 'month', start, end } = req.query;
    const { startIso, endIso } = getDateRange(preset, start, end);
    const cacheKey = `${preset}|${startIso}|${endIso}`;
    const cached = aimfoxCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < AIMFOX_CACHE_TTL_MS) {
      return res.json(cached.payload);
    }

    if (!AIMFOX_API_KEY) {
      return res.json({
        ok: true,
        linkedin: emptyLinkedinMetrics(),
        replies: [],
        meta: { degraded: true, reason: 'Missing AIMFOX_API_KEY' },
      });
    }

    const [accountsData, recentLeadsData, conversationsData] = await Promise.all([
      fetchAimfoxJson('/accounts'),
      fetchAimfoxJson('/analytics/recent-leads'),
      fetchAimfoxJson('/conversations'),
    ]);

    const accountIds = new Set((accountsData.accounts || []).map(a => String(a.id || '')).filter(Boolean));
    const leads = Array.isArray(recentLeadsData.leads) ? recentLeadsData.leads : [];
    const leadsInRange = leads.filter(l => isInRange(l.timestamp, startIso, endIso));

    const transitionCounts = leadsInRange.reduce((acc, l) => {
      const t = String(l.transition || '').toLowerCase();
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {});

    let positiveResponse = 0;
    leadsInRange.forEach(l => {
        const tags = Array.isArray(l.tags) ? l.tags : (typeof l.tags === 'string' ? l.tags.split(',') : []);
        if (tags.some(t => {
            const low = String(t).trim().toLowerCase();
            return low === 'interested' || low === 'positive' || low === 'warm';
        })) {
            positiveResponse++;
        }
    });

    const accepted = transitionCounts.accepted || 0;
    const replied = transitionCounts.reply || 0;
    const connect = transitionCounts.connect || transitionCounts.connection || 0;
    const connectionRequests = connect > 0 ? connect : (accepted + replied);

    const conversations = Array.isArray(conversationsData.conversations) ? conversationsData.conversations : [];
    const replies = conversations
      .filter(c => isInRange(c.last_activity_at, startIso, endIso))
      .map(c => normalizeAimfoxReply(c, accountIds))
      .filter(Boolean)
      .sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp))
      .slice(0, 10);

    const linkedin = {
      connection_requests: connectionRequests,
      total_accepted: accepted,
      total_replied: replied,
      positive_response: positiveResponse,
      demos_booked: 0,
      qualified_demos: 0,
      cost_per_qualified_demo: 0,
      total_signups: 0,
      cost_per_trial_signup: 0,
    };

    const payload = {
      ok: true,
      range: { startIso, endIso },
      linkedin,
      replies,
      meta: {
        inferred_connection_requests: connect === 0,
        transitions: transitionCounts,
      },
    };
    aimfoxCache.set(cacheKey, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    console.error('LinkedIn (Aimfox) error:', err.message);
    res.json({
      ok: true,
      linkedin: emptyLinkedinMetrics(),
      replies: [],
      meta: { degraded: true, reason: err.message },
    });
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
  const headers = { ...authHeaders(), ...(options.headers || {}) };
  const attempts = 4;
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, { ...options, headers });
    if (res.ok) return res.json();

    const text = await res.text();
    if (res.status === 429 && i < attempts) {
      console.log(`[GHL-RETRY] 429 attempt ${i} for ${url}`);
      const retryAfter = Number(res.headers.get('Retry-After') || 0);
      const backoffMs = retryAfter > 0 ? retryAfter * 1000 : (300 * (2 ** (i - 1)));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(`GHL ${res.status}: ${text}`);
  }
  throw new Error('GHL request failed after retries');
}

async function fetchAimfoxJson(path) {
  const url = path.startsWith('http') ? path : `${AIMFOX_BASE}${path}`;
  const attempts = 4;
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIMFOX_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status === 503) && i < attempts) {
      const retryAfter = Number(res.headers.get('Retry-After') || 0);
      const backoffMs = retryAfter > 0 ? retryAfter * 1000 : (300 * (2 ** (i - 1)));
      console.log(`[AIMFOX-RETRY] ${res.status} attempt ${i} for ${url}`);
      await sleep(backoffMs);
      continue;
    }
    throw new Error(`AIMFOX ${res.status}: ${text}`);
  }
  throw new Error('Aimfox request failed after retries');
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

function filterBookedEvents(events) {
  const excluded = new Set(['rescheduled', 'cancelled', 'canceled']);
  return (events || []).filter(e => {
    if (!e || e.deleted) return false;
    const status = String(e.appointmentStatus || e.status || '').trim().toLowerCase();
    return !excluded.has(status);
  });
}

function buildBookedMeetingsList(events, limit = Number.POSITIVE_INFINITY) {
  return (events || [])
    .slice()
    .sort((a, b) => toMs(b.startTime || b.start_time || b.start || b.startDate) - toMs(a.startTime || a.start_time || a.start || a.startDate))
    .slice(0, limit)
    .map(e => ({
      name: e.title || e.contactName || e.name || 'Untitled Meeting',
      start_time: e.startTime || e.start_time || e.start || e.startDate || null,
      status: e.appointmentStatus || e.status || '',
      calendar_id: e.calendarId || null,
    }));
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

async function fetchContactSummariesInRange(startIso, endIso, maxContacts) {
  const limit = 100;
  const pagesHardLimit = 25;
  const all = [];

  for (let page = 1; page <= pagesHardLimit; page++) {
    const url = new URL(`${GHL_BASE}/contacts/`);
    url.searchParams.set('locationId', GHL_LOCATION_ID);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('page', String(page));

    const data = await fetchJson(url.toString());
    const batch = Array.isArray(data.contacts) ? data.contacts : [];
    const inRange = batch.filter(c => isInRange(c.dateUpdated || c.dateAdded || c.updatedAt || c.createdAt, startIso, endIso));
    all.push(...inRange);
    if (all.length >= maxContacts) break;
    if (batch.length < limit) break;
    await sleep(120);
  }
  return all.slice(0, maxContacts);
}

async function fetchContactsByIds(ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  const all = [];

  const CONCURRENCY = 7;
  for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
    const chunk = uniqueIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async id => {
      try {
        const data = await fetchJson(`${GHL_BASE}/contacts/${id}`);
        return data.contact || data || null;
      } catch {
        // Continue; partial data is better than hard-failing the dashboard.
        return null;
      }
    }));
    
    for (const c of results) {
      if (c) all.push(c);
    }
    
    // Safety buffer: 7 requests every 500ms = 14 req/sec (Safe within GHL burst rules)
    await sleep(500); 
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

function parseCsvValues(raw) {
  return (raw || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeAimfoxReply(conversation, accountIds) {
  let msg = conversation.last_message || {};
  let body = String(msg.body || '').trim();

  if (Array.isArray(conversation.messages) && conversation.messages.length > 0) {
    const leadMsg = conversation.messages.slice().reverse().find(m => {
      const sId = String(m.sender?.id || m.sender_id || '');
      return sId && !accountIds.has(sId) && String(m.body || '').trim();
    });
    if (leadMsg) {
      msg = leadMsg;
      body = String(msg.body || '').trim();
    }
  }

  if (!body) return null;
  
  const senderId = String(msg.sender?.id || msg.sender_id || '');
  const isOurs = senderId && accountIds.has(senderId);

  const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
  const lead = participants.find(p => {
    const pid = String(p.id || '');
    return pid && !accountIds.has(pid);
  }) || participants[0] || {};

  if (isOurs) {
    body = `You: ${body}`;
  }

  return {
    name: lead.full_name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Unknown Lead',
    company: lead.occupation || '',
    msg: body,
    timestamp: msg.created_at || conversation.last_activity_at || null,
  };
}

function emptyLinkedinMetrics() {
  return {
    connection_requests: 0,
    total_accepted: 0,
    total_replied: 0,
    positive_response: 0,
    demos_booked: 0,
    qualified_demos: 0,
    cost_per_qualified_demo: 0,
    total_signups: 0,
    cost_per_trial_signup: 0,
  };
}

function parseStatusValues(raw) {
  if (Array.isArray(raw)) return raw.map(v => String(v || '').trim()).filter(Boolean);
  const s = String(raw || '').trim();
  if (!s) return [];

  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map(v => String(v || '').trim()).filter(Boolean);
  } catch {}

  return s
    .split(/[,\n;|]/)
    .map(v => v.trim())
    .filter(Boolean);
}

function getContactStatuses(contact) {
  const customFields = Array.isArray(contact.customFields) ? contact.customFields : [];
  const hit = customFields.find(f => String(f.id) === String(GHL_CALL_STATUS_FIELD_ID));
  if (!hit) return [];
  const raw = hit.value ?? hit.fieldValueString ?? hit.field_value ?? '';
  return parseStatusValues(raw);
}

function hasAnyStatus(statuses, allowedLower) {
  const set = new Set((statuses || []).map(s => String(s || '').toLowerCase().trim()));
  return allowedLower.some(v => set.has(v));
}

function getRecordingUrl(contact) {
  const fields = Array.isArray(contact.customFields) ? contact.customFields : [];
  if (GHL_CALL_RECORDING_FIELD_ID) {
    const hit = fields.find(f => String(f.id) === String(GHL_CALL_RECORDING_FIELD_ID));
    const val = String(hit?.value ?? hit?.fieldValueString ?? '').trim();
    return /^https?:\/\//i.test(val) ? val : '';
  }

  const anyUrl = fields.find(f => {
    const v = String(f.value ?? f.fieldValueString ?? '').trim();
    return /^https?:\/\//i.test(v) && /mp3|wav|m4a|ogg|audio|record/i.test(v);
  });
  return anyUrl ? String(anyUrl.value ?? anyUrl.fieldValueString ?? '').trim() : '';
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
