const RELEASE_BASE = "https://github.com/singularityos-lab/sinty-updates/releases/download";
const API_BASE = "https://api.github.com/repos/singularityos-lab/sinty-updates";
const ASSET_ID_TTL = 300;

const ALLOWED_ASSETS = new Set([
  "rootfs.erofs",
  "rootfs.hash",
  "kernelcache.efi",
  "kernelcache.efi.sig",
  "firmware-active-amd.img",
  "firmware-active-amd.hash",
  "firmware-active-nvidia.img",
  "firmware-active-nvidia.hash",
  "six-active.erofs",
]);

const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

const LOADER_ASSET = /^atom-loader-[1-9][0-9]*\.efi(\.sig)?$/;

function artifactFromPath(pathname) {
  const match = /^\/artifacts\/(v[1-9][0-9]*)\/([^/]+)$/.exec(pathname);
  if (!match || !(ALLOWED_ASSETS.has(match[2]) || LOADER_ASSET.test(match[2]))) {
    return null;
  }
  return { version: match[1], asset: match[2] };
}

function errorResponse(status, message, extraHeaders = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

async function cancelBody(response) {
  if (!response.body) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {
    // The client still receives the generic origin error below.
  }
}

function releaseAssetRedirect(response) {
  if (response.status !== 302) {
    return null;
  }
  const location = response.headers.get("location");
  if (!location) {
    return null;
  }

  let url;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "release-assets.githubusercontent.com"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || !url.pathname.startsWith("/github-production-release-asset/")
  ) {
    return null;
  }
  return url;
}

function apiHeaders(token, accept) {
  return new Headers({
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "sinty-updates-artifact-proxy",
    "x-github-api-version": "2022-11-28",
  });
}

async function assetID(artifact, token) {
  const cache = typeof caches === "undefined" ? null : caches.default;
  const key = new Request(`https://updates.sinty.dev/.asset-id/${artifact.version}/${artifact.asset}`);
  const cached = cache ? await cache.match(key) : undefined;
  if (cached) {
    return Number(await cached.text());
  }

  const response = await fetch(`${API_BASE}/releases/tags/${artifact.version}`, {
    headers: apiHeaders(token, "application/vnd.github+json"),
    cache: "no-store",
  });
  if (response.status === 404) {
    await cancelBody(response);
    return null;
  }
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`release lookup returned ${response.status}`);
  }
  const release = await response.json();
  const asset = (release.assets ?? []).find((entry) => entry.name === artifact.asset);
  if (!asset || !Number.isSafeInteger(asset.id)) {
    return null;
  }
  if (cache) {
    await cache.put(key, new Response(String(asset.id), {
      headers: { "cache-control": `max-age=${ASSET_ID_TTL}` },
    }));
  }
  return asset.id;
}

async function fetchRelease(artifact, method, upstreamHeaders, token) {
  if (!token) {
    return fetch(`${RELEASE_BASE}/${artifact.version}/${artifact.asset}`, {
      method,
      headers: upstreamHeaders,
      redirect: "manual",
      cache: "no-store",
    });
  }
  const id = await assetID(artifact, token);
  if (id === null) {
    return null;
  }
  return fetch(`${API_BASE}/releases/assets/${id}`, {
    method,
    headers: apiHeaders(token, "application/octet-stream"),
    redirect: "manual",
    cache: "no-store",
  });
}

export async function handleRequest(request, env = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "Method not allowed", { allow: "GET, HEAD" });
  }

  const url = new URL(request.url);
  if (url.search !== "") {
    return errorResponse(400, "Query parameters are not supported");
  }

  const artifact = artifactFromPath(url.pathname);
  if (!artifact) {
    return errorResponse(404, "Artifact not found");
  }

  const range = request.headers.get("range");
  if (range && (range.length > 128 || !/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(range))) {
    return errorResponse(400, "Invalid range");
  }
  const ifRange = request.headers.get("if-range");
  if (ifRange && ifRange.length > 256) {
    return errorResponse(400, "Invalid if-range");
  }

  const upstreamHeaders = new Headers({
    accept: "application/octet-stream",
    "user-agent": "sinty-updates-artifact-proxy",
  });
  if (range) {
    upstreamHeaders.set("range", range);
    if (ifRange) {
      upstreamHeaders.set("if-range", ifRange);
    }
  }

  let releaseResponse;
  try {
    releaseResponse = await fetchRelease(artifact, request.method, upstreamHeaders, env.GITHUB_TOKEN);
  } catch (error) {
    console.error(JSON.stringify({
      message: "artifact fetch failed",
      version: artifact.version,
      asset: artifact.asset,
      error: error instanceof Error ? error.message : String(error),
    }));
    return errorResponse(502, "Artifact origin unavailable");
  }
  if (!releaseResponse) {
    return errorResponse(404, "Artifact not found");
  }

  const redirectURL = releaseAssetRedirect(releaseResponse);
  await cancelBody(releaseResponse);
  if (!redirectURL) {
    console.error(JSON.stringify({
      message: "artifact origin returned an invalid redirect",
      version: artifact.version,
      asset: artifact.asset,
      status: releaseResponse.status,
    }));
    return errorResponse(502, "Artifact origin unavailable");
  }

  let upstream;
  try {
    upstream = await fetch(redirectURL, {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "release asset fetch failed",
      version: artifact.version,
      asset: artifact.asset,
      error: error instanceof Error ? error.message : String(error),
    }));
    return errorResponse(502, "Artifact origin unavailable");
  }

  if (upstream.status === 416) {
    const contentRange = upstream.headers.get("content-range");
    await cancelBody(upstream);
    return new Response(null, {
      status: 416,
      headers: {
        "cache-control": "no-store",
        ...(contentRange ? { "content-range": contentRange } : {}),
        "x-content-type-options": "nosniff",
      },
    });
  }

  if (!upstream.ok) {
    await cancelBody(upstream);
    console.error(JSON.stringify({
      message: "artifact origin rejected request",
      version: artifact.version,
      asset: artifact.asset,
      status: upstream.status,
    }));
    return errorResponse(502, "Artifact origin unavailable");
  }

  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) {
      responseHeaders.set(name, value);
    }
  }

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export default {
  fetch: handleRequest,
};
