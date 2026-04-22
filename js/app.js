/* ─── State ──────────────────────────────────────────────────── */
let currentPreset = 'month';
let funnelChart   = null;
let trendChart    = null;
const MEETINGS_PAGE_SIZE = 5;
let meetingsBookedRows = [];
let meetingsBookedVisible = MEETINGS_PAGE_SIZE;

/* ─── Init ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    setHeaderDate();
    initFlatpickr();
    initCharts();
    const loadMoreBtn = document.getElementById('meetings-booked-load-more');
    if (loadMoreBtn) loadMoreBtn.addEventListener('click', onMeetingsLoadMore);
    applyFilters();          // render with default "month" data
    renderStaticLists();
});

/* ─── Date Header ─────────────────────────────────────────────── */
function setHeaderDate() {
    const el = document.getElementById('headerDate');
    if (el) {
        el.textContent = new Date().toLocaleDateString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        });
    }
}

/* ─── flatpickr setup ─────────────────────────────────────────── */
function initFlatpickr() {
    flatpickr('#dateFrom', { dateFormat: 'M j, Y', disableMobile: true });
    flatpickr('#dateTo',   { dateFormat: 'M j, Y', disableMobile: true });
}

/* ─── Filter Panel Toggle ─────────────────────────────────────── */
function toggleFilterPanel() {
    document.getElementById('filterPanel').classList.toggle('open');
}

/* ─── Tab Switching ────────────────────────────────────────────── */
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick').includes(tabId));
    });
    document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.remove('active');
    });
    document.getElementById('tab-' + tabId).classList.add('active');
}

/* ─── Date Presets ────────────────────────────────────────────── */
function setPreset(preset) {
    currentPreset = preset;

    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === preset);
    });

    const customDates = document.getElementById('customDates');
    if (preset === 'custom') {
        customDates.classList.add('visible');
    } else {
        customDates.classList.remove('visible');
        applyFilters();
    }
}

/* ─── Apply Filters ───────────────────────────────────────────── */
async function applyFilters() {
    const data = MOCK_DATA[currentPreset] || MOCK_DATA.month;

    setSectionLoading('tab-overview', true);
    setSectionLoading('tab-linkedin', true);
    setSectionLoading('tab-cold-calling', true);
    document.querySelectorAll('.kpi-value').forEach(el => el.classList.add('refreshing'));
    renderMeetingsBookedSkeleton();

    const [liveMain, liveTrend] = await Promise.all([
        fetchOverviewLive(),
        fetchTrendLive(),
    ]);

    setTimeout(() => {
        renderMain(liveMain || data.main);
        renderMeetingsBooked((liveMain && liveMain.meetings_booked_list) || (data.main && data.main.meetings_booked_list) || []);
        updateCharts(data, liveTrend);
        setSectionLoading('tab-overview', false);
        document.querySelectorAll('#tab-overview .kpi-value').forEach(el => el.classList.remove('refreshing'));
    }, 160);

    // Cold-calling data can be slow due to rate-limited upstream APIs.
    // Update it asynchronously so the full dashboard does not block.
    fetchColdCallingLive().then(liveCold => {
        renderColdCalling((liveCold && liveCold.cold_calling) || data.cold_calling);
        renderRecordingsList((liveCold && liveCold.recordings) || RECORDINGS);
        setSectionLoading('tab-cold-calling', false);
        document.querySelectorAll('#tab-cold-calling .kpi-value').forEach(el => el.classList.remove('refreshing'));
    }).catch(() => {
        renderColdCalling(data.cold_calling);
        renderRecordingsList(RECORDINGS);
        setSectionLoading('tab-cold-calling', false);
        document.querySelectorAll('#tab-cold-calling .kpi-value').forEach(el => el.classList.remove('refreshing'));
    });

    fetchLinkedInLive().then(liveLinkedIn => {
        renderLinkedIn((liveLinkedIn && liveLinkedIn.linkedin) || data.linkedin);
        renderRepliesList((liveLinkedIn && liveLinkedIn.replies) || LI_REPLIES);
        setSectionLoading('tab-linkedin', false);
        document.querySelectorAll('#tab-linkedin .kpi-value').forEach(el => el.classList.remove('refreshing'));
    }).catch(() => {
        renderLinkedIn(data.linkedin);
        renderRepliesList(LI_REPLIES);
        setSectionLoading('tab-linkedin', false);
        document.querySelectorAll('#tab-linkedin .kpi-value').forEach(el => el.classList.remove('refreshing'));
    });
}

