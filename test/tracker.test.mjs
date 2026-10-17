import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AssistantTextAccumulator,
  ReplyTracker,
  accumulateFinalAssistantText,
  textFromHarnessContent,
} from '../src/qq/tracker.js';

const REQUEST_ID = 'qq-final';

const text = (value) => ({ type: 'text', text: value });
const message = (step, content) => ({
  type: 'assistant/message',
  data: { turn: 1, step, message: { content } },
});
const delta = (step, index, value) => ({
  type: 'assistant/chunk',
  data: { turn: 1, step, chunk: { type: 'text-delta', index, text: value } },
});
const tool = (step = 0) => ({
  type: 'tool/call',
  data: { turn: 1, step, name: 'bash', callId: `call-${step}` },
});
const call = { type: 'tool-call', name: 'bash', callId: 'call-0' };
const reasoning = { type: 'reasoning', text: 'PRIVATE_REASONING_MUST_NOT_APPEAR' };

/** Assign ascending seq numbers to a hand-built event list. */
function withSeq(events) {
  return events.map((event, seq) => ({ ...event, seq }));
}

function promptTurn({ turn = 1, rpcId = REQUEST_ID } = {}) {
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { turn, source: { rpcId } } },
  ];
}

function turnEnd({ turn = 1, reason = { kind: 'completed' } } = {}) {
  return { type: 'turn/end', data: { turn, reason } };
}

/** Feed events one at a time, the way the live QQ bridge consumes them. */
function feed(tracker, events) {
  return events.map((event) => tracker.consume(event));
}

// ---------------------------------------------------------------------------
// Ported from upstream test/qq-final-answer.test.mjs (live stream half only).
// The upstream `extractCompletedTurnAnswer` history-recovery half is omitted:
// dsh-qq-lite has no history-recovery API.
// ---------------------------------------------------------------------------

const finalAnswerCases = [
  ['tool preamble and final answer', [message(0, [text('Checking'), call]), tool(), message(1, [reasoning, text('Answer')])], 'Answer'],
  ['tool event before its canonical message', [delta(0, 0, 'Checking'), tool(), message(0, [text('Checking'), call]), message(1, [text('Answer')])], 'Answer'],
  ['canonical tool call without separate tool event', [message(0, [text('Checking'), call]), message(1, [text('Answer')])], 'Answer'],
  ['separate tool event without canonical tool call', [message(0, [text('Checking')]), tool(), message(1, [text('Answer')])], 'Answer'],
  ['multiple tools discard every intermediate step', [message(0, [text('Checking'), call]), tool(), message(1, [text('Verifying'), call]), tool(1), message(2, [text('Answer')])], 'Answer'],
  ['complete final blocks replace draft and keep following paragraphs', [message(0, [text('Checking'), call]), tool(), delta(1, 0, 'Draft'), message(1, [text('First'), reasoning, text('Second')]), message(2, [text('Third')])], 'First\nSecond\n\nThird'],
  ['delta-only final preserves part order', [delta(0, 0, 'Checking'), tool(), delta(1, 1, 'Second'), delta(1, 0, 'First'), delta(1, 0, '!')], 'First!\nSecond'],
  ['tool-only completion does not fall back to preamble', [message(0, [text('Checking'), call]), tool()], ''],
  ['empty canonical clears draft and earlier text', [message(0, [text('Checking')]), delta(1, 0, 'Draft'), message(1, [])], ''],
  ['reasoning-only canonical is not a final answer', [message(0, [text('Checking')]), message(1, [reasoning])], ''],
  ['legacy messages without step replace prior text', [message(undefined, [text('Checking'), call]), tool(undefined), message(undefined, [text('Draft')]), message(undefined, [text('Answer')])], 'Answer'],
  ['ordinary multi-step text remains complete', [message(0, [text('First')]), message(1, [text('Second')])], 'First\n\nSecond'],
];

for (const [name, body, expected] of finalAnswerCases) {
  test(`QQ final answer: ${name}`, () => {
    const events = withSeq([
      ...promptTurn(),
      ...body,
      turnEnd(),
    ]);
    const tracker = new ReplyTracker({ requestId: REQUEST_ID });
    const results = feed(tracker, events);

    assert.equal(tracker.finalAnswer, expected);
    assert.equal(tracker.finished, true);
    assert.deepEqual(tracker.reason, { kind: 'completed' });
    assert.equal(tracker.turn, 1);
    // Its own turn/start frame never owns the reply; every other event of the
    // tracked turn (including the starting prompt and the ending turn/end) does.
    assert.equal(results[0], false);
    assert.equal(results.slice(1).every(Boolean), true);
  });
}

