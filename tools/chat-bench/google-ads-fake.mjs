// A local stand-in for the Google Ads API (dev tool, never deployed): deterministic, fictional
// account data (an online language school; every name and id is made up) served through the
// same HTTP shapes src/connectors/google_ads.js parses: POST customers/{id}/googleAds:search with
// a GAQL query, pages of 10,000 rows with nextPageToken, nested camelCase rows with int64 values
// as strings, and Google's error body for a query it rejects; plus googleAdsFields:search for
// field discovery.
//
// The data is built bottom-up so every level agrees: keyword days sum to their ad group and
// search campaign, campaign days sum to the account. Search terms are their own long tail (as in
// Google Ads they do not add up to the keywords). Some campaigns spend without converting, a few
// are paused (and stop spending that day), one launched mid-period. growth > 1 adds campaigns,
// keywords and search terms (existing campaigns and keywords keep their ids and daily rows; the
// search-term tail is redrawn), to simulate a refresh that brings more rows.
//
// GAQL support: SELECT / FROM / WHERE (AND of =, !=, <, <=, >, >=, IN, NOT IN, LIKE, NOT LIKE,
// IS [NOT] NULL, BETWEEN, DURING, REGEXP_MATCH, CONTAINS ANY) / ORDER BY / LIMIT / PARAMETERS;
// segments date, week, month, quarter, year, day_of_week, device, ad_network_type,
// conversion_action_name/category, keyword.info.* (search terms). Resources it holds no data for
// answer with no rows.
import { prng } from './random.mjs';

const DAY = 86400000;
export const CUSTOMER_ID = '1234567890';
const ACCOUNT = {
  id: CUSTOMER_ID,
  descriptiveName: 'Lingoloop Language School (fictional)',
  currencyCode: 'USD',
  timeZone: 'America/New_York',
};
export const HISTORY_DAYS = 120;
const PAGE = 10000;

const seeded = (...parts) =>
  prng(parts.reduce((h, p) => Math.imul(h ^ p, 2654435761) >>> 0, 20261005));
function poisson(rand, lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 40) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(rand)));
  const limit = Math.exp(-lambda);
  let k = 0,
    p = 1;
  do {
    k++;
    p *= rand();
  } while (p > limit);
  return k - 1;
}
function binomial(rand, n, p) {
  if (n <= 0 || p <= 0) return 0;
  if (n > 60)
    return Math.min(n, Math.max(0, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * gauss(rand))));
  let k = 0;
  for (let i = 0; i < n; i++) if (rand() < p) k++;
  return k;
}
function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}

// ---------- the fictional account ----------
// theme: the words its keywords grow from; zero: spends but never converts.
const CAMPAIGNS = [
  {
    name: 'Search - Brand',
    channel: 'SEARCH',
    theme: 'lingoloop',
    scale: 1.4,
    ctr: 0.12,
    cpc: 0.6,
    cvr: 0.11,
  },
  { name: 'Search - Spanish Courses', channel: 'SEARCH', theme: 'spanish', scale: 1.6, cvr: 0.045 },
  { name: 'Search - French Courses', channel: 'SEARCH', theme: 'french', scale: 1.2, cvr: 0.04 },
  { name: 'Search - German Courses', channel: 'SEARCH', theme: 'german', scale: 1.0, cvr: 0.035 },
  {
    name: 'Search - Business English',
    channel: 'SEARCH',
    theme: 'business english',
    scale: 1.1,
    cpc: 2.4,
    cvr: 0.03,
  },
  {
    name: 'Search - Kids Lessons',
    channel: 'SEARCH',
    theme: 'kids language',
    scale: 0.8,
    cvr: 0.025,
  },
  {
    name: 'Search - Exam Prep',
    channel: 'SEARCH',
    theme: 'ielts',
    scale: 0.9,
    cpc: 2.1,
    cvr: 0.05,
  },
  {
    name: 'Search - Competitor Terms',
    channel: 'SEARCH',
    theme: 'language app',
    scale: 1.0,
    cpc: 2.8,
    cvr: 0.006,
  },
  {
    name: 'Search - Online Tutors',
    channel: 'SEARCH',
    theme: 'online tutor',
    scale: 0.9,
    cvr: 0.03,
  },
  {
    name: 'Search - Japanese Courses',
    channel: 'SEARCH',
    theme: 'japanese',
    scale: 0.7,
    cvr: 0.03,
    pausedDaysAgo: 45,
  },
  { name: 'Search - Italian Courses', channel: 'SEARCH', theme: 'italian', scale: 0.7, cvr: 0.035 },
  {
    name: 'Search - Pronunciation Tools',
    channel: 'SEARCH',
    theme: 'pronunciation',
    scale: 0.6,
    cpc: 1.7,
    zero: true,
  },
  {
    name: 'Search - Free Trial',
    channel: 'SEARCH',
    theme: 'free language',
    scale: 0.8,
    cpc: 0.9,
    cvr: 0.015,
  },
  {
    name: 'Search - Corporate Training',
    channel: 'SEARCH',
    theme: 'corporate language',
    scale: 0.6,
    cpc: 3.6,
    cvr: 0.02,
  },
  {
    name: 'Search - Grammar Checker',
    channel: 'SEARCH',
    theme: 'grammar',
    scale: 0.5,
    cpc: 1.3,
    zero: true,
  },
  {
    name: 'Search - Portuguese Courses',
    channel: 'SEARCH',
    theme: 'portuguese',
    scale: 0.5,
    cvr: 0.03,
    launchedDaysAgo: 21,
  },
  {
    name: 'Search - Chinese Courses',
    channel: 'SEARCH',
    theme: 'mandarin',
    scale: 0.6,
    cvr: 0.025,
    pausedDaysAgo: 80,
  },
  {
    name: 'Search - Dynamic All Pages',
    channel: 'SEARCH',
    theme: 'language course',
    scale: 0.7,
    cvr: 0.02,
  },
  {
    name: 'PMax - All Courses',
    channel: 'PERFORMANCE_MAX',
    scale: 2.0,
    cpc: 0.9,
    ctr: 0.012,
    cvr: 0.03,
  },
  {
    name: 'PMax - Corporate',
    channel: 'PERFORMANCE_MAX',
    scale: 0.8,
    cpc: 1.4,
    ctr: 0.01,
    cvr: 0.012,
    pausedDaysAgo: 10,
  },
  {
    name: 'Display - Remarketing',
    channel: 'DISPLAY',
    scale: 1.0,
    cpc: 0.45,
    ctr: 0.006,
    cvr: 0.02,
  },
  {
    name: 'Display - Prospecting Interests',
    channel: 'DISPLAY',
    scale: 1.2,
    cpc: 0.35,
    ctr: 0.004,
    zero: true,
  },
  { name: 'Video - Brand Story', channel: 'VIDEO', scale: 1.1, cpc: 0.7, ctr: 0.003, cvr: 0.004 },
  {
    name: 'Video - Student Testimonials',
    channel: 'VIDEO',
    scale: 0.8,
    cpc: 0.8,
    ctr: 0.003,
    zero: true,
  },
  {
    name: 'Demand Gen - Lookalikes',
    channel: 'DEMAND_GEN',
    scale: 0.9,
    cpc: 0.55,
    ctr: 0.008,
    cvr: 0.01,
  },
  // Added by a refresh with growth (20% more campaigns).
  { name: 'Search - Korean Courses', channel: 'SEARCH', theme: 'korean', scale: 0.6, cvr: 0.03 },
  { name: 'Search - Arabic Courses', channel: 'SEARCH', theme: 'arabic', scale: 0.5, cvr: 0.02 },
  {
    name: 'Search - Summer Intensive',
    channel: 'SEARCH',
    theme: 'intensive language',
    scale: 0.6,
    cvr: 0.03,
  },
  { name: 'PMax - Kids', channel: 'PERFORMANCE_MAX', scale: 0.7, cpc: 0.8, ctr: 0.01, cvr: 0.015 },
  {
    name: 'Display - Cart Remarketing',
    channel: 'DISPLAY',
    scale: 0.5,
    cpc: 0.5,
    ctr: 0.007,
    zero: true,
  },
];
const BASE_CAMPAIGNS = 25;
const AD_GROUP_WORDS = ['course', 'lessons', 'learn', 'classes', 'tutor', 'online'];
const MODIFIERS = [
  'online',
  'for beginners',
  'app',
  'near me',
  'free',
  'best',
  'cheap',
  'advanced',
  'fast',
  'with certificate',
  'for adults',
  'for kids',
  'intensive',
  'weekend',
  'private',
  'group',
  'one to one',
  'conversation',
  'grammar',
  'vocabulary',
  'price',
  'reviews',
  'trial',
  'evening',
  'course fees',
  'b1 level',
  'a2 level',
  'c1 level',
  'for travel',
  'for work',
];
const TAILS = [
  '2026',
  'cost',
  'how long',
  'is it worth it',
  'vs duolingo',
  'jobs',
  'salary',
  'pdf',
  'book',
  'youtube',
  'reddit',
  'meaning',
  'translate',
  'download',
  'login',
  'uk',
  'usa',
  'canada',
  'australia',
  'india',
  'nyc',
  'london',
  'chicago',
  'toronto',
  'boston',
  'seattle',
  'austin',
  'denver',
  'miami',
  'dallas',
  'part time',
  'full time',
  'summer',
  'winter',
  'saturday',
  'sunday',
  'certificate',
  'exam',
  'test',
  'quiz',
  'games',
  'songs',
  'podcast',
  'movies',
  'news',
];
const MATCH = ['EXACT', 'PHRASE', 'BROAD'];
const DEVICES = [
  ['MOBILE', 0.58],
  ['DESKTOP', 0.36],
  ['TABLET', 0.06],
];
const ACTIONS = [
  ['Course purchase', 'PURCHASE', 0.72],
  ['Free trial sign-up', 'SIGNUP', 0.28],
];
const NETWORK = {
  SEARCH: 'SEARCH',
  PERFORMANCE_MAX: 'MIXED',
  DISPLAY: 'CONTENT',
  VIDEO: 'YOUTUBE',
  DEMAND_GEN: 'MIXED',
};
const SUBTYPE = { DEMAND_GEN: 'DEMAND_GEN_MULTI_FORMAT', VIDEO: 'VIDEO_ACTION' };
const BIDDING = {
  SEARCH: 'MAXIMIZE_CONVERSIONS',
  PERFORMANCE_MAX: 'MAXIMIZE_CONVERSION_VALUE',
  DISPLAY: 'TARGET_CPA',
  VIDEO: 'TARGET_CPM',
  DEMAND_GEN: 'MAXIMIZE_CLICKS',
};
const AD_GROUP_TYPE = {
  SEARCH: 'SEARCH_STANDARD',
  DISPLAY: 'DISPLAY_STANDARD',
  VIDEO: 'VIDEO_TRUE_VIEW_IN_STREAM',
  DEMAND_GEN: 'DEMAND_GEN_MULTI_FORMAT',
};
const NEGATIVES = ['jobs', 'salary', 'free pdf', 'translate', 'download', 'meaning'];

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const zero = () => ({ impr: 0, clicks: 0, cost: 0, conv: 0, value: 0, views: 0, vtc: 0 });
function add(into, r) {
  into.impr += r.impr;
  into.clicks += r.clicks;
  into.cost += r.cost;
  into.conv += r.conv;
  into.value += r.value;
  into.views += r.views || 0;
  into.vtc += r.vtc || 0;
  return into;
}

