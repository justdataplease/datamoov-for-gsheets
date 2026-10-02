// The analyst sheet tools: one message cleans a messy export (trim, remove duplicates after a yes,
// split names, a Status dropdown), builds a pivot and colours CPA over 50, and a second undoes
// the colour.
//
//   node videos/kit/record.mjs videos/analyst-tools --format all
//
// The tabs are drawn by ./sheets.mjs from a fictional export (example.com addresses); the replies
// quote its numbers: 4 cells trimmed, rows 5, 8 and 13 duplicate an email, 11 leads kept, 5 CPA
// cells over 50, spend 2,900 in the pivot.
import { buildSheets } from './sheets.mjs';

export const formats = ['square', 'portrait', 'landscape'];
export const prepare = buildSheets;

const ASK =
  'Clean this export: trim spaces, remove duplicate emails, split the name, add a Status dropdown. ' +
  'Then pivot spend by campaign and month, and colour CPA over 50 red.';

const CONFIRM = {
  text:
    'Trimmed 4 cells. **3 rows repeat an email** from an earlier row (rows 5, 8 and 13). ' +
    'Remove them? You can undo it afterwards.',
  options: ['Yes, remove them', 'No'],
  events: [
    { kind: 'read', text: 'Inspected Leads export!A1:G15' },
    { kind: 'write', text: 'Trimmed spaces in Leads export!A1:G15 · 4 cells' },
  ],
};

const DONE = {
  text:
    '**Done.**\n\n' +
    '- Removed 3 duplicate rows: **11 unique leads** left\n' +
    '- Split Name into First name and Last name\n' +
    '- Status is a dropdown: New, Contacted, Won, Lost\n' +
    '- Pivot of spend by campaign and month on **Spend by campaign** (total 2,900.00)\n' +
    '- CPA over 50 is red as a live rule: 5 leads today',
  events: [
    { kind: 'write', text: 'Removed 3 duplicate rows from Leads export (confirmed)' },
    { kind: 'write', text: 'Split Leads export!B2:B12 into First name and Last name' },
    { kind: 'write', text: 'Added a Status dropdown to Leads export!I2:I12' },
    { kind: 'write', text: 'Created a pivot on Spend by campaign' },
    { kind: 'write', text: 'Added a rule: CPA > 50 in red on Leads export!H2:H12' },
  ],
};

const UNDONE = {
  text: 'Removed the CPA colour rule. Everything else stays. Your last 10 edits can be undone.',
  events: [{ kind: 'write', text: 'Undid "CPA > 50 in red" on Leads export' }],
};

export default async function (d) {
  /* ---- Open on the messy export ---- */
  await d.stage('setTabs', ['Leads export'], 'Leads export');
  await d.dashboard('export-before');
  await d.reveal(0);
  await d.card({
    kicker: 'New in DataMoov for Google Sheets',
    title: 'Your spreadsheet just hired an analyst.',
    hold: 2700,
  });
  const sheet = await d.stage('rect', 'sheet');
  const table = { x: sheet.x, y: sheet.y, w: 1000, h: 400 };
  await d.say('A messy export: stray spaces, duplicate leads, names in one column');
  await d.look(table, 0);
  await d.wait(2800);

  /* ---- One message ---- */
  await d.chatScript(
    [
      {
        steps: ['Inspecting Leads export', 'Trimming spaces', 'Checking duplicate emails'],
        reply: CONFIRM,
      },
      {
        steps: [
          'Removing 3 duplicate rows',
          'Splitting names',
          'Adding a Status dropdown',
          'Creating the pivot',
          'Adding the colour rule',
        ],
        reply: DONE,
      },
      { steps: ['Undoing the last change'], reply: UNDONE },
    ],
    700
  );
  await d.click('#tab-chat');
  await d.say('Ask in plain words, like you would ask an analyst');
  await d.look('chat', 1200);
  await d.type('#chat-input', ASK, { cps: 55 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.waitAnswers(1);
  await d.say('It asks before deleting anything');
  await d.wait(1800);
  await d.click('.chip:has-text("Yes, remove them")');
  await d.hidePointer();
  await d.say('');
  await d.waitAnswers(2);
  await d.wait(1600);

  /* ---- The result ---- */
  await d.dashboard('export-red');
  await d.say('11 unique leads, first and last name, a Status dropdown');
  await d.look(table, 1200);
  await d.wait(2600);
  await d.say('CPA over 50 in red, as a live rule that updates with the data');
  await d.look({ x: sheet.x + 560, y: sheet.y, w: 460, h: 300 }, 1100);
  await d.wait(2600);

  await d.tab('Spend by campaign', true);
  await d.dashboard('pivot');
  await d.say('A native pivot of spend by campaign and month');
  await d.look({ x: sheet.x, y: sheet.y, w: 640, h: 220 }, 1200);
  await d.wait(2800);

  /* ---- Undo ---- */
  await d.activate('Leads export');
  await d.dashboard('export-red');
  await d.say('Changed your mind? Undo it');
  await d.look('chat', 1100);
  await d.type('#chat-input', 'Undo the colour', { cps: 30 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.waitAnswers(3);
  await d.wait(900);
  await d.dashboard('export-clean');
  await d.say('Only the colour rule is gone. Everything else stays.');
  await d.look(table, 1100);
  await d.wait(2600);
  await d.say('');

  await d.card({
    kicker: 'Cleanup · lookups · pivots · colour rules · undo',
    title: 'Analyst work, done in your sheet.',
    hold: 2600,
  });
  await d.card({
    title: 'DataMoov for Google Sheets',
    text: 'Chat with your data and your spreadsheet, right where you work.',
    note: 'justdataplease.com · demo data',
    hold: 3200,
    stay: true,
  });
}