test('QQ final answer ignores foreign and late events after finishing', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  const events = withSeq([
    ...promptTurn(),
    message(0, [text('Checking'), call]), tool(), message(1, [text('Answer')]),
    { type: 'tool/call', data: { turn: 2, name: 'foreign' } },
    turnEnd(),
    tool(),
  ]);
  const results = feed(tracker, events);

  assert.equal(tracker.finalAnswer, 'Answer');
  assert.equal(tracker.finished, true);
  // seq 5 is another turn's tool call; seq 7 arrives after our turn/end.
  assert.deepEqual(results, [false, true, true, true, true, false, true, false]);
});

// ---------------------------------------------------------------------------
// Foreign turns.
// ---------------------------------------------------------------------------

test('QQ final answer: events of a foreign turn never start or advance tracking', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  const trackerEvents = [
    { seq: 0, type: 'turn/start', data: { turn: 2 } },
    { seq: 1, type: 'user/message', data: { turn: 2, source: { rpcId: 'some-other-request' } } },
    { seq: 2, type: 'assistant/chunk', data: { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: 'FOREIGN' } } },
    { seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    { seq: 4, type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [text('FOREIGN')] } } },
  ];

  const results = feed(tracker, trackerEvents);
  assert.deepEqual(results, [false, false, false, false, false]);
  assert.equal(tracker.turn, null);
  assert.equal(tracker.finished, false);
  assert.equal(tracker.finalAnswer, '');

  const own = [
    { seq: 10, type: 'user/message', data: { turn: 1, source: { rpcId: REQUEST_ID } } },
    { seq: 11, type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Answer' } } },
    { seq: 12, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  assert.deepEqual(feed(tracker, own), [true, true, true]);
  assert.equal(tracker.turn, 1);
  assert.equal(tracker.finalAnswer, 'Answer');
});

test('QQ final answer: foreign turn events are ignored after tracking starts', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  const events = withSeq([
    { type: 'user/message', data: { turn: 1, source: { rpcId: REQUEST_ID } } },
    delta(0, 0, 'Answer'),
    { type: 'tool/call', data: { turn: 9, name: 'foreign' } },
    { type: 'assistant/chunk', data: { turn: 9, step: 0, chunk: { type: 'text-delta', index: 0, text: 'MUST_NOT_APPEAR' } } },
    { type: 'assistant/message', data: { turn: 9, step: 0, message: { content: [text('MUST_NOT_APPEAR')] } } },
    { type: 'turn/end', data: { turn: 9, reason: { kind: 'error' } } },
    turnEnd(),
  ]);
  const results = feed(tracker, events);

  assert.deepEqual(results, [true, true, false, false, false, false, true]);
  // A foreign turn/end must not finish or overwrite our reason.
  assert.equal(tracker.finished, true);
  assert.deepEqual(tracker.reason, { kind: 'completed' });
  assert.equal(tracker.finalAnswer, 'Answer');
});

// ---------------------------------------------------------------------------
// Seq guarding: duplicates, gaps, out-of-order and seq-less events.
// ---------------------------------------------------------------------------

test('QQ final answer: duplicate and out-of-order seq are ignored', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  const events = [
    { type: 'user/message', seq: 0, data: { turn: 1, source: { rpcId: REQUEST_ID } } },
    delta(0, 0, 'Later'),
    delta(0, 0, 'Second'),
    delta(0, 0, 'Earlier'),
    delta(0, 0, ' Again'),
  ];
  // seq 0 prompt, then 5, duplicate 5, out-of-order 4, then 6.
  events[1].seq = 5;
  events[2].seq = 5;
  events[3].seq = 4;
  events[4].seq = 6;

  const results = feed(tracker, events);
  assert.deepEqual(results, [true, true, false, false, true]);
  assert.equal(tracker.finalAnswer, 'Later Again');
});

