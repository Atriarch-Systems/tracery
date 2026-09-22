# Licensing and redistribution

Tracery's original code is licensed under the [Apache License 2.0](../LICENSE).
Third-party dependencies and vendored files retain their own licenses. An
Apache-2.0 package declaration does not replace those licenses.

The repository [NOTICE](../NOTICE) provides selected attributions. It is not a
complete inventory of dependencies or a substitute for their license texts.

## Dependencies and vendored code

The npm lockfile records license declarations for resolved packages. Review
those declarations together with the actual upstream license and copyright
notices when adding or upgrading dependencies. Include runtime dependencies,
transitive dependencies, bundled browser code, data, fonts, and images.

The vendored `vite-plugin-singlefile` package is MIT-licensed. Its license is
preserved in [the vendor directory](../apps/hub/web/vendor/vite-plugin-singlefile/LICENSE),
and its origin and packaging modifications are documented in the
[vendor README](../apps/hub/web/vendor/README.md).

Build tools are distinct from distributed runtime code, but a tool's assets,
runtime helpers, or data can become part of its output. Inspect what the build
actually ships rather than treating every development dependency as exempt.

## Release review

For each release:

1. Record the source commit and resolved dependency versions. Review missing,
   changed, or unfamiliar licenses and upstream copyright notices.
2. Confirm that Tracery has the right to distribute imported source and assets.
   A dependency scanner cannot establish authorship or employer ownership.
3. Inspect the actual npm tarballs and Python wheel. Include the applicable
   Tracery LICENSE and NOTICE, and preserve notices for any copied or bundled
   third-party code. Separately installed npm dependencies are not the same as
   code copied into a package's browser bundle.
4. Include readable, complete third-party license and copyright notices with
   the hosted UI. Preserve them inside standalone HTML exports as well: the
   exported file must carry its notices when detached from the server.
5. Include Tracery's LICENSE and NOTICE in the final container, along with the
   notices required for bundled software. Review the base image and operating
   system packages separately; an npm scan does not cover them.
6. Repeat artifact inspection after dependency or bundler changes. Keeping a
   license file in the source tree does not prove it survives packaging.

The release review must verify these conditions; this document does not assert
that the current build already satisfies every item.

## License references

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), particularly
  redistribution in Section 4 and contributions in Section 5.
- [MIT License](https://opensource.org/license/mit): retain the copyright and
  permission notice with copies or substantial portions of the software.
- [ISC License](https://spdx.org/licenses/ISC.html): retain the copyright and
  permission notice in copies.
- [BSD 3-Clause](https://opensource.org/license/bsd-3-clause): preserve the
  required notices and observe the non-endorsement condition.
- [Blue Oak Model License 1.0.0](https://blueoakcouncil.org/license/1.0.0): give
  recipients the required license notice.
- [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/):
  review attribution obligations when distributing covered data or other material.

These are engineering review guidelines, not a legal opinion about ownership,
trademarks, patents, or a particular distribution.

## Automated release checks

Run `npm run license:check` against the lockfile. The gate rejects unlisted,
ambiguous, unknown and copyleft licenses pending review. BlueOak-1.0.0 is accepted
as permissive; caniuse-lite's CC-BY-4.0 data is accepted only as a development
entry. New exceptions require a documented source and justification in the PR.
CI also uses Trivy 0.74.0 for license inventory and a CycloneDX source SBOM,
retained in the license-and-sbom artifact. This does not scan a final container.

Hosted and standalone viewer builds automatically collect license files for
resolved third-party modules, emit THIRD-PARTY-NOTICES.txt and embed a readable
Open-source licenses disclosure in each HTML artifact. Missing packaged license
text fails the build; reviewed upstream fallbacks live in licenses/vendor with
pinned source references. The container Dockerfile copies the resulting notices
and Tracery's own LICENSE/NOTICE. Final image and registry validation are separate
from the v0.1.0 source release.
