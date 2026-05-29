# Home2.0 design note

## Direction

Home2.0 should feel like a public, approachable life journal rather than a boxed blog or dashboard. The main metaphor is a real scrapbook book:

- PC reading H5: an open spread with two visible pages.
- Mobile H5: one page at a time, without the desktop book shell.
- Content: handwriting, taped photos, stickers, bookmarks, cover and table of contents.
- PC admin H5: a separate paper canvas where the owner can write, draw, paste photos and save a page.
- Mini program upgrade: keep platform-specific browser or `wx.*` calls behind `frontend/src/platform/runtimePort.js`.

## Concept image

The first visual concept generated for this implementation is saved at:

```text
docs/design-concept.png
```

## Tokens

- Paper: `#fffdf7`
- Ink: `#26312d`
- Sage: `#88a891`
- Coral: `#e87f67`
- Sky: `#83bcd9`
- Warm yellow: `#f4c95d`

The UI avoids rigid boxed grids. Controls use bookmark, tape and torn-paper shapes while keeping buttons and inputs accessible.
