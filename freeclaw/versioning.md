# FreeClaw Versioning

FreeClaw reset its product version when it forked from OpenClaw. Treat the
root `package.json` version as the source of truth for the FreeClaw product
line, even if older inherited git tags exist in this repository.

Use integer product versioning for FreeClaw releases:

- the public product release is a single increasing integer
- stable git tags use `vN`, for example `v2`
- beta git tags use `vN-beta.M`, for example `v3-beta.1`
- increment the integer for each public release train

npm still requires semantic versions in `package.json`, so encode the integer
product version as an npm-compatible major version:

```text
v2        -> package.json 2.0.0
v3-beta.1 -> package.json 3.0.0-beta.1
```

Do not publish new FreeClaw releases as `vX.Y.Z` tags. This repository contains
historical OpenClaw-style tags, and FreeClaw releases should be recognizable by
the integer tag line.

Example: for FreeClaw 2, set `package.json` to `2.0.0` and tag the release
commit as `v2`.
