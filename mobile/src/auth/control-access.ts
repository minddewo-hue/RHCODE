export const defaultTransferServerUrl = normalizedTransferServerUrl(
  process.env.EXPO_PUBLIC_TRANSFER_SERVER_URL || "http://218.201.210.211:8000",
);
export const controlServiceUrl = `${defaultTransferServerUrl}/control`;

function normalizedTransferServerUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "http://218.201.210.211:8000";
  }
}

export function normalizeAccessKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error("请输入桌面端生成的 KEY。");
  if (!/^rhzy_[A-Za-z0-9_-]{43}$/.test(key)) {
    throw new Error("KEY 格式无效，请从桌面端重新复制。");
  }
  return key;
}
