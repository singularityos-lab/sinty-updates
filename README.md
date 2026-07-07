# sinty-updates

Signed update feed for Sinty OS, served at `updates.sinty.dev`. `updated` polls the
manifest, verifies `root -> signing-cert -> manifest`, and pulls artifacts from the matching
GitHub Release. Signatures are the trust, not the host; private keys never live here.

## Layout

```
stable/manifest.json(.sig)      release pointer (version, artifact URLs, hashes) + signature
stable/signing-cert.json(.sig)  signing public key, root-signed
```

## Publish

```
./publish.sh <version> <rootfs.erofs> <kernelcache.efi>
```

Then upload the two artifacts to the `<version>` GitHub Release and push.
