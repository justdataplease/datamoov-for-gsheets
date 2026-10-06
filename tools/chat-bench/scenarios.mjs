// The chat benchmark's scenario matrix. Each scenario is a chained conversation in one session.
//
// Tab-data scenarios, five business domains, three turns: generate a dataset of N rows,
// summarize it per entity, category or period, build a dashboard. Prompts are worded the way
// different users write (terse, typos, polite) and are deliberately not the wording of any one
// production session; turns 2 and 3 rotate through three wordings each across runs, with
// different summaries (per entity, per category, per period) and dashboard intents (actionable
// only, a named set of charts, a scorecard), so a fix that only helps one phrasing or one
// intent does not move the totals. Run --runs 3 to cover every wording.
//
// Google Ads scenarios run over the real connector and a local fake of the API with fictional
// data (google-ads-fake.mjs): google_ads (a dashboard comparing periods, a "where is money
// wasted" question, an edit of the dashboard) and reports_dashboard (three reports saved through
// chat, then a dashboard over their tabs, then a refresh that brings more rows). Their prompts
// rotate between several wordings across runs.
//
// Each tab domain also carries a fictional seed schema, used only when turn 1 is skipped
// (--turns 2,3): the data tab then starts filled, and the transcript says what turn 1 made.
import { prng } from './random.mjs';

// N as the prompt writes it: "30,000" or "30000".
const written = (n, style) => (style === 'comma' ? n.toLocaleString('en-US') : String(n));

