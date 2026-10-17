/**
 * Final-answer extraction for one DSH turn.
 *
 * QQ users should only see the answer that follows the last tool boundary:
 * no reasoning chain, no intermediate "let me check..." preamble, no tool
 * chatter. These helpers keep the live `assistant/chunk` /
 * `assistant/message` stream for the tracked turn and discard everything the
 * model wrote before it last called a tool.
 *
 * Ported from `@xmanrui/dsh-im` (`src/channels/shared/harness-client.mjs`) and
 * reduced to the QQ-only bridge needs: no progress/reasoning update stream, no
 * tool-name bookkeeping, no history recovery, no mux cursors.
 */

/** Join only visible text blocks from one Harness message payload. */
export function textFromHarnessContent(content) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** Aggregate assistant text in stable step/index order for one Harness Turn. */
export class AssistantTextAccumulator {
  #steps = new Map();
  #legacyText = '';

  clear() {
    this.#steps.clear();
    this.#legacyText = '';
  }

  appendDelta(step, index, text) {
    if (typeof text !== 'string' || !text) return;
    const stepNumber = Number.isSafeInteger(step) ? step : 0;
    const partIndex = Number.isSafeInteger(index) ? index : 0;
    this.#legacyText = '';
    const parts = this.#steps.get(stepNumber) ?? new Map();
    parts.set(partIndex, (parts.get(partIndex) ?? '') + text);
    this.#steps.set(stepNumber, parts);
  }

  setCanonical(step, text) {
    if (typeof text !== 'string' || !text.trim()) return;
    if (!Number.isSafeInteger(step)) {
      this.#steps.clear();
      this.#legacyText = text.trim();
      return;
    }
    this.#legacyText = '';
    this.#steps.set(step, new Map([[0, text.trim()]]));
  }

  get text() {
    if (this.#steps.size === 0) return this.#legacyText;
    return [...this.#steps.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, parts]) => [...parts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, text]) => text)
        .join('\n')
        .trim())
      .filter(Boolean)
      .join('\n\n');
  }
}

/** Keep answer text after the last tool boundary. */
export function accumulateFinalAssistantText(accumulator, event) {
  if (event.type === 'tool/call') {
    accumulator.clear();
  } else if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
    accumulator.appendDelta(event.data.step, event.data.chunk.index, event.data.chunk.text);
  } else if (event.type === 'assistant/message') {
    const content = event.data?.message?.content;
    const text = textFromHarnessContent(content);
    // Canonical tool messages can arrive before or after the separate call.
    // An explicitly empty final message must not revive an earlier preamble.
    if (!text || content.some((part) => part?.type === 'tool-call')) accumulator.clear();
    else accumulator.setCanonical(event.data.step, text);
  }
}

/**
 * Tracks exactly one DSH turn, identified by the RPC id of the prompt request
 * that started it, and exposes the final answer text for that turn.
 *
 * `consume(event)` is deliberately per-event (no batch, no sorting): the caller
 * owns the live event stream order. It returns true only for events that belong
 * to the tracked turn, so a caller can reset its stall timer on each of them.
 */
export class ReplyTracker {
  #requestId;
  #lastSeq = -1;
  #turn = null;
  #openTurn = null;
  #matched = false;
  #finished = false;
  #reason = null;
  #finalAssistantText = new AssistantTextAccumulator();

  constructor({ requestId } = {}) {
    this.#requestId = requestId;
  }

  /**
   * Feed one raw Harness event.
   * @returns {boolean} true when the event belonged to / advanced the tracked turn.
   */
  consume(event) {
    const seq = event?.seq;
    // No cursor, no ownership: events without a usable seq cannot be ordered
    // against what we already consumed, so they never advance the turn.
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return false;
    if (this.#finished) return false;
    if (seq <= this.#lastSeq) return false;
    const type = event?.type;
    const data = event?.data;
    const turn = Number.isSafeInteger(data?.turn) ? data.turn : null;

    // A live user/message carries no turn id (only turn/start does), so the
    // latest turn/start before the prompt names the turn the prompt belongs to.
    // Pre-match frames never advance the cursor: the prompt may still arrive.
    if (type === 'turn/start') {
      this.#openTurn = turn;
      if (!this.#matched) return false;
      this.#lastSeq = seq;
      if (this.#turn === null) this.#turn = turn;
      return this.#turn === turn;
    }

    if (!this.#matched) {
      if (type !== 'user/message' || data?.source?.rpcId !== this.#requestId) return false;
      this.#matched = true;
      this.#lastSeq = seq;
      // Until a turn/start names the turn, stay matched but unattributed.
      this.#turn = turn ?? this.#openTurn;
      return true;
    }

    this.#lastSeq = seq;

    if (this.#turn === null) return false;

    if (type === 'user/message' && data?.source?.rpcId === this.#requestId) {
      // A repeated prompt echo is idempotent: it may re-state the turn, but it
      // must not clear accumulated text or resurrect a finished turn.
      if (turn !== null) this.#turn = turn;
      return true;
    }

    if (type === 'turn/end') {
      if (turn !== this.#turn) return false;
      this.#finished = true;
      this.#reason = data?.reason ?? null;
      return true;
    }

    // Every other event must belong to the tracked turn to affect the answer.
    if (turn !== this.#turn) return false;

    accumulateFinalAssistantText(this.#finalAssistantText, event);
    return true;
  }

  /** True once this turn's `turn/end` has been consumed. */
  get finished() {
    return this.#finished;
  }

  /** The `turn/end` reason payload, or null while the turn is unfinished. */
  get reason() {
    return this.#reason;
  }

  /** The tracked turn id, or null before the matching prompt event arrives. */
  get turn() {
    return this.#turn;
  }

  /**
   * Text the QQ user should receive: '' when the turn produced no post-tool
   * text (tool-only completion, reasoning-only output, failure, or no turn).
   */
  get finalAnswer() {
    return this.#finalAssistantText.text.trim();
  }
}
