/**
 * Mock data simulating responses from:
 *   - GHL Calendar API  (GET /calendars/events)
 *   - GHL Pipeline API  (GET /opportunities/search)
 *   - AimFox / Excel    (LinkedIn metrics)
 *   - Internal campaign tracking
 *
 * Replace MOCK_DATA[period] blocks with real API calls when integrating.
 */

const MOCK_DATA = {

    today: {
        main: {
            new_meetings_booked:    3,
            qualified_completed:    2,
            new_trial_signups:      1,
            cost_per_demo:          42,
            cost_per_trial_signup:  185,
            pipeline_value:         12_500,
            demos_completed:        2,
        },
        linkedin: {
            connection_requests:    48,
            total_accepted:         14,
            total_replied:          6,
            demos_booked:           2,
            qualified_demos:        1,
            cost_per_qualified_demo: 95,
            total_signups:          1,
            cost_per_trial_signup:  185,
        },
        cold_calling: {
            total_calls:            42,
            total_pickups:          11,
            positive_response:      4,
            demos_booked:           1,
            qualified_demos:        1,
            cost_per_qualified_demo: 115,
            total_signups:          0,
            cost_per_trial_signup:  0,
        },
    },

    week: {
        main: {
            new_meetings_booked:    18,
            qualified_completed:    11,
            new_trial_signups:      5,
            cost_per_demo:          78,
            cost_per_trial_signup:  220,
            pipeline_value:         67_000,
            demos_completed:        13,
        },
        linkedin: {
            connection_requests:    280,
            total_accepted:         79,
            total_replied:          31,
            demos_booked:           9,
            qualified_demos:        6,
            cost_per_qualified_demo: 118,
            total_signups:          3,
            cost_per_trial_signup:  236,
        },
        cold_calling: {
            total_calls:            215,
            total_pickups:          58,
            positive_response:      22,
            demos_booked:           9,
            qualified_demos:        5,
            cost_per_qualified_demo: 145,
            total_signups:          2,
            cost_per_trial_signup:  362,
        },
    },

    month: {
        main: {
            new_meetings_booked:    67,
            qualified_completed:    44,
            new_trial_signups:      19,
            cost_per_demo:          92,
            cost_per_trial_signup:  278,
            pipeline_value:         248_500,
            demos_completed:        51,
        },
        linkedin: {
            connection_requests:    1240,
            total_accepted:         347,
            total_replied:          128,
            demos_booked:           38,
            qualified_demos:        26,
            cost_per_qualified_demo: 132,
            total_signups:          11,
            cost_per_trial_signup:  312,
        },
        cold_calling: {
            total_calls:            890,
            total_pickups:          234,
            positive_response:      89,
            demos_booked:           29,
            qualified_demos:        18,
            cost_per_qualified_demo: 168,
            total_signups:          8,
            cost_per_trial_signup:  378,
        },
    },

    last_month: {
        main: {
            new_meetings_booked:    59,
            qualified_completed:    38,
            new_trial_signups:      15,
            cost_per_demo:          105,
            cost_per_trial_signup:  310,
            pipeline_value:         198_000,
            demos_completed:        43,
        },
        linkedin: {
            connection_requests:    1080,
            total_accepted:         291,
            total_replied:          103,
            demos_booked:           31,
            qualified_demos:        20,
            cost_per_qualified_demo: 148,
            total_signups:          8,
            cost_per_trial_signup:  340,
        },
        cold_calling: {
            total_calls:            760,
            total_pickups:          198,
            positive_response:      72,
            demos_booked:           22,
            qualified_demos:        14,
            cost_per_qualified_demo: 188,
            total_signups:          7,
            cost_per_trial_signup:  402,
        },
    },

};

