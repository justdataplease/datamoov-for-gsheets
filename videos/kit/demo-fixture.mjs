// A fictional business for social videos: an outdoor-gear shop with two Google Ads accounts in
// USD. Every name and number here is invented. Accounts are labelled, never numbered, so no
// frame of a video can carry something that reads as a customer ID.
//
//   node tools/dashboard-preview.mjs --plan v2 --fixture videos/kit/demo-fixture.mjs --out <dir>
//
// The shapes match the built-in fixture of tools/dashboard-preview.mjs; see its comments.

// Seed keys only; labels are what the page shows.
export const ACCOUNTS = ['demo-store-us', 'demo-store-eu'];
export const LABELS = ['Demo Store US', 'Demo Store EU'];
export const CURRENCY = 'USD';

// [account, campaign, channel, monthly spend, CPA, value per conversion, CPC, CTR]
export const CAMPAIGNS = [
  [0, 'Search · Hiking boots', 'SEARCH', 24000, 38, 142, 1.45, 0.072],
  [0, 'Search · Rain jackets', 'SEARCH', 18500, 44, 128, 1.3, 0.066],
  [0, 'Search · Tents', 'SEARCH', 16000, 44, 210, 1.6, 0.061],
  [0, 'Search · Backpacks', 'SEARCH', 12500, 41, 118, 1.2, 0.058],
  [0, 'Search · Sleeping bags', 'SEARCH', 9800, 47, 124, 1.15, 0.063],
  [0, 'Search · Trekking poles', 'SEARCH', 6200, 33, 74, 0.95, 0.069],
  [0, 'Search · Brand', 'SEARCH', 7400, 6, 131, 0.35, 0.22],
  [0, 'Search · Climbing gear', 'SEARCH', 7900, 52, 165, 1.9, 0.041],
  [0, 'Search · Camp kitchen', 'SEARCH', 5600, 50, 96, 1.25, 0.044],
  [0, 'PMax · All products', 'PERFORMANCE_MAX', 21000, 49, 136, 0.62, 0.021],
  [0, 'PMax · Footwear', 'PERFORMANCE_MAX', 14200, 58, 139, 0.58, 0.019],
  [0, 'PMax · New arrivals', 'PERFORMANCE_MAX', 9600, 56, 120, 0.55, 0.017],
  [0, 'Display · Remarketing', 'DISPLAY', 5200, 54, 118, 0.42, 0.0049],
  [0, 'Display · Prospecting', 'DISPLAY', 4800, 140, 110, 0.38, 0.0041],
  [0, 'Demand Gen · Trail season', 'DEMAND_GEN', 4400, 118, 115, 0.51, 0.0088],
  [1, 'Search · Hiking boots EU', 'SEARCH', 9800, 42, 133, 1.25, 0.064],
  [1, 'Search · Rain jackets EU', 'SEARCH', 7600, 39, 121, 1.1, 0.06],
  [1, 'Search · Tents EU', 'SEARCH', 6900, 47, 198, 1.4, 0.057],
  [1, 'PMax · All products EU', 'PERFORMANCE_MAX', 8800, 55, 127, 0.57, 0.02],
  [1, 'Display · Remarketing EU', 'DISPLAY', 2600, 81, 109, 0.4, 0.0046],
];

// [campaign code, product, weight]: keywords are "<theme> <product>".
export const KEYWORD_CITIES = [
  ['Hiking boots', 'hiking boots', 1.6],
  ['Rain jackets', 'rain jacket', 1.2],
  ['Tents', 'camping tent', 1],
  ['Backpacks', 'hiking backpack', 0.9],
  ['Sleeping bags', 'sleeping bag', 0.7],
  ['Trekking poles', 'trekking poles', 0.5],
  ['Climbing gear', 'climbing harness', 0.4],
];
export const KEYWORD_THEMES = ['waterproof', 'womens', 'mens', 'lightweight', 'best'];

// Searches the shop cannot serve: they spend and never convert.
export const WASTE = [
  ['hiking boots repair near me', 'BROAD', 'Hiking boots', 3180],
  ['tent rental weekend', 'PHRASE', 'Tents', 2640],
  ['how to waterproof a jacket', 'BROAD', 'Rain jackets', 2210],
  ['used backpack free', 'BROAD', 'Backpacks', 1870],
  ['sleeping bag diy pattern', 'PHRASE', 'Sleeping bags', 1420],
  ['hiking trails near me', 'BROAD', 'Hiking boots', 1260],
  ['climbing gym membership', 'BROAD', 'Climbing gear', 1090],
  ['camping tent drawing', 'PHRASE', 'Tents', 940],
];

export const LONG_TAIL = [
  ...['for kids', 'on sale', 'size 12', 'near me', 'for women', 'for men'],
  ...['cheap', 'best rated', 'ultralight', 'winter', 'summer', 'for beginners'],
  ...['gore tex', 'vegan', 'wide fit', 'review', 'deals', 'clearance'],
  ...['outlet', 'discount code', 'black', 'green', 'for travel', 'compact'],
  ...['2 person', '4 person', 'for rain', 'for snow', 'with hood', 'packable'],
  ...['for hiking', 'for camping', 'sale', 'brands', 'lifetime warranty', 'recycled'],
  ...['free shipping', 'in stock', 'next day', 'gift', 'for teens', 'xl'],
];

export const ASSETS = [
  ['HEADLINE', 'Waterproof Hiking Boots', 'BEST'],
  ['HEADLINE', 'Free Returns for 60 Days', 'BEST'],
  ['HEADLINE', 'Gear Tested on Real Trails', 'GOOD'],
  ['HEADLINE', 'Ships Today, Arrives Fast', 'GOOD'],
  ['HEADLINE', 'Shop Our Outdoor Collection', 'LOW'],
  ['HEADLINE', 'Lightweight Tents from $149', 'BEST'],
  ['HEADLINE', 'Rain Jackets That Breathe', 'GOOD'],
  ['HEADLINE', 'Over 2,000 Products', 'LEARNING'],
  ['HEADLINE', 'Quality Outdoor Equipment', 'LOW'],
  ['HEADLINE', 'Built for Every Season', 'GOOD'],
  ['DESCRIPTION', 'Boots, tents and jackets tested on real trails. Free returns.', 'BEST'],
  ['DESCRIPTION', 'Order by 3 pm and your gear ships the same day.', 'GOOD'],
  ['DESCRIPTION', 'We have a wide range of products for all of your needs.', 'LOW'],
  ['DESCRIPTION', 'Planning a trip? Build your kit in one order.', 'LEARNING'],
  ['IMAGE', 'trail-boots-1200x628.jpg', 'BEST'],
  ['IMAGE', 'tent-dusk-1200x1200.jpg', 'GOOD'],
  ['IMAGE', 'catalog-grid-1200x628.jpg', 'LOW'],
  ['IMAGE', 'ridge-hiker-1200x1200.jpg', 'GOOD'],
  ['VIDEO', 'Boot test 30s', 'GOOD'],
  ['VIDEO', 'Pitch a tent in 60s', 'LEARNING'],
];

export const keywordCampaign = (code) => 'Search · ' + code;
export const longTailKeyword = (product, modifier) => product + ' ' + modifier;
export const adGroupName = (code, product) => product;
