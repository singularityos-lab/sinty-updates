# sinty-updates

Signed update feed for Sinty OS, served at `updates.sinty.dev`. `updated` polls the
manifest, verifies `root -> signing-cert -> manifest`, and pulls artifacts from the matching
GitHub Release. Signatures are the trust, not the host; private keys never live here.

## Publish

```
./publish.sh <version> <rootfs.erofs> <kernelcache.efi>
```

Then upload the two artifacts to the `<version>` GitHub Release and push.
