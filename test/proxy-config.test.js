import assert from "node:assert/strict";
import test from "node:test";
import { parseProxyList } from "../src/proxy-config.js";

test("supports different credentials for each proxy", () => {
  const proxies = parseProxyList(
    "JP-Tokyo=http://tokyo-user:tokyo%40pass@tokyo.example:8000;" +
      "UK-London=http://london-user:london%23pass@london.example:8000",
  );

  assert.deepEqual(
    proxies.map(({ label, server, username, password }) => ({
      label,
      server,
      username,
      password,
    })),
    [
      {
        label: "JP-Tokyo",
        server: "http://tokyo.example:8000/",
        username: "tokyo-user",
        password: "tokyo@pass",
      },
      {
        label: "UK-London",
        server: "http://london.example:8000/",
        username: "london-user",
        password: "london#pass",
      },
    ],
  );
  assert.notEqual(proxies[0].id, proxies[1].id);
  assert.equal(proxies[0].displayServer, "http://tokyo.example:8000/");
});
