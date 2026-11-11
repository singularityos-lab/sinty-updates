import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/worker.mjs";

const RELEASE_URL = "https://github.com/singularityos-lab/sinty-updates/releases/download/v131/rootfs.erofs";
const ASSET_URL = "https://release-assets.githubusercontent.com/github-production-release-asset/1/asset?sig=test";

function redirect(location = ASSET_URL) {
  return new Response(null, { status: 302, headers: { location } });
}

function replaceFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function silenceErrors(t) {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
}

test("rejects methods other than GET and HEAD", async () => {
  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.erofs",
    { method: "POST" },
  ));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("rejects unknown paths, assets, versions, and query parameters", async () => {
  const cases = [
    ["/other/v131/rootfs.erofs", 404],
    ["/artifacts/v131/unknown.img", 404],
    ["/artifacts/v131/atom-loader-x.efi", 404],
    ["/artifacts/v131/atom-loader-0.efi", 404],
    ["/artifacts/v131/kernelcache.l4t.efi", 404],
    ["/artifacts/v131/aarch64/kernelcache.L4T.efi", 404],
    ["/artifacts/v131/aarch64/kernelcache..efi", 404],
    ["/artifacts/v131/aarch64/kernelcache.l4t.efi.bak", 404],
    ["/artifacts/latest/rootfs.erofs", 404],
    ["/artifacts/v131/rootfs.erofs?source=other", 400],
  ];

  for (const [path, status] of cases) {
    const response = await handleRequest(new Request(`https://updates.sinty.dev${path}`));
    assert.equal(response.status, status);
  }
});

test("rejects malformed and multiple ranges", async () => {
  const ranges = ["bytes=0-1,4-5", "items=0-1", "bytes=-", `bytes=0-${"9".repeat(128)}`];
  for (const range of ranges) {
    const response = await handleRequest(new Request(
      "https://updates.sinty.dev/artifacts/v131/rootfs.erofs",
      { headers: { range } },
    ));
    assert.equal(response.status, 400);
  }
});

test("accepts one pinned redirect and streams an allowed asset", { concurrency: false }, async (t) => {
  const calls = [];
  replaceFetch(t, async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return redirect();
    }
    return new Response("payload", {
      status: 200,
      headers: {
        "content-length": "7",
        "content-type": "application/octet-stream",
        etag: '"asset-etag"',
      },
    });
  });

  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.erofs",
  ));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, RELEASE_URL);
  assert.equal(calls[1].url, ASSET_URL);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[1].options.redirect, "manual");
  assert.equal(calls[1].options.cache, "no-store");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "7");
  assert.equal(response.headers.get("etag"), '"asset-etag"');
  assert.equal(await response.text(), "payload");
});

test("rejects redirects to an untrusted host", { concurrency: false }, async (t) => {
  silenceErrors(t);
  let calls = 0;
  replaceFetch(t, async () => {
    calls += 1;
    return redirect("https://example.com/asset");
  });

  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.erofs",
  ));

  assert.equal(response.status, 502);
  assert.equal(calls, 1);
});

test("rejects a second redirect", { concurrency: false }, async (t) => {
  silenceErrors(t);
  let calls = 0;
  replaceFetch(t, async () => {
    calls += 1;
    return calls === 1 ? redirect() : redirect(`${ASSET_URL}-again`);
  });

  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.erofs",
  ));

  assert.equal(response.status, 502);
  assert.equal(calls, 2);
});

test("forwards a range and preserves Content-Range", { concurrency: false }, async (t) => {
  const calls = [];
  replaceFetch(t, async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return redirect();
    }
    return new Response("part", {
      status: 206,
      headers: {
        "content-length": "4",
        "content-range": "bytes 0-3/7",
      },
    });
  });

  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.erofs",
    { headers: { range: "bytes=0-3" } },
  ));

  assert.equal(calls[1].options.headers.get("range"), "bytes=0-3");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/7");
  assert.equal(await response.text(), "part");
});

test("preserves Content-Range on an unsatisfied range", { concurrency: false }, async (t) => {
  replaceFetch(t, async (url) => (
    String(url) === RELEASE_URL
      ? redirect()
      : new Response(null, { status: 416, headers: { "content-range": "bytes */7" } })
  ));

  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.erofs",
    { headers: { range: "bytes=9-10" } },
  ));

  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */7");
});

test("hides upstream failures and cancels their bodies", { concurrency: false }, async (t) => {
  silenceErrors(t);
  let calls = 0;
  let cancelled = false;
  replaceFetch(t, async () => {
    calls += 1;
    if (calls === 1) {
      return redirect();
    }
    return new Response(new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }), { status: 404 });
  });

  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.hash",
  ));

  assert.equal(response.status, 502);
  assert.equal(cancelled, true);
});

test("proxies a versioned boot loader and its signature", async (t) => {
  const requested = [];
  replaceFetch(t, async (url) => {
    requested.push(String(url));
    return requested.length % 2 ? redirect() : new Response("loader", { status: 200 });
  });
  for (const asset of ["atom-loader-2.efi", "atom-loader-2.efi.sig"]) {
    const response = await handleRequest(new Request(`https://updates.sinty.dev/artifacts/v206/${asset}`));
    assert.notEqual(response.status, 404);
  }
  assert.ok(requested.some((url) => url.endsWith("/v206/atom-loader-2.efi")));
});

