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