function resetFilters() {
    setPreset('month');
    document.getElementById('channelFilter').value = 'all';
    document.getElementById('memberFilter').value  = 'all';

    // show/hide channel sections
    document.getElementById('section-linkedin').style.display    = '';
    document.getElementById('section-cold-calling').style.display = '';
}

async function fetchOverviewLive() {
    try {
        const params = new URLSearchParams({ preset: currentPreset });
        if (currentPreset === 'custom') {
            const s = document.getElementById('dateFrom')?.value || '';
            const e = document.getElementById('dateTo')?.value || '';
            if (s && e) {
                params.set('start', s);
                params.set('end', e);
            }
        }

        const res = await fetch(`/api/overview?${params.toString()}`);
        if (!res.ok) return null;
        const json = await res.json();
        return json && json.ok ? json.data : null;
    } catch (err) {
        return null;
    }
}

async function fetchTrendLive() {
    try {
        const res = await fetch('/api/trend?months=6');
        if (!res.ok) return null;
        const json = await res.json();
        return json && json.ok ? json : null;
    } catch (err) {
        return null;
    }
}

async function fetchColdCallingLive() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 60-second timeout
        const params = new URLSearchParams({ preset: currentPreset });
        if (currentPreset === 'custom') {
            const s = document.getElementById('dateFrom')?.value || '';
            const e = document.getElementById('dateTo')?.value || '';
            if (s && e) {
                params.set('start', s);
                params.set('end', e);
            }
        }

        console.log(`[Cold Calling API] Fetching /api/cold-calling?${params.toString()}`);
        const res = await fetch(`/api/cold-calling?${params.toString()}`, { signal: controller.signal });
        clearTimeout(timeout);
        
        if (!res.ok) {
            console.error('[Cold Calling API] HTTP Error:', res.status, res.statusText);
            throw new Error(`HTTP error! status: ${res.status}`);
        }
        
        const json = await res.json();
        console.log('[Cold Calling API] Response:', json);
        
        if (!json.ok) {
            console.error('[Cold Calling API] Endpoint reported failure:', json);
            return null;
        }
        
        return json;
    } catch (err) {
        console.error('[Cold Calling API] Fetch Exception caught:', err);
        throw err;
    }
}

async function fetchLinkedInLive() {
    try {
        const params = new URLSearchParams({ preset: currentPreset });
        if (currentPreset === 'custom') {
            const s = document.getElementById('dateFrom')?.value || '';
            const e = document.getElementById('dateTo')?.value || '';
            if (s && e) {
                params.set('start', s);
                params.set('end', e);
            }
        }

        const res = await fetch(`/api/linkedin?${params.toString()}`);
        if (!res.ok) return null;
        const json = await res.json();
        return json && json.ok ? json : null;
    } catch (err) {
        return null;
    }
}

