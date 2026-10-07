// Scripted provider of the benchmark's self-test: each AI request of the real chat runtime is
// answered by the next step, a function of the request body, so every tool runs for real against
// the in-memory book with no request leaving the machine.
export const call = (name, args) => ({
  candidates: [
    { finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name, args } }] } },
  ],
});
export const say = (text) => ({
  candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }],
});
// A tool call the provider could not form (the app retries it without running anything).
export const malformed = () => ({
  candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { role: 'model', parts: [] } }],
});

// The newest token of a kind in the request (tool results arrive as escaped JSON text).
const latest = (body, key, pattern) => {
  const re = new RegExp('\\\\*"' + key + '\\\\*"\\s*:\\s*\\\\*"(' + pattern + ')', 'g');
  const all = [...body.matchAll(re)];
  return all.length ? all[all.length - 1][1] : undefined;
};
export const editToken = (body) => latest(body, 'editToken', 'e[0-9a-f]+');
export const confirmToken = (body) => latest(body, 'confirmToken', 'c[0-9a-f]{32}');
// The newest saved item's id (a dashboard or report the scripted model saved).
export const savedId = (body) => latest(body, 'id', '[0-9a-f]{8}-[0-9a-f-]{27}');

// Review notes get the last scripted answer again without consuming another scenario step.
const CHECK =
  /^(?:No tool changed the spreadsheet in this request|These cells this request wrote show formula errors|These numbers in the answer are unsupported|Review the derived classifier labels)/;
const lastUserText = (body) => {
  try {
    const parts = JSON.parse(body).contents.at(-1).parts || [];
    return parts.map((part) => part.text || '').join('\n');
  } catch {
    return '';
  }
};
const textOf = (reply) =>
  (reply?.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');

// Steps answer requests in order. A loop step keeps answering the same call until the app asks
// for its final answer (the step-limit or time-over prompt). A check note gets the last answer
// again, as a model that stands by it, and takes no step.
export function scripted(steps) {
  const queue = steps.slice();
  let answer = 'Done.';
  const said = (reply) => {
    if (textOf(reply)) answer = textOf(reply);
    return reply;
  };
  return (body) => {
    if (CHECK.test(lastUserText(body))) return say(answer);
    const step = queue[0];
    if (!step) return said(say('Done.'));
    if (step.loop) {
      if (/The time for this turn is over|The step limit for this turn is reached/.test(body)) {
        queue.shift();
        return said(say(step.final));
      }
      return said(step.loop(body));
    }
    queue.shift();
    return said(step(body));
  };
}

// Compares a record's fields with the expected ones; returns the differences.
export function differences(record, expected) {
  const bad = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = record[key];
    if (JSON.stringify(got) !== JSON.stringify(want))
      bad.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return bad;
}
