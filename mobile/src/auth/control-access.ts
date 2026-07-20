export const defaultControlHost = "127.0.0.1";
export const defaultControlPort = 8790;

export function normalizeControlHost(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("请输入桌面端显示的 IP 地址。");
  if (raw.includes("://") || /[/?#@]/.test(raw)) {
    throw new Error("IP 地址中不要包含协议、端口或路径。");
  }

  const unwrapped = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (!isPrivateNetworkHost(unwrapped)) {
    throw new Error("请输入同一局域网内的本机 IP 地址。");
  }
  return unwrapped.toLowerCase();
}

export function normalizeControlPort(value: string | number): number {
  const raw = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(raw) || raw < 1 || raw > 65_535) {
    throw new Error("端口必须是 1 到 65535 之间的整数。");
  }
  return raw;
}

export function buildControlUrl(host: string, port: string | number): string {
  const normalizedHost = normalizeControlHost(host);
  const normalizedPort = normalizeControlPort(port);
  const formattedHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  return `http://${formattedHost}:${normalizedPort}`;
}

export function normalizeAccessKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error("请输入桌面端生成的 KEY。");
  if (!/^rhzy_[A-Za-z0-9_-]{43}$/.test(key)) {
    throw new Error("KEY 格式无效，请从桌面端重新复制。");
  }
  return key;
}

function isPrivateNetworkHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return validIpv4(normalized);
  if (/^10(?:\.\d{1,3}){3}$/.test(normalized)) return validIpv4(normalized);
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(normalized)) return validIpv4(normalized);
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(normalized)) return validIpv4(normalized);
  if (/^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*$/i.test(normalized)) return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length === 4 && validIpv4(normalized)) {
    return octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31;
  }
  return /^[a-z0-9-]+$/i.test(normalized) || normalized.endsWith(".local");
}

function validIpv4(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((part) => {
    const number = Number(part);
    return /^\d{1,3}$/.test(part) && Number.isInteger(number) && number >= 0 && number <= 255;
  });
}