/* ─── Campaign Lists ─────────────────────────────────────────── */
const CAMPAIGNS = {
    cold_calling: [
        {
            name:    "Q2 Healthcare Outreach",
            status:  "active",
            calls:   420,
            demos:   14,
            started: "Apr 1, 2026",
        },
        {
            name:    "SMB Tech Vertical — April",
            status:  "active",
            calls:   310,
            demos:   9,
            started: "Apr 5, 2026",
        },
        {
            name:    "Real Estate Brokers Q2",
            status:  "paused",
            calls:   160,
            demos:   6,
            started: "Mar 28, 2026",
        },
    ],
    linkedin: [
        {
            name:        "SaaS Founders April 2026",
            status:      "active",
            connections: 580,
            replies:     47,
            started:     "Apr 1, 2026",
        },
        {
            name:        "Healthcare Decision Makers",
            status:      "active",
            connections: 420,
            replies:     31,
            started:     "Apr 3, 2026",
        },
        {
            name:        "E-Commerce Directors",
            status:      "active",
            connections: 240,
            replies:     22,
            started:     "Apr 8, 2026",
        },
        {
            name:        "March SMB Push",
            status:      "ended",
            connections: 890,
            replies:     78,
            started:     "Mar 1, 2026",
        },
    ],
};

/* ─── Call Recordings ────────────────────────────────────────── */
const RECORDINGS = [
    { name: "Healthcare Outreach · Call #847", duration: "4:32", date: "Apr 17", outcome: "Demo Booked",    url: "#" },
    { name: "SMB Tech · Call #623",            duration: "2:18", date: "Apr 17", outcome: "Not Interested", url: "#" },
    { name: "Healthcare Outreach · Call #844", duration: "6:05", date: "Apr 16", outcome: "Follow Up",      url: "#" },
    { name: "Real Estate · Call #312",         duration: "3:47", date: "Apr 16", outcome: "Demo Booked",    url: "#" },
    { name: "SMB Tech · Call #618",            duration: "1:52", date: "Apr 15", outcome: "Voicemail",      url: "#" },
];

/* ─── LinkedIn Replies ───────────────────────────────────────── */
const LI_REPLIES = [
    { name: "Sarah Chen",       company: "MedTech Solutions",  msg: "Yes, I'd be open to a quick call next week.",        sentiment: "pos", time: "2h ago" },
    { name: "James Patterson",  company: "CloudBase Inc",       msg: "Not the right time for us, maybe Q3.",               sentiment: "neu", time: "3h ago" },
    { name: "Maria Rodriguez",  company: "HealthFirst Group",   msg: "Interesting! Can you send more details?",             sentiment: "pos", time: "5h ago" },
    { name: "David Kim",        company: "PropTech Ventures",   msg: "We're already using a competitor, thanks.",           sentiment: "neg", time: "6h ago" },
    { name: "Amanda Foster",    company: "RetailEdge Co",       msg: "This looks relevant. Let's connect.",                 sentiment: "pos", time: "8h ago" },
    { name: "Robert Chang",     company: "FinanceFlow LLC",     msg: "I'll check with my team and get back to you.",        sentiment: "neu", time: "1d ago"  },
    { name: "Lisa Thompson",    company: "AgriTech Partners",   msg: "Great timing! We need exactly this.",                 sentiment: "pos", time: "1d ago"  },
    { name: "Michael Brown",    company: "Secure Systems Inc",  msg: "Remove me from your list please.",                   sentiment: "neg", time: "1d ago"  },
    { name: "Jennifer Park",    company: "EduTech Hub",         msg: "We'd love to see a demo.",                            sentiment: "pos", time: "2d ago"  },
    { name: "Carlos Mendez",    company: "BioLogic Research",   msg: "Can we schedule for next month?",                    sentiment: "neu", time: "2d ago"  },
];

/* ─── Trend Data (6-month history) ──────────────────────────── */
const TREND = {
    labels:   ["Nov '25", "Dec '25", "Jan '26", "Feb '26", "Mar '26", "Apr '26"],
    meetings: [41, 38, 53, 61, 59, 67],
    signups:  [10, 9,  14, 17, 15, 19],
    demos:    [24, 22, 31, 36, 34, 43],
};
