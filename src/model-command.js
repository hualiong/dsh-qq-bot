// /model support: read the Host model catalog and switch one session's model,
// mirroring the chat-box picker (provider key, model key, reasoning efforts).
import { sessionService } from './dsh.js';

function currentSelection(catalog, projection) {
  return projection?.next ?? projection?.lastUsed ?? catalog?.default ?? null;
}

function effortsOf(model) {
  return model?.reasoning?.efforts ?? [];
}

function effortName(model, effortId) {
  if (!effortId) return null;
  const effort = effortsOf(model).find((candidate) => candidate.id === effortId);
  return effort?.name ?? effortId;
}

function effortListText(model) {
  const efforts = effortsOf(model);
  if (efforts.length === 0) return '无思考挡位';
  const names = [...new Set(efforts.map((effort) => effort.name ?? effort.id))];
  return `挡位 ${names.join(' / ')}`;
}

function findModel(catalog, providerId, modelId) {
  const group = (catalog?.groups ?? []).find((candidate) => candidate.id === providerId);
  const model = group?.models?.find((candidate) => candidate.id === modelId);
  return group && model ? { group, model } : null;
}

function selectionText(catalog, selection) {
  if (!selection) return '未知';
  const found = findModel(catalog, selection.provider, selection.model);
  const effort = found ? effortName(found.model, selection.reasoningEffort) : selection.reasoningEffort;
  const name = found?.model?.name && found.model.name !== selection.model ? `（${found.model.name}）` : '';
  return `${selection.provider}/${selection.model}${name}${effort ? ` · ${effort}` : ''}`;
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
    // A missing projection only costs the "current" marker.
  }
  return { catalog, current: currentSelection(catalog, projection) };
}

export async function modelListText(ctx, sessionId) {
  const { catalog, current } = await modelSnapshot(ctx, sessionId);
  const lines = [`当前模型：${selectionText(catalog, current)}`, '可用模型：'];
  let index = 0;
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      index += 1;
      const open = current && current.provider === group.id && current.model === model.id;
      const name = model.name && model.name !== model.id ? `（${model.name}）` : '';
      lines.push(`${index}. ${group.id}/${model.id}${name} · ${effortListText(model)}${open ? '  ← 当前' : ''}`);
    }
  }
  if (index === 0) lines.push('（没有可用模型，请先在 DSH 设置里配置供应商）');
  lines.push('用法：/model <供应商>/<模型> [挡位]');
  return lines.join('\n');
}

export async function switchModel(ctx, sessionId, args) {
  const target = args.trim();
  if (!target) return modelListText(ctx, sessionId);

  const [reference, ...rest] = target.split(/\s+/u);
  const slash = reference.indexOf('/');
  if (slash <= 0 || slash === reference.length - 1) {
    return '格式：/model <供应商>/<模型> [挡位]';
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
    const efforts = effortsOf(model);
    const effort = efforts.find((candidate) => candidate.id.toLowerCase() === lower
      || (candidate.name ?? '').toLowerCase() === lower);
    if (!effort) {
      const available = efforts.map((candidate) => candidate.name ?? candidate.id).join(' / ');
      return effortListText(model) === '无思考挡位'
        ? `模型 ${reference} 不提供思考挡位。`
        : `模型 ${reference} 没有挡位「${wanted}」。可用：${available}`;
    }
    reasoningEffort = effort.id;
  }

  const result = await sessionService(ctx).selectModel({
    sessionId,
    provider: group.id,
    model: model.id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });
  // The Host materializes the default effort, so report what it actually chose.
  const selected = result?.selected ?? { provider: group.id, model: model.id, reasoningEffort };
  const effort = effortName(model, selected.reasoningEffort);
  return `已切换：${selected.provider}/${selected.model}${effort ? ` · ${effort}` : ''}`;
}
