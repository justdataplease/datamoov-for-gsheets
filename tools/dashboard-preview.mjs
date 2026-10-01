// Local visual preview of a dashboard refresh. Runs the real src/ files in the offline test
// sandbox against a seeded Google Ads-like fixture, replays the recorded Sheets batch into a grid
// model per tab and renders each tab to HTML and a Playwright PNG under data/dashboard-preview/.
// No network and no deployment: what you see is what the batch would draw, approximately.
//
//   node tools/dashboard-preview.mjs [--plan v2|v2-basic|v1] [--refresh] [--html-only] [--root <dir>]
//                                    [--fixture <module>] [--out <dir>]
//
// --root runs another checkout's src/ and tests/helpers/ (for example a git archive of HEAD), so
// a baseline and the working tree can be rendered from the same fixture. --fixture swaps the
// seeded business for another module's (videos/kit/demo-fixture.mjs is a fictional shop with no
// account numbers), and --out writes somewhere other than data/dashboard-preview/.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
let outDir = path.join(root, 'data', 'dashboard-preview');
const VIEWPORT = 1600;
const DATA_TAB_ROWS = 120; // data tabs can hold thousands of rows; the preview shows the top
const ROW_HEADER = 46;
const COLUMN_HEADER = 21;

// ---------------------------------------------------------------------------------------------
// Fixture: two Google Ads accounts in AED, seeded so every run draws the same numbers.

