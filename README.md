# sinty-updates

The update feed for Sinty OS. Served at **https://updates.sinty.dev** (GitHub Pages,
optionally behind Cloudflare). A device's `updated` agent polls the signed manifest here,
compares the version, and -- if newer -- downloads the artifacts from **GitHub Releases**.

## Why this is safe on a cheap/untrusted host

Every manifest is **Ed25519-signed**. The device verifies the chain
`root.pub -> signing-cert -> manifest.sig` before trusting anything, so the transport and
the host are irrelevant: a forged manifest or a swapped artifact is rejected by signature,
not by TLS. That is why the manifest can live on GitHub Pages / Cloudflare (pennies) and the
artifacts on GitHub Releases (their bandwidth), while security stays intact.

## Layout

```
stable/
  manifest.json         # the current release: version + artifact URLs + hashes
  manifest.json.sig     # Ed25519 signature by the signing key
  signing-cert.json     # the signing key, vouched for by the ROOT key
  signing-cert.json.sig
CNAME                   # updates.sinty.dev (GitHub Pages custom domain)
.nojekyll               # serve the JSON verbatim (no Jekyll)
```

The device fetches `https://updates.sinty.dev/stable/manifest.json` (+ `.sig`,
`signing-cert.json`). Channels are directories: add `beta/` later the same way.

## Publishing a release

`./publish.sh <version> <rootfs.erofs> <kernelcache.efi>` regenerates + signs the manifest
(via `atom-sign`) and commits it. Upload the two artifacts to the matching GitHub Release
(`releases/download/<version>/...`). Then push. The ROOT key never touches this repo -- only
the signing key signs the manifest; the ROOT key (cold, offline) only ever signs the
signing-cert, rarely.

## Status: PLACEHOLDER

`stable/manifest.json` currently advertises **v2** with placeholder artifact URLs (no real
release exists yet). This lets the client exercise check + "update available" end to end
without a real download. Replace it with a real release via `publish.sh` when the first
image ships.

## Setup (Mirko, one-time)

1. Repo is **private**; enable GitHub Pages from `main` (public Pages from a private repo,
   or make it public since the manifest is signed anyway).
2. Point `updates.sinty.dev` at GitHub Pages (CNAME record), optionally proxied by Cloudflare.
3. Verify `https://updates.sinty.dev/stable/manifest.json` serves the JSON.
