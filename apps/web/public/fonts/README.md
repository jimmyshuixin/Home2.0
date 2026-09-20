# Xvyin Serif

For the current site, import `xvyin-serif-critical.css` once and preload `xvyin-serif-critical.woff2` instead of the broad file. The 137,844-byte critical subset covers all 654 printable characters from the current 70 public Vue/TypeScript/CSS source files and public snapshot, plus printable ASCII and NBSP. Its exact 507 Unicode ranges are declared after the broad face in that CSS, so additional dynamic characters load the broad font only as needed. Remove later duplicate broad `Xvyin Serif` declarations so they do not override this ordering. `xvyin-serif-critical-manifest.json` records the source snapshot hash, coverage, asset hash and validation. Every critical glyph outline and advance was checked against the broad font; all are identical.

`xvyin-serif-regular.woff2` is a self-hosted, static weight-400 subset of the locally installed open-source Noto Serif SC variable font. The subset has been renamed Xvyin Serif to distinguish it from the original. The bundled SIL Open Font License 1.1 and the original Adobe copyright notice apply.

It includes the GB2312 repertoire, the current public snapshot and public UI characters, Latin text and common punctuation: 7,812 Unicode codepoints, including 6,763 basic Chinese characters. All 652 unique printable characters in the public source and snapshot at generation time are present. OpenType layout features and hinting were retained.

The file is 1,434,368 bytes. A trial containing the entire Basic CJK block produced a 4,254,640-byte WOFF2 file, so the smaller common-character subset is used. Future rare characters and emoji must continue to use the CSS fallback stack; the subset does not claim complete Unicode or complete CJK coverage.

Suggested declaration (not automatically imported):

```css
@font-face {
  font-family: 'Xvyin Serif';
  src: url('/fonts/xvyin-serif-regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
/* Keep system fallbacks for characters outside the subset. */
/* font-family: 'Xvyin Serif', 'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', serif; */
```

Provenance and validation, including the source font version and SHA-256 hashes, are recorded in `xvyin-serif-manifest.json`. The local font's internal version is `Version 2.02;241114204558;non-release`; it has not been claimed to match the hash of a current upstream release. No proprietary system font has been copied or redistributed.

Official sources:

- [Noto CJK Serif license](https://github.com/notofonts/noto-cjk/blob/main/Serif/LICENSE)
- [Google Fonts Noto Serif SC metadata](https://github.com/google/fonts/blob/main/ofl/notoserifsc/METADATA.pb)
- [Noto font usage documentation](https://github.com/notofonts/noto-docs/blob/main/docs/website/use.md)

Build tooling: fontTools 4.65.0 and Brotli 1.2.0. The build fixes the `wght` axis to 400, subsets to GB2312 plus current UI/public-content characters and punctuation, retains layout features, and encodes WOFF2. Tooling was installed in a temporary directory and adds no project dependency.