test('QQ final answer: events without a seq never start or advance tracking', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });

  assert.equal(tracker.consume({ type: 'user/message', data: { turn: 1, source: { rpcId: REQUEST_ID } } }), false);
  assert.equal(tracker.turn, null);
  assert.equal(tracker.consume({ type: 'assistant/chunk', seq: null, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } } }), false);
  assert.equal(tracker.consume({ type: 'assistant/chunk', seq: '7', data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } } }), false);
  assert.equal(tracker.consume(undefined), false);

  assert.equal(tracker.consume({ type: 'user/message', seq: 0, data: { turn: 1, source: { rpcId: REQUEST_ID } } }), true);
  assert.equal(tracker.turn, 1);
  assert.equal(tracker.finalAnswer, '');
});

// ---------------------------------------------------------------------------
// Turn completion state.
// ---------------------------------------------------------------------------

test('QQ final answer: finished and reason are set only by the tracked turn/end', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq([
    ...promptTurn(),
    message(0, [text('Answer')]),
  ]));
  assert.equal(tracker.finished, false);
  assert.equal(tracker.reason, null);

  const end = { type: 'turn/end', seq: 99, data: { turn: 1, reason: { kind: 'aborted' } } };
  assert.equal(tracker.consume(end), true);
  assert.equal(tracker.finished, true);
  assert.deepEqual(tracker.reason, { kind: 'aborted' });
  assert.equal(tracker.turn, 1);
  assert.equal(tracker.finalAnswer, 'Answer');

  // Everything after the end is dead, even fresh text for the same turn.
  assert.equal(tracker.consume({ type: 'assistant/chunk', seq: 100, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'LATE' } } }), false);
  assert.equal(tracker.consume({ type: 'turn/end', seq: 101, data: { turn: 1, reason: { kind: 'error' } } }), false);
  assert.equal(tracker.consume({ type: 'user/message', seq: 102, data: { turn: 1, source: { rpcId: REQUEST_ID } } }), false);
  assert.equal(tracker.finalAnswer, 'Answer');
  assert.deepEqual(tracker.reason, { kind: 'aborted' });
});

test('QQ final answer: turn/end without a reason yields null reason and empty answer', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq(promptTurn()));
  assert.equal(tracker.consume({ type: 'turn/end', seq: 50, data: { turn: 1 } }), true);
  assert.equal(tracker.finished, true);
  assert.equal(tracker.reason, null);
  assert.equal(tracker.finalAnswer, '');
});

for (const reason of [{ kind: 'completed' }, { kind: 'error' }, { kind: 'aborted' }]) {
  test(`QQ final answer: ${reason.kind} finishes without requiring an assistant answer`, () => {
    const tracker = new ReplyTracker({ requestId: REQUEST_ID });
    feed(tracker, withSeq([...promptTurn(), turnEnd({ reason })]));
    assert.equal(tracker.finished, true);
    assert.deepEqual(tracker.reason, reason);
    assert.equal(tracker.finalAnswer, '');
  });
}

// ---------------------------------------------------------------------------
// Prompt ownership.
// ---------------------------------------------------------------------------

test('QQ final answer: a repeated prompt echo does not reset accumulated state', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq([
    ...promptTurn(),
    message(0, [text('First')]),
    message(1, [text('Second')]),
  ]));
  assert.equal(tracker.finalAnswer, 'First\n\nSecond');

  const echo = { type: 'user/message', seq: 90, data: { turn: 1, source: { rpcId: REQUEST_ID } } };
  assert.equal(tracker.consume(echo), true);
  // No destructive reset: the answer and the finish flag survive.
  assert.equal(tracker.finalAnswer, 'First\n\nSecond');
  assert.equal(tracker.finished, false);

  assert.equal(tracker.consume({ type: 'assistant/chunk', seq: 91, data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'Third' } } }), true);
  assert.equal(tracker.finalAnswer, 'First\n\nSecond\n\nThird');
});

test('QQ final answer: turn/end of a foreign turn does not finish the pending tracker', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  const results = feed(tracker, withSeq([
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    ...promptTurn({ turn: 1 }),
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    message(0, [text('Answer')]),
    turnEnd(),
  ]));
  assert.deepEqual(results, [false, false, true, false, true, true]);
  assert.equal(tracker.finished, true);
  assert.equal(tracker.finalAnswer, 'Answer');
});

// ---------------------------------------------------------------------------
// Explicit reasoning / tool-only expectations.
// ---------------------------------------------------------------------------

