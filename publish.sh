#!/bin/sh
# publish.sh <version> <rootfs.erofs> <kernelcache.efi> [channel]
# Regenerate + sign the update manifest for a release, then commit it. Artifacts go to the
# matching GitHub Release through the artifact proxy; this only publishes the signed pointer.
# The ROOT key is never used here -- only the signing key.
set -eu

ATOMLOOPS="${ATOMLOOPS:-$HOME/Projects/personal/AtomLoops}"
SIGNING_KEY="${SIGNING_KEY:-$ATOMLOOPS/signing-v1.key}"
SIGNING_CERT="${SIGNING_CERT:-$ATOMLOOPS/signing-cert-v1.json}"

version="${1:?usage: publish.sh <version> <rootfs.erofs> <kernelcache.efi> [channel]}"
rootfs="${2:?rootfs artifact required}"
kc="${3:?kernelcache artifact required}"
channel="${4:-stable}"
product_name="${PRODUCT_NAME:-Sinty OS Event Horizon}"
product_version="${PRODUCT_VERSION:?set PRODUCT_VERSION to the public release number}"
product_build="${PRODUCT_BUILD:?set PRODUCT_BUILD to the public build identifier}"
firmware_dir="${FIRMWARE_DIR:-$(dirname "$rootfs")}"
amd_firmware="${AMD_FIRMWARE_IMG:-$firmware_dir/firmware-active-amd.img}"
amd_firmware_hash="${AMD_FIRMWARE_HASHTREE:-$firmware_dir/firmware-active-amd.hash}"
amd_firmware_verity="${AMD_FIRMWARE_VERITY_HASH:?set AMD_FIRMWARE_VERITY_HASH}"
nvidia_firmware="${NVIDIA_FIRMWARE_IMG:-$firmware_dir/firmware-active-nvidia.img}"
nvidia_firmware_hash="${NVIDIA_FIRMWARE_HASHTREE:-$firmware_dir/firmware-active-nvidia.hash}"
nvidia_firmware_verity="${NVIDIA_FIRMWARE_VERITY_HASH:?set NVIDIA_FIRMWARE_VERITY_HASH}"
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
[ -f "$amd_firmware" ] || { echo "publish: missing AMD firmware image $amd_firmware" >&2; exit 1; }
[ -f "$amd_firmware_hash" ] || { echo "publish: missing AMD firmware hash tree $amd_firmware_hash" >&2; exit 1; }
[ -f "$nvidia_firmware" ] || { echo "publish: missing NVIDIA firmware image $nvidia_firmware" >&2; exit 1; }
[ -f "$nvidia_firmware_hash" ] || { echo "publish: missing NVIDIA firmware hash tree $nvidia_firmware_hash" >&2; exit 1; }
min="${MIN_VERSION:-$version}"

here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/$channel"
base="${ARTIFACT_BASE:-https://updates.sinty.dev/artifacts}/$version"

( cd "$ATOMLOOPS" && go run ./cmd/atom-sign manifest \
    --version "$version" --min-version "$min" \
    --product-name "$product_name" --product-version "$product_version" \
    --product-build "$product_build" \
    --rootfs "$rootfs" --rootfs-url "$base/$(basename "$rootfs")" \
    --rootfs-verity-hash "$verity" \
    --rootfs-hashtree "$rootfs_ht" --rootfs-hashtree-url "$base/$(basename "$rootfs_ht")" \
    --kernelcache "$kc" --kc-url "$base/$(basename "$kc")" \
    --kc-sig "$kc_sig" --kc-sig-url "$base/$(basename "$kc_sig")" \
    --bundle "name=amd,img=$amd_firmware,url=$base/$(basename "$amd_firmware"),verity=$amd_firmware_verity,hashtree=$amd_firmware_hash,hashtree-url=$base/$(basename "$amd_firmware_hash"),version=1,chips=amd" \
    --bundle "name=nvidia,img=$nvidia_firmware,url=$base/$(basename "$nvidia_firmware"),verity=$nvidia_firmware_verity,hashtree=$nvidia_firmware_hash,hashtree-url=$base/$(basename "$nvidia_firmware_hash"),version=1,chips=nvidia" \
    --out "$here/$channel/manifest.json" )
( cd "$ATOMLOOPS" && go run ./cmd/atom-sign sign \
    --manifest "$here/$channel/manifest.json" --priv "$SIGNING_KEY" )

# keep the (root-signed) signing cert alongside the manifest
cp "$SIGNING_CERT"     "$here/$channel/signing-cert.json"
cp "$SIGNING_CERT.sig" "$here/$channel/signing-cert.json.sig"

echo "published $channel/$version -- upload $rootfs $rootfs_ht $kc $kc_sig $amd_firmware $amd_firmware_hash $nvidia_firmware $nvidia_firmware_hash to the '$version' GitHub Release, then commit+push"
