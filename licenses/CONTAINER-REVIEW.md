# Container redistribution review

Reviewed for the release candidate on 2026-09-23. This records the engineering
basis for distribution; it is not a legal opinion or a guarantee of ownership.

## Application and commercial use

Tracery's original code is Apache-2.0. The locked JavaScript application
dependencies reviewed here have permissive licenses; no GPL, LGPL, AGPL or SSPL
application dependency was found. Keep the package license gate and browser
notice generation enabled. Atriarch's ownership confirmation covers the original
visualizer code, not the separately licensed packages it uses.

Nothing identified in this review requires the independent Tracery application
or private managed-service implementation to be relicensed under the GPL.
Commercial hosting and distribution still require respecting third-party
notices and any applicable source obligations. This review covers the public
community artifacts, not a future private enterprise distribution.

## Exact runtime

- Node 22.23.2, from the digest-pinned official `node:22.23.2-alpine3.24` image.
  Copy its unmodified binary and complete upstream LICENSE. npm, Corepack and
  Yarn are absent from the final image, including its base layers.
- Alpine 3.24.2, digest pinned. The exact 18 packages, source commits and declared
  licenses are recorded in [container-policy.json](container-policy.json).
- Changes to that inventory or Node's full license-text digest fail the release
  gate until the new material is reviewed. This is not a blanket GPL exception
  for application code.

## Operating-system components

These are independent, unmodified distribution components. GPL components in an
aggregate do not automatically relicense the other independent programs in it.
See [GPLv2 section 2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) and
the [GNU aggregation FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation).
They do still have their own redistribution obligations.

| Source origin | Scope and treatment |
| --- | --- |
| alpine-baselayout, apk-tools, busybox, pax-utils | GPL-2.0 components; full corresponding source, Alpine patches/configuration and build recipes accompany the binaries. |
| musl | MIT libc plus utilities with MIT/BSD/GPL notices; all origin sources and recipes accompany the image. |
| gcc | Alpine metadata combines GPL/LGPL labels. libgcc/libstdc++ carry GCC runtime permissions; retain all source and notices, including COPYING.RUNTIME. No application source exemption is inferred solely from Alpine's metadata. |
| ca-certificates | MPL-2.0/MIT certificate material; matching source and notices accompany the image. |
| alpine-base, alpine-keys, openssl, zlib | Permissive components; full matching source, recipe and notices are retained as well. |

The [GCC Runtime Library Exception](https://www.gnu.org/licenses/gcc-exception-3.1.html)
permits qualifying independent programs to use the runtime under their own
licenses. Tracery copies the official, unmodified Node runtime and dynamically
linked Alpine runtime libraries; it does not modify GCC or use proprietary GCC
compiler plugins. Including the library sources avoids relying on that exception
as a reason to omit the libraries' own source material.

`scripts/container-sources.py` reads the actual runtime APK database, fetches
each origin's exact aports revision, and verifies every source against its
APKBUILD checksums using `abuild`. Recipes, patches, configuration, upstream
archives, common license texts and an inventory are archived together.

The archive is **inside every image**, at `/usr/share/tracery/sources.tar.gz`.
Recipients get source together with object code; no email request, account or
external source-server availability is required. Instructions are included at
`/usr/share/tracery/SOURCES.txt`. The release smoke test extracts the archive,
checks every recorded checksum and compares its package database with the live
image. The same archive is also attached to the GitHub release.

## Node's bundled notices

Node's full license file includes MIT/BSD/ISC/Zlib/Apache notices, ICU, c-ares,
NAIST, Artistic-2.0, and Autoconf exception text. Trivy reports the latter as GPL
findings even though the additional permissions apply to generated output.
These findings are accepted **only** at `/usr/share/licenses/node/LICENSE`, with
the exact reviewed SHA-256 in the policy. The exception never applies to a GPL
application dependency or a different file. Preserve the entire upstream file,
not just its leading MIT paragraph.

Sources: [Node 22.23.2 LICENSE](https://github.com/nodejs/node/blob/v22.23.2/LICENSE),
[Autoconf exception](https://www.gnu.org/licenses/autoconf-exception-3.0.html),
and [official Node image runtime guidance](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#smaller-images-without-npmyarn).

## Evidence and limits

The release workflow retains source and final-image CycloneDX SBOMs, full Trivy
license/vulnerability/secret reports, exact tested npm tarballs, package
integrities, source archive and SHA-256 checksums. It rejects empty scans,
unreviewed licenses, detected secrets and HIGH/CRITICAL vulnerabilities.
Permissive BlueOak-1.0.0 is explicitly recognized even though Trivy labels it
unknown. Reports retain those findings instead of suppressing them.

Scans do not prove authorship, patent clearance or trademark rights. Do not turn
this review into an unconditional claim that all third-party software is
Apache-2.0, or reuse it to approve a changed enterprise artifact.