// variant: 'normal' (about 3,500 search terms) or 'large' (about 100,000); growth: entity scale.
export function createGoogleAdsData({ variant = 'normal', today, growth = 1 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today)))
    throw new Error('google-ads-fake: today as YYYY-MM-DD');
  const end = Date.parse(today + 'T12:00:00Z') - DAY; // yesterday, the last day with data
  const dates = Array.from({ length: HISTORY_DAYS }, (_, i) =>
    iso(end - (HISTORY_DAYS - 1 - i) * DAY)
  );
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const termTarget = (variant === 'large' ? 140000 : 3500) * growth; // large: about 100,000 in the last 30 days
  const campaignCount = Math.min(CAMPAIGNS.length, Math.round(BASE_CAMPAIGNS * growth));
  const grow = (n) => Math.max(1, Math.round(n * growth));
  const seasonal = dates.map((d, i) => {
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    return (wd === 0 || wd === 6 ? 0.78 : 1.05) * (0.9 + (0.2 * i) / HISTORY_DAYS);
  });

  const campaigns = [],
    adGroups = [],
    keywords = [],
    terms = [],
    negatives = [];
  for (let ci = 0; ci < campaignCount; ci++) {
    const spec = CAMPAIGNS[ci];
    const rand = seeded(1, ci);
    const id = String(17000000000 + ci * 7919 + 101);
    const first = spec.launchedDaysAgo ? HISTORY_DAYS - spec.launchedDaysAgo : 0;
    const last = spec.pausedDaysAgo ? HISTORY_DAYS - 1 - spec.pausedDaysAgo : HISTORY_DAYS - 1;
    const campaign = {
      index: ci,
      id,
      name: spec.name,
      channel: spec.channel,
      status: spec.pausedDaysAgo ? 'PAUSED' : 'ENABLED',
      first,
      last,
      budgetMicros: Math.round((40 + rand() * 260) * spec.scale) * 1000000,
      startDate: dates[first],
      days: new Map(), // day index -> metrics
      impressionShare: Math.round((0.25 + rand() * 0.6) * 10000) / 10000,
      lostBudget: Math.round(rand() * 0.3 * 10000) / 10000,
      spec,
    };
    campaign.lostRank =
      Math.round(Math.max(0, 1 - campaign.impressionShare - campaign.lostBudget) * 10000) / 10000;
    campaigns.push(campaign);
    const cpc = spec.cpc || 1.1 + rand() * 1.4;
    const ctr = spec.ctr || 0.035 + rand() * 0.05;
    const cvr = spec.zero ? 0 : spec.cvr || 0.03;
    const aov = 60 + Math.round(rand() * 240); // dollars per conversion
    if (spec.channel === 'SEARCH') {
      const groups = 3 + Math.floor(rand() * 3);
      for (let gi = 0; gi < groups; gi++) {
        const group = {
          id: String(140000000000 + ci * 1000 + gi * 17 + 3),
          name: `${spec.theme} ${AD_GROUP_WORDS[gi % AD_GROUP_WORDS.length]}`.replace(/^./, (c) =>
            c.toUpperCase()
          ),
          campaign,
          status: 'ENABLED',
          type: 'SEARCH_STANDARD',
          days: new Map(),
          keywords: [],
        };
        adGroups.push(group);
        const baseKeywords = 10 + Math.floor(rand() * 14);
        group.baseCount = baseKeywords;
        const count = grow(baseKeywords);
        for (let ki = 0; ki < count; ki++) {
          const kr = seeded(2, ci, gi, ki);
          const text =
            ki === 0
              ? `${spec.theme} ${AD_GROUP_WORDS[gi % AD_GROUP_WORDS.length]}`
              : `${spec.theme} ${AD_GROUP_WORDS[gi % AD_GROUP_WORDS.length]} ${MODIFIERS[(ki * 7 + gi) % MODIFIERS.length]}${ki >= MODIFIERS.length ? ' ' + TAILS[ki % TAILS.length] : ''}`;
          const keyword = {
            id: String(300000000 + ci * 100000 + gi * 1000 + ki),
            text,
            match: MATCH[(ki + gi) % 3],
            group,
            campaign,
            status: kr() < 0.08 ? 'PAUSED' : 'ENABLED',
            quality: 1 + Math.floor(kr() * 10),
            weight: 1 / Math.pow(ki + 1, 0.9),
            ctr: ctr * (0.5 + kr()),
            cpc: cpc * (0.6 + kr() * 0.8),
            // A few keywords of a converting campaign never convert either.
            cvr: kr() < 0.15 ? 0 : cvr * (0.4 + kr() * 1.2),
            aov,
            days: [],
          };
          group.keywords.push(keyword);
          keywords.push(keyword);
        }
      }
      const totalWeight = campaign.spec.scale * 900; // impressions a day across the campaign
      const groupKeywords = adGroups
        .filter((g) => g.campaign === campaign)
        .flatMap((g) => g.keywords);
      // Normalized over the keywords before growth, so a keyword keeps its numbers when more arrive.
      const weightSum = adGroups
        .filter((g) => g.campaign === campaign)
        .reduce(
          (a, g) =>
            a +
            Array.from({ length: g.baseCount }, (_, k) => 1 / Math.pow(k + 1, 0.9)).reduce(
              (x, y) => x + y,
              0
            ),
          0
        );
      for (const keyword of groupKeywords) {
        if (keyword.status === 'PAUSED') continue;
        const kr = seeded(3, Number(keyword.id));
        const lambda = (totalWeight * keyword.weight) / weightSum;
        for (let d = first; d <= last; d++) {
          const impr = poisson(kr, lambda * seasonal[d]);
          if (!impr) continue;
          const clicks = binomial(kr, impr, keyword.ctr);
          const cost = clicks
            ? Math.round(clicks * keyword.cpc * (0.85 + kr() * 0.3) * 100) * 10000
            : 0;
          const conv = binomial(kr, clicks, keyword.cvr);
          const value = conv * keyword.aov * 100; // cents
          const row = { d, impr, clicks, cost, conv, value, views: 0, vtc: 0 };
          keyword.days.push(row);
          if (!keyword.group.days.has(d)) keyword.group.days.set(d, zero());
          add(keyword.group.days.get(d), row);
          if (!campaign.days.has(d)) campaign.days.set(d, zero());
          add(campaign.days.get(d), row);
        }
      }
    } else {
      const lambda =
        spec.scale * (spec.channel === 'DISPLAY' || spec.channel === 'VIDEO' ? 14000 : 6000);
      const viewRate = spec.channel === 'VIDEO' ? 0.22 + rand() * 0.15 : 0;
      for (let d = first; d <= last; d++) {
        const impr = poisson(rand, lambda * seasonal[d]);
        if (!impr) continue;
        const clicks = binomial(rand, impr, ctr * (0.8 + rand() * 0.4));
        const views = viewRate ? binomial(rand, impr, viewRate) : 0;
        const cost =
          spec.channel === 'VIDEO'
            ? Math.round(views * 0.035 * (0.85 + rand() * 0.3) * 100) * 10000
            : Math.round(clicks * cpc * (0.85 + rand() * 0.3) * 100) * 10000;
        const conv = binomial(rand, clicks, cvr);
        const vtc = spec.zero ? 0 : binomial(rand, Math.round(impr / 1000), 0.2);
        campaign.days.set(d, { impr, clicks, cost, conv, value: conv * aov * 100, views, vtc });
      }
      // One ad group (asset group for Performance Max) carries the campaign's numbers.
      adGroups.push({
        id: String(140000000000 + ci * 1000 + 999),
        name:
          spec.channel === 'PERFORMANCE_MAX'
            ? 'Asset group 1'
            : `${spec.name.split(' - ')[1]} - main`,
        campaign,
        status: 'ENABLED',
        type: AD_GROUP_TYPE[spec.channel] || 'UNSPECIFIED',
        days: campaign.days,
        keywords: [],
        assetGroup: spec.channel === 'PERFORMANCE_MAX',
      });
    }
    if (spec.channel === 'SEARCH' && ci % 3 === 0)
      for (let n = 0; n < 3; n++)
        negatives.push({
          id: String(900000 + ci * 10 + n),
          campaign,
          text: NEGATIVES[(ci + n) % NEGATIVES.length],
          match: n ? 'PHRASE' : 'BROAD',
        });
  }
  // Search terms: a long tail per keyword (more for heavier keywords), each seen on a few days.
  const live = keywords.filter((k) => k.days.length);
  const liveWeight = live.reduce((a, k) => a + k.weight, 0);
  const seen = new Set();
  let assigned = 0;
  live.forEach((keyword, n) => {
    const share =
      n === live.length - 1
        ? Math.max(0, Math.round(termTarget) - assigned)
        : Math.round((termTarget * keyword.weight) / liveWeight);
    assigned += share;
    const tr = seeded(4, Number(keyword.id));
    const activeDays = keyword.days.map((x) => x.d);
    for (let t = 0; t < share; t++) {
      const base = keyword.text;
      let text = '';
      for (
        let attempt = 0;
        attempt < 6 && (!text || seen.has(keyword.group.id + '|' + text));
        attempt++
      ) {
        const a = MODIFIERS[Math.floor(tr() * MODIFIERS.length)];
        const b = TAILS[Math.floor(tr() * TAILS.length)];
        text = t === 0 && attempt === 0 ? base : attempt < 3 ? `${base} ${b}` : `${a} ${base} ${b}`;
        if (attempt === 5) text = `${base} ${b} ${t}`;
      }
      seen.add(keyword.group.id + '|' + text);
      // Irrelevant terms (a fifth) click but never convert: what a negative-keyword list is for.
      const irrelevant = tr() < 0.2;
      const termDays = new Map();
      const count = 1 + Math.floor(tr() * tr() * 6);
      // Mostly recent: half the terms land a day in the last 30 days.
      for (let k = 0; k < count; k++) {
        const pool =
          k === 0 && tr() < 0.6 ? activeDays.filter((d) => d >= HISTORY_DAYS - 30) : activeDays;
        const list = pool.length ? pool : activeDays;
        const d = list[Math.floor(tr() * list.length)];
        if (termDays.has(d)) continue;
        const impr = 1 + poisson(tr, 2 + 30 * keyword.weight * tr());
        const clicks = binomial(tr, impr, keyword.ctr * (irrelevant ? 0.8 : 1.1));
        const cost = clicks
          ? Math.round(clicks * keyword.cpc * (0.85 + tr() * 0.3) * 100) * 10000
          : 0;
        const conv = irrelevant ? 0 : binomial(tr, clicks, keyword.cvr * 1.2);
        termDays.set(d, {
          d,
          impr,
          clicks,
          cost,
          conv,
          value: conv * keyword.aov * 100,
          views: 0,
          vtc: 0,
        });
      }
      const r = tr();
      terms.push({
        text,
        keyword,
        group: keyword.group,
        campaign: keyword.campaign,
        status: r < 0.04 ? 'ADDED' : r < 0.07 ? 'EXCLUDED' : 'NONE',
        days: [...termDays.values()].sort((a, b) => a.d - b.d),
      });
    }
  });
  const account = { days: new Map() };
  for (const campaign of campaigns)
    for (const [d, row] of campaign.days) {
      if (!account.days.has(d)) account.days.set(d, zero());
      add(account.days.get(d), row);
    }
  return {
    variant,
    today,
    growth,
    dates,
    dayIndex,
    campaigns,
    adGroups,
    keywords,
    terms,
    negatives,
    account,
  };
}