test('QQ final answer: reasoning-only turn produces no answer text', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  const results = feed(tracker, withSeq([
    ...promptTurn(),
    { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'PRIVATE_REASONING_MUST_NOT_APPEAR' } } },
    message(0, [reasoning]),
    { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'MORE_PRIVATE_REASONING' } } },
    turnEnd(),
  ]));
  // Reasoning frames still belong to the tracked turn (they advance liveness).
  assert.equal(results.slice(2).every(Boolean), true);
  assert.equal(tracker.finished, true);
  assert.equal(tracker.finalAnswer, '');
  assert.equal(tracker.finalAnswer.includes('PRIVATE'), false);
});

test('QQ final answer: tool-only completion produces no answer text', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq([
    ...promptTurn(),
    message(0, [text('Checking'), call]),
    tool(),
    { type: 'tool/result', data: { turn: 1, step: 0, callId: 'call-0', text: 'secret tool output' } },
    message(0, []),
    turnEnd(),
  ]));
  assert.equal(tracker.finished, true);
  assert.equal(tracker.finalAnswer, '');
});

test('QQ final answer: consume returns true only for tracked-turn events', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  const checks = [
    [{ type: 'turn/start', seq: 0, data: { turn: 1 } }, false],
    [{ type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'too-early' } } }, false],
    [{ type: 'user/message', seq: 2, data: { turn: 1, source: { rpcId: 'not-our-prompt' } } }, false],
    [{ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } }, false],
    [{ type: 'user/message', seq: 4, data: { turn: 1, source: { rpcId: REQUEST_ID } } }, true],
    [{ type: 'assistant/chunk', seq: 5, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Answer' } } }, true],
    [{ type: 'assistant/chunk', seq: 6, data: { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: 'foreign' } } }, false],
    [{ type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } } }, true],
    [{ type: 'assistant/chunk', seq: 8, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'late' } } }, false],
  ];

  for (const [event, expected] of checks) {
    assert.equal(tracker.consume(event), expected, `${event.type} seq ${event.seq}`);
  }
  assert.equal(tracker.finalAnswer, 'Answer');
});

// ---------------------------------------------------------------------------
// Ported from upstream test/harness-reply-tracker.test.mjs: the
// assistant/chunk-only cases translate cleanly to the final-answer accumulator.
// ---------------------------------------------------------------------------

test('QQ final answer accumulates text deltas across steps', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq([
    ...promptTurn(),
    delta(0, 0, '第一段'),
    delta(1, 0, '第二段'),
    turnEnd(),
  ]));
  assert.equal(tracker.finalAnswer, '第一段\n\n第二段');
  assert.equal(tracker.finished, true);
});

test('QQ final answer orders content parts within each step', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq([
    ...promptTurn(),
    delta(1, 1, '乙'),
    delta(0, 0, '甲'),
    delta(1, 0, '丙'),
  ]));
  assert.equal(tracker.finalAnswer, '甲\n\n丙\n乙');
});

test('QQ final answer merges canonical assistant messages across steps', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq([
    ...promptTurn(),
    message(0, [text('第一步定稿')]),
    message(1, [text('第二步定稿')]),
  ]));
  assert.equal(tracker.finalAnswer, '第一步定稿\n\n第二步定稿');
});

test('QQ final answer replaces one step deltas with its canonical message', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq([
    ...promptTurn(),
    delta(0, 0, '第一步草稿'),
    message(0, [text('第一步定稿')]),
    delta(1, 0, '第二步草稿'),
    message(1, [text('第二步定稿')]),
  ]));
  assert.equal(tracker.finalAnswer, '第一步定稿\n\n第二步定稿');
  assert.equal(tracker.finalAnswer.includes('草稿'), false);
});

test('QQ final answer keeps replace-latest behavior for messages without step metadata', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq([
    ...promptTurn(),
    message(undefined, [text('旧定稿')]),
    message(undefined, [text('新定稿')]),
  ]));
  assert.equal(tracker.finalAnswer, '新定稿');
});

test('QQ final answer excludes reasoning and tool events from the answer', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  feed(tracker, withSeq([
    ...promptTurn(),
    { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: '内部推理' } } },
    { type: 'tool/call', data: { turn: 1, step: 0, name: 'search' } },
    { type: 'tool/result', data: { turn: 1, step: 0, secret: '工具结果' } },
    delta(1, 0, '用户可见答案'),
    turnEnd(),
  ]));
  assert.equal(tracker.finalAnswer, '用户可见答案');
});

