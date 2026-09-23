# Recovered dependency license texts

These exact npm versions declare MIT but omit a top-level license file. The
build fails for any newly missing license until its source is reviewed.

- react-force-graph-2d 1.29.1: LICENSE copied verbatim from the package's npm
  gitHead, [5ee21b6](https://github.com/vasturiano/react-force-graph/blob/5ee21b693d83f62da569cba6e3cdf31e028406e1/LICENSE).
- bezier-js 6.1.4: npm gitHead [a41f3e0](https://github.com/Pomax/bezierjs/tree/a41f3e08e9724c9973eca0eb5c1304120e72fc70)
  has no LICENSE file. Its [source header](https://github.com/Pomax/bezierjs/blob/a41f3e08e9724c9973eca0eb5c1304120e72fc70/src/bezier.js)
  identifies Pomax and grants MIT; its README repeats that grant. The fallback
  preserves that attribution and appends the standard MIT permission/warranty
  text. No copyright year was supplied by that source or invented here.
- abstract-logging 2.0.1: npm package and upstream tag commit
  [80dfaef](https://github.com/jsumners/abstract-logging/tree/80dfaef91ee87008f4ed2b6e78921d383bccd406)
  omit LICENSE and link to <https://jsumners.mit-license.org/> from Readme.md.
  The fallback preserves that page's MIT grant and copyright notice retrieved
  2026-09-23 (the linked site renders the current year), with its obfuscated
  email rendered as the same author address recorded in package.json.
