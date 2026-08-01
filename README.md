# sinty-updates

Signed update feed for Sinty OS, served at `updates.sinty.dev`. `updated` polls the
manifest, verifies `root -> signing-cert -> manifest`, and pulls artifacts from the matching
GitHub Release through the restricted streaming proxy. Signatures are the trust, not the
host; private keys never live here.

## Publish

```
./publish.sh <version> <rootfs.erofs> <kernelcache.efi>
```

Then upload the two artifacts to the `<version>` GitHub Release and push.

## Artifact proxy

The Worker route at `/artifacts/<version>/<asset>` follows the GitHub Release redirect on
behalf of clients that require a direct `200` response. It accepts only the fixed OTA asset
names and streams response bodies without buffering them.

```
node --test test/worker.test.mjs
wrangler deploy --dry-run
```