test('QQ final answer still ignores duplicate sequences and unrelated turns', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });
  const events = withSeq([
    { type: 'turn/start', data: { turn: 7 } },
    { type: 'user/message', data: { turn: 7, source: { rpcId: REQUEST_ID } } },
    { type: 'assistant/chunk', data: { turn: 7, step: 0, chunk: { type: 'text-delta', index: 0, text: '有效' } } },
    { type: 'assistant/chunk', data: { turn: 7, step: 0, chunk: { type: 'text-delta', index: 0, text: '重复' } } },
    { type: 'assistant/chunk', data: { turn: 8, step: 0, chunk: { type: 'text-delta', index: 0, text: '其他 Turn' } } },
  ]);
  // Duplicate the third event's seq on the fourth; the fifth is a foreign turn.
  events[3].seq = events[2].seq;

  feed(tracker, events);
  assert.equal(tracker.finalAnswer, '有效');
  assert.equal(tracker.turn, 7);
});

test('QQ final answer does not let pre-turn frames skip the prompt turn', () => {
  const tracker = new ReplyTracker({ requestId: REQUEST_ID });

  // A frame for turn 1 that arrives before its prompt is unattributable and
  // must not advance the cursor past the prompt's own sequence.
  assert.equal(tracker.consume({ type: 'assistant/chunk', seq: 5, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '过早到达' } } }), false);
  assert.equal(tracker.turn, null);
  assert.equal(tracker.finalAnswer, '');

  feed(tracker, withSeq([
    ...promptTurn({ turn: 1 }),
    delta(0, 0, '有效答案'),
    turnEnd({ turn: 1, reason: { kind: 'completed' } }),
  ]));
  // promptTurn → seq 0, 1; delta seq 2; turn/end seq 3 (still > lastSeq).
  assert.equal(tracker.finalAnswer, '有效答案');
  assert.equal(tracker.finished, true);
});

// ---------------------------------------------------------------------------
// Extracted helpers, exercised directly.
// ---------------------------------------------------------------------------

test('textFromHarnessContent joins only visible text blocks and trims', () => {
  assert.equal(
    textFromHarnessContent([text('First\nSecond'), reasoning, call, text('Third')]),
    'First\nSecond\nThird',
  );
  assert.equal(textFromHarnessContent([text('  padded  ')]), 'padded');
  assert.equal(textFromHarnessContent([reasoning, call]), '');
  assert.equal(textFromHarnessContent([]), '');
  assert.equal(textFromHarnessContent(undefined), '');
  assert.equal(textFromHarnessContent([{ type: 'text' }]), '');
});

test('AssistantTextAccumulator orders steps and content parts', () => {
  const accumulator = new AssistantTextAccumulator();
  accumulator.appendDelta(1, 1, 'Second');
  accumulator.appendDelta(0, 0, 'First');
  accumulator.appendDelta(1, 0, 'Before');
  assert.equal(accumulator.text, 'First\n\nBefore\nSecond');

  // Canonical text replaces the deltas of its own step only.
  accumulator.setCanonical(1, 'Canonical');
  assert.equal(accumulator.text, 'First\n\nCanonical');

  // A canonical message without step metadata replaces the whole answer.
  accumulator.setCanonical(undefined, 'Legacy');
  assert.equal(accumulator.text, 'Legacy');
  accumulator.setCanonical(undefined, 'Latest');
  assert.equal(accumulator.text, 'Latest');

  accumulator.clear();
  assert.equal(accumulator.text, '');
});

test('accumulateFinalAssistantText drops pre-tool text and ignores reasoning', () => {
  const accumulator = new AssistantTextAccumulator();
  accumulateFinalAssistantText(accumulator, delta(0, 0, 'Checking'));
  assert.equal(accumulator.text, 'Checking');

  accumulateFinalAssistantText(accumulator, tool());
  assert.equal(accumulator.text, '');

  // Post-tool reasoning never becomes answer text, and an empty canonical
  // message cannot revive the preamble.
  accumulateFinalAssistantText(accumulator, { type: 'assistant/chunk', data: { step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'Private' } } });
  accumulateFinalAssistantText(accumulator, message(1, [reasoning]));
  assert.equal(accumulator.text, '');

  accumulateFinalAssistantText(accumulator, message(1, [text('Answer')]));
  assert.equal(accumulator.text, 'Answer');
});
