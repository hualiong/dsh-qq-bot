// /model support: read the Host model catalog and switch one session's model,
// mirroring the chat-box picker (provider key, model key, reasoning efforts).
// Everything printed is exactly what /model accepts: provider/model keys and
// lower-case effort ids, so a user can copy a line back without translating it.
import { sessionService } from './dsh.js';

function currentSelection(catalog, projection) {
  return projection?.next ?? projection?.lastUsed ?? catalog?.default ?? null;
}

function effortsOf(model) {
  return model?.reasoning?.efforts ?? [];
}

function effortIds(model) {
  return [...new Set(effortsOf(model).map((effort) => effort.id))];
}

function findModel(catalog, providerId, modelId) {
  const group = (catalog?.groups ?? []).find((candidate) => candidate.id === providerId);
  const model = group?.models?.find((candidate) => candidate.id === modelId);
  return group && model ? { group, model } : null;
}

function selectionLabel(provider, model, effortId) {
  return `${provider}/${model}${effortId ? `（${effortId}）` : ''}`;
}

export async function modelSnapshot(ctx, sessionId) {
  const controller = sessionService(ctx);
  const catalog = await controller.modelCatalog();
  let projection = null;
  try {
    // projections() insists on an AbortSignal even in-process.
    const projected = await controller.projections({ sessionId }, new AbortController().signal);
    projection = projected?.values?.modelSelection ?? null;
  } catch {
    // A missing projection only costs the bold "current" row.
  }
  return { catalog, current: currentSelection(catalog, projection) };
}

export async function modelListText(ctx, sessionId) {
  const { catalog, current } = await modelSnapshot(ctx, sessionId);
  const lines = ['**可用模型**'];
  let index = 0;
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      index += 1;
      const ids = effortIds(model);
      const efforts = ids.length > 0 ? `（${ids.join(' / ')}）` : '';
      const isCurrent = current && current.provider === group.id && current.model === model.id;
      const line = `${group.id}/${model.id}${efforts}`;
      lines.push(`- ${isCurrent ? `**${line}**` : line}`);
    }
  }
  if (index === 0) lines.push('- 没有可用模型，请先在 DSH 设置里配置供应商。');
  lines.push('', '**切换模型**：`/model <供应商>/<模型> [挡位]`');
  return lines.join('\n');
}

export async function switchModel(ctx, sessionId, args) {
  const target = args.trim();
  if (!target) return modelListText(ctx, sessionId);

  const [reference, ...rest] = target.split(/\s+/u);
  const slash = reference.indexOf('/');
  if (slash <= 0 || slash === reference.length - 1) {
    return '格式：`/model <供应商>/<模型> [挡位]`';
  }
  const providerId = reference.slice(0, slash);
  const modelId = reference.slice(slash + 1);

  const { catalog } = await modelSnapshot(ctx, sessionId);
  const found = findModel(catalog, providerId, modelId);
  if (!found) return `没有找到模型 ${reference}。发送 /model 查看可用列表。`;
  const { group, model } = found;

  let reasoningEffort;
  if (rest.length > 0) {
    const wanted = rest.join(' ').trim();
    const lower = wanted.toLowerCase();
    const ids = effortIds(model);
    const effort = ids.find((id) => id === wanted)
      ?? ids.find((id) => id.toLowerCase() === lower);
    if (!effort) {
      return ids.length === 0
        ? `模型 ${reference} 不提供思考挡位。`
        : `模型 ${reference} 没有挡位「${wanted}」。可用：${ids.join(' / ')}`;
    }
    reasoningEffort = effort;
  }

  const result = await sessionService(ctx).selectModel({
    sessionId,
    provider: group.id,
    model: model.id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });
  // The Host materializes the default effort, so report what it actually chose.
  const selected = result?.selected ?? { provider: group.id, model: model.id, reasoningEffort };
  return `已切换：**${selectionLabel(selected.provider, selected.model, selected.reasoningEffort)}**`;
}