// ---------- ground truth ----------
// Inclusive date window of a preset, as src/dmv_core.js dmvDateRange_ computes it.
export function presetWindow(preset, today) {
  const day = Date.parse(today + 'T12:00:00Z');
  const end = day - DAY;
  const n = {
    last7: 7,
    last14: 14,
    last30: 30,
    last90: 90,
    previous7: 7,
    previous14: 14,
    previous30: 30,
    previous90: 90,
  }[preset];
  if (!n) throw new Error('presetWindow: ' + preset);
  const stop = preset.startsWith('previous') ? end - n * DAY : end;
  return { startDate: iso(stop - (n - 1) * DAY), endDate: iso(stop) };
}

// Per campaign totals over [startDate, endDate]: spend and conversion value in dollars.
export function campaignTotals(data, { startDate, endDate }) {
  const lo = data.dates.findIndex((d) => d >= startDate);
  const hi = data.dates.length - 1 - [...data.dates].reverse().findIndex((d) => d <= endDate);
  return data.campaigns.map((c) => {
    const t = zero();
    for (const [d, row] of c.days) if (d >= lo && d <= hi && lo >= 0) add(t, row);
    return {
      name: c.name,
      id: c.id,
      status: c.status,
      channel: c.channel,
      impressions: t.impr,
      clicks: t.clicks,
      spend: t.cost / 1e6,
      conversions: t.conv,
      value: t.value / 100,
    };
  });
}

