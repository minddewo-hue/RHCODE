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
  if (model?.reasoningEfforts) {
    return [...new Set(model.reasoningEfforts)].filter((value) => reasoningEffortValues.has(value));
  }
  return reasoningEffortValues.has(model?.defaultReasoningEffort as RemoteReasoningEffort)
    ? [model?.defaultReasoningEffort as RemoteReasoningEffort]
    : ["high"];
}

export function groupRemoteModels(models: RemoteModelOption[]): RemoteModelGroup[] {
  const groups = new Map<string, RemoteModelGroup & { sourceOrder: number }>();
  for (const [index, model] of models.entries()) {
    const presentation = modelSourcePresentation(model, index);
    const group = groups.get(presentation.key) || {
      key: presentation.key,
      source: presentation.source,
      models: [],
      sourceOrder: presentation.sourceOrder,
    };
    group.models.push({ ...model, sourceModelName: presentation.modelName });
    groups.set(presentation.key, group);
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

function modelSourcePresentation(model: RemoteModelOption, index: number): {
  key: string;
  source: string;
  modelName: string;
  sourceOrder: number;
} {
  const explicitSource = model.source?.trim();
  const explicitModelName = model.sourceModelName?.trim();
  if (explicitSource) {
    return {
      key: `source:${explicitSource.toLocaleLowerCase()}`,
      source: explicitSource,
      modelName: explicitModelName || model.displayName || model.model,
      sourceOrder: index,
    };
  }

  const separatorIndex = model.displayName.indexOf(" - ");
  if (separatorIndex > 0) {
    const source = model.displayName.slice(0, separatorIndex).trim();
    return {
      key: `display:${source}`,
      source,
      modelName: model.displayName.slice(separatorIndex + 3).trim() || model.model,
      sourceOrder: Number.MAX_SAFE_INTEGER,
    };
  }

  const slashIndex = model.model.indexOf("/");
  if (slashIndex > 0) {
    const source = model.model.slice(0, slashIndex);
    return {
      key: `model:${source}`,
      source,
      modelName: model.displayName || model.model.slice(slashIndex + 1),
      sourceOrder: Number.MAX_SAFE_INTEGER,
    };
  }

  return {
    key: "other",
    source: "Other",
    modelName: model.displayName || model.model,
    sourceOrder: Number.MAX_SAFE_INTEGER,
  };
}
