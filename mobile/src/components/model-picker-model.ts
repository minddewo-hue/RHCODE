import type { RemoteModelOption, RemoteReasoningEffort } from "@rhzycode/protocol";

export interface RemoteModelGroup {
  key: string;
  source: string;
  models: Array<RemoteModelOption & { sourceModelName: string }>;
}

const modelNameCollator = new Intl.Collator(["zh-CN", "en"], {
  numeric: true,
  sensitivity: "base",
});

const reasoningEffortValues = new Set<RemoteReasoningEffort>([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

export function remoteModelReasoningEfforts(model: RemoteModelOption | null): RemoteReasoningEffort[] {
  return [...new Set(model?.reasoningEfforts || [])].filter((value) => reasoningEffortValues.has(value));
}

export function groupRemoteModels(models: RemoteModelOption[]): RemoteModelGroup[] {
  const groups = new Map<string, RemoteModelGroup & { sourceOrder: number }>();
  for (const [index, model] of models.entries()) {
    const key = model.source.toLocaleLowerCase();
    const group = groups.get(key) || {
      key,
      source: model.source,
      models: [],
      sourceOrder: index,
    };
    group.models.push(model);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((left, right) =>
      left.sourceOrder - right.sourceOrder
      || modelNameCollator.compare(left.source, right.source))
    .map(({ sourceOrder: _sourceOrder, ...group }) => ({
      ...group,
      models: group.models.sort((left, right) =>
        modelNameCollator.compare(left.sourceModelName, right.sourceModelName)
        || modelNameCollator.compare(left.model, right.model)),
    }));
}