/* ─── Formatters ──────────────────────────────────────────────── */
function fmt(key, val) {
    if (val === 0 || val == null) return '0';

    const isMoney = key.includes('cost') || key.includes('pipeline') || key.includes('value');

    if (isMoney) {
        return '$' + Number(val).toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    return val.toLocaleString();
}

function pct(num, denom) {
    if (!denom) return '';
    return ((num / denom) * 100).toFixed(1) + '%';
}

/* ─── Render Main KPIs ────────────────────────────────────────── */
function renderMain(d) {
    set('v-meetings',      'new_meetings_booked',   d.new_meetings_booked);
    set('v-qualified',     'qualified_completed',   d.qualified_completed);
    set('v-trial-signups', 'new_trial_signups',     d.new_trial_signups);
    set('v-cost-demo',     'cost_per_demo',         d.cost_per_demo);
    set('v-cost-trial',    'cost_per_trial_signup', d.cost_per_trial_signup);
    set('v-pipeline',      'pipeline_value',        d.pipeline_value);
    set('v-demos',         'demos_completed',       d.demos_completed);
}

/* ─── Render LinkedIn KPIs ────────────────────────────────────── */
function renderLinkedIn(d) {
    set('v-li-conn',     'connection_requests',     d.connection_requests);
    set('v-li-accepted', 'total_accepted',          d.total_accepted);
    set('v-li-replied',  'total_replied',           d.total_replied);
    set('v-li-positive', 'positive_response',       d.positive_response);
    set('v-li-demos',    'demos_booked',            d.demos_booked);
    set('v-li-qd',       'qualified_demos',         d.qualified_demos);
    set('v-li-cpqd',     'cost_per_qualified_demo', d.cost_per_qualified_demo);
    set('v-li-su',       'total_signups',           d.total_signups);
    set('v-li-cpsu',     'cost_per_trial_signup',   d.cost_per_trial_signup);

    // Conversion rates
    setText('r-li-accepted', pct(d.total_accepted, d.connection_requests) + ' accept rate');
    setText('r-li-replied',  pct(d.total_replied,  d.total_accepted)      + ' reply rate');
    setText('r-li-positive', pct(d.positive_response, d.total_replied)    + ' positive rate');
    setText('r-li-demos',    pct(d.demos_booked,   d.total_replied)       + ' → demo');

    // Channel summary
    const rate = pct(d.total_signups, d.connection_requests);
    setText('li-conv-rate', `${rate} overall conversion · ${d.total_signups} sign-ups`);
}

/* ─── Render Cold Calling KPIs ────────────────────────────────── */
function renderColdCalling(d) {
    set('v-cc-calls',    'total_calls',             d.total_calls);
    set('v-cc-pickups',  'total_pickups',           d.total_pickups);
    set('v-cc-positive', 'positive_response',       d.positive_response);
    set('v-cc-demos',    'demos_booked',            d.demos_booked);
    set('v-cc-qd',       'qualified_demos',         d.qualified_demos);
    set('v-cc-cpqd',     'cost_per_qualified_demo', d.cost_per_qualified_demo);
    set('v-cc-su',       'total_signups',           d.total_signups);
    set('v-cc-cpsu',     'cost_per_trial_signup',   d.cost_per_trial_signup);

    setText('r-cc-pickups',  pct(d.total_pickups,   d.total_calls)   + ' pickup rate');
    setText('r-cc-positive', pct(d.positive_response, d.total_pickups) + ' positive rate');
    setText('r-cc-demos',    pct(d.demos_booked,    d.total_pickups)  + ' → demo');

    const rate = pct(d.total_signups, d.total_calls);
    setText('cc-conv-rate', `${rate} overall conversion · ${d.total_signups} sign-ups`);
}

/* ─── Helpers ─────────────────────────────────────────────────── */
function set(id, key, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = fmt(key, val);
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/* ─── Static Lists ────────────────────────────────────────────── */
function renderStaticLists() {
    renderCampaignList('list-cc-campaigns', 'cc-camp-count', CAMPAIGNS.cold_calling, 'calls');
    renderCampaignList('list-li-campaigns', 'li-camp-count', CAMPAIGNS.linkedin,     'connections');
    renderRecordingsList(RECORDINGS);
    renderRepliesList(LI_REPLIES);
}

function renderMeetingsBooked(items) {
    const ul = document.getElementById('list-meetings-booked');
    if (!ul) return;

    meetingsBookedRows = Array.isArray(items) ? items : [];
    meetingsBookedVisible = MEETINGS_PAGE_SIZE;
    renderMeetingsBookedVisible();
}

function renderMeetingsBookedVisible() {
    const ul = document.getElementById('list-meetings-booked');
    if (!ul) return;

    const rows = meetingsBookedRows;
    const visibleRows = rows.slice(0, meetingsBookedVisible);
    const countText = `${rows.length} total`;
    setText('meetings-booked-count', countText);

    if (!rows.length) {
        ul.innerHTML = '<li><div class="item-main"><div class="item-name">No meetings in selected range</div></div></li>';
        toggleMeetingsLoadMore(false);
        return;
    }

    ul.innerHTML = visibleRows.map(r => {
        const raw = r.start_time ? new Date(r.start_time) : null;
        const when = raw && Number.isFinite(raw.getTime())
            ? raw.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
            : 'No date';
        const status = ((r.status || '').toLowerCase() || 'booked');
        return `<li>
            <div class="item-main">
                <div class="item-name">${r.name || 'Untitled Meeting'}</div>
                <div class="item-meta">${when}</div>
            </div>
            <span class="item-badge">${status}</span>
        </li>`;
    }).join('');

    toggleMeetingsLoadMore(rows.length > visibleRows.length);
}

function onMeetingsLoadMore() {
    meetingsBookedVisible += MEETINGS_PAGE_SIZE;
    renderMeetingsBookedVisible();
}

function toggleMeetingsLoadMore(show) {
    const actions = document.querySelector('.list-actions');
    const btn = document.getElementById('meetings-booked-load-more');
    if (!actions || !btn) return;
    actions.style.display = show ? 'block' : 'none';
    const remaining = Math.max(0, meetingsBookedRows.length - meetingsBookedVisible);
    btn.textContent = remaining > MEETINGS_PAGE_SIZE ? `Load more (${remaining} left)` : 'Load more';
}

function renderMeetingsBookedSkeleton() {
    const ul = document.getElementById('list-meetings-booked');
    if (!ul) return;
    ul.innerHTML = Array.from({ length: 3 }).map(() => `
        <li class="skeleton-row">
            <div class="item-main">
                <div class="item-name">.</div>
                <div class="item-meta">.</div>
            </div>
            <span class="item-badge">.</span>
        </li>
    `).join('');
    setText('meetings-booked-count', 'Loading...');
    toggleMeetingsLoadMore(false);
}

function setSectionLoading(sectionId, isLoading) {
    document.querySelectorAll(`#${sectionId} .kpi-card`).forEach(card => {
        card.classList.toggle('skeleton-loading', isLoading);
    });
}

function renderCampaignList(listId, countId, campaigns, statKey) {
    const ul = document.getElementById(listId);
    if (!ul) return;

    const active = campaigns.filter(c => c.status === 'active').length;
    setText(countId, `${active} active`);

    ul.innerHTML = campaigns.map(c => {
        const stat = statKey === 'calls'
            ? `${c.calls.toLocaleString()} calls · ${c.demos} demos`
            : `${c.connections.toLocaleString()} connections · ${c.replies} replies`;

        return `<li>
            <div class="item-main">
                <div class="item-name">${c.name}</div>
                <div class="item-meta">${stat} · Started ${c.started}</div>
            </div>
            <span class="item-badge badge-${c.status}">${c.status}</span>
        </li>`;
    }).join('');
}

function renderRecordingsList(recordings) {
    const ul = document.getElementById('list-recordings');
    if (!ul) return;

    const rows = Array.isArray(recordings) ? recordings : [];
    ul.innerHTML = rows.map(r => {
        const meta = `${(r.duration || '')}${r.duration ? ' | ' : ''}${(r.date || '')}${r.date ? ' | ' : ''}${(r.outcome || '')}`;
        return `
        <li>
            <div class="item-main">
                <div class="item-name">${r.name || 'Call Recording'}</div>
                <div class="item-meta">${meta}</div>
            </div>
            ${renderRecordingAction(r.url)}
        </li>
    `;
    }).join('');
}

function renderRecordingAction(url) {
    const safe = String(url || '').trim();
    if (!safe || safe === '#') return '<span class="play-link">No audio</span>';
    const lower = safe.toLowerCase();
    const isAudio = /\\.mp3|\\.wav|\\.ogg|\\.m4a|audio|record/i.test(lower);
    if (isAudio) {
        return `<audio controls preload="none" style="max-width:220px"><source src="${safe}"></audio>`;
    }
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="play-link">Open</a>`;
}

function renderRepliesList(replies) {
    const ul = document.getElementById('list-li-replies');
    if (!ul) return;

    const rows = Array.isArray(replies) ? replies : [];
    if (!rows.length) {
        ul.innerHTML = '<li><div class="item-main"><div class="item-name">No recent LinkedIn replies in selected range</div></div></li>';
        return;
    }
    ul.innerHTML = rows.map(r => `
        <li>
            <span class="reply-dot s-${r.sentiment || 'neu'}"></span>
            <div class="item-main" style="margin-left:6px">
                <div class="item-name">${r.name || 'Unknown'} <span style="color:var(--text3);font-weight:400">| ${r.company || ''}</span></div>
                <div class="item-meta">"${r.msg || ''}"</div>
            </div>
            <span class="reply-time">${toRelativeTime(r.timestamp, r.time)}</span>
        </li>
    `).join('');
}

function toRelativeTime(timestamp, fallback) {
    if (!timestamp) return fallback || '';
    const d = new Date(timestamp);
    if (!Number.isFinite(d.getTime())) return fallback || '';
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 60000) return 'just now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}
/* ─── Charts ──────────────────────────────────────────────────── */
function initCharts() {
    Chart.defaults.color          = '#6b635b';
    Chart.defaults.borderColor    = '#e7dfd7';
    Chart.defaults.font.family    = "'Space Grotesk', 'Segoe UI', sans-serif";

    // Funnel (horizontal bar)
    const fCtx = document.getElementById('funnelChart').getContext('2d');
    funnelChart = new Chart(fCtx, {
        type: 'bar',
        data: {
            labels: ['Connections', 'Accepted', 'Replied', 'Demo Booked', 'Qualified', 'Sign-up'],
            datasets: [{
                data: [1240, 347, 128, 38, 26, 11],
                backgroundColor: [
                    'rgba(240,124,33,0.85)',
                    'rgba(240,124,33,0.70)',
                    'rgba(240,124,33,0.56)',
                    'rgba(240,124,33,0.42)',
                    'rgba(240,124,33,0.30)',
                    'rgba(240,124,33,0.20)',
                ],
                borderRadius: 5,
                borderSkipped: false,
            }],
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => ' ' + ctx.parsed.x.toLocaleString() + ' leads',
                    },
                },
            },
            scales: {
                x: { grid: { color: '#e9e1d9' }, ticks: { color: '#7c746c' } },
                y: { grid: { display: false },   ticks: { color: '#6b635b', font: { size: 11 } } },
            },
        },
    });

    // Trend (line)
    const tCtx = document.getElementById('trendChart').getContext('2d');
    trendChart = new Chart(tCtx, {
        type: 'line',
        data: {
            labels: TREND.labels,
            datasets: [
                {
                    label: 'Meetings Booked',
                    data: TREND.meetings,
                    borderColor: '#f07c21',
                    backgroundColor: 'rgba(240,124,33,0.14)',
                    fill: true,
                    tension: 0.4,
                    pointBackgroundColor: '#f07c21',
                    pointRadius: 4,
                    pointHoverRadius: 6,
                },
                {
                    label: 'Trial Sign-ups',
                    data: TREND.signups,
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37,99,235,0.10)',
                    fill: true,
                    tension: 0.4,
                    pointBackgroundColor: '#3b82f6',
                    pointRadius: 4,
                    pointHoverRadius: 6,
                },
                {
                    label: 'Demos Completed',
                    data: TREND.demos,
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34,197,94,0.10)',
                    fill: true,
                    tension: 0.4,
                    pointBackgroundColor: '#22c55e',
                    pointRadius: 4,
                    pointHoverRadius: 6,
                },
            ],
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: { mode: 'index', intersect: false },
            },
            scales: {
                x: { grid: { color: '#e9e1d9' }, ticks: { color: '#7c746c' } },
                y: { grid: { color: '#e9e1d9' }, ticks: { color: '#7c746c' } },
            },
        },
    });
}

function updateCharts(data, liveTrend) {
    if (!funnelChart) return;
    const li = data.linkedin;
    funnelChart.data.datasets[0].data = [
        li.connection_requests,
        li.total_accepted,
        li.total_replied,
        li.demos_booked,
        li.qualified_demos,
        li.total_signups,
    ];
    funnelChart.update('active');

    // Update funnel subtitle
    const subtitleMap = { today: 'Today', week: 'This Week', month: 'This Month', last_month: 'Last Month', custom: 'Custom Range' };
    setText('funnelSubtitle', subtitleMap[currentPreset] || '');

    if (liveTrend && trendChart) {
        trendChart.data.labels = liveTrend.labels;
        trendChart.data.datasets[0].data = liveTrend.meetings;
        trendChart.data.datasets[1].data = liveTrend.signups;
        trendChart.data.datasets[2].data = liveTrend.demos || [];
        trendChart.update('active');
    }
}

/*
 * ─── GHL API Integration (uncomment to connect live data) ────────
 *
 * const GHL_API_KEY = 'YOUR_API_KEY_HERE';
 * const GHL_BASE    = 'https://services.leadconnectorhq.com';
 *
 * async function fetchLiveData(startIso, endIso) {
 *     const headers = { Authorization: `Bearer ${GHL_API_KEY}` };
 *
 *     // Meetings: GHL Calendar API
 *     const appts = await fetch(
 *         `${GHL_BASE}/calendars/events?startTime=${startIso}&endTime=${endIso}`,
 *         { headers }
 *     ).then(r => r.json());
 *
 *     // Opportunities / Pipeline
 *     const opps = await fetch(
 *         `${GHL_BASE}/opportunities/search?date_added=${startIso}&date_added_lte=${endIso}`,
 *         { headers }
 *     ).then(r => r.json());
 *
 *     return { appointments: appts, opportunities: opps };
 * }
 */
