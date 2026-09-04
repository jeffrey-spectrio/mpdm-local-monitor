import { createHash } from "node:crypto";

function splitList(value) {
  return (value || "")
    .split(/[;,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProxyServer(value) {
  return /^[a-z]+:\/\//i.test(value) ? value : `http://${value}`;
}

function parseProxyServer(value) {
  const rawServer = normalizeProxyServer(value);
  const url = new URL(rawServer);
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  url.username = "";
  url.password = "";
  return { server: url.href, username, password };
}

export function parseProxyList(value) {
  return splitList(value).map((entry, index) => {
    const equalsIndex = entry.indexOf("=");
    const label = equalsIndex > 0 ? entry.slice(0, equalsIndex).trim() : `Proxy ${index + 1}`;
    const rawServer = equalsIndex > 0 ? entry.slice(equalsIndex + 1).trim() : entry;
    const parsed = parseProxyServer(rawServer);
    const id = createHash("sha256")
      .update(`${parsed.server}\0${parsed.username || ""}\0${parsed.password || ""}`)
      .digest("hex")
      .slice(0, 10);
    return { id, label, ...parsed, displayServer: parsed.server };
  });
}