export const DOMAINS = [
  {
    id: 'retail',
    label: 'Retail orders',
    rows: 1000,
    style: 'comma',
    // Words the reply may use for the generated rows (claims check).
    nouns: ['orders', 'order', 'transactions', 'sales', 'records', 'rows', 'lines', 'entries'],
    entity: 'customer',
    turns: [
      (n) =>
        `can you create a dataset of ${n} retail orders for an online shop? realistic please, with customers, products, categories and amounts`,
      [
        () => 'thanks! now add a tab that summarizes it per customer',
        () => 'Please summarize revenue and units per product category in a new tab.',
        () => 'per month totals on another sheet pls',
      ],
      [
        () => 'build me a dashbaord w/ nice visuals, just the stuff i can actually act on',
        () =>
          'Create a dashboard with monthly revenue, the top 10 products and the average order value.',
        () => 'one-page sales overview for the owner: trend, best categories, slow sellers',
      ],
    ],
    seed: {
      tab: 'Orders',
      columns: [
        'Order ID',
        'Order Date',
        'Customer ID',
        'Category',
        'Product',
        'Quantity',
        'Unit Price',
        'Order Total',
      ],
      row: (i, rand, pick) => {
        const qty = 1 + Math.floor(rand() * 4);
        const price = Math.round((5 + rand() * 195) * 100) / 100;
        return [
          'ORD-' + (100001 + i),
          day(rand),
          'CUST-' + (1001 + Math.floor(rand() * 400)),
          pick(['Electronics', 'Home', 'Toys', 'Books', 'Beauty']),
          pick(['Item A', 'Item B', 'Item C', 'Item D']),
          qty,
          price,
          Math.round(qty * price * 100) / 100,
        ];
      },
    },
  },
  {
    id: 'saas',
    label: 'SaaS subscriptions',
    rows: 30000,
    style: 'plain',
    nouns: [
      'invoices',
      'invoice',
      'subscriptions',
      'subscription',
      'records',
      'rows',
      'lines',
      'entries',
    ],
    entity: 'plan',
    turns: [
      (n) =>
        `generate ${n} saas subscription invoices — customer, plan, billing month, MRR, status (paid/failed/refunded)`,
      [
        () => 'summary per plan pls on a new tab',
        () => 'Add a tab with MRR and invoice counts per billing month.',
        () => 'summarise by status (paid / failed / refunded) in its own sheet',
      ],
      [
        () =>
          'Could you put together a dashboard for the monthly leadership review? Clear charts, and only what we can act on: MRR trend, plan mix and failed payments.',
        () => 'dashboard: MRR by month and by plan, refund rate',
        () =>
          'Build a churn-risk view: which plans and months have the most failed or refunded invoices?',
      ],
    ],
    seed: {
      tab: 'Invoices',
      columns: ['Invoice ID', 'Customer', 'Plan', 'Billing Month', 'MRR', 'Status'],
      row: (i, rand, pick) => {
        const plan = pick(['Starter', 'Growth', 'Pro', 'Enterprise']);
        const mrr = { Starter: 29, Growth: 99, Pro: 299, Enterprise: 1200 }[plan];
        return [
          'INV-' + (500001 + i),
          'Account ' + (1 + Math.floor(rand() * 2500)),
          plan,
          month(rand),
          mrr,
          pick(['Paid', 'Paid', 'Paid', 'Failed', 'Refunded']),
        ];
      },
    },
  },
  {
    id: 'hr',
    label: 'HR headcount',
    rows: 100000,
    style: 'comma',
    nouns: [
      'employees',
      'employee',
      'records',
      'people',
      'staff',
      'rows',
      'lines',
      'entries',
      'workers',
    ],
    entity: 'department',
    turns: [
      (n) =>
        `I need a dataset of ${n} employee records for HR: department, location, hire date, salary, level and employment status.`,
      [
        () => 'Please create a summary tab per department with headcount and salary figures.',
        () => 'headcount by location and level, new tab',
        () => 'Summarize hires per year and the average salary per level on a separate sheet.',
      ],
      [
        () => 'make a dashbord with good charts, only actionable insights',
        () =>
          'An HR overview please: headcount trend by hire year, salary spread per department, attrition by location.',
        () => 'dashboard for the people team with the main headcount and pay numbers',
      ],
    ],
    seed: {
      tab: 'Employees',
      columns: ['Employee ID', 'Department', 'Location', 'Hire Date', 'Level', 'Salary', 'Status'],
      row: (i, rand, pick) => [
        'EMP-' + (200001 + i),
        pick(['Engineering', 'Sales', 'Support', 'Finance', 'HR', 'Marketing']),
        pick(['Berlin', 'Austin', 'Lisbon', 'Toronto']),
        day(rand, 2015, 11),
        pick(['L1', 'L2', 'L3', 'L4', 'L5']),
        Math.round(35000 + rand() * 115000),
        pick(['Active', 'Active', 'Active', 'On Leave', 'Terminated']),
      ],
    },
  },
  {
    id: 'logistics',
    label: 'Logistics shipments',
    rows: 5000,
    style: 'plain',
    nouns: [
      'shipments',
      'shipment',
      'deliveries',
      'records',
      'rows',
      'lines',
      'entries',
      'parcels',
    ],
    entity: 'carrier',
    turns: [
      (n) =>
        `create ${n} shipments for a logistics company, carriers, origin/destination, ship & delivery dates, cost, on-time or late`,
      [
        () => 'now a per-carrier summary in its own tab',
        () => 'Please add a summary of cost and on-time rate per origin and destination.',
        () => 'weekly shipment counts + spend, separate tab',
      ],
      [
        () =>
          'Great. Next, a visual dashboard for the ops team showing only what needs action: where are we late, and what is it costing us?',
        () => 'dashboard with shipments per month, cost per carrier and the on-time %',
        () => 'Can you build a carrier scorecard dashboard comparing cost and delivery times?',
      ],
    ],
    seed: {
      tab: 'Shipments',
      columns: [
        'Shipment ID',
        'Carrier',
        'Origin',
        'Destination',
        'Ship Date',
        'Delivery Date',
        'Cost',
        'On Time',
      ],
      row: (i, rand, pick) => {
        const ship = day(rand);
        return [
          'SHP-' + (700001 + i),
          pick(['FastFreight', 'BlueLine', 'Northway', 'ParcelGo']),
          pick(['Rotterdam', 'Hamburg', 'Lyon', 'Milan']),
          pick(['Madrid', 'Vienna', 'Prague', 'Oslo']),
          ship,
          new Date(ship.getTime() + (1 + Math.floor(rand() * 7)) * 86400000),
          Math.round((40 + rand() * 900) * 100) / 100,
          pick(['Yes', 'Yes', 'Yes', 'No']),
        ];
      },
    },
  },
  {
    id: 'marketing',
    label: 'Marketing leads',
    rows: 30000,
    style: 'comma',
    nouns: ['leads', 'lead', 'records', 'contacts', 'rows', 'lines', 'entries', 'opportunities'],
    entity: 'source',
    turns: [
      (n) =>
        `Hi! Could you generate a dataset of ${n} marketing leads for a B2B pipeline (source, campaign, created date, stage, deal value, owner)?`,
      [
        () => 'summarize by lead source in a separate sheet',
        () => 'Add a tab with pipeline value per owner and stage.',
        () => 'leads per month and win rate, new sheet please',
      ],
      [
        () =>
          'dashboard time: clean charts of pipeline by stage and source, plus which owners need help. skip vanity metrics',
        () =>
          'Please make a marketing dashboard: leads per month, conversion by campaign, total won value.',
        () => 'funnel dashboard, stage counts and deal value',
      ],
    ],
    seed: {
      tab: 'Leads',
      columns: ['Lead ID', 'Created Date', 'Source', 'Campaign', 'Stage', 'Deal Value', 'Owner'],
      row: (i, rand, pick) => [
        'LEAD-' + (300001 + i),
        day(rand),
        pick(['Organic', 'Paid Search', 'LinkedIn', 'Referral', 'Events']),
        pick(['Spring Promo', 'Webinar Q2', 'Retargeting', 'Newsletter']),
        pick(['New', 'Qualified', 'Proposal', 'Won', 'Lost']),
        Math.round(500 + rand() * 49500),
        pick(['Avery', 'Jordan', 'Riley', 'Sam']),
      ],
    },
  },
];

