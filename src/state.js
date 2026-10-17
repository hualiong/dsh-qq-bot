// One JSON document: the single QQ binding, the auto-claimed owner, the last
// QQ chat the bot heard from (the push target), and the recent message ids
// that were already handled (QQ redelivers; a prompt must never run twice).
//
// Writes are serialized and committed only after the file landed: a failed
// write leaves memory unchanged (so QQ's redelivery can try again) and never
// poisons the queue for later writes.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_SEEN = 1000;

function empty() {
  return { version: 1, sessionId: null, ownerOpenId: null, target: null, seenMessageIds: [] };
}

export function createStateStore(path) {
  let doc = empty();
  let writes = Promise.resolve();

  const write = async (next) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    doc = next;
  };

  const mutate = (change) => {
    const run = writes.then(() => {
      const next = change(doc);
      if (next === doc) return undefined;
      return write(next);
    });
    // Keep the chain alive after a rejection; the caller still sees the error.
    writes = run.catch(() => undefined);
    return run;
  };

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (parsed?.version === 1) {
          doc = {
            ...empty(),
            ...parsed,
            seenMessageIds: Array.isArray(parsed.seenMessageIds) ? parsed.seenMessageIds : [],
          };
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return this;
    },
    get sessionId() { return doc.sessionId; },
    get ownerOpenId() { return doc.ownerOpenId; },
    get target() { return doc.target; },
    hasSeen(messageId) { return doc.seenMessageIds.includes(messageId); },
    async markSeen(messageId) {
      if (this.hasSeen(messageId)) return;
      await mutate((current) => ({
        ...current,
        seenMessageIds: [...current.seenMessageIds.slice(-(MAX_SEEN - 1)), messageId],
      }));
    },
    async setSession(sessionId) {
      await mutate((current) => (current.sessionId === sessionId
        ? current : { ...current, sessionId }));
    },
    async setOwner(openId) {
      await mutate((current) => (current.ownerOpenId === openId
        ? current : { ...current, ownerOpenId: openId }));
    },
    async setTarget(target) {
      await mutate((current) => (current.target?.targetId === target?.targetId
        ? current : { ...current, target }));
    },
  };
}
