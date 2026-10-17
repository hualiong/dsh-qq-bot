// One JSON document: the single QQ binding, the auto-claimed owner, the last
// QQ chat the bot heard from (the push target), and the recent message ids
// that were already handled (QQ redelivers; a prompt must never run twice).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_SEEN = 1000;

function empty() {
  return { version: 1, sessionId: null, ownerOpenId: null, target: null, seenMessageIds: [] };
}

export function createStateStore(path) {
  let doc = empty();
  let writes = Promise.resolve();

  const save = () => {
    writes = writes.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    });
    return writes;
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
      doc.seenMessageIds = [...doc.seenMessageIds.slice(-(MAX_SEEN - 1)), messageId];
      await save();
    },
    async setSession(sessionId) { doc.sessionId = sessionId; await save(); },
    async setOwner(openId) { doc.ownerOpenId = openId; await save(); },
    async setTarget(target) {
      if (doc.target?.targetId === target?.targetId) return;
      doc.target = target;
      await save();
    },
  };
}