function seeded(key) {
  let h = 2166136261;
  for (const ch of String(key)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
let ACCOUNTS = ['7675648123', '5317611045'];
// What the page calls each account, the currency both report in, and how keyword campaigns, long-
// tail keywords and ad groups are named. A --fixture module may replace any of these and the
// tables below.
let LABELS = ['Google Ads 7675648123', 'Google Ads 5317611045'];
let CURRENCY = 'AED';
let keywordCampaign = (code) => code + '_Gue_Sea_Adw_EN_Dom_All';
let longTailKeyword = (city, modifier) => 'furnished apartments ' + city + ' ' + modifier;
let adGroupName = (code, city) => code + '_' + city;
// [account, campaign, channel, monthly spend, CPA, value per conversion, CPC, CTR]
let CAMPAIGNS = [
  [0, 'Nyc_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 103000, 1700, 28800, 11.5, 0.071],
  [0, 'Chi_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 71000, 1085, 28000, 9.8, 0.068],
  [0, 'Bos_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 71000, 1445, 30000, 10.2, 0.064],
  [0, 'Bos_Gue_Sea_Adw_EN_Int_All', 'SEARCH', 55000, 1520, 23000, 8.9, 0.052],
  [0, 'Wdc_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 42000, 900, 16800, 8.1, 0.066],
  [0, 'Sea_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 36000, 727, 16200, 7.4, 0.071],
  [0, 'Sfo_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 35000, 1015, 31500, 10.9, 0.069],
  [0, 'us_brand_sea_adw_en_all', 'SEARCH', 34000, 142, 28000, 1.9, 0.21],
  [0, 'Sfo_Gue_Sea_Adw_EN_Int_All', 'SEARCH', 25000, 1164, 16400, 8.6, 0.049],
  [0, 'Lax_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 32000, 1250, 21000, 9.4, 0.058],
  [0, 'Mia_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 33000, 1380, 19000, 8.2, 0.055],
  [0, 'Atx_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 30000, 2100, 15000, 7.1, 0.047],
  [0, 'Sfo_Gue_Perf_Max_EN_All', 'PERFORMANCE_MAX', 75000, 1454, 18500, 4.6, 0.022],
  [0, 'Nyc_Gue_Perf_Max_EN_All', 'PERFORMANCE_MAX', 69000, 2226, 21000, 4.9, 0.019],
  [0, 'Chi_Gue_Perf_Max_EN_All', 'PERFORMANCE_MAX', 60000, 1690, 19500, 4.2, 0.021],
  [0, 'Lax_Gue_Perf_Max_EN_All', 'PERFORMANCE_MAX', 52000, 1980, 17800, 4.4, 0.02],
  [0, 'Nyc_Gue_Dis_Rmk_EN_All', 'DISPLAY', 22000, 2900, 12500, 1.4, 0.0048],
  [0, 'Us_Gue_Dis_Pros_EN_All', 'DISPLAY', 22000, 4100, 11000, 1.2, 0.0041],
  [0, 'Nyc_Gue_Dgen_Pros_EN_All', 'DEMAND_GEN', 18000, 3900, 11500, 2.1, 0.0092],
  [0, 'Sfo_Gue_Dgen_Pros_EN_All', 'DEMAND_GEN', 20000, 4400, 10800, 2.3, 0.0085],
  [1, 'Tyo_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 31000, 1703, 23000, 6.8, 0.061],
  [1, 'Par_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 25000, 1104, 20000, 6.1, 0.058],
  [1, 'Lon_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 38000, 1310, 22000, 7.9, 0.062],
  [1, 'Dxb_Gue_Sea_Adw_EN_Dom_All', 'SEARCH', 31000, 980, 18000, 4.2, 0.074],
  [1, 'Lon_Gue_Perf_Max_EN_All', 'PERFORMANCE_MAX', 28000, 1870, 19000, 4.3, 0.02],
];
const WEEKDAY = [0.88, 1.06, 1.08, 1.05, 1.02, 0.95, 0.86];

function days(startDate, endDate) {
  const out = [];
  for (
    let t = Date.parse(startDate + 'T12:00:00Z');
    t <= Date.parse(endDate + 'T12:00:00Z');
    t += 86400000
  )
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function campaignRows(account, startDate, endDate) {
  const rows = [];
  for (const date of days(startDate, endDate)) {
    // The month before September spent a little less and converted noticeably less.
    const spendTrend = date < '2026-09-01' ? 0.93 : 1;
    const conversionTrend = date < '2026-09-01' ? 0.86 : 1;
    const weekday = WEEKDAY[new Date(date + 'T12:00:00Z').getUTCDay()];
    for (const [owner, name, channel, monthly, cpa, value, cpc, ctr] of CAMPAIGNS) {
      if (ACCOUNTS[owner] !== account) continue;
      const r = seeded(account + name + date);
      const cost = round((monthly / 30) * weekday * spendTrend * (0.7 + 0.6 * r()), 2);
      const clicks = Math.round(cost / (cpc * (0.85 + 0.3 * r())));
      const conversions =
        r() < 0.06 ? 0 : round((cost / cpa) * conversionTrend * (0.35 + 1.3 * r()), 3);
      rows.push({
        'segments.date': date,
        'campaign.name': name,
        'campaign.advertising_channel_type': channel,
        'metrics.cost_micros': cost,
        'metrics.clicks': clicks,
        'metrics.impressions': Math.round(clicks / (ctr * (0.85 + 0.3 * r()))),
        'metrics.conversions': conversions,
        'metrics.conversions_value': round(conversions * value * (0.8 + 0.4 * r()), 2),
      });
    }
  }
  return rows;
}

function totalsRow(account, startDate, endDate) {
  const total = {};
  for (const row of campaignRows(account, startDate, endDate))
    for (const key of TOTAL_FIELDS.map((field) => field.key))
      total[key] = round((total[key] || 0) + row[key], 3);
  return [total];
}

let KEYWORD_CITIES = [
  ['Nyc', 'nyc', 1.6],
  ['Chi', 'chicago', 1.1],
  ['Bos', 'boston', 1],
  ['Sfo', 'san francisco', 0.9],
  ['Wdc', 'washington dc', 0.7],
  ['Sea', 'seattle', 0.6],
  ['Lax', 'los angeles', 0.6],
  ['Mia', 'miami', 0.5],
  ['Atx', 'austin', 0.4],
];
let KEYWORD_THEMES = [
  'furnished apartments',
  'monthly rentals',
  'corporate housing',
  'short term rentals',
  'serviced apartments',
];
// Searches the business cannot serve: they spend and never convert.
let WASTE = [
  ['cheap apartments nyc', 'BROAD', 'Nyc', 4820],
  ['apartments for sale chicago', 'PHRASE', 'Chi', 3350],
  ['hotel deals san francisco', 'BROAD', 'Sfo', 2780],
  ['airbnb seattle', 'PHRASE', 'Sea', 2140],
  ['rent to own homes miami', 'BROAD', 'Mia', 1980],
  ['student dorms boston', 'BROAD', 'Bos', 1610],
  ['free housing boston', 'BROAD', 'Bos', 1240],
  ['section 8 apartments los angeles', 'PHRASE', 'Lax', 1050],
];
const MATCH = ['EXACT', 'PHRASE', 'BROAD'];
let LONG_TAIL = [
  ...['near me', 'downtown', 'with parking', 'pet friendly', 'for families', 'for students'],
  ...['1 bedroom', '2 bedroom', 'studio', 'luxury', 'cheap', 'monthly'],
  ...['weekly', 'long stay', 'corporate', 'relocation', 'with gym', 'with pool'],
  ...['walkable', 'quiet', 'all bills included', 'no deposit', 'last minute', 'this month'],
  ...['next month', 'for nurses', 'for interns', 'for couples', 'with balcony', 'with view'],
];

function keywordRows(account, startDate, endDate) {
  const scale = days(startDate, endDate).length / 30;
  const rows = [];
  const add = ({ text, match, code, impressions, ctr, cpc, cpa, quality }) => {
    const clicks = Math.round(impressions * ctr);
    const cost = round(clicks * cpc, 2);
    rows.push({
      'ad_group_criterion.keyword.text': text,
      'ad_group_criterion.keyword.match_type': match,
      'campaign.name': keywordCampaign(code),
      'metrics.clicks': clicks,
      'metrics.impressions': impressions,
      'metrics.ctr': impressions ? round(clicks / impressions, 4) : 0,
      'metrics.cost_micros': cost,
      'metrics.conversions': cpa ? round(cost / cpa, 3) : 0,
      'ad_group_criterion.quality_info.quality_score': quality,
    });
  };
  for (const [code, city, weight] of KEYWORD_CITIES)
    for (const theme of KEYWORD_THEMES) {
      const r = seeded(account + city + theme);
      if (r() < 0.12) continue;
      const impressions = Math.round(9000 * weight * (0.3 + 1.4 * r()) * scale);
      // A few ordinary keywords simply had no conversion this period.
      const cpa = r() < 0.1 ? 0 : 800 + 1600 * r();
      // Properties evaluate in order, which keeps the seeded sequence stable.
      add({
        text: theme + ' ' + city,
        match: MATCH[Math.floor(r() * 3)],
        code,
        impressions,
        ctr: 0.04 + 0.07 * r(),
        cpc: 6 + 8 * r(),
        cpa,
        quality: 4 + Math.floor(r() * 7),
      });
    }
  for (const [text, match, code, cost] of WASTE) {
    const r = seeded(account + text);
    const cpc = 3.5 + 4 * r(),
      ctr = 0.02 + 0.03 * r();
    const impressions = Math.round((cost * scale) / cpc / ctr);
    add({ text, match, code, impressions, ctr, cpc, cpa: 0, quality: 2 + Math.floor(r() * 4) });
  }
  // The long tail a live account holds: hundreds of keywords with a few clicks each, most of
  // them without a conversion. An action list keeps only the top rows by spend.
  for (const [code, city] of KEYWORD_CITIES)
    for (const modifier of LONG_TAIL) {
      const r = seeded(account + city + modifier);
      add({
        text: longTailKeyword(city, modifier),
        match: MATCH[Math.floor(r() * 3)],
        code,
        impressions: Math.round((40 + 600 * r()) * scale),
        ctr: 0.03 + 0.05 * r(),
        cpc: 4 + 6 * r(),
        cpa: r() < 0.6 ? 0 : 900 + 1500 * r(),
        quality: 3 + Math.floor(r() * 6),
      });
    }
  return rows;
}

let ASSETS = [
  ['HEADLINE', 'Furnished Apartments in NYC', 'BEST'],
  ['HEADLINE', 'Move-In Ready Monthly Rentals', 'BEST'],
  ['HEADLINE', 'Stay 30 Days or More', 'GOOD'],
  ['HEADLINE', 'Book Online in Minutes', 'GOOD'],
  ['HEADLINE', 'Fully Equipped Kitchens', 'LOW'],
  ['HEADLINE', 'Flexible Leases, No Broker Fees', 'BEST'],
  ['HEADLINE', 'Corporate Housing Made Simple', 'GOOD'],
  ['HEADLINE', 'Apartments in 9 US Cities', 'LEARNING'],
  ['HEADLINE', 'Weekly Cleaning Available', 'LOW'],
  ['HEADLINE', 'Pet-Friendly Apartments', 'GOOD'],
  ['DESCRIPTION', 'Spacious furnished apartments with flexible leases. Book online today.', 'BEST'],
  ['DESCRIPTION', 'Everything included: Wi-Fi, utilities and 24/7 guest support.', 'GOOD'],
  ['DESCRIPTION', 'Design-forward homes in central neighborhoods, ready when you are.', 'LOW'],
  [
    'DESCRIPTION',
    'Relocating for work? Stay a month or a year with one simple booking.',
    'LEARNING',
  ],
  ['IMAGE', 'living-room-wide-1200x628.jpg', 'BEST'],
  ['IMAGE', 'kitchen-detail-1200x1200.jpg', 'GOOD'],
  ['IMAGE', 'bedroom-morning-1200x628.jpg', 'LOW'],
  ['IMAGE', 'skyline-balcony-1200x1200.jpg', 'GOOD'],
  ['VIDEO', 'Apartment tour 30s', 'GOOD'],
  ['VIDEO', 'How booking works 15s', 'LEARNING'],
];
// How well each asset does, as Google once labelled it: it shapes the numbers only. Google no
// longer fills the label for Search and Display assets, so the report does not select it.
const LABEL_LIFT = { BEST: 1.5, GOOD: 1, LOW: 0.45, LEARNING: 0.3 };

// Google reports each asset once per ad group that serves it (and per field type), so a live
// account returns thousands of asset rows; here every asset serves in each city's ad group.
// Without a cost column the ranked report keeps the top rows by impressions, which keeps image
// and video assets (cheap per impression) beside the text ones a cost ranking would favour.

function assetRows(account, startDate, endDate) {
  const scale = days(startDate, endDate).length / 30;
  const AD_GROUPS = KEYWORD_CITIES.map(([code, city, weight]) => [adGroupName(code, city), weight]);
  const AD_GROUP_WEIGHT = AD_GROUPS.reduce((total, [, weight]) => total + weight, 0);
  return ASSETS.flatMap(([type, text, label]) => {
    const r = seeded(account + text);
    const reach = 160000 * LABEL_LIFT[label] * (0.4 + r()) * scale * (type === 'VIDEO' ? 0.4 : 1);
    const rate =
      (type === 'IMAGE' || type === 'VIDEO' ? 0.006 : 0.045) *
      (0.6 + 0.8 * r()) *
      Math.sqrt(LABEL_LIFT[label]);
    const conversion = 0.011 * (0.5 + r());
    return AD_GROUPS.map(([adGroup, weight]) => {
      const g = seeded(account + text + adGroup);
      const impressions = Math.round(((reach * weight) / AD_GROUP_WEIGHT) * (0.6 + 0.8 * g()));
      const clicks = Math.round(impressions * rate * (0.8 + 0.4 * g()));
      return {
        'ad_group.name': adGroup,
        'ad_group_ad_asset_view.field_type': type,
        'asset.name': text,
        'metrics.impressions': impressions,
        'metrics.clicks': clicks,
        'metrics.conversions': round(clicks * conversion, 3),
      };
    });
  });
}

const field = (key, label, type) => ({ key, label, type });
const CAMPAIGN_FIELDS = [
  field('segments.date', 'Date', 'date'),
  field('campaign.name', 'Campaign', 'text'),
  field('campaign.advertising_channel_type', 'Channel type', 'text'),
  field('metrics.cost_micros', 'Spend', 'currency'),
  field('metrics.clicks', 'Clicks', 'number'),
  field('metrics.impressions', 'Impressions', 'number'),
  field('metrics.conversions', 'Conversions', 'number'),
  field('metrics.conversions_value', 'Conversion value', 'currency'),
];
const TOTAL_FIELDS = CAMPAIGN_FIELDS.filter((item) => item.key.startsWith('metrics.'));
const KEYWORD_FIELDS = [
  field('ad_group_criterion.keyword.text', 'Keyword', 'text'),
  field('ad_group_criterion.keyword.match_type', 'Match type', 'text'),
  field('campaign.name', 'Campaign', 'text'),
  field('metrics.clicks', 'Clicks', 'number'),
  field('metrics.impressions', 'Impressions', 'number'),
  field('metrics.ctr', 'CTR', 'percent'),
  field('metrics.cost_micros', 'Cost', 'currency'),
  field('metrics.conversions', 'Conversions', 'number'),
  field('ad_group_criterion.quality_info.quality_score', 'Quality score', 'number'),
];
const ASSET_FIELDS = [
  field('ad_group.name', 'Ad group', 'text'),
  field('ad_group_ad_asset_view.field_type', 'Asset type', 'text'),
  field('asset.name', 'Asset', 'text'),
  field('metrics.impressions', 'Impressions', 'number'),
  field('metrics.clicks', 'Clicks', 'number'),
  field('metrics.conversions', 'Conversions', 'number'),
];
const REPORT_FIELDS = {
  campaign_daily: CAMPAIGN_FIELDS,
  account_totals: TOTAL_FIELDS,
  keyword: KEYWORD_FIELDS,
  ad_asset: ASSET_FIELDS,
};

function registerFixture(f) {
  // ranked: as the source's ranked reports (keywords, ad assets) declare it, the rows go by cost
  // (by impressions without a cost column) down to the top asked for, and only a cut list says
  // so: metadata.topRows beside the note the dashboard shows.
  const report = (id, label, fields, rows, ranked) => ({
    id,
    label,
    fields,
    dateRange: true,
    configFields: ranked ? [{ key: 'top', label: 'Keep the top rows', type: 'number' }] : [],
    fetch(ctx) {
      const columns = fields.filter((item) => !ctx.fields.length || ctx.fields.includes(item.key));
      let data = rows(ctx.credentials.account, ctx.startDate, ctx.endDate);
      const metadata = { complete: true, currency: CURRENCY };
      const rank =
        ranked &&
        (columns.find((item) => item.key === 'metrics.cost_micros') ||
          columns.find((item) => item.key === 'metrics.impressions'));
      if (rank) {
        const top = ctx.config.top;
        data = data.sort((a, b) => b[rank.key] - a[rank.key]).slice(0, top || ctx.maxRows);
        if (top && data.length === top)
          Object.assign(metadata, { topRows: top, note: `Top ${top} by ${rank.label}` });
      }
      return { columns, rows: data, metadata };
    },
  });
  f.api.dmvRegisterConnector_({
    id: 'google_ads_fixture',
    label: 'Google Ads',
    category: 'Advertising',
    allowedHosts: ['fixture.example'],
    authFields: [
      { key: 'account', label: 'Customer ID', type: 'text', required: true },
      { key: 'token', label: 'Developer token', type: 'password', required: true },
    ],
    reports: [
      report('campaign_daily', 'Daily campaign performance', CAMPAIGN_FIELDS, campaignRows),
      report('account_totals', 'Account totals', TOTAL_FIELDS, totalsRow),
      report('keyword', 'Keyword performance', KEYWORD_FIELDS, keywordRows, true),
      report('ad_asset', 'Ad assets', ASSET_FIELDS, assetRows, true),
    ],
  });
  return ACCOUNTS.map((account) =>
    plain(
      f.api.dmvSaveConnection({
        connectorId: 'google_ads_fixture',
        label: LABELS[ACCOUNTS.indexOf(account)],
        credentials: { account, token: 'fixture-token' },
      })
    )
  );
}

// ---------------------------------------------------------------------------------------------
// The plan the user asked chat for. v2 uses every dashboard v2 option: previous-period datasets
// for both accounts, compare lists on the scorecards, a trend and a table, highlight rules and
// polarity. v2-basic keeps the plan-level options with one-dataset compares; v1 is what the
// runtime accepted before v2 and mirrors the dashboard in the user's screenshots.

const TIERS = ['v2', 'v2-basic', 'v1'];
const CAMPAIGN_MAPPING = {
  'segments.date': 'date',
  'campaign.name': 'campaign_name',
  'campaign.advertising_channel_type': 'channel_type',
  'metrics.cost_micros': 'spend',
  'metrics.clicks': 'clicks',
  'metrics.impressions': 'impressions',
  'metrics.conversions': 'conversions',
  'metrics.conversions_value': 'conversion_value',
};
const RATIOS = {
  cpa: { key: 'cpa', label: 'CPA', numerator: 'spend', denominator: 'conversions' },
  roas: { key: 'roas', label: 'ROAS', numerator: 'conversion_value', denominator: 'spend' },
  cpc: { key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' },
  ctr: { key: 'ctr', label: 'CTR', numerator: 'clicks', denominator: 'impressions', percent: true },
  // The keyword and asset datasets are read alone, by their own field keys.
  fieldCtr: {
    key: 'ctr',
    label: 'CTR',
    numerator: 'metrics.clicks',
    denominator: 'metrics.impressions',
    percent: true,
  },
};
const sum = (...fields) => fields.map((name) => ({ field: name, agg: 'sum' }));

function planFor(tier, connections) {
  const v2 = tier !== 'v1',
    full = tier === 'v2';
  const [one, two] = connections.map((connection) => connection.id);
  // Campaign datasets get shared column names, so tiles can read them together.
  const dataset = (
    id,
    label,
    sheetName,
    connectionId,
    reportType,
    preset = 'lastMonth',
    config
  ) => {
    const fields = REPORT_FIELDS[reportType];
    const mapped = reportType === 'campaign_daily' || reportType === 'account_totals';
    return {
      id,
      label,
      sheetName,
      connectionId,
      reportType,
      config: config || {},
      fields: fields.map((item) => item.key),
      dateRange: { preset },
      mapping: mapped
        ? fields.map((item) => ({ field: item.key, key: CAMPAIGN_MAPPING[item.key] }))
        : undefined,
    };
  };
  const datasets = [
    dataset('ads1', LABELS[0], 'Google Ads 1 Data', one, 'campaign_daily'),
    dataset('ads2', LABELS[1], 'Google Ads 2 Data', two, 'campaign_daily'),
  ];
  // The previous month of both accounts, by day and campaign: it feeds the scorecard changes,
  // the dashed previous-period trend and the change columns of the campaign table.
  if (full)
    datasets.push(
      dataset(
        'ads1_prev',
        LABELS[0] + ' previous month',
        'Google Ads 1 Previous',
        one,
        'campaign_daily',
        'previousMonth'
      ),
      dataset(
        'ads2_prev',
        LABELS[1] + ' previous month',
        'Google Ads 2 Previous',
        two,
        'campaign_daily',
        'previousMonth'
      )
    );
  else if (v2)
    datasets.push(
      dataset(
        'ads1_prev',
        LABELS[0] + ' previous month',
        'Google Ads 1 Previous',
        one,
        'account_totals',
        'previousMonth'
      )
    );
  // Keywords and assets are action lists, not dumps: v2 asks each ranked report for its top 300
  // by cost, which the page then names on the tiles, their totals and the data sources. v1 took
  // every row, as the dashboards that overflowed the row limit and the Sheets write did.
  const top = v2 ? { top: 300 } : undefined;
  datasets.push(
    dataset('keywords', LABELS[0] + ' keywords', 'Keywords Data', one, 'keyword', 'lastMonth', top),
    dataset('assets', LABELS[0] + ' assets', 'Assets Data', one, 'ad_asset', 'lastMonth', top)
  );
  const both = ['ads1', 'ads2'];
  const periods = ['ads1', 'ads2', 'ads1_prev', 'ads2_prev'];
  const compare = { current: both, previous: ['ads1_prev', 'ads2_prev'] };
  const tiles = [
    {
      title: 'Performance summary',
      type: 'kpi',
      datasets: full ? periods : v2 ? ['ads1', 'ads1_prev'] : both,
      metrics: sum('spend', 'conversions', 'conversion_value'),
      ratios: [RATIOS.cpa, RATIOS.roas, RATIOS.cpc, RATIOS.ctr],
      compare: full ? compare : v2 ? { current: 'ads1', previous: 'ads1_prev' } : undefined,
    },
    v2
      ? {
          // Day by day, so no partial week at the end of the month reads as a drop.
          title: 'Daily spend vs previous month',
          type: 'line',
          datasets: full ? periods : both,
          groupBy: ['date'],
          dateBucket: 'day',
          metrics: sum('spend'),
          compare: full ? compare : undefined,
          width: 'full',
        }
      : {
          // As chat built it before v2: three measures of different scale on one axis.
          title: 'Weekly Spend & CPA Trend',
          type: 'line',
          datasets: both,
          groupBy: ['date'],
          dateBucket: 'week',
          metrics: sum('spend', 'conversions'),
          ratios: [RATIOS.cpa],
          width: 'full',
        },
    // A rate stays comparable in the short last week, so the CPA trend can go by week.
    v2
      ? {
          title: 'Weekly CPA vs previous month',
          type: 'column',
          datasets: full ? periods : both,
          groupBy: ['date'],
          dateBucket: 'week',
          ratios: [RATIOS.cpa],
          compare: full ? compare : undefined,
        }
      : undefined,
    {
      title: v2 ? 'Spend by channel type' : 'Spend by Channel Type',
      type: v2 ? 'pie' : 'bar',
      datasets: both,
      groupBy: ['channel_type'],
      metrics: sum('spend'),
    },
    {
      title: v2 ? 'Top campaigns' : 'Top Campaigns Performance Matrix',
      type: 'table',
      datasets: full ? periods : both,
      groupBy: v2 ? ['campaign_name'] : ['campaign_name', 'channel_type'],
      metrics: v2 ? sum('spend', 'conversions') : sum('spend', 'conversions', 'conversion_value'),
      ratios: [RATIOS.cpa, RATIOS.roas],
      orderBy: { field: 'spend__sum', direction: 'desc' },
      limit: 20,
      compare: full ? compare : undefined,
      highlight: full
        ? [
            { field: 'cpa', op: 'gt', ofTotal: 1.5, color: 'red' },
            { field: 'roas', op: 'gte', ofTotal: 1.5, color: 'green' },
          ]
        : undefined,
    },
    {
      title: 'Keyword waste: spend without conversions',
      type: 'table',
      datasets: ['keywords'],
      groupBy: [
        'ad_group_criterion.keyword.text',
        'ad_group_criterion.keyword.match_type',
        'campaign.name',
      ],
      metrics: [
        ...sum('metrics.cost_micros', 'metrics.clicks'),
        { field: 'ad_group_criterion.quality_info.quality_score', agg: 'avg' },
      ],
      ratios: [RATIOS.fieldCtr],
      filters: [
        { field: 'metrics.cost_micros', op: 'gt', value: 0 },
        { field: 'metrics.conversions', op: 'eq', value: 0 },
      ],
      orderBy: { field: 'metrics.cost_micros__sum', direction: 'desc' },
      limit: 15,
      highlight: full
        ? [{ field: 'metrics.cost_micros', op: 'gte', value: 2000, color: 'red' }]
        : undefined,
    },
    {
      title: 'Asset performance',
      type: 'table',
      datasets: ['assets'],
      groupBy: ['asset.name', 'ad_group_ad_asset_view.field_type'],
      metrics: sum('metrics.impressions', 'metrics.clicks', 'metrics.conversions'),
      ratios: [RATIOS.fieldCtr],
      // The user's request: flag the weak assets for replacement. Google no longer rates them,
      // so their click-through rate does, among the text assets: images and videos run far
      // below text, and a rule over all of them would flag every one.
      filters: full
        ? [{ field: 'ad_group_ad_asset_view.field_type', op: 'in', value: 'HEADLINE,DESCRIPTION' }]
        : undefined,
      orderBy: { field: 'metrics.impressions__sum', direction: 'desc' },
      limit: 20,
      highlight: full ? [{ field: 'ctr', op: 'lt', ofTotal: 0.75, color: 'red' }] : undefined,
    },
  ].filter(Boolean);
  // JSON drops the undefined options, which the runtime would reject as unknown settings.
  return plain({
    name: 'Google Ads Performance Dashboard',
    target: { sheetName: 'Performance Dashboard' },
    datasets,
    tiles,
    lowerIsBetter: v2 ? ['cpa', 'cpc'] : undefined,
    neutral: v2 ? ['spend'] : undefined,
  });
}

// Saves the richest plan the runtime accepts (or the one asked for), then refreshes it.
async function buildDashboard({ tier, refresh, sourceRoot }) {
  const sandbox = path.join(sourceRoot, 'tests', 'helpers', 'datamoov-sandbox.mjs');
  const { createDatamoovSandbox } = await import(pathToFileURL(sandbox).href);
  const f = createDatamoovSandbox();
  // Refreshed 2026-10-01 03:29 in Los Angeles, as in the user's screenshots.
  f.book.timezone = 'America/Los_Angeles';
  f.advance(Date.parse('2026-10-01T10:29:00Z') - f.api.Date.now());
  const connections = registerFixture(f);
  const attempts = [];
  for (const candidate of tier ? [tier] : TIERS) {
    const input = planFor(candidate, connections);
    try {
      const saved = plain(f.api.dmvSaveDashboard(input));
      const before = f.book.sheets.map((sheet) => ({
        id: sheet.id,
        title: sheet.name,
        rows: sheet.maxRows,
        columns: sheet.maxColumns,
      }));
      let result = plain(f.api.dmvRunDashboard(saved.id));
      if (refresh) result = plain(f.api.dmvRunDashboard(saved.id));
      return { f, tier: candidate, input, saved, result, attempts, before };
    } catch (error) {
      attempts.push({ tier: candidate, error: error.message });
      if (tier) break;
    }
  }
  throw new Error(
    'No plan ran: ' + attempts.map((item) => `${item.tier}: ${item.error}`).join(' | ')
  );
}

// ---------------------------------------------------------------------------------------------
// Replay: the Sheets batch requests applied to an in-memory model of every tab and chart.

// "a.b,c(d,e.f)" -> ["a.b", "c.d", "c.e.f"]
function maskPaths(fields) {
  const out = [];
  const walk = (text, prefix) => {
    let depth = 0,
      start = 0;
    for (let i = 0; i <= text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === ',' || ch === undefined) && depth === 0) {
        const part = text.slice(start, i).trim();
        start = i + 1;
        if (!part) continue;
        const open = part.indexOf('(');
        if (open < 0) out.push(prefix + part);
        else walk(part.slice(open + 1, part.lastIndexOf(')')), prefix + part.slice(0, open) + '.');
      }
    }
  };
  walk(String(fields || ''), '');
  return out;
}

const getPath = (object, dotted) => dotted.split('.').reduce((value, key) => value?.[key], object);
function setPath(object, dotted, value) {
  const keys = dotted.split('.');
  let target = object;
  for (const key of keys.slice(0, -1))
    target = target[key] && typeof target[key] === 'object' ? target[key] : (target[key] = {});
  if (value === undefined) delete target[keys.at(-1)];
  else target[keys.at(-1)] = structuredClone(value);
}

// A field mask decides what a request changes; masked paths missing from the source are cleared.
function applyMask(target, source, fields) {
  if (fields === '*' || fields === undefined) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, structuredClone(source || {}));
    return;
  }
  for (const dotted of maskPaths(fields)) setPath(target, dotted, getPath(source || {}, dotted));
}

function replay(batches, initialSheets) {
  const sheets = new Map(),
    charts = new Map(),
    ignored = new Set();
  const addSheet = (properties) => {
    const props = structuredClone(properties);
    props.gridProperties = { rowCount: 1000, columnCount: 26, ...(props.gridProperties || {}) };
    sheets.set(props.sheetId, {
      props,
      cells: new Map(),
      columnWidths: new Map(),
      rowHeights: new Map(),
      hiddenRows: new Set(),
      hiddenColumns: new Set(),
      merges: [],
    });
  };
  for (const sheet of initialSheets)
    addSheet({
      sheetId: sheet.id,
      title: sheet.title,
      gridProperties: { rowCount: sheet.rows, columnCount: sheet.columns },
    });
  const sheetOf = (id) => sheets.get(id ?? 0) || sheets.values().next().value;
  const bounds = (range) => {
    const sheet = sheetOf(range.sheetId);
    return {
      sheet,
      r0: range.startRowIndex ?? 0,
      r1: range.endRowIndex ?? sheet.props.gridProperties.rowCount,
      c0: range.startColumnIndex ?? 0,
      c1: range.endColumnIndex ?? sheet.props.gridProperties.columnCount,
    };
  };
  const cell = (sheet, r, c) => {
    const key = r + ':' + c;
    if (!sheet.cells.has(key)) sheet.cells.set(key, {});
    return sheet.cells.get(key);
  };
  const forEachCell = (range, visit) => {
    const b = bounds(range);
    for (let r = b.r0; r < b.r1; r++)
      for (let c = b.c0; c < b.c1; c++) visit(cell(b.sheet, r, c), r - b.r0, c - b.c0, b, r, c);
  };
  const handlers = {
    addSheet: (request) => addSheet(request.properties || {}),
    deleteSheet: (request) => sheets.delete(request.sheetId),
    updateSheetProperties: (request) => {
      const sheet = sheetOf(request.properties.sheetId);
      const props = structuredClone(sheet.props);
      applyMask(props, request.properties, request.fields);
      props.sheetId = sheet.props.sheetId;
      sheet.props = props;
      // A moved tab: like the API, the index counts positions before the move.
      if (maskPaths(request.fields).includes('index')) {
        const order = [...sheets.entries()];
        const from = order.findIndex(([, item]) => item === sheet);
        const [entry] = order.splice(from, 1);
        const to =
          request.properties.index > from ? request.properties.index - 1 : request.properties.index;
        order.splice(to, 0, entry);
        sheets.clear();
        for (const [id, item] of order) sheets.set(id, item);
      }
    },
    appendDimension: (request) => {
      const grid = sheetOf(request.sheetId).props.gridProperties;
      if (request.dimension === 'ROWS') grid.rowCount += request.length;
      else grid.columnCount += request.length;
    },
    updateCells: (request) => {
      const rows = request.rows || [];
      const range = request.range || {
        sheetId: request.start.sheetId,
        startRowIndex: request.start.rowIndex || 0,
        startColumnIndex: request.start.columnIndex || 0,
        endRowIndex: (request.start.rowIndex || 0) + rows.length,
        endColumnIndex:
          (request.start.columnIndex || 0) +
          Math.max(0, ...rows.map((row) => (row.values || []).length)),
      };
      forEachCell(range, (target, r, c) =>
        applyMask(target, rows[r]?.values?.[c] || {}, request.fields)
      );
    },
    repeatCell: (request) =>
      forEachCell(request.range, (target) => applyMask(target, request.cell || {}, request.fields)),
    updateBorders: (request) => {
      forEachCell(request.range, (target, r, c, b) => {
        const last = { r: b.r1 - b.r0 - 1, c: b.c1 - b.c0 - 1 };
        const sides = {
          top: r === 0 ? request.top : request.innerHorizontal,
          bottom: r === last.r ? request.bottom : request.innerHorizontal,
          left: c === 0 ? request.left : request.innerVertical,
          right: c === last.c ? request.right : request.innerVertical,
        };
        for (const [side, border] of Object.entries(sides)) {
          if (!border) continue;
          target.userEnteredFormat ??= {};
          target.userEnteredFormat.borders ??= {};
          if (border.style === 'NONE') delete target.userEnteredFormat.borders[side];
          else target.userEnteredFormat.borders[side] = structuredClone(border);
        }
      });
    },
    mergeCells: (request) => {
      const b = bounds(request.range);
      const type = request.mergeType || 'MERGE_ALL';
      const add = (r0, r1, c0, c1) =>
        (r1 - r0 > 1 || c1 - c0 > 1) && b.sheet.merges.push({ r0, r1, c0, c1 });
      if (type === 'MERGE_ROWS') for (let r = b.r0; r < b.r1; r++) add(r, r + 1, b.c0, b.c1);
      else if (type === 'MERGE_COLUMNS')
        for (let c = b.c0; c < b.c1; c++) add(b.r0, b.r1, c, c + 1);
      else add(b.r0, b.r1, b.c0, b.c1);
    },
    unmergeCells: (request) => {
      const b = bounds(request.range);
      b.sheet.merges = b.sheet.merges.filter(
        (m) => m.r1 <= b.r0 || m.r0 >= b.r1 || m.c1 <= b.c0 || m.c0 >= b.c1
      );
    },
    updateDimensionProperties: (request) => {
      const range = request.range,
        sheet = sheetOf(range.sheetId);
      const rows = range.dimension === 'ROWS';
      const end =
        range.endIndex ??
        (rows ? sheet.props.gridProperties.rowCount : sheet.props.gridProperties.columnCount);
      const masked = maskPaths(request.fields || 'pixelSize,hiddenByUser');
      for (let i = range.startIndex ?? 0; i < end; i++) {
        if (masked.includes('pixelSize'))
          (rows ? sheet.rowHeights : sheet.columnWidths).set(i, request.properties.pixelSize);
        if (masked.includes('hiddenByUser')) {
          const hidden = rows ? sheet.hiddenRows : sheet.hiddenColumns;
          if (request.properties.hiddenByUser) hidden.add(i);
          else hidden.delete(i);
        }
      }
    },
    addChart: (request) => {
      const chart = structuredClone(request.chart);
      chart.chartId ??= Math.max(0, ...charts.keys()) + 1;
      charts.set(chart.chartId, chart);
    },
    updateChartSpec: (request) => {
      if (charts.has(request.chartId))
        charts.get(request.chartId).spec = structuredClone(request.spec);
    },
    updateEmbeddedObjectPosition: (request) => {
      const chart = charts.get(request.objectId);
      if (!chart) return;
      if (request.newPosition?.overlayPosition) {
        chart.position = { overlayPosition: chart.position?.overlayPosition || {} };
        applyMask(
          chart.position.overlayPosition,
          request.newPosition.overlayPosition,
          request.fields
        );
      } else chart.position = structuredClone(request.newPosition);
    },
    updateEmbeddedObjectBorder: (request) => {
      const chart = charts.get(request.objectId);
      if (chart) applyMask((chart.border ??= {}), request.border, request.fields);
    },
    deleteEmbeddedObject: (request) => charts.delete(request.objectId),
  };
  for (const { body } of batches)
    for (const request of body.requests || []) {
      const [kind] = Object.keys(request);
      if (handlers[kind]) handlers[kind](request[kind]);
      else ignored.add(kind);
    }
  return { sheets, charts: [...charts.values()], ignored: [...ignored] };
}

// ---------------------------------------------------------------------------------------------
// Values and number formats as Sheets displays them.

const THEME = {
  TEXT: '#000000',
  BACKGROUND: '#ffffff',
  ACCENT1: '#4285f4',
  ACCENT2: '#ea4335',
  ACCENT3: '#fbbc04',
  ACCENT4: '#34a853',
  ACCENT5: '#ff6d01',
  ACCENT6: '#46bdc6',
  LINK: '#1155cc',
};
const PALETTE = [
  '#4285f4',
  '#ea4335',
  '#fbbc04',
  '#34a853',
  '#ff6d01',
  '#46bdc6',
  '#7baaf7',
  '#f07b72',
  '#fcd04f',
  '#71c287',
  '#ff994d',
  '#7ed1d7',
];
const FORMAT_COLORS = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
};
const DEFAULT_PATTERNS = {
  NUMBER: '#,##0.00',
  PERCENT: '0.00%',
  CURRENCY: '"$"#,##0.00',
  SCIENTIFIC: '0.00E+00',
};

// A ColorStyle (rgbColor or themeColor) wins over the legacy Color, as in Sheets.
function hex(style, legacy) {
  if (style?.themeColor) return THEME[style.themeColor] || null;
  const rgb = style?.rgbColor || legacy;
  if (!rgb) return null;
  const part = (value) =>
    Math.round((value || 0) * 255)
      .toString(16)
      .padStart(2, '0');
  return '#' + part(rgb.red) + part(rgb.green) + part(rgb.blue);
}

// Automatic format: up to ten significant digits, no grouping.
function generalNumber(value) {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const text = String(Number(value.toPrecision(10)));
  return text.includes('e') ? value.toExponential(2).toUpperCase() : text;
}

function splitSections(pattern) {
  const sections = [];
  let current = '',
    quoted = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '"') quoted = !quoted;
    if (ch === '\\' && !quoted) {
      current += ch + (pattern[++i] ?? '');
      continue;
    }
    if (ch === ';' && !quoted) {
      sections.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  return sections.concat([current]);
}

// The Sheets patterns the app writes: sections (positive;negative;zero), quoted text, 0 # ?
// digits, grouping, %, @ and [Color]. A decimal point always prints, so '#,##0.###' shows a
// whole number as "2,494." exactly like Sheets does.
function formatNumber(value, pattern) {
  const sections = splitSections(pattern);
  let section = sections[0],
    number = value,
    sign = '';
  if (value < 0 && sections.length > 1) {
    section = sections[1];
    number = -value;
  } else if (value === 0 && sections.length > 2) section = sections[2];
  else if (value < 0) {
    sign = '-';
    number = -value;
  }
  let color = null;
  section = section.replace(/\[([^\]]*)\]/g, (_, name) => {
    color = FORMAT_COLORS[name.toLowerCase()] || color;
    return '';
  });
  const tokens = [];
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      tokens.push({ kind: 'text', text: section.slice(i + 1, end < 0 ? undefined : end) });
      i = end < 0 ? section.length : end;
    } else if (ch === '\\') tokens.push({ kind: 'text', text: section[++i] ?? '' });
    else if (ch === '_' || ch === '*') i++;
    else if ('0#?'.includes(ch)) tokens.push({ kind: 'digit', ch });
    else if (ch === '.' && !tokens.some((token) => token.kind === 'dot'))
      tokens.push({ kind: 'dot' });
    else if (ch === ',') tokens.push({ kind: 'comma' });
    else if (ch === '%') tokens.push({ kind: 'text', text: '%', percent: true });
    else if (ch === '@') tokens.push({ kind: 'at' });
    else tokens.push({ kind: 'text', text: ch });
  }
  const dot = tokens.findIndex((token) => token.kind === 'dot');
  const integerEnd = dot < 0 ? tokens.length : dot;
  const digits = tokens.filter((token) => token.kind === 'digit');
  if (!digits.length) {
    const text = tokens
      .map((token) => (token.kind === 'at' ? generalNumber(value) : token.text || ''))
      .join('');
    return { text: sign && text ? sign + text : text, color };
  }
  const integer = tokens.slice(0, integerEnd).filter((token) => token.kind === 'digit');
  const fraction = dot < 0 ? [] : tokens.slice(dot + 1).filter((token) => token.kind === 'digit');
  const lastIntegerDigit = tokens
    .slice(0, integerEnd)
    .map((token) => token.kind)
    .lastIndexOf('digit');
  const grouped = tokens.slice(0, lastIntegerDigit).some((token) => token.kind === 'comma');
  const scaling = tokens
    .slice(lastIntegerDigit + 1, integerEnd)
    .filter((token) => token.kind === 'comma').length;
  const percents = tokens.filter((token) => token.percent).length;
  number = (number * 100 ** percents) / 1000 ** scaling;
  const required = fraction.filter((token) => token.ch !== '#').length;
  let [whole, part = ''] = number.toFixed(fraction.length).split('.');
  while (part.length > required && part.endsWith('0')) part = part.slice(0, -1);
  const minimum = integer.filter((token) => token.ch === '0').length;
  if (whole === '0' && !minimum) whole = '';
  whole = whole.padStart(minimum, '0');
  if (grouped) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (sign && !/[1-9]/.test(whole + part)) sign = '';
  let text = '',
    placed = false;
  tokens.forEach((token, index) => {
    if (token.kind === 'text') text += token.text;
    else if (token.kind === 'at') text += generalNumber(value);
    else if (token.kind === 'digit' && !placed && index < integerEnd) {
      text += whole;
      placed = true;
    } else if (token.kind === 'dot') {
      if (!placed) {
        text += whole;
        placed = true;
      }
      text += '.' + part;
    }
  });
  return { text: sign + text, color };
}

// What a cell shows: { text, numeric, color } or null when it is empty.
function cellText(cell) {
  const value = cell?.userEnteredValue;
  if (!value) return null;
  const format = cell.userEnteredFormat?.numberFormat;
  if ('numberValue' in value) {
    const pattern = format?.pattern || DEFAULT_PATTERNS[format?.type] || '';
    if (!pattern || pattern === '@' || /^(DATE|TIME|DATE_TIME)$/.test(format?.type || ''))
      return { text: generalNumber(value.numberValue), numeric: true };
    return { ...formatNumber(value.numberValue, pattern), numeric: true };
  }
  if ('boolValue' in value) return { text: value.boolValue ? 'TRUE' : 'FALSE', bool: true };
  if ('formulaValue' in value) return { text: value.formulaValue, formula: true };
  if ('errorValue' in value) return { text: '#ERROR!' };
  if ('stringValue' in value && value.stringValue !== '') return { text: value.stringValue };
  return null;
}

const numberOf = (cell) => {
  const value = cell?.userEnteredValue?.numberValue;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

// Rough Arial/Roboto advance widths in em: enough for layout decisions, not for pixel truth.
function textWidth(text, px, bold) {
  let em = 0;
  for (const ch of String(text))
    em += /[ilIj.,:;'|!()[\]]/.test(ch)
      ? 0.28
      : /[mwMW@%]/.test(ch)
        ? 0.84
        : /[A-Z]/.test(ch)
          ? 0.67
          : /[0-9]/.test(ch)
            ? 0.556
            : ch === ' '
              ? 0.278
              : /[a-z]/.test(ch)
                ? 0.52
                : 0.62;
  return em * px * (bold ? 1.06 : 1);
}

const esc = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
const columnName = (index) => {
  let name = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const pt = (size) => (size || 10) * (4 / 3); // Sheets font sizes are points

// ---------------------------------------------------------------------------------------------
// Grid geometry: real pixel sizes, default 100px columns and 21px rows grown for large fonts
// and wrapped text the way Sheets auto-fits rows nobody sized.

function hasContent(cell) {
  const format = cell.userEnteredFormat || {};
  return (
    !!cellText(cell) ||
    !!hex(format.backgroundColorStyle, format.backgroundColor) ||
    !!format.borders
  );
}

function geometry(sheet, charts, { minWidth, maxRows }) {
  const grid = sheet.props.gridProperties;
  const columnWidth = (c) => (sheet.hiddenColumns.has(c) ? 0 : (sheet.columnWidths.get(c) ?? 100));
  let usedRows = 0,
    usedColumns = 0;
  for (const [key, cell] of sheet.cells) {
    if (!hasContent(cell)) continue;
    const [r, c] = key.split(':').map(Number);
    usedRows = Math.max(usedRows, r + 1);
    usedColumns = Math.max(usedColumns, c + 1);
  }
  for (const m of sheet.merges) {
    usedRows = Math.max(usedRows, m.r1);
    usedColumns = Math.max(usedColumns, m.c1);
  }
  const autoHeight = new Map();
  for (const [key, cell] of sheet.cells) {
    const shown = cellText(cell);
    if (!shown) continue;
    const [r, c] = key.split(':').map(Number);
    const text = cell.userEnteredFormat?.textFormat || {};
    const line = pt(text.fontSize) * 1.2;
    let lines = 1;
    if (cell.userEnteredFormat?.wrapStrategy === 'WRAP') {
      const merge = sheet.merges.find((m) => m.r0 === r && m.c0 === c);
      let width = 0;
      for (let i = c; i < (merge ? merge.c1 : c + 1); i++) width += columnWidth(i);
      const lineWidth = (part) => textWidth(part, pt(text.fontSize), text.bold);
      const room = Math.max(10, width - 6);
      lines = shown.text
        .split('\n')
        .reduce((count, part) => count + Math.max(1, Math.ceil(lineWidth(part) / room)), 0);
    }
    autoHeight.set(r, Math.max(autoHeight.get(r) || 0, Math.ceil(line * lines + 5)));
  }
  const rowHeight = (r) =>
    sheet.hiddenRows.has(r) ? 0 : (sheet.rowHeights.get(r) ?? Math.max(21, autoHeight.get(r) || 0));
  // Charts extend the page: count the rows and columns their boxes cover.
  for (const chart of charts) {
    const pos = chart.position.overlayPosition,
      anchor = pos.anchorCell;
    let r = anchor.rowIndex || 0,
      height = (pos.offsetYPixels || 0) + (pos.heightPixels || 371);
    while (height > 0 && r < grid.rowCount) height -= rowHeight(r++);
    let c = anchor.columnIndex || 0,
      width = (pos.offsetXPixels || 0) + (pos.widthPixels || 600);
    while (width > 0 && c < grid.columnCount) width -= columnWidth(c++);
    usedRows = Math.max(usedRows, r);
    usedColumns = Math.max(usedColumns, c);
  }
  const rows = Math.min(grid.rowCount, usedRows + 3, maxRows ?? Infinity);
  let columns = Math.min(grid.columnCount, usedColumns + 1);
  const xs = [0];
  for (let c = 0; c < columns || (xs[c] < minWidth && c < grid.columnCount); c++)
    xs.push(xs[c] + columnWidth(c));
  columns = xs.length - 1;
  const ys = [0];
  for (let r = 0; r < rows; r++) ys.push(ys[r] + rowHeight(r));
  return { rows, columns, xs, ys, usedRows, width: xs[columns], height: ys[rows] };
}

// ---------------------------------------------------------------------------------------------
// One tab as HTML: gridlines, fills, borders, text (spilling like Sheets) and charts.

const BORDER_WIDTH = { SOLID: 1, DOTTED: 1, DASHED: 1, SOLID_MEDIUM: 2, SOLID_THICK: 3, DOUBLE: 3 };
const BORDER_STYLE = { DOTTED: 'dotted', DASHED: 'dashed', DOUBLE: 'double' };

function renderSheet(sheet, model, { maxRows } = {}) {
  const charts = model.charts.filter(
    (chart) => chart.position?.overlayPosition?.anchorCell?.sheetId === sheet.props.sheetId
  );
  const g = geometry(sheet, charts, { minWidth: VIEWPORT - ROW_HEADER, maxRows });
  const mergeAt = new Map(),
    covered = new Set();
  for (const m of sheet.merges) {
    mergeAt.set(m.r0 + ':' + m.c0, m);
    for (let r = m.r0; r < m.r1; r++)
      for (let c = m.c0; c < m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(r + ':' + c);
  }
  const mergeOf = (r, c) =>
    sheet.merges.find((m) => r >= m.r0 && r < m.r1 && c >= m.c0 && c < m.c1);
  const box = (r0, c0, r1, c1) => ({
    x: g.xs[Math.min(c0, g.columns)],
    y: g.ys[Math.min(r0, g.rows)],
    w: g.xs[Math.min(c1, g.columns)] - g.xs[Math.min(c0, g.columns)],
    h: g.ys[Math.min(r1, g.rows)] - g.ys[Math.min(r0, g.rows)],
  });
  const empty = (r, c) =>
    !covered.has(r + ':' + c) &&
    !mergeAt.has(r + ':' + c) &&
    !cellText(sheet.cells.get(r + ':' + c));
  const fills = [],
    borders = [],
    texts = [];
  for (const [key, cell] of sheet.cells) {
    const [r, c] = key.split(':').map(Number);
    if (r >= g.rows || c >= g.columns) continue;
    const format = cell.userEnteredFormat || {};
    const merge = mergeAt.get(key);
    const area = merge ? box(merge.r0, merge.c0, merge.r1, merge.c1) : box(r, c, r + 1, c + 1);
    const fill = hex(format.backgroundColorStyle, format.backgroundColor);
    if (fill && !covered.has(key))
      fills.push(
        `<div class="fill" style="left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px;background:${fill}"></div>`
      );
    // Only the outer edges of a merged block keep their borders.
    const outer = mergeOf(r, c) || { r0: r, r1: r + 1, c0: c, c1: c + 1 };
    const cellBox = box(r, c, r + 1, c + 1);
    for (const [side, border] of Object.entries(format.borders || {})) {
      if (!border || border.style === 'NONE') continue;
      if (
        (side === 'top' && r !== outer.r0) ||
        (side === 'bottom' && r !== outer.r1 - 1) ||
        (side === 'left' && c !== outer.c0) ||
        (side === 'right' && c !== outer.c1 - 1)
      )
        continue;
      const width =
        border.width && border.style === 'SOLID' ? border.width : BORDER_WIDTH[border.style] || 1;
      const line = `${width}px ${BORDER_STYLE[border.style] || 'solid'} ${hex(border.colorStyle, border.color) || '#000'}`;
      const offset = Math.ceil(width / 2);
      if (side === 'top' || side === 'bottom') {
        const y = (side === 'top' ? cellBox.y : cellBox.y + cellBox.h) - offset;
        borders.push(
          `<div class="edge" style="left:${cellBox.x - 1}px;top:${y}px;width:${cellBox.w + 1}px;border-top:${line}"></div>`
        );
      } else {
        const x = (side === 'left' ? cellBox.x : cellBox.x + cellBox.w) - offset;
        borders.push(
          `<div class="edge" style="left:${x}px;top:${cellBox.y - 1}px;height:${cellBox.h + 1}px;border-left:${line}"></div>`
        );
      }
    }
    const shown = cellText(cell);
    if (!shown || covered.has(key)) continue;
    const text = format.textFormat || {};
    const align =
      format.horizontalAlignment || (shown.numeric ? 'RIGHT' : shown.bool ? 'CENTER' : 'LEFT');
    const wrap = format.wrapStrategy || 'OVERFLOW_CELL';
    let x0 = area.x,
      x1 = area.x + area.w;
    // Text spills into empty neighbours; numbers, merged cells and CLIP/WRAP stay inside.
    if (!shown.numeric && !merge && (wrap === 'OVERFLOW_CELL' || wrap === 'LEGACY_WRAP')) {
      let right = c + 1,
        left = c - 1;
      while (right < g.columns && empty(r, right)) right++;
      while (left >= 0 && empty(r, left)) left--;
      if (align === 'LEFT') x1 = g.xs[right];
      else if (align === 'RIGHT') x0 = g.xs[left + 1];
      else {
        const reach = Math.min(g.xs[right] - x1, x0 - g.xs[left + 1]);
        x0 -= reach;
        x1 += reach;
      }
    }
    const padding = { top: 2, right: 3, bottom: 2, left: 3, ...(format.padding || {}) };
    const link = text.link?.uri;
    const color =
      shown.color ||
      hex(text.foregroundColorStyle, text.foregroundColor) ||
      (link ? THEME.LINK : '#000000');
    const decoration =
      [text.underline || link ? 'underline' : '', text.strikethrough ? 'line-through' : '']
        .filter(Boolean)
        .join(' ') || 'none';
    const style = [
      `font-family:${text.fontFamily ? `'${text.fontFamily}', ` : ''}Arial, sans-serif`,
      `font-size:${text.fontSize || 10}pt`,
      `font-weight:${text.bold ? 700 : 400}`,
      `font-style:${text.italic ? 'italic' : 'normal'}`,
      `color:${color}`,
      `text-decoration:${decoration}`,
      `text-align:${align.toLowerCase()}`,
      `white-space:${wrap === 'WRAP' ? 'pre-wrap' : 'pre'}`,
    ].join(';');
    const valign = { TOP: 'flex-start', MIDDLE: 'center' }[format.verticalAlignment] || 'flex-end';
    // An internal link (#gid=<this tab>&range=A<row>) jumps to that row of the preview.
    const target = link && /#gid=(\d+)&range=[A-Z]+(\d+)/.exec(link);
    const href = target && Number(target[1]) === sheet.props.sheetId ? '#row-' + target[2] : link;
    const content = link
      ? `<a href="${esc(href)}" style="color:inherit">${esc(shown.text)}</a>`
      : esc(shown.text);
    texts.push(
      `<div class="text" style="left:${x0}px;top:${area.y}px;width:${x1 - x0}px;height:${area.h}px;justify-content:${valign};padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px"><div style="${style}">${content}</div></div>`
    );
  }
  const gridPath = [
    ...g.xs.slice(1).map((x) => `M${x - 0.5} 0V${g.height}`),
    ...g.ys.slice(1).map((y) => `M0 ${y - 0.5}H${g.width}`),
  ].join('');
  const gridlines = sheet.props.gridProperties.hideGridlines
    ? ''
    : `<svg class="lines" width="${g.width}" height="${g.height}"><path d="${gridPath}" stroke="#e2e3e3"/></svg>`;
  const frozen = sheet.props.gridProperties.frozenRowCount;
  const freeze = frozen
    ? `<div class="freeze" style="top:${g.ys[Math.min(frozen, g.rows)] - 2}px;width:${g.width}px"></div>`
    : '';
  const chartHtml = charts.map((chart) => {
    const pos = chart.position.overlayPosition,
      anchor = pos.anchorCell;
    const x = g.xs[Math.min(anchor.columnIndex || 0, g.columns)] + (pos.offsetXPixels || 0);
    const y = g.ys[Math.min(anchor.rowIndex || 0, g.rows)] + (pos.offsetYPixels || 0);
    return `<div class="chart" style="left:${x}px;top:${y}px">${chartSvg(chart, model.sheets)}</div>`;
  });
  const columnHeaders = Array.from(
    { length: g.columns },
    (_, c) =>
      `<div class="head" style="left:${ROW_HEADER + g.xs[c]}px;top:0;width:${g.xs[c + 1] - g.xs[c]}px;height:${COLUMN_HEADER}px">${g.xs[c + 1] > g.xs[c] ? columnName(c) : ''}</div>`
  );
  const rowHeaders = Array.from(
    { length: g.rows },
    (_, r) =>
      `<div class="head" id="row-${r + 1}" style="left:0;top:${COLUMN_HEADER + g.ys[r]}px;width:${ROW_HEADER}px;height:${g.ys[r + 1] - g.ys[r]}px">${g.ys[r + 1] > g.ys[r] ? r + 1 : ''}</div>`
  );
  const tabs = [...model.sheets.values()]
    .filter((item) => !item.props.hidden || item === sheet)
    .map((item) => {
      const tabColor = hex(item.props.tabColorStyle, item.props.tabColor);
      const label = esc(item.props.title) + (item.props.hidden ? ' <i>(hidden)</i>' : '');
      return `<div class="tab${item === sheet ? ' active' : ''}"${tabColor ? ` style="box-shadow:inset 0 -4px 0 ${tabColor}"` : ''}>${label}</div>`;
    });
  const more =
    g.usedRows > g.rows && maxRows
      ? `<div class="more">${(g.usedRows - g.rows).toLocaleString('en-US')} more rows are not drawn in this preview.</div>`
      : '';
  return `<title>${esc(sheet.props.title)} · preview</title>
<style>
  body { margin: 0; background: #fff; font-family: Arial, sans-serif; }
  .page { position: relative; width: ${ROW_HEADER + g.width}px; height: ${COLUMN_HEADER + g.height}px; overflow: hidden; }
  .head { position: absolute; box-sizing: border-box; background: #f8f9fa; color: #5f6368; font: 11px Arial, sans-serif; display: flex; align-items: center; justify-content: center; border-right: 1px solid #c7c7c7; border-bottom: 1px solid #c7c7c7; overflow: hidden; }
  .grid { position: absolute; left: ${ROW_HEADER}px; top: ${COLUMN_HEADER}px; width: ${g.width}px; height: ${g.height}px; overflow: hidden; }
  .lines, .fill, .edge, .text, .chart, .freeze { position: absolute; }
  .lines { left: 0; top: 0; }
  .edge { height: 0; width: 0; }
  .text { box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; }
  .text > div { overflow: hidden; line-height: 1.2; overflow-wrap: anywhere; }
  .freeze { left: 0; height: 4px; background: #c7c7c7; }
  .tabs { display: flex; gap: 2px; padding: 6px 8px 8px ${ROW_HEADER}px; background: #f1f3f4; border-top: 1px solid #dadce0; font: 13px Arial, sans-serif; color: #444; }
  .tab { padding: 6px 14px; border-radius: 0 0 6px 6px; }
  .tab.active { background: #fff; color: #0b57d0; font-weight: 700; }
  .more { padding: 8px ${ROW_HEADER}px; font: italic 12px Arial, sans-serif; color: #777; }
</style>
<div class="page">
${columnHeaders.join('\n')}
${rowHeaders.join('\n')}
<div class="grid">
${gridlines}
${fills.join('\n')}
${borders.join('\n')}
${freeze}
${texts.join('\n')}
${chartHtml.join('\n')}
</div>
</div>
${more}
<div class="tabs">${tabs.join('')}</div>
`;
}

// ---------------------------------------------------------------------------------------------
// Charts as inline SVG from the chart spec and the cells of its source ranges.

const DASHES = {
  DOTTED: '2 3',
  MEDIUM_DASHED: '7 5',
  MEDIUM_DASHED_DOTTED: '7 4 2 4',
  LONG_DASHED: '13 5',
  LONG_DASHED_DOTTED: '13 4 2 4',
};

function sourceCells(sheets, data) {
  const cells = [];
  for (const source of data?.sourceRange?.sources || []) {
    const sheet = sheets.get(source.sheetId);
    if (!sheet) continue;
    for (let r = source.startRowIndex ?? 0; r < (source.endRowIndex ?? 0); r++)
      for (let c = source.startColumnIndex ?? 0; c < (source.endColumnIndex ?? 0); c++)
        cells.push(sheet.cells.get(r + ':' + c) || {});
  }
  return cells;
}

// Axis and label numbers use the source cells' pattern when the series agree on one, like Sheets.
const patternOf = (cells) =>
  cells.map((cell) => cell.userEnteredFormat?.numberFormat?.pattern).find(Boolean) || null;
const formatWith = (value, pattern) =>
  pattern && pattern !== '@' ? formatNumber(value, pattern).text : generalNumber(round(value, 6));

function niceTicks(min, max, count = 5) {
  if (min === max) max = min + (min ? Math.abs(min) : 1);
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw * 0.999);
  const lo = Math.floor(min / step + 1e-9) * step,
    hi = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(round(v, 10));
  return ticks;
}

// A second axis shares the first one's gridlines: same number of intervals, its own nice step.
function alignedTicks(min, max, intervals) {
  let step = niceTicks(min, max, intervals)[1] - niceTicks(min, max, intervals)[0];
  const lo = Math.floor(min / step + 1e-9) * step;
  while (lo + step * intervals < max - 1e-9) step = niceTicks(0, step * 1.01, 1)[1];
  return Array.from({ length: intervals + 1 }, (_, i) => round(lo + i * step, 10));
}

// Catmull-Rom through the points, as cubic Beziers: Sheets' lineSmoothing, approximately.
function smoothPath(points) {
  if (points.length < 3) return 'M' + points.map((p) => `${p.x} ${p.y}`).join('L');
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i],
      p1 = points[i],
      p2 = points[i + 1],
      p3 = points[i + 2] || p2;
    d += `C${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6} ${p2.x} ${p2.y}`;
  }
  return d;
}

function chartSvg(chart, sheets) {
  const spec = chart.spec || {};
  const pos = chart.position.overlayPosition;
  const width = pos.widthPixels || 600,
    height = pos.heightPixels || 371;
  const font = `${spec.fontName ? `'${spec.fontName}', ` : ''}Roboto, Arial, sans-serif`;
  const out = [];
  const text = (x, y, value, { size = 12, color = '#333', anchor = 'start', weight = 400 } = {}) =>
    out.push(
      `<text x="${round(x, 1)}" y="${round(y, 1)}" font-size="${round(size, 1)}" fill="${color}" text-anchor="${anchor}" font-weight="${weight}">${esc(value)}</text>`
    );
  const background = hex(spec.backgroundColorStyle, spec.backgroundColor) || '#ffffff';
  out.push(`<rect width="${width}" height="${height}" fill="${background}"/>`);
  let top = 10;
  if (spec.title) {
    const format = spec.titleTextFormat || {};
    const size = format.fontSize ? pt(format.fontSize) : 18;
    const align = spec.titleTextPosition?.horizontalAlignment || 'LEFT';
    const x = align === 'CENTER' ? width / 2 : align === 'RIGHT' ? width - 16 : 16;
    text(x, top + size, spec.title, {
      size,
      color: hex(format.foregroundColorStyle, format.foregroundColor) || '#757575',
      weight: format.bold ? 700 : 400,
      anchor: { CENTER: 'middle', RIGHT: 'end' }[align] || 'start',
    });
    top += size + 14;
  }
  if (spec.subtitle) {
    text(16, top + 12, spec.subtitle, { size: 13, color: '#757575' });
    top += 22;
  }
  const area = { x0: 0, y0: top, x1: width, y1: height };
  if (spec.pieChart) pieChart(spec.pieChart, sheets, area, out, text);
  else if (spec.basicChart) basicChart(spec.basicChart, sheets, area, out, text);
  else
    text(
      width / 2,
      height / 2,
      'Chart type not drawn by this preview: ' +
        Object.keys(spec)
          .filter((key) => /Chart$/.test(key))
          .join(', '),
      { anchor: 'middle', color: '#999' }
    );
  // Sheets frames an unselected chart in grey unless a border colour is set.
  const border = hex(chart.border?.colorStyle, chart.border?.color) || '#a0a0a0';
  out.push(
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="${border}"/>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${esc(font)}">${out.join('')}</svg>`;
}

// Legend entries in centred rows (top/bottom) or a column (left/right); the legend's room is
// taken from the area left for the plot.
function legend(entries, position, area, out, text) {
  if (!entries.length || position === 'NO_LEGEND') return;
  const size = 12;
  const mark = (entry, x, y) => {
    if (entry.mark === 'line')
      out.push(
        `<line x1="${x}" y1="${y}" x2="${x + 16}" y2="${y}" stroke="${entry.color}" stroke-width="${Math.max(2, entry.width || 2)}"${entry.dash ? ` stroke-dasharray="${entry.dash}"` : ''}/>`
      );
    else if (entry.mark === 'dot')
      out.push(`<circle cx="${x + 6}" cy="${y}" r="5" fill="${entry.color}"/>`);
    else
      out.push(
        `<rect x="${x + 1}" y="${y - 5}" width="11" height="11" rx="2" fill="${entry.color}"/>`
      );
  };
  const widthOf = (entry) => 22 + textWidth(entry.label, size) + 14;
  if (/LEFT|RIGHT|LABELED/.test(position)) {
    const columnWidth = Math.min((area.x1 - area.x0) * 0.4, Math.max(...entries.map(widthOf)));
    const x = /LEFT/.test(position) ? area.x0 + 12 : area.x1 - columnWidth - 8;
    let y = (area.y0 + area.y1) / 2 - (entries.length * 20) / 2 + 10;
    for (const entry of entries) {
      mark(entry, x, y);
      const room = Math.floor((columnWidth - 30) / (size * 0.55));
      text(
        x + 22,
        y + 4,
        entry.label.length > room ? entry.label.slice(0, Math.max(1, room - 1)) + '…' : entry.label,
        { size, color: '#222' }
      );
      y += 20;
    }
    if (/LEFT/.test(position)) area.x0 += columnWidth + 16;
    else area.x1 -= columnWidth + 12;
    return;
  }
  const rows = [[]];
  let used = 0;
  for (const entry of entries) {
    if (used + widthOf(entry) > area.x1 - area.x0 - 32 && rows.at(-1).length) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1).push(entry);
    used += widthOf(entry);
  }
  const bottom = position === 'BOTTOM_LEGEND';
  let y = bottom ? area.y1 - rows.length * 20 - 2 : area.y0 + 8;
  for (const row of rows) {
    let x = (area.x0 + area.x1) / 2 - row.reduce((total, entry) => total + widthOf(entry), 0) / 2;
    for (const entry of row) {
      mark(entry, x, y + 6);
      text(x + 22, y + 10, entry.label, { size, color: '#222' });
      x += widthOf(entry);
    }
    y += 20;
  }
  if (bottom) area.y1 -= rows.length * 20 + 6;
  else area.y0 += rows.length * 20 + 10;
}

function axisFormat(axes, position) {
  const format = (axes || []).find((axis) => axis.position === position)?.format || {};
  return {
    size: format.fontSize ? pt(format.fontSize) : 12,
    color: hex(format.foregroundColorStyle, format.foregroundColor) || '#444',
    weight: format.bold ? 700 : 400,
  };
}

function basicChart(b, sheets, area, out, text) {
  const header = b.headerCount || 0;
  const horizontal = b.chartType === 'BAR';
  const domainCells = sourceCells(sheets, b.domains?.[0]?.domain);
  let categories = domainCells.slice(header).map((cell) => cellText(cell)?.text ?? '');
  const series = (b.series || []).map((item, index) => {
    const cells = sourceCells(sheets, item.series);
    const values = cells.slice(header).map(numberOf);
    const kind = b.chartType === 'COMBO' ? item.type || 'COLUMN' : b.chartType;
    return {
      label: header ? cellText(cells[0])?.text || `Series ${index + 1}` : `Series ${index + 1}`,
      values,
      pattern: patternOf(cells.slice(header)),
      mark:
        { LINE: 'line', AREA: 'area', STEPPED_AREA: 'area', SCATTER: 'scatter' }[kind] || 'column',
      axis: item.targetAxis === 'RIGHT_AXIS' ? 'right' : 'left',
      color: hex(item.colorStyle, item.color) || PALETTE[index % PALETTE.length],
      width: item.lineStyle?.width || 2,
      dash: DASHES[item.lineStyle?.type],
      labelSpec: item.dataLabel,
      point: item.pointStyle,
    };
  });
  if (b.domains?.[0]?.reversed) {
    categories = categories.reverse();
    series.forEach((item) => item.values.reverse());
  }
  const count = Math.max(categories.length, ...series.map((item) => item.values.length), 1);
  const stacked = b.stackedType === 'STACKED' || b.stackedType === 'PERCENT_STACKED';
  legend(
    series.map((item) => ({
      label: item.label,
      color: item.color,
      mark: item.mark === 'column' || item.mark === 'area' ? 'box' : 'line',
      dash: item.dash,
      width: item.width,
    })),
    b.legendPosition || 'RIGHT_LEGEND',
    area,
    out,
    text
  );
  // Value ranges per axis; stacked marks add up per category.
  const range = (axis) => {
    let lo = 0,
      hi = 0;
    const members = series.filter((item) => item.axis === axis);
    for (let i = 0; i < count; i++) {
      let up = 0,
        down = 0;
      for (const item of members) {
        const value = item.values[i] ?? 0;
        if (stacked && item.mark !== 'line') value >= 0 ? (up += value) : (down += value);
        else {
          lo = Math.min(lo, value);
          hi = Math.max(hi, value);
        }
      }
      lo = Math.min(lo, down);
      hi = Math.max(hi, up);
    }
    return { lo, hi, members };
  };
  const view = (position) =>
    (b.axis || []).find((axis) => axis.position === position)?.viewWindowOptions || {};
  const left = range('left'),
    right = range('right');
  const valuePosition = horizontal ? 'BOTTOM_AXIS' : 'LEFT_AXIS';
  const leftTicks = niceTicks(
    view(valuePosition).viewWindowMin ?? left.lo,
    view(valuePosition).viewWindowMax ?? left.hi
  );
  const rightTicks = right.members.length
    ? alignedTicks(right.lo, right.hi, leftTicks.length - 1)
    : null;
  const sharedPattern = (members) => {
    const patterns = [...new Set(members.map((item) => item.pattern))];
    return patterns.length === 1 ? patterns[0] : null;
  };
  const valueStyle = axisFormat(b.axis, valuePosition),
    categoryStyle = axisFormat(b.axis, horizontal ? 'LEFT_AXIS' : 'BOTTOM_AXIS');
  const rightStyle = axisFormat(b.axis, 'RIGHT_AXIS');
  const leftLabels = leftTicks.map((tick) => formatWith(tick, sharedPattern(left.members)));
  const rightLabels = rightTicks
    ? rightTicks.map((tick) => formatWith(tick, sharedPattern(right.members)))
    : [];
  const axisTitle = (position) => (b.axis || []).find((axis) => axis.position === position)?.title;
  const plot = { ...area };
  plot.x0 += 14;
  plot.x1 -= 18;
  plot.y0 += 8;
  if (horizontal) {
    plot.x0 += Math.min(
      (area.x1 - area.x0) * 0.35,
      Math.max(...categories.map((label) => textWidth(label, categoryStyle.size))) + 10
    );
    plot.y1 -= valueStyle.size + 14;
  } else {
    plot.x0 += Math.max(...leftLabels.map((label) => textWidth(label, valueStyle.size))) + 8;
    if (rightTicks)
      plot.x1 -= Math.max(...rightLabels.map((label) => textWidth(label, rightStyle.size))) + 8;
    plot.y1 -= categoryStyle.size + 16;
  }
  if (axisTitle('LEFT_AXIS')) plot.x0 += 18;
  if (axisTitle('BOTTOM_AXIS')) plot.y1 -= 18;
  const scale = (ticks, from, to) => (value) =>
    from + ((value - ticks[0]) / (ticks.at(-1) - ticks[0])) * (to - from);
  const valueAt = horizontal
    ? scale(leftTicks, plot.x0, plot.x1)
    : scale(leftTicks, plot.y1, plot.y0);
  const rightAt = rightTicks ? scale(rightTicks, plot.y1, plot.y0) : null;
  const band = (horizontal ? plot.y1 - plot.y0 : plot.x1 - plot.x0) / count;
  const center = (i) => (horizontal ? plot.y0 : plot.x0) + band * (i + 0.5);
  // Gridlines and value labels.
  leftTicks.forEach((tick, i) => {
    const at = valueAt(tick);
    if (horizontal) {
      out.push(
        `<line x1="${at}" y1="${plot.y0}" x2="${at}" y2="${plot.y1}" stroke="${tick === 0 ? '#333' : '#e0e0e0'}"/>`
      );
      // Sheets drops a tick label that would run past the chart edge.
      if (at + textWidth(leftLabels[i], valueStyle.size) / 2 <= area.x1 + 8)
        text(at, plot.y1 + valueStyle.size + 6, leftLabels[i], { ...valueStyle, anchor: 'middle' });
    } else {
      out.push(
        `<line x1="${plot.x0}" y1="${at}" x2="${plot.x1}" y2="${at}" stroke="${tick === 0 ? '#333' : '#e0e0e0'}"/>`
      );
      text(plot.x0 - 6, at + valueStyle.size * 0.35, leftLabels[i], {
        ...valueStyle,
        anchor: 'end',
      });
      if (rightTicks)
        text(plot.x1 + 6, at + rightStyle.size * 0.35, rightLabels[i], { ...rightStyle });
    }
  });
  // Category labels: a few categories each keep a (truncated) label; long axes are thinned out.
  const labelWidth = Math.max(
    ...categories.map((label) => textWidth(label, categoryStyle.size)),
    1
  );
  const fitsTruncated = count <= 15 && band >= categoryStyle.size * 4;
  const every = horizontal
    ? Math.max(1, Math.ceil((categoryStyle.size + 4) / band))
    : fitsTruncated
      ? 1
      : Math.max(1, Math.ceil((labelWidth + 10) / band));
  categories.forEach((label, i) => {
    if (i % every) return;
    const room = horizontal ? plot.x0 - area.x0 - 24 : band * every - 6;
    const fits = Math.max(1, Math.floor(room / (categoryStyle.size * 0.56)));
    const shown =
      textWidth(label, categoryStyle.size) > room
        ? label.slice(0, Math.max(1, fits - 1)) + '…'
        : label;
    if (horizontal)
      text(plot.x0 - 8, center(i) + categoryStyle.size * 0.35, shown, {
        ...categoryStyle,
        anchor: 'end',
      });
    else
      text(center(i), plot.y1 + categoryStyle.size + 6, shown, {
        ...categoryStyle,
        anchor: 'middle',
      });
  });
  if (axisTitle('LEFT_AXIS'))
    out.push(
      `<text transform="translate(${area.x0 + 22} ${(plot.y0 + plot.y1) / 2}) rotate(-90)" font-size="12" fill="#444" text-anchor="middle">${esc(axisTitle('LEFT_AXIS'))}</text>`
    );
  if (axisTitle('BOTTOM_AXIS'))
    text((plot.x0 + plot.x1) / 2, plot.y1 + categoryStyle.size + 26, axisTitle('BOTTOM_AXIS'), {
      anchor: 'middle',
      color: '#444',
    });
  // Columns and bars: grouped side by side, or one stacked bar per category.
  const columns = series.filter((item) => item.mark === 'column');
  const labels = [];
  const dataLabel = (item, value, x, y, anchor = 'middle') => {
    if (item.labelSpec?.type !== 'DATA' || value === null) return;
    const format = item.labelSpec.textFormat || {};
    labels.push([
      x,
      y,
      formatWith(value, item.pattern),
      {
        size: format.fontSize ? pt(format.fontSize) : 11,
        color: hex(format.foregroundColorStyle, format.foregroundColor) || '#444',
        anchor,
      },
    ]);
  };
  for (let i = 0; i < count; i++) {
    let up = 0,
      down = 0;
    columns.forEach((item, k) => {
      const value = item.values[i];
      if (value === null || value === undefined) return;
      const at = item.axis === 'right' && rightAt ? rightAt : valueAt;
      const thickness = stacked ? band * 0.62 : (band * 0.72) / columns.length;
      const offset = stacked ? -thickness / 2 : -band * 0.36 + k * thickness;
      const base = stacked ? (value >= 0 ? up : down) : 0;
      const end = base + value;
      if (stacked) value >= 0 ? (up = end) : (down = end);
      const a = at(base),
        z = at(end);
      if (horizontal) {
        out.push(
          `<rect x="${Math.min(a, z)}" y="${center(i) + offset}" width="${Math.abs(z - a)}" height="${Math.max(1, thickness - 1)}" fill="${item.color}"/>`
        );
        dataLabel(item, value, z + 4, center(i) + offset + thickness / 2 + 4, 'start');
      } else {
        out.push(
          `<rect x="${center(i) + offset}" y="${Math.min(a, z)}" width="${Math.max(1, thickness - 1)}" height="${Math.abs(z - a)}" fill="${item.color}"/>`
        );
        dataLabel(item, value, center(i) + offset + thickness / 2, z - 5);
      }
    });
  }
  // Areas, lines and scatter points, drawn over the columns as Sheets does in combo charts.
  const floor = new Array(count).fill(0);
  for (const item of series.filter((entry) => entry.mark !== 'column')) {
    const at = item.axis === 'right' && rightAt ? rightAt : valueAt;
    const points = [];
    item.values.forEach((value, i) => {
      if (value === null || value === undefined) return;
      const base = stacked && item.mark === 'area' ? floor[i] : 0;
      if (stacked && item.mark === 'area') floor[i] += value;
      points.push({ x: center(i), y: at(base + value), base: at(base), value });
    });
    if (!points.length) continue;
    const d = b.lineSmoothing
      ? smoothPath(points)
      : 'M' + points.map((p) => `${p.x} ${p.y}`).join('L');
    if (item.mark === 'area') {
      const back = points
        .slice()
        .reverse()
        .map((p) => `L${p.x} ${p.base}`)
        .join('');
      out.push(`<path d="${d}${back}Z" fill="${item.color}" fill-opacity="0.3"/>`);
    }
    if (item.mark !== 'scatter')
      out.push(
        `<path d="${d}" fill="none" stroke="${item.color}" stroke-width="${item.width}" stroke-linejoin="round"${item.dash ? ` stroke-dasharray="${item.dash}"` : ''}/>`
      );
    const radius =
      item.mark === 'scatter'
        ? 4
        : item.point?.size
          ? item.point.size / 2
          : points.length === 1
            ? 3
            : 0;
    if (radius)
      points.forEach((p) =>
        out.push(`<circle cx="${p.x}" cy="${p.y}" r="${radius}" fill="${item.color}"/>`)
      );
    points.forEach((p) => dataLabel(item, p.value, p.x, p.y - 8));
  }
  for (const [x, y, value, style] of labels) text(x, y, value, style);
}

function pieChart(p, sheets, area, out, text) {
  const labels = sourceCells(sheets, p.domain).map((cell) => cellText(cell)?.text ?? '');
  const values = sourceCells(sheets, p.series).map(numberOf);
  const slices = labels
    .map((label, i) => ({
      label,
      value: values[i] || 0,
      color: PALETTE[i % PALETTE.length],
      mark: 'dot',
    }))
    .filter((slice) => slice.value > 0);
  legend(slices, p.legendPosition || 'RIGHT_LEGEND', area, out, text);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const cx = (area.x0 + area.x1) / 2,
    cy = (area.y0 + area.y1) / 2;
  const radius = Math.max(10, Math.min(area.x1 - area.x0, area.y1 - area.y0) / 2 - 12);
  const hole = radius * (p.pieHole || 0);
  const point = (angle, r) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  let angle = -Math.PI / 2;
  for (const slice of slices) {
    const sweep = (slice.value / total) * Math.PI * 2;
    const end = angle + Math.min(sweep, Math.PI * 2 - 1e-4);
    const large = sweep > Math.PI ? 1 : 0;
    const [x1, y1] = point(angle, radius),
      [x2, y2] = point(end, radius);
    const [x3, y3] = point(end, hole),
      [x4, y4] = point(angle, hole);
    const d = hole
      ? `M${x1} ${y1}A${radius} ${radius} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${hole} ${hole} 0 ${large} 0 ${x4} ${y4}Z`
      : `M${cx} ${cy}L${x1} ${y1}A${radius} ${radius} 0 ${large} 1 ${x2} ${y2}Z`;
    out.push(`<path d="${d}" fill="${slice.color}" stroke="#fff" stroke-width="1"/>`);
    // Sheets prints each slice's share inside it when the slice is big enough.
    if (slice.value / total >= 0.05) {
      const [lx, ly] = point(angle + sweep / 2, hole ? (radius + hole) / 2 : radius * 0.62);
      text(lx, ly + 4, `${round((slice.value / total) * 100, 1)}%`, {
        size: 12,
        color: '#fff',
        anchor: 'middle',
      });
    }
    angle += sweep;
  }
}

// ---------------------------------------------------------------------------------------------
// Pages, screenshots and the command line.

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    // The repo's browser tests use the installed Chrome when Playwright's own is missing.
    return chromium.launch({
      executablePath:
        process.env.PLAYWRIGHT_CHROME_EXECUTABLE ||
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
    });
  }
}

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// A fixture module exports any of these; what it leaves out keeps the built-in value.
function useFixture(fixture) {
  ({
    ACCOUNTS = ACCOUNTS,
    LABELS = LABELS,
    CURRENCY = CURRENCY,
    CAMPAIGNS = CAMPAIGNS,
    KEYWORD_CITIES = KEYWORD_CITIES,
    KEYWORD_THEMES = KEYWORD_THEMES,
    WASTE = WASTE,
    LONG_TAIL = LONG_TAIL,
    ASSETS = ASSETS,
    keywordCampaign = keywordCampaign,
    longTailKeyword = longTailKeyword,
    adGroupName = adGroupName,
  } = fixture);
}

async function main() {
  const args = process.argv.slice(2);
  const tier = args.includes('--plan') ? args[args.indexOf('--plan') + 1] : null;
  if (tier && !TIERS.includes(tier)) throw new Error('--plan takes ' + TIERS.join(', '));
  const sourceRoot = path.resolve(
    args.includes('--root') ? args[args.indexOf('--root') + 1] : root
  );
  if (sourceRoot !== path.resolve(root)) console.log('Runtime from ' + sourceRoot);
  if (args.includes('--out')) outDir = path.resolve(args[args.indexOf('--out') + 1]);
  if (args.includes('--fixture')) {
    const fixturePath = path.resolve(args[args.indexOf('--fixture') + 1]);
    useFixture(await import(pathToFileURL(fixturePath).href));
    console.log('Fixture from ' + fixturePath);
  }
  const run = await buildDashboard({ tier, refresh: args.includes('--refresh'), sourceRoot });
  for (const attempt of run.attempts)
    console.log(`Plan ${attempt.tier} was not accepted: ${attempt.error}`);
  console.log(`Plan used: ${run.tier}`);
  const model = replay(run.f.state.batches, run.before);
  const byTitle = (title) =>
    [...model.sheets.values()].find((sheet) => sheet.props.title === title);
  const target = run.input.target.sheetName;
  const pages = [
    { name: 'dashboard', sheet: byTitle(target) },
    { name: 'chart-data', sheet: byTitle(target.slice(0, 86) + ' (chart data)') },
    ...run.input.datasets.map((dataset) => ({
      name: 'data-' + slug(dataset.sheetName),
      sheet: byTitle(dataset.sheetName),
      maxRows: DATA_TAB_ROWS,
    })),
  ].filter((page) => page.sheet);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'plan.json'),
    JSON.stringify({ tier: run.tier, plan: run.input }, null, 2)
  );
  await writeFile(
    path.join(outDir, 'batch.json'),
    JSON.stringify(run.f.state.batches.at(-1).body, null, 1)
  );
  for (const page of pages) {
    page.html = path.join(outDir, page.name + '.html');
    await writeFile(page.html, renderSheet(page.sheet, model, { maxRows: page.maxRows }));
  }
  if (!args.includes('--html-only')) {
    const browser = await launchBrowser();
    try {
      const tab = await browser.newPage({ viewport: { width: VIEWPORT, height: 900 } });
      for (const page of pages) {
        page.png = page.html.replace(/\.html$/, '.png');
        await tab.goto(pathToFileURL(page.html).href);
        await tab.screenshot({ path: page.png, fullPage: true });
      }
    } finally {
      await browser.close();
    }
  }
  for (const page of pages)
    console.log(`${page.sheet.props.title}: ${[page.html, page.png].filter(Boolean).join('  ')}`);
  if (model.ignored.length)
    console.log('Requests the preview does not draw: ' + model.ignored.join(', '));
  const result = run.result,
    tiles = run.input.tiles;
  const tables = result.tiles.filter((tile) => tile.type === 'table').length;
  console.log(
    `${result.name} (plan ${run.tier}): ${tiles.length} tiles, ${result.scorecards.length} scorecards, ` +
      `${result.chartCount} charts (${model.charts.length} drawn), ${tables} tables, ` +
      `${result.rowCount.toLocaleString('en-US')} rows in ${result.datasets.length} datasets, ` +
      `dashboard tab ${pages[0] ? geometry(pages[0].sheet, [], { minWidth: 0 }).usedRows : 0} rows`
  );
}

export { formatNumber, planFor, replay, renderSheet };

// Importing the module (for a check or another tool) does not run it.
if (
  path.resolve(process.argv[1] || '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
)
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
