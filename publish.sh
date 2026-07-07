#!/bin/sh
# publish.sh <version> <rootfs.erofs> <kernelcache.efi> [channel]
# Regenerate + sign the update manifest for a release, then commit it. Artifacts go to the
# matching GitHub Release (releases/download/<version>/...); this only publishes the signed
# pointer. The ROOT key is never used here -- only the signing key.
set -eu

ATOMLOOPS="${ATOMLOOPS:-$HOME/Projects/personal/AtomLoops}"
SIGNING_KEY="${SIGNING_KEY:-$ATOMLOOPS/signing-v1.key}"
REPO_BASE="${REPO_BASE:-singularityos-lab/sinty-updates}"

version="${1:?usage: publish.sh <version> <rootfs.erofs> <kernelcache.efi> [channel]}"
rootfs="${2:?rootfs artifact required}"
kc="${3:?kernelcache artifact required}"
channel="${4:-stable}"
min="${MIN_VERSION:-$version}"

here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/$channel"
base="https://github.com/$REPO_BASE/releases/download/$version"

( cd "$ATOMLOOPS" && go run ./cmd/atom-sign manifest \
    --version "$version" --min-version "$min" \
    --rootfs "$rootfs" --rootfs-url "$base/$(basename "$rootfs")" \
    --kernelcache "$kc" --kc-url "$base/$(basename "$kc")" \
    --out "$here/$channel/manifest.json" )
( cd "$ATOMLOOPS" && go run ./cmd/atom-sign sign \
    --manifest "$here/$channel/manifest.json" --priv "$SIGNING_KEY" )

# keep the (root-signed) signing cert alongside the manifest
cp "$ATOMLOOPS/signing-cert-v1.json"     "$here/$channel/signing-cert.json"
cp "$ATOMLOOPS/signing-cert-v1.json.sig" "$here/$channel/signing-cert.json.sig"

echo "published $channel/$version -- upload $rootfs + $kc to the '$version' GitHub Release, then commit+push"