export const TAB_TURN_KINDS = ['generate', 'summarize', 'dashboard'];

function day(rand, fromYear = 2026, years = 1) {
  return new Date(Date.UTC(fromYear, 0, 1) + Math.floor(rand() * 365 * years) * 86400000);
}
function month(rand) {
  return new Date(Date.UTC(2026, Math.floor(rand() * 9), 1));
}

// The prompt of one turn (1-based) for N rows. A turn with several wordings rotates through them
// across runs ((run - 1) % length), as the Google Ads scenarios do, so no single phrasing (nor
// one dashboard intent, such as "only actionable") decides the totals.
export function promptFor(domain, turn, rows, run = 1) {
  const wordings = domain.turns[turn - 1];
  const wording = Array.isArray(wordings) ? wordings[(run - 1) % wordings.length] : wordings;
  return wording(written(rows, domain.style));
}

// Fictional rows for a skipped turn 1, and the transcript that says turn 1 made them.
export function seedData(domain, rows) {
  const rand = prng(20261005 + domain.id.length);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const table = [domain.seed.columns];
  for (let i = 0; i < rows; i++) table.push(domain.seed.row(i, rand, pick));
  const last = String.fromCharCode(64 + domain.seed.columns.length);
  const transcript = [
    { role: 'user', text: promptFor(domain, 1, rows) },
    {
      role: 'assistant',
      text: `I created the ${domain.seed.tab} tab with ${rows.toLocaleString('en-US')} rows in A1:${last}${rows + 1}. Columns: ${domain.seed.columns.join(', ')}.`,
      actions: [
        `Created tab ${domain.seed.tab}`,
        `Updated ${domain.seed.tab}!A1:${last}${rows + 1}`,
      ],
    },
  ];
  return { tab: domain.seed.tab, table, transcript };
}