// The facts a reply can be checked against: totals and per-campaign values (spend, clicks,
// impressions, conversions, value, CTR, CPC, CPA, ROAS, conversion rate, spend share) for the
// usual windows, and the period-over-period changes of the totals.
export function groundTruth(data) {
  const windows = {};
  for (const preset of [
    'last7',
    'last14',
    'last30',
    'previous30',
    'last90',
    'previous7',
    'previous14',
  ])
    windows[preset] = presetWindow(preset, data.today);
  windows.all = { startDate: data.dates[0], endDate: data.dates[data.dates.length - 1] };
  const out = { windows, periods: {} };
  for (const [key, window] of Object.entries(windows)) {
    const rows = campaignTotals(data, window);
    const total = rows.reduce(
      (a, r) => ({
        impressions: a.impressions + r.impressions,
        clicks: a.clicks + r.clicks,
        spend: a.spend + r.spend,
        conversions: a.conversions + r.conversions,
        value: a.value + r.value,
      }),
      { impressions: 0, clicks: 0, spend: 0, conversions: 0, value: 0 }
    );
    out.periods[key] = {
      window,
      total,
      campaigns: rows,
      // Spend with no conversion in the window: the waste a "which campaigns waste money" answer
      // must name.
      zeroConversion: rows.filter((r) => r.spend > 0 && r.conversions === 0).map((r) => r.name),
    };
  }
  return out;
}

// ---------- GAQL ----------
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const RESOURCES_WITH_DATA = [
  'customer',
  'campaign',
  'campaign_budget',
  'ad_group',
  'ad_group_ad',
  'keyword_view',
  'search_term_view',
  'asset_group',
  'ad_group_criterion',
  'campaign_criterion',
];
const EMPTY_RESOURCES = [
  'geographic_view',
  'user_location_view',
  'age_range_view',
  'gender_view',
  'landing_page_view',
  'expanded_landing_page_view',
  'group_placement_view',
  'detail_placement_view',
  'shopping_performance_view',
  'ad_group_audience_view',
  'campaign_audience_view',
  'ad_group_ad_asset_view',
  'asset',
  'conversion_action',
  'bidding_strategy',
  'label',
  'change_event',
  'recommendation',
  'customer_client',
  'display_keyword_view',
  'topic_view',
  'video',
  'dynamic_search_ads_search_term_view',
  'paid_organic_search_term_view',
  'asset_group_asset',
  'campaign_search_term_insight',
];
// Parents whose attributes a resource may select.
const PARENTS = {
  customer: [],
  campaign: ['customer', 'campaign_budget'],
  campaign_budget: ['customer'],
  ad_group: ['campaign', 'customer', 'campaign_budget'],
  ad_group_ad: ['ad_group', 'campaign', 'customer'],
  keyword_view: ['ad_group_criterion', 'ad_group', 'campaign', 'customer'],
  search_term_view: ['ad_group', 'campaign', 'customer'],
  asset_group: ['campaign', 'customer'],
  ad_group_criterion: ['ad_group', 'campaign', 'customer'],
  campaign_criterion: ['campaign', 'customer'],
};
const NO_METRICS = new Set(['ad_group_criterion', 'campaign_criterion']);

