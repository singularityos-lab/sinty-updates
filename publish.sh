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
# The hash tree and the loader signature are part of the release, not extras: without
# them a device stages an update it can never boot. Conventional names beside the
# artifacts, overridable for odd layouts.
rootfs_ht="${ROOTFS_HASHTREE:-${rootfs%.erofs}.hash}"
kc_sig="${KC_SIG:-$kc.sig}"
# dm-verity ROOT hash of the image, the value baked in its UKI cmdline. The device
# compares it against the running cmdline before promoting, so without it the update
# stages, boots, and stays pending forever. veritysetup printed it at build time.
verity="${ROOTFS_VERITY_HASH:-}"
if [ -z "$verity" ] && [ -f "$(dirname "$rootfs")/verity-output.txt" ]; then
    verity=$(awk '/Root hash:/{print $3}' "$(dirname "$rootfs")/verity-output.txt")
fi
[ -n "$verity" ] || { echo "publish: set ROOTFS_VERITY_HASH (or provide verity-output.txt beside $rootfs)" >&2; exit 1; }
[ -f "$rootfs_ht" ] || { echo "publish: missing rootfs hash tree $rootfs_ht" >&2; exit 1; }
[ -f "$kc_sig" ] || { echo "publish: missing kernelcache signature $kc_sig" >&2; exit 1; }
min="${MIN_VERSION:-$version}"

here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/$channel"
base="https://github.com/$REPO_BASE/releases/download/$version"

( cd "$ATOMLOOPS" && go run ./cmd/atom-sign manifest \
    --version "$version" --min-version "$min" \
    --rootfs "$rootfs" --rootfs-url "$base/$(basename "$rootfs")" \
    --rootfs-verity-hash "$verity" \
    --rootfs-hashtree "$rootfs_ht" --rootfs-hashtree-url "$base/$(basename "$rootfs_ht")" \
    --kernelcache "$kc" --kc-url "$base/$(basename "$kc")" \
    --kc-sig "$kc_sig" --kc-sig-url "$base/$(basename "$kc_sig")" \
    --out "$here/$channel/manifest.json" )
( cd "$ATOMLOOPS" && go run ./cmd/atom-sign sign \
    --manifest "$here/$channel/manifest.json" --priv "$SIGNING_KEY" )

# keep the (root-signed) signing cert alongside the manifest
cp "$ATOMLOOPS/signing-cert-v1.json"     "$here/$channel/signing-cert.json"
cp "$ATOMLOOPS/signing-cert-v1.json.sig" "$here/$channel/signing-cert.json.sig"

echo "published $channel/$version -- upload $rootfs $rootfs_ht $kc $kc_sig to the '$version' GitHub Release, then commit+push"