// ---------- Google Ads scenarios ----------
// A turn: kind and the wordings it rotates through across runs ((run - 1) % length). An edit
// wording names what it asks for (weekly_chart, range_90), so the measure knows what to look for.
export const ADS_SCENARIOS = [
  {
    id: 'google_ads',
    label: 'Google Ads dashboard',
    family: 'ads',
    turns: [
      {
        kind: 'dashboard',
        prompts: [
          'build me a Google Ads performance dashboard: last 30 days compared to the previous 30',
          'Could you put together a dashboard of our Google Ads results for the last 30 days versus the period before?',
          'gads dashbaord pls, last 30d vs prior period',
        ],
      },
      {
        kind: 'analysis',
        prompts: [
          'which campaigns are wasting money?',
          'Are any of my campaigns spending without bringing conversions? Please list them with what they cost.',
          'where am i burning budget - which campaigns',
        ],
      },
      {
        kind: 'edit',
        prompts: [
          { text: 'add a weekly spend trend chart to the dashboard', edit: 'weekly_chart' },
          { text: 'Please change the dashboard to cover the last 90 days.', edit: 'range_90' },
          { text: 'can u also chart spend by week', edit: 'weekly_chart' },
        ],
      },
    ],
  },
  {
    id: 'reports_dashboard',
    label: 'Saved reports to dashboard',
    family: 'reports',
    // After the last turn the saved reports refresh with 20% more rows (refresh.mjs).
    refresh: { growth: 1.2 },
    turns: [
      {
        kind: 'save_report',
        prompts: [
          'save a report of daily campaign performance for the last 30 days in its own tab',
          'Please save a daily campaign report (last 30 days) to a new tab.',
          'save daily campaign stats last 30 days as a report tab',
        ],
      },
      {
        kind: 'save_report',
        prompts: [
          'now save a search terms report too, same period',
          'Can you also save a search term report for the last 30 days?',
          'search terms report as well pls',
        ],
      },
      {
        kind: 'save_report',
        prompts: [
          'and a keyword performance report',
          'Please add a saved keyword report as well, last 30 days.',
          'keywords report too, same dates',
        ],
      },
      {
        kind: 'dashboard',
        prompts: [
          'use those report tabs to build a dashboard',
          'Build a dashboard on top of the report tabs you just saved.',
          'make a dashbord from these 3 report tabs',
        ],
      },
    ],
  },
];

export const SCENARIO_IDS = DOMAINS.map((d) => d.id).concat(ADS_SCENARIOS.map((s) => s.id));

// One scenario as the conversation runner takes it: { id, label, family, turns: [{ n, kind,
// text, edit? }], rowsRequested, nouns, seed, refresh }.
export function buildScenario(id, { run = 1, turns = null, rows = null } = {}) {
  const domain = DOMAINS.find((d) => d.id === id);
  if (domain) {
    const n = rows ?? domain.rows;
    const chosen = (turns || [1, 2, 3]).filter((t) => t >= 1 && t <= 3);
    return {
      id,
      label: domain.label,
      family: 'tab',
      rowsRequested: n,
      nouns: domain.nouns,
      seed: chosen.includes(1) ? null : seedData(domain, n),
      turns: chosen.map((t) => ({
        n: t,
        kind: TAB_TURN_KINDS[t - 1],
        text: promptFor(domain, t, n, run),
      })),
    };
  }
  const spec = ADS_SCENARIOS.find((s) => s.id === id);
  if (!spec) throw new Error(`Unknown scenario ${id}; choose from ${SCENARIO_IDS.join(', ')}`);
  const chosen = (turns || spec.turns.map((_, i) => i + 1)).filter(
    (t) => t >= 1 && t <= spec.turns.length
  );
  return {
    id,
    label: spec.label,
    family: spec.family,
    rowsRequested: null,
    // Only row counts and ranges are claims the book can check here.
    nouns: ['rows', 'row'],
    seed: null,
    refresh: chosen.includes(spec.turns.length) ? spec.refresh || null : null,
    turns: chosen.map((t) => {
      const turn = spec.turns[t - 1];
      const wording = turn.prompts[(run - 1) % turn.prompts.length];
      return typeof wording === 'string'
        ? { n: t, kind: turn.kind, text: wording }
        : { n: t, kind: turn.kind, text: wording.text, edit: wording.edit };
    }),
  };
}