const res = (c) => `customers/${CUSTOMER_ID}/campaigns/${c.id}`;
// Attribute getters: entity e = { campaign, group, keyword, term, negative, ad }.
const ATTRIBUTES = {
  customer: {
    id: () => CUSTOMER_ID,
    descriptive_name: () => ACCOUNT.descriptiveName,
    currency_code: () => ACCOUNT.currencyCode,
    time_zone: () => ACCOUNT.timeZone,
    resource_name: () => `customers/${CUSTOMER_ID}`,
    status: () => 'ENABLED',
    manager: () => false,
    test_account: () => false,
    auto_tagging_enabled: () => true,
  },
  campaign: {
    id: (e) => e.campaign.id,
    name: (e) => e.campaign.name,
    status: (e) => e.campaign.status,
    serving_status: (e) => (e.campaign.status === 'ENABLED' ? 'SERVING' : 'NONE'),
    primary_status: (e) => (e.campaign.status === 'ENABLED' ? 'ELIGIBLE' : 'PAUSED'),
    advertising_channel_type: (e) => e.campaign.channel,
    advertising_channel_sub_type: (e) => SUBTYPE[e.campaign.channel] || 'UNSPECIFIED',
    bidding_strategy_type: (e) => BIDDING[e.campaign.channel],
    start_date: (e) => e.campaign.startDate,
    end_date: () => '2037-12-30',
    resource_name: (e) => res(e.campaign),
    campaign_budget: (e) => `customers/${CUSTOMER_ID}/campaignBudgets/${Number(e.campaign.id) + 5}`,
    optimization_score: (e) => Math.round((0.55 + (e.campaign.index % 7) * 0.06) * 1000) / 1000,
    'network_settings.target_google_search': (e) => e.campaign.channel === 'SEARCH',
    'network_settings.target_search_network': (e) => e.campaign.channel === 'SEARCH',
    'network_settings.target_content_network': (e) => e.campaign.channel !== 'SEARCH',
  },
  campaign_budget: {
    id: (e) => String(Number(e.campaign.id) + 5),
    name: (e) => `${e.campaign.name} budget`,
    amount_micros: (e) => String(e.campaign.budgetMicros),
    delivery_method: () => 'STANDARD',
    status: () => 'ENABLED',
    explicitly_shared: () => false,
    resource_name: (e) => `customers/${CUSTOMER_ID}/campaignBudgets/${Number(e.campaign.id) + 5}`,
  },
  ad_group: {
    id: (e) => e.group.id,
    name: (e) => e.group.name,
    status: (e) => e.group.status,
    type: (e) => e.group.type,
    campaign: (e) => res(e.campaign),
    cpc_bid_micros: (e) => String(1500000 + (Number(e.group.id) % 9) * 100000),
    resource_name: (e) => `customers/${CUSTOMER_ID}/adGroups/${e.group.id}`,
  },
  ad_group_ad: {
    'ad.id': (e) => String(Number(e.group.id) + 77),
    'ad.name': (e) => `${e.group.name} ad`,
    'ad.type': (e) =>
      e.campaign.channel === 'SEARCH'
        ? 'RESPONSIVE_SEARCH_AD'
        : e.campaign.channel === 'VIDEO'
          ? 'VIDEO_RESPONSIVE_AD'
          : 'RESPONSIVE_DISPLAY_AD',
    'ad.final_urls': (e) => [
      `https://www.example.com/${e.campaign.name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
    ],
    status: () => 'ENABLED',
    ad_strength: (e) => ['GOOD', 'EXCELLENT', 'AVERAGE', 'POOR'][Number(e.group.id) % 4],
    'policy_summary.approval_status': () => 'APPROVED',
    resource_name: (e) =>
      `customers/${CUSTOMER_ID}/adGroupAds/${e.group.id}~${Number(e.group.id) + 77}`,
  },
  ad_group_criterion: {
    criterion_id: (e) => (e.keyword ? e.keyword.id : e.negative.id),
    'keyword.text': (e) => (e.keyword ? e.keyword.text : e.negative.text),
    'keyword.match_type': (e) => (e.keyword ? e.keyword.match : e.negative.match),
    status: (e) => (e.keyword ? e.keyword.status : 'ENABLED'),
    negative: (e) => !e.keyword,
    type: () => 'KEYWORD',
    display_name: (e) => (e.keyword ? e.keyword.text : e.negative.text),
    'quality_info.quality_score': (e) => (e.keyword ? e.keyword.quality : undefined),
    'quality_info.creative_quality_score': (e) =>
      e.keyword ? ['BELOW_AVERAGE', 'AVERAGE', 'ABOVE_AVERAGE'][e.keyword.quality % 3] : undefined,
    'quality_info.post_click_quality_score': (e) =>
      e.keyword ? ['AVERAGE', 'ABOVE_AVERAGE', 'BELOW_AVERAGE'][e.keyword.quality % 3] : undefined,
    'quality_info.search_predicted_ctr': (e) =>
      e.keyword ? ['ABOVE_AVERAGE', 'BELOW_AVERAGE', 'AVERAGE'][e.keyword.quality % 3] : undefined,
    cpc_bid_micros: (e) =>
      e.keyword ? String(Math.round(e.keyword.cpc * 1.3 * 100) * 10000) : undefined,
    effective_cpc_bid_micros: (e) =>
      e.keyword ? String(Math.round(e.keyword.cpc * 1.3 * 100) * 10000) : undefined,
    system_serving_status: (e) =>
      e.keyword && e.keyword.quality <= 2 ? 'RARELY_SERVED' : 'ELIGIBLE',
    approval_status: () => 'APPROVED',
    final_urls: () => [],
    resource_name: (e) =>
      `customers/${CUSTOMER_ID}/adGroupCriteria/${e.group.id}~${e.keyword ? e.keyword.id : e.negative.id}`,
  },
  campaign_criterion: {
    criterion_id: (e) => e.negative.id,
    'keyword.text': (e) => e.negative.text,
    'keyword.match_type': (e) => e.negative.match,
    negative: () => true,
    type: () => 'KEYWORD',
    status: () => 'ENABLED',
    display_name: (e) => e.negative.text,
    resource_name: (e) =>
      `customers/${CUSTOMER_ID}/campaignCriteria/${e.campaign.id}~${e.negative.id}`,
  },
  keyword_view: {
    resource_name: (e) => `customers/${CUSTOMER_ID}/keywordViews/${e.group.id}~${e.keyword.id}`,
  },
  search_term_view: {
    search_term: (e) => e.term.text,
    status: (e) => e.term.status,
    ad_group: (e) => `customers/${CUSTOMER_ID}/adGroups/${e.group.id}`,
    resource_name: (e) =>
      `customers/${CUSTOMER_ID}/searchTermViews/${e.campaign.id}~${e.group.id}~${Buffer.from(e.term.text).toString('base64url')}`,
  },
  asset_group: {
    id: (e) => e.group.id,
    name: (e) => e.group.name,
    status: () => 'ENABLED',
    campaign: (e) => res(e.campaign),
    resource_name: (e) => `customers/${CUSTOMER_ID}/assetGroups/${e.group.id}`,
  },
};
// Metrics from a summed bucket t (cost in micros, value in cents).
const ratio = (a, b) => (b ? a / b : 0);
const METRICS = {
  impressions: (t) => String(t.impr),
  clicks: (t) => String(t.clicks),
  cost_micros: (t) => String(t.cost),
  conversions: (t) => t.conv,
  conversions_value: (t) => t.value / 100,
  all_conversions: (t) => t.conv + t.vtc,
  all_conversions_value: (t) => t.value / 100,
  view_through_conversions: (t) => String(t.vtc),
  interactions: (t) => String(t.clicks),
  ctr: (t) => ratio(t.clicks, t.impr),
  interaction_rate: (t) => ratio(t.clicks, t.impr),
  average_cpc: (t) => ratio(t.cost, t.clicks),
  average_cost: (t) => ratio(t.cost, t.clicks),
  average_cpm: (t) => ratio(t.cost * 1000, t.impr),
  cost_per_conversion: (t) => ratio(t.cost, t.conv),
  cost_per_all_conversions: (t) => ratio(t.cost, t.conv + t.vtc),
  conversions_from_interactions_rate: (t) => ratio(t.conv, t.clicks),
  value_per_conversion: (t) => ratio(t.value / 100, t.conv),
  video_trueview_views: (t) => String(t.views),
  video_views: (t) => String(t.views),
  video_trueview_view_rate: (t) => ratio(t.views, t.impr),
  video_view_rate: (t) => ratio(t.views, t.impr),
  trueview_average_cpv: (t) => ratio(t.cost, t.views),
  average_cpv: (t) => ratio(t.cost, t.views),
  video_quartile_p25_rate: (t) => (t.views ? 0.71 : 0),
  video_quartile_p50_rate: (t) => (t.views ? 0.52 : 0),
  video_quartile_p75_rate: (t) => (t.views ? 0.39 : 0),
  video_quartile_p100_rate: (t) => (t.views ? 0.27 : 0),
  search_impression_share: (t, e) =>
    e.campaign && e.campaign.channel === 'SEARCH' ? e.campaign.impressionShare : undefined,
  search_budget_lost_impression_share: (t, e) =>
    e.campaign && e.campaign.channel === 'SEARCH' ? e.campaign.lostBudget : undefined,
  search_rank_lost_impression_share: (t, e) =>
    e.campaign && e.campaign.channel === 'SEARCH' ? e.campaign.lostRank : undefined,
  search_top_impression_share: (t, e) =>
    e.campaign && e.campaign.channel === 'SEARCH'
      ? Math.round(e.campaign.impressionShare * 0.7 * 10000) / 10000
      : undefined,
  absolute_top_impression_percentage: (t, e) =>
    e.campaign && e.campaign.channel === 'SEARCH'
      ? Math.round(e.campaign.impressionShare * 0.4 * 10000) / 10000
      : undefined,
  top_impression_percentage: (t, e) =>
    e.campaign && e.campaign.channel === 'SEARCH'
      ? Math.round(e.campaign.impressionShare * 0.8 * 10000) / 10000
      : undefined,
};
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
// Date segments: the bucket of a day.
const DATE_SEGMENTS = {
  date: (d) => d,
  week: (d) => {
    const t = Date.parse(d + 'T12:00:00Z');
    return iso(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY);
  },
  month: (d) => d.slice(0, 8) + '01',
  quarter: (d) =>
    d.slice(0, 5) +
    String(Math.floor((Number(d.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0') +
    '-01',
  year: (d) => Number(d.slice(0, 4)),
  day_of_week: (d) => WEEKDAYS[new Date(d + 'T12:00:00Z').getUTCDay()],
};
// Segments that split a bucket into parts with fixed shares.
const SPLIT_SEGMENTS = {
  device: () => DEVICES.map(([name, share]) => ({ values: { device: name }, share })),
  conversion_action_name: () =>
    ACTIONS.map(([name, category, share]) => ({
      values: { conversion_action_name: name, conversion_action_category: category },
      share,
    })),
  conversion_action_category: () =>
    ACTIONS.map(([name, category, share]) => ({
      values: { conversion_action_name: name, conversion_action_category: category },
      share,
    })),
};
const OTHER_SEGMENTS = {
  ad_network_type: (e) => NETWORK[e.campaign ? e.campaign.channel : 'SEARCH'] || 'SEARCH',
  'keyword.info.text': (e) => (e.keyword ? e.keyword.text : undefined),
  'keyword.info.match_type': (e) => (e.keyword ? e.keyword.match : undefined),
};

class QueryError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function splitTopLevel(text, word) {
  const parts = [];
  let depth = 0,
    quote = '',
    start = 0;
  const upper = text.toUpperCase();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (
      !depth &&
      upper.startsWith(word, i) &&
      /\s/.test(text[i - 1] || ' ') &&
      /\s/.test(text[i + word.length] || ' ')
    ) {
      parts.push(text.slice(start, i).trim());
      start = i + word.length;
      i += word.length - 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}
const literal = (v) => {
  const s = v.trim();
  if (/^'.*'$|^".*"$/s.test(s)) return s.slice(1, -1);
  if (/^(TRUE|FALSE)$/i.test(s)) return /^TRUE$/i.test(s);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s; // an enum
};
const list = (v) =>
  splitTopLevel(v.replace(/^\(|\)$/g, ''), ',')
    .flatMap((x) => x.split(','))
    .map((x) => literal(x))
    .filter((x) => x !== '');

export function parseGaql(text) {
  const q = String(text).replace(/\s+/g, ' ').trim();
  const m =
    /^SELECT (.+?)(?: FROM ([a-z_]+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?(?: PARAMETERS (.+))?$/i.exec(
      q
    );
  if (!m)
    throw new QueryError('UNEXPECTED_INPUT', `Error in query: unexpected input ${q.slice(0, 60)}.`);
  const fields = m[1].split(',').map((s) => s.trim());
  for (const f of fields)
    if (!/^[a-z_]+(\.[a-z0-9_]+)*$/.test(f))
      throw new QueryError(
        'UNEXPECTED_INPUT',
        `Error in SELECT clause: invalid field name '${f}'.`
      );
  const where = [];
  if (m[3]) {
    if (/\sOR\s/i.test(m[3].replace(/'[^']*'/g, "''")))
      throw new QueryError('UNEXPECTED_INPUT', 'Error in WHERE clause: unexpected input OR.');
    const parts = splitTopLevel(m[3], 'AND');
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i];
      if (/\sBETWEEN\s/i.test(part) && i + 1 < parts.length) part += ' AND ' + parts[++i];
      where.push(parseCondition(part));
    }
  }
  const orderBy = m[4]
    ? m[4].split(',').map((s) => {
        const [field, dir] = s.trim().split(/\s+/);
        return { field, desc: /^desc$/i.test(dir || '') };
      })
    : [];
  return {
    fields,
    resource: m[2] ? m[2].toLowerCase() : null,
    where,
    orderBy,
    limit: m[5] ? Number(m[5]) : null,
  };
}
function parseCondition(text) {
  let m;
  if ((m = /^(\S+) BETWEEN (\S+) AND (\S+)$/i.exec(text)))
    return { field: m[1], op: 'BETWEEN', value: [literal(m[2]), literal(m[3])] };
  if ((m = /^(\S+) DURING (\w+)$/i.exec(text)))
    return { field: m[1], op: 'DURING', value: m[2].toUpperCase() };
  if ((m = /^(\S+) (NOT IN|IN) ?(\(.*\))$/i.exec(text)))
    return { field: m[1], op: m[2].toUpperCase(), value: list(m[3]) };
  if ((m = /^(\S+) (CONTAINS ANY|CONTAINS ALL|CONTAINS NONE) ?(\(.*\))$/i.exec(text)))
    return { field: m[1], op: m[2].toUpperCase(), value: list(m[3]) };
  if ((m = /^(\S+) (NOT LIKE|LIKE|REGEXP_MATCH|NOT REGEXP_MATCH) (.+)$/i.exec(text)))
    return { field: m[1], op: m[2].toUpperCase(), value: literal(m[3]) };
  if ((m = /^(\S+) IS (NOT )?NULL$/i.exec(text)))
    return { field: m[1], op: m[2] ? 'NOT NULL' : 'NULL' };
  if ((m = /^(\S+?) ?(=|!=|>=|<=|>|<) ?(.+)$/.exec(text)))
    return { field: m[1], op: m[2], value: literal(m[3]) };
  throw new QueryError(
    'UNEXPECTED_INPUT',
    `Error in WHERE clause: invalid condition ${text.slice(0, 60)}.`
  );
}
function compare(op, a, b) {
  const num = (x) => (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x);
  const x = num(a),
    y = num(b);
  switch (op) {
    case '=':
      return String(x) === String(y);
    case '!=':
      return String(x) !== String(y);
    case '>':
      return x > y;
    case '>=':
      return x >= y;
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case 'IN':
      return b.map(String).includes(String(a));
    case 'NOT IN':
      return !b.map(String).includes(String(a));
    case 'LIKE':
    case 'NOT LIKE': {
      const re = new RegExp(
        '^' +
          String(b)
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/%/g, '.*')
            .replace(/_/g, '.') +
          '$',
        's'
      );
      return (op === 'LIKE') === re.test(String(a ?? ''));
    }
    case 'REGEXP_MATCH':
    case 'NOT REGEXP_MATCH':
      return (op === 'REGEXP_MATCH') === new RegExp('^(?:' + b + ')$').test(String(a ?? ''));
    case 'NULL':
      return a === undefined || a === null;
    case 'NOT NULL':
      return a !== undefined && a !== null;
    case 'CONTAINS ANY':
      return (Array.isArray(a) ? a : [a]).some((v) => b.map(String).includes(String(v)));
    case 'CONTAINS ALL':
      return b.every((v) => (Array.isArray(a) ? a : [a]).map(String).includes(String(v)));
    case 'CONTAINS NONE':
      return !(Array.isArray(a) ? a : [a]).some((v) => b.map(String).includes(String(v)));
  }
  return false;
}
function during(name, today) {
  const day = Date.parse(today + 'T12:00:00Z');
  const yesterday = day - DAY;
  const n = { LAST_7_DAYS: 7, LAST_14_DAYS: 14, LAST_30_DAYS: 30, LAST_90_DAYS: 90 }[name];
  if (n) return [iso(yesterday - (n - 1) * DAY), iso(yesterday)];
  const dt = new Date(day);
  switch (name) {
    case 'TODAY':
      return [today, today];
    case 'YESTERDAY':
      return [iso(yesterday), iso(yesterday)];
    case 'THIS_MONTH':
      return [today.slice(0, 8) + '01', today];
    case 'LAST_MONTH': {
      const first = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() - 1, 1, 12);
      const last = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 0, 12);
      return [iso(first), iso(last)];
    }
    case 'THIS_WEEK_MON_TODAY':
    case 'THIS_WEEK_SUN_TODAY': {
      const back = name === 'THIS_WEEK_MON_TODAY' ? (dt.getUTCDay() + 6) % 7 : dt.getUTCDay();
      return [iso(day - back * DAY), today];
    }
    case 'LAST_WEEK_MON_SUN':
    case 'LAST_BUSINESS_WEEK': {
      const monday = day - (((dt.getUTCDay() + 6) % 7) + 7) * DAY;
      return [iso(monday), iso(monday + (name === 'LAST_BUSINESS_WEEK' ? 4 : 6) * DAY)];
    }
    case 'LAST_WEEK_SUN_SAT': {
      const sunday = day - (dt.getUTCDay() + 7) * DAY;
      return [iso(sunday), iso(sunday + 6 * DAY)];
    }
  }
  throw new QueryError(
    'INVALID_VALUE_WITH_DURING_OPERATOR',
    `Invalid value with DURING operator: ${name}.`
  );
}

// The entities of a resource, each with its attribute context and its day rows.
function entities(data, resource) {
  const campaignDays = (c) => [...c.days].map(([d, r]) => ({ d, ...r }));
  switch (resource) {
    case 'customer':
      return [{ ctx: {}, days: () => [...data.account.days].map(([d, r]) => ({ d, ...r })) }];
    case 'campaign':
    case 'campaign_budget':
      return data.campaigns.map((campaign) => ({
        ctx: { campaign },
        days: () => campaignDays(campaign),
      }));
    case 'ad_group':
    case 'ad_group_ad':
      return data.adGroups
        .filter((g) => !g.assetGroup)
        .map((group) => ({
          ctx: { campaign: group.campaign, group },
          days: () => [...group.days].map(([d, r]) => ({ d, ...r })),
        }));
    case 'asset_group':
      return data.adGroups
        .filter((g) => g.assetGroup)
        .map((group) => ({
          ctx: { campaign: group.campaign, group },
          days: () => [...group.days].map(([d, r]) => ({ d, ...r })),
        }));
    case 'keyword_view':
      return data.keywords.map((keyword) => ({
        ctx: { campaign: keyword.campaign, group: keyword.group, keyword },
        days: () => keyword.days,
      }));
    case 'search_term_view':
      return data.terms.map((term) => ({
        ctx: { campaign: term.campaign, group: term.group, keyword: term.keyword, term },
        days: () => term.days,
      }));
    case 'ad_group_criterion':
      return data.keywords
        .map((keyword) => ({
          ctx: { campaign: keyword.campaign, group: keyword.group, keyword },
          days: () => [],
        }))
        .concat(
          data.adGroups
            .filter((g) => g.keywords.length && Number(g.id) % 4 === 0)
            .map((group, i) => ({
              ctx: {
                campaign: group.campaign,
                group,
                negative: {
                  id: String(800000 + i),
                  text: NEGATIVES[i % NEGATIVES.length],
                  match: 'PHRASE',
                },
              },
              days: () => [],
            }))
        );
    case 'campaign_criterion':
      return data.negatives.map((negative) => ({
        ctx: { campaign: negative.campaign, negative },
        days: () => [],
      }));
  }
  return [];
}

function attributeGetter(resource, name) {
  const [head, ...rest] = name.split('.');
  const table = ATTRIBUTES[head];
  if (!table) return null;
  const allowed = head === resource || (PARENTS[resource] || []).includes(head);
  const getter = table[rest.join('.')];
  if (!getter)
    throw new QueryError('UNRECOGNIZED_FIELD', `Unrecognized field in the query: '${name}'.`);
  if (!allowed)
    throw new QueryError(
      'PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE',
      `The following field is not selectable with FROM ${resource}: ${name}.`
    );
  return getter;
}

// Runs one query; returns the full list of result rows (nested, camelCase).
export function runQuery(data, text) {
  const q = parseGaql(text);
  if (!q.resource) throw new QueryError('EXPECTED_FROM', 'Error in query: expected FROM clause.');
  const resource = q.resource;
  if (EMPTY_RESOURCES.includes(resource)) return { rows: [], fields: q.fields };
  if (!RESOURCES_WITH_DATA.includes(resource))
    throw new QueryError(
      'INVALID_RESOURCE_NAME',
      `Invalid resource name in FROM clause: ${resource}.`
    );
  const metricNames = [],
    dateSegs = [],
    splitSegs = [],
    otherSegs = [];
  const getters = new Map();
  const classify = (name, inSelect) => {
    if (name.startsWith('metrics.')) {
      const key = name.slice(8);
      if (!METRICS[key])
        throw new QueryError('UNRECOGNIZED_FIELD', `Unrecognized field in the query: '${name}'.`);
      if (NO_METRICS.has(resource))
        throw new QueryError(
          'PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE',
          `Cannot select or filter on the following metrics: '${name}' (could not support requested resources: '${resource.toUpperCase()}').`
        );
      if (inSelect) metricNames.push(key);
      return;
    }
    if (name.startsWith('segments.')) {
      const key = name.slice(9);
      if (DATE_SEGMENTS[key]) {
        if (inSelect && !dateSegs.includes(key)) dateSegs.push(key);
      } else if (SPLIT_SEGMENTS[key]) {
        if (inSelect && !splitSegs.includes(key)) splitSegs.push(key);
      } else if (OTHER_SEGMENTS[key]) {
        if (key.startsWith('keyword.') && resource !== 'search_term_view')
          throw new QueryError(
            'PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE',
            `The segment '${name}' is not selectable with FROM ${resource}.`
          );
        if (inSelect && !otherSegs.includes(key)) otherSegs.push(key);
      } else
        throw new QueryError('UNRECOGNIZED_FIELD', `Unrecognized field in the query: '${name}'.`);
      return;
    }
    const getter = attributeGetter(resource, name);
    if (!getter)
      throw new QueryError('UNRECOGNIZED_FIELD', `Unrecognized field in the query: '${name}'.`);
    getters.set(name, getter);
  };
  q.fields.forEach((f) => classify(f, true));
  q.where.forEach((c) => classify(c.field, false));
  q.orderBy.forEach((o) => classify(o.field, false));
  if (
    splitSegs.some((s) => s.startsWith('conversion_action')) &&
    metricNames.some((m) => !/conversions|value_per/.test(m))
  )
    throw new QueryError(
      'PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE',
      'The conversion action segments cannot be selected with metrics other than conversion metrics.'
    );
  // Date window from segments.date conditions.
  let lo = data.dates[0],
    hi = data.dates[data.dates.length - 1],
    dated = false;
  const rest = [];
  for (const c of q.where) {
    if (c.field === 'segments.date') {
      dated = true;
      if (c.op === 'BETWEEN')
        [lo, hi] = [c.value[0] > lo ? c.value[0] : lo, c.value[1] < hi ? c.value[1] : hi];
      else if (c.op === 'DURING') {
        const [a, b] = during(c.value, data.today);
        lo = a > lo ? a : lo;
        hi = b < hi ? b : hi;
      } else if (c.op === '>=' || c.op === '>')
        lo =
          c.op === '>'
            ? iso(Date.parse(c.value + 'T12:00:00Z') + DAY)
            : c.value > lo
              ? c.value
              : lo;
      else if (c.op === '<=' || c.op === '<')
        hi =
          c.op === '<'
            ? iso(Date.parse(c.value + 'T12:00:00Z') - DAY)
            : c.value < hi
              ? c.value
              : hi;
      else if (c.op === '=') [lo, hi] = [c.value, c.value];
      else rest.push(c);
    } else rest.push(c);
  }
  if (dateSegs.length && !dated && dateSegs.includes('date'))
    throw new QueryError(
      'DATE_RANGE_TOO_WIDE',
      'Error in query: segments.date in the SELECT clause requires a finite date range in the WHERE clause.'
    );
  const loI = data.dates.findIndex((d) => d >= lo);
  const hiI = (() => {
    for (let i = data.dates.length - 1; i >= 0; i--) if (data.dates[i] <= hi) return i;
    return -1;
  })();
  const hasMetrics =
    metricNames.length > 0 ||
    dateSegs.length > 0 ||
    splitSegs.length > 0 ||
    q.where.some((c) => c.field.startsWith('metrics.'));
  const attrConds = rest.filter(
    (c) => !c.field.startsWith('metrics.') && !c.field.startsWith('segments.')
  );
  const postConds = rest.filter(
    (c) => c.field.startsWith('metrics.') || c.field.startsWith('segments.')
  );
  const out = [];
  for (const entity of entities(data, resource)) {
    const ctx = entity.ctx;
    if (!attrConds.every((c) => compare(c.op, attributeGetter(resource, c.field)(ctx), c.value)))
      continue;
    let buckets;
    if (!hasMetrics) buckets = [{ key: '', seg: {}, t: zero() }];
    else {
      const map = new Map();
      for (const row of entity.days()) {
        if (row.d < loI || row.d > hiI || loI < 0) continue;
        const date = data.dates[row.d];
        const seg = {};
        for (const s of dateSegs) seg[s] = DATE_SEGMENTS[s](date);
        const key = dateSegs.map((s) => seg[s]).join('|');
        if (!map.has(key)) map.set(key, { key, seg, t: zero() });
        add(map.get(key).t, row);
      }
      buckets = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (!buckets.length) continue; // no row for an entity without data in the window
      // Split segments: fixed shares, integers by largest remainder within each bucket.
      for (const s of splitSegs) {
        if (s === 'conversion_action_category' && splitSegs.includes('conversion_action_name'))
          continue;
        const parts = SPLIT_SEGMENTS[s]();
        buckets = buckets.flatMap((b) => {
          const split = parts.map((p) => ({
            seg: { ...b.seg, ...p.values },
            key: b.key + '|' + Object.values(p.values).join('/'),
            t: zero(),
          }));
          for (const field of ['impr', 'clicks', 'cost', 'conv', 'value', 'views', 'vtc']) {
            const total = b.t[field];
            const unit = field === 'cost' ? 10000 : 1;
            let left = Math.round(total / unit);
            parts.forEach((p, i) => {
              const n =
                i === parts.length - 1
                  ? left
                  : Math.min(left, Math.round((total / unit) * p.share));
              split[i].t[field] = n * unit;
              left -= n;
            });
          }
          return split.filter((x) => x.t.impr || x.t.cost || x.t.conv);
        });
      }
    }
    for (const b of buckets) {
      const t = b.t;
      if (hasMetrics && !t.impr && !t.cost && !t.conv && !t.views) continue;
      const read = (name) => {
        if (name.startsWith('metrics.')) return METRICS[name.slice(8)](t, ctx);
        if (name.startsWith('segments.')) {
          const key = name.slice(9);
          if (key in b.seg) return b.seg[key];
          if (DATE_SEGMENTS[key]) return undefined;
          if (OTHER_SEGMENTS[key]) return OTHER_SEGMENTS[key](ctx);
          return undefined;
        }
        return getters.get(name) ? getters.get(name)(ctx) : attributeGetter(resource, name)(ctx);
      };
      if (!postConds.every((c) => compare(c.op, read(c.field), c.value))) continue;
      out.push({ read, ctx });
    }
  }
  if (q.orderBy.length)
    out.sort((a, b) => {
      for (const o of q.orderBy) {
        const x = a.read(o.field),
          y = b.read(o.field);
        const nx = typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x;
        const ny = typeof y === 'string' && /^-?\d+(\.\d+)?$/.test(y) ? Number(y) : y;
        if (nx === ny) continue;
        const less = nx === undefined ? true : ny === undefined ? false : nx < ny;
        return (less ? -1 : 1) * (o.desc ? -1 : 1);
      }
      return 0;
    });
  const kept = q.limit ? out.slice(0, q.limit) : out;
  const top = camel(resource);
  const rows = kept.map((r) => {
    const obj = {};
    for (const name of q.fields) {
      const value = r.read(name);
      if (value === undefined) continue;
      const path = name.split('.').map(camel);
      let node = obj;
      for (let i = 0; i < path.length - 1; i++) node = node[path[i]] = node[path[i]] || {};
      node[path[path.length - 1]] = value;
    }
    // Google adds the queried resource's resource name to every row.
    if (ATTRIBUTES[resource]?.resource_name) {
      obj[top] = obj[top] || {};
      obj[top].resourceName = ATTRIBUTES[resource].resource_name(r.ctx);
    }
    return obj;
  });
  return { rows, fields: q.fields };
}

// googleAdsFields:search: the field service answers the discovery queries of the connector.
function fieldService(text) {
  const q = String(text).replace(/\s+/g, ' ').trim();
  const resourceNames = RESOURCES_WITH_DATA.concat(EMPTY_RESOURCES);
  const selectableWith = (resource) =>
    NO_METRICS.has(resource)
      ? PARENTS[resource] || []
      : Object.keys(METRICS)
          .map((m) => 'metrics.' + m)
          .concat(
            Object.keys(DATE_SEGMENTS)
              .concat(Object.keys(SPLIT_SEGMENTS), ['ad_network_type'])
              .map((s) => 'segments.' + s)
          )
          .concat(
            resource === 'search_term_view'
              ? ['segments.keyword.info.text', 'segments.keyword.info.match_type']
              : []
          )
          .concat(PARENTS[resource] || []);
  const describe = (name) => {
    const [head, ...rest] = name.split('.');
    const known =
      (head === 'metrics' && METRICS[rest.join('.')]) ||
      (head === 'segments' &&
        (DATE_SEGMENTS[rest.join('.')] ||
          SPLIT_SEGMENTS[rest.join('.')] ||
          OTHER_SEGMENTS[rest.join('.')])) ||
      (ATTRIBUTES[head] && ATTRIBUTES[head][rest.join('.')]);
    if (!known) return null;
    return {
      resourceName: 'googleAdsFields/' + name,
      name,
      category: head === 'metrics' ? 'METRIC' : head === 'segments' ? 'SEGMENT' : 'ATTRIBUTE',
      selectable: true,
      filterable: true,
      sortable: true,
      isRepeated: /final_urls$/.test(name),
      dataType: /(_micros|impressions|clicks|interactions|views|_id|^.*\.id)$/.test(name)
        ? 'INT64'
        : head === 'metrics'
          ? 'DOUBLE'
          : /date|week|month|quarter/.test(name)
            ? 'DATE'
            : 'STRING',
    };
  };
  let m;
  if ((m = /WHERE name IN \((.+)\)/i.exec(q)))
    return list('(' + m[1] + ')')
      .map(describe)
      .filter(Boolean);
  if (/category = 'RESOURCE'/i.test(q))
    return resourceNames.map((name) => ({
      resourceName: 'googleAdsFields/' + name,
      name,
      category: 'RESOURCE',
    }));
  if ((m = /WHERE name = '([a-z_]+)'/i.exec(q))) {
    const name = m[1];
    if (!resourceNames.includes(name)) return [];
    return [
      {
        resourceName: 'googleAdsFields/' + name,
        name,
        category: 'RESOURCE',
        selectableWith: selectableWith(name),
        attributeResources: PARENTS[name] || [],
      },
    ];
  }
  if ((m = /WHERE name LIKE '([a-z_]+)\.%'/i.exec(q))) {
    const table = ATTRIBUTES[m[1]] || {};
    return Object.keys(table)
      .map((key) => describe(m[1] + '.' + key))
      .filter(Boolean);
  }
  return [];
}

// The fake's HTTP face: handle(url, options) returns a UrlFetchApp-like response, or null when
// the URL is not the Google Ads API. Counts requests and rows served.
export function createGoogleAdsFake({ variant = 'normal', today }) {
  let data = createGoogleAdsData({ variant, today });
  const cache = new Map(); // query text -> rows (pages of the same query)
  const stats = { requests: 0, rows: 0, queries: [], errors: 0 };
  const respond = (code, body) => {
    const text = JSON.stringify(body);
    return {
      getResponseCode: () => code,
      getContentText: () => text,
      getAllHeaders: () => ({ 'Content-Type': 'application/json' }),
      getHeaders: () => ({ 'Content-Type': 'application/json' }),
      getBlob: () => ({ getBytes: () => [...Buffer.from(text)], getDataAsString: () => text }),
    };
  };
  const failure = (kind, message) => ({
    error: {
      code: 400,
      message: 'Request contains an invalid argument.',
      status: 'INVALID_ARGUMENT',
      details: [
        {
          '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
          errors: [{ errorCode: { queryError: kind }, message }],
          requestId: 'fake-request',
        },
      ],
    },
  });
  function handle(url, options = {}) {
    const m = /^https:\/\/googleads\.googleapis\.com\/v\d+\/(.+)$/.exec(String(url));
    if (!m) return null;
    stats.requests++;
    const auth = (options.headers || {}).Authorization || (options.headers || {}).authorization;
    if (!auth || !/^Bearer \S+/.test(auth))
      return respond(401, {
        error: {
          code: 401,
          message: 'Request is missing required authentication credential.',
          status: 'UNAUTHENTICATED',
        },
      });
    let body = {};
    try {
      body = JSON.parse(String(options.payload || '{}'));
    } catch {
      return respond(400, failure('UNEXPECTED_INPUT', 'Invalid JSON payload.'));
    }
    const path = m[1];
    try {
      if (path === 'googleAdsFields:search') {
        stats.queries.push(String(body.query).slice(0, 300));
        const results = fieldService(body.query);
        return respond(200, { results, totalResultsCount: String(results.length) });
      }
      const sm = /^customers\/(\d+)\/googleAds:search$/.exec(path);
      if (!sm)
        return respond(404, { error: { code: 404, message: 'Not found.', status: 'NOT_FOUND' } });
      if (sm[1] !== CUSTOMER_ID)
        return respond(403, {
          error: {
            code: 403,
            message: 'The caller does not have permission',
            status: 'PERMISSION_DENIED',
            details: [
              {
                '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
                errors: [
                  {
                    errorCode: { authorizationError: 'USER_PERMISSION_DENIED' },
                    message: 'User does not have permission.',
                  },
                ],
              },
            ],
          },
        });
      const query = String(body.query || '');
      let rows = cache.get(query);
      if (!rows) {
        stats.queries.push(query.slice(0, 300));
        rows = runQuery(data, query).rows;
        cache.set(query, rows);
      }
      const offset = body.pageToken
        ? Number(Buffer.from(String(body.pageToken), 'base64url').toString().split(':')[1])
        : 0;
      const page = rows.slice(offset, offset + PAGE);
      stats.rows += page.length;
      const next =
        offset + PAGE < rows.length
          ? Buffer.from(`${cache.size}:${offset + PAGE}`).toString('base64url')
          : '';
      const fieldMask = parseGaql(query)
        .fields.map((f) => f.split('.').map(camel).join('.'))
        .join(',');
      return respond(200, {
        results: page,
        fieldMask,
        ...(next ? { nextPageToken: next } : {}),
        totalResultsCount: String(rows.length),
        queryResourceConsumption: String(1 + Math.round(rows.length / 50)),
      });
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      stats.errors++;
      return respond(400, failure(error.kind, error.message));
    }
  }
  return {
    handle,
    stats,
    get data() {
      return data;
    },
    // A refresh with more rows: more campaigns, keywords and search terms; existing ones keep
    // their numbers.
    grow(growth) {
      data = createGoogleAdsData({ variant, today, growth });
      cache.clear();
    },
    truth: () => groundTruth(data),
  };
}