test("resolves the asset through the authenticated API when a token is set", { concurrency: false }, async (t) => {
  const calls = [];
  replaceFetch(t, async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return Response.json({ assets: [{ id: 7, name: "rootfs.erofs" }, { id: 8, name: "rootfs.hash" }] });
    }
    if (calls.length === 2) {
      return redirect();
    }
    return new Response("payload", { status: 206, headers: { "content-range": "bytes 0-6/7" } });
  });

  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.hash",
    { headers: { range: "bytes=0-6" } },
  ), { GITHUB_TOKEN: "secret" });

  assert.equal(calls[0].url, "https://api.github.com/repos/singularityos-lab/sinty-updates/releases/tags/v131");
  assert.equal(calls[1].url, "https://api.github.com/repos/singularityos-lab/sinty-updates/releases/assets/8");
  assert.equal(calls[0].options.headers.get("authorization"), "Bearer secret");
  assert.equal(calls[1].options.headers.get("authorization"), "Bearer secret");
  assert.equal(calls[1].options.headers.get("accept"), "application/octet-stream");
  assert.equal(calls[1].options.redirect, "manual");
  assert.equal(calls[2].url, ASSET_URL);
  assert.equal(calls[2].options.headers.get("authorization"), null);
  assert.equal(calls[2].options.headers.get("range"), "bytes=0-6");
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "payload");
});

test("reports a missing release asset as not found", { concurrency: false }, async (t) => {
  const responses = [Response.json({ assets: [] }), new Response(null, { status: 404 })];
  replaceFetch(t, async () => responses.shift());

  for (const asset of ["rootfs.erofs", "rootfs.hash"]) {
    const response = await handleRequest(new Request(
      `https://updates.sinty.dev/artifacts/v131/${asset}`,
    ), { GITHUB_TOKEN: "secret" });
    assert.equal(response.status, 404);
  }
});

test("hides a failed release lookup", { concurrency: false }, async (t) => {
  silenceErrors(t);
  replaceFetch(t, async () => new Response("limited", { status: 429 }));

  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.erofs",
  ), { GITHUB_TOKEN: "secret" });

  assert.equal(response.status, 502);
});

test("retries GitHub rate limits before giving up", { concurrency: false }, async (t) => {
  const calls = [];
  replaceFetch(t, async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response("limited", { status: 429 });
    }
    return calls.length === 2 ? redirect() : new Response("payload", { status: 200 });
  });

  const response = await handleRequest(new Request(
    "https://updates.sinty.dev/artifacts/v131/rootfs.erofs",
  ));

  assert.equal(calls.length, 3);
  assert.equal(calls[0], RELEASE_URL);
  assert.equal(calls[1], RELEASE_URL);
  assert.equal(response.status, 200);
});

test("reports a release that does not exist as not found", { concurrency: false }, async (t) => {
  replaceFetch(t, async () => new Response("Not Found", { status: 404 }));

  for (const env of [{}, { GITHUB_TOKEN: "secret" }]) {
    const response = await handleRequest(new Request(
      "https://updates.sinty.dev/artifacts/v300/rootfs.hash",
    ), env);
    assert.equal(response.status, 404);
  }
});

test("serves aarch64 artifacts from their own release", { concurrency: false }, async (t) => {
  const calls = [];
  replaceFetch(t, async (url) => {
    calls.push(String(url));
    return new Response("payload", { status: 200, headers: { "content-length": "7" } });
  });
  await handleRequest(new Request("https://updates.sinty.dev/artifacts/v131/aarch64/rootfs.erofs"));
  assert.ok(calls[0].includes("/v131-aarch64/rootfs.erofs") || calls[0].includes("/tags/v131-aarch64"), calls[0]);
  const family = await handleRequest(new Request("https://updates.sinty.dev/artifacts/v131/aarch64/kernelcache.l4t.efi.sig"));
  assert.notEqual(family.status, 404);
  assert.ok(calls.some((c) => c.includes("kernelcache.l4t.efi.sig")), calls.join(" "));
  const other = await handleRequest(new Request("https://updates.sinty.dev/artifacts/v131/riscv64/rootfs.erofs"));
  assert.equal(other.status, 404);
});

test("retries the release asset when its storage fails for a moment", async (t) => {
  let assetCalls = 0;
  replaceFetch(t, async (url) => {
    if (String(url) === RELEASE_URL) {
      return redirect();
    }
    assetCalls += 1;
    if (assetCalls === 1) {
      return new Response("busy", { status: 503 });
    }
    return new Response("data", { status: 200 });
  });
  const response = await handleRequest(new Request("https://updates.sinty.dev/artifacts/v131/rootfs.erofs"), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "data");
  assert.equal(assetCalls, 2);
});

test("retries the release lookup after a network error", async (t) => {
  let releaseCalls = 0;
  replaceFetch(t, async (url) => {
    if (String(url) === RELEASE_URL) {
      releaseCalls += 1;
      if (releaseCalls === 1) {
        throw new TypeError("network connection lost");
      }
      return redirect();
    }
    return new Response("data", { status: 200 });
  });
  const response = await handleRequest(new Request("https://updates.sinty.dev/artifacts/v131/rootfs.erofs"), {});
  assert.equal(response.status, 200);
  assert.equal(releaseCalls, 2);
});
