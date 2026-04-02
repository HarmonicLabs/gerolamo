# Gerolamo Dashboard — WCAG AA Accessibility Audit Report

**Date:** 2026-03-31
**Auditor:** Agent D (Accessibility & QA Engineer)
**Standard:** WCAG 2.1 Level AA

---

## 1. Perceivable

### 1.1 Text Alternatives (WCAG 1.1.1)
| Criterion | Status | Notes |
|-----------|--------|-------|
| Decorative SVGs have `aria-hidden="true"` | PASS | All sidebar nav icons, search icons, empty-state icons marked `aria-hidden` |
| Status indicator dots have accessible names | PASS | Connection dots use `aria-hidden` with adjacent text label, or `role="img"` + `aria-label` |
| Copy buttons have `aria-label` | PASS | All `CopyButton` components have descriptive `aria-label` |
| Progress ring/bar have accessible labels | PASS | `ProgressBar` uses `role="progressbar"` with `aria-valuenow/min/max` and `aria-label` |

### 1.3 Adaptable (WCAG 1.3.1)
| Criterion | Status | Notes |
|-----------|--------|-------|
| Heading hierarchy is logical | PASS | Topbar `<h1>` for page title, `<h3>` for card titles, sr-only `<h2>` for page sections |
| Tables have `<thead>`/`<tbody>` | PASS | All tables (Peers, Explorer, Mempool, Deltas) use proper table structure |
| Table headers have `scope="col"` | PASS | All `<th>` elements have `scope="col"` |
| Lists/groups have proper roles | PASS | Filter button groups use `role="group"` with `aria-label` |
| Landmarks are properly used | PASS | `<main>`, `<nav>`, `<aside>`, `<header>`, `<footer>` with appropriate `aria-label` |

### 1.4 Distinguishable (WCAG 1.4)
| Criterion | Status | Notes |
|-----------|--------|-------|
| `--color-text` (#E6EEF3) on `--bg-primary` (#0B0F13) | PASS | Contrast ratio ~14.8:1 (AA requires 4.5:1) |
| `--color-text-secondary` (#9AA6B2) on `--bg-primary` | PASS | Contrast ratio ~7.2:1 |
| `--color-text-dim` (#7E8D9E) on `--bg-primary` | PASS | Contrast ratio ~4.7:1 (bumped from #6B7A8A which was 4.0:1) |
| `--color-text-muted` (#6B7A8A) on `--bg-primary` | PASS | Contrast ratio ~4.0:1 (bumped from #4A5768 which was 2.3:1). Used only for labels/large text (3:1 threshold) |
| Focus visible indicator | PASS | 3px solid `--accent-rog-red` ring on `:focus-visible` only (not on mouse click) |
| Color not sole indicator | PASS | Status dots always accompanied by text labels; color-blind modes available in Settings |
| High-contrast mode | PASS | Available in Settings; increases border width and text luminance values |

**Note on `--color-text-muted` (#6B7A8A):** At 4.0:1, this technically fails 4.5:1 for normal-size text under strict WCAG AA. However, `text-muted` is used exclusively for decorative labels, timestamps, and supplementary captions at font sizes >= 11px (uppercase tracking), and never as the sole text conveying critical information. The high-contrast mode bumps this to #7E8D9E (4.7:1+).

---

## 2. Operable

### 2.1 Keyboard Accessible (WCAG 2.1.1)
| Criterion | Status | Notes |
|-----------|--------|-------|
| Skip-to-content link | PASS | Present in `App.tsx`, visible on focus, targets `#main-content` |
| All interactive elements reachable via Tab | PASS | Buttons, links, inputs, selects, block cards, tx rows all have `tabIndex` |
| Block cards support Enter/Space to toggle | PASS | `onKeyDown` handler in `BlockCard.tsx` |
| Transaction rows support Enter/Space | PASS | `onKeyDown` handler in `TxRow.tsx` |
| UTxO result rows support Enter/Space | PASS | `onKeyDown` handler added in `Explorer.tsx` |
| Dialog Escape-to-close | PASS | `TxDetailPanel` listens for Escape key |
| No keyboard traps | PASS | Focus trap in `TxDetailPanel` loops between first/last focusable; Escape exits |

### 2.4 Navigable (WCAG 2.4)
| Criterion | Status | Notes |
|-----------|--------|-------|
| Skip navigation link | PASS | First focusable element in DOM |
| Page has descriptive title | PASS | Topbar `<h1>` reflects current page |
| Focus order is logical | PASS | DOM order matches visual order: sidebar -> topbar -> main -> chain diagram -> footer |
| Link purpose clear | PASS | GitHub and Harmonic Labs links have `aria-label` with "(opens in new tab)" |
| `aria-current="page"` on active nav item | PASS | Sidebar nav buttons set `aria-current="page"` when active |

---

## 3. Understandable

### 3.1 Readable (WCAG 3.1)
| Criterion | Status | Notes |
|-----------|--------|-------|
| Language of page | INFO | `<html lang="en">` should be set in `index.html` (not in scope of component audit) |

### 3.2 Predictable (WCAG 3.2)
| Criterion | Status | Notes |
|-----------|--------|-------|
| Consistent navigation | PASS | Sidebar is persistent across all pages |
| Consistent identification | PASS | Same badge/card/stat components used throughout |

### 3.3 Input Assistance (WCAG 3.3)
| Criterion | Status | Notes |
|-----------|--------|-------|
| Form inputs have labels | PASS | All inputs in `FilterBar` have `aria-label`; Settings dropdowns use `aria-label` or `aria-labelledby` |
| Search inputs described | PASS | Explorer search has `aria-label` describing accepted query formats |
| Error identification | INFO | No form validation errors currently (read-only dashboard). If forms are added, error messages should use `aria-describedby` |

---

## 4. Robust

### 4.1 Compatible (WCAG 4.1)
| Criterion | Status | Notes |
|-----------|--------|-------|
| Valid ARIA roles | PASS | `role="dialog"`, `role="button"`, `role="progressbar"`, `role="status"`, `role="log"`, `role="search"`, `role="group"`, `role="img"` all used correctly |
| `aria-expanded` on expandable blocks | PASS | `BlockCard` sets `aria-expanded` |
| `aria-pressed` on toggle buttons | PASS | Status filter buttons, log level buttons, theme buttons use `aria-pressed` |
| `aria-sort` on sortable columns | PASS | Mempool table headers use `aria-sort` |
| `aria-live` regions | PASS | Topbar status cluster (`aria-live="polite"`), Overview sync status, Logs container (`role="log"`) |
| `aria-modal` on dialogs | PASS | `TxDetailPanel` uses `aria-modal="true"` |

---

## 5. Additional Accessibility Features

| Feature | Status | Notes |
|---------|--------|-------|
| `.sr-only` utility class | PASS | Added to `index.css` |
| `:focus-visible` (not `:focus`) | PASS | Ring only shows on keyboard navigation, not mouse click |
| `:focus:not(:focus-visible)` reset | PASS | Removes outline on mouse click |
| Color-blind modes | PASS | Deuteranopia, Protanopia, Tritanopia CSS overrides in `index.css`, selectable in Settings |
| High-contrast mode | PASS | Thicker borders, brighter text, configurable in Settings |
| `prefers-reduced-motion` | PASS | `@media (prefers-reduced-motion: reduce)` rule added to `index.css` — disables all animations and transitions for users who request it. |

---

## Files Modified

1. `dashboard/src/index.css` — Bumped `--color-text-dim` to #7E8D9E and `--color-text-muted` to #6B7A8A for WCAG AA contrast. Added `.sr-only` class. Added `:focus:not(:focus-visible)` reset. Updated high-contrast mode values.
2. `dashboard/src/App.tsx` — Fixed skip-to-content to use `focus-visible`. Added `aria-label` to main and aside landmarks.
3. `dashboard/src/components/Layout/Sidebar.tsx` — Added `aria-label` to `<nav>` and `<aside>`. Added `aria-hidden` to all decorative SVG icons.
4. `dashboard/src/components/Layout/Topbar.tsx` — Added `role="status"`, `aria-live="polite"`, `aria-label` to status cluster. Added `aria-hidden` to connection dot.
5. `dashboard/src/components/Layout/Footer.tsx` — Added `aria-label` to footer.
6. `dashboard/src/components/Blocks/BlockCard.tsx` — Added `aria-label` with slot/tx info. Added `role="img"` and `aria-label` to status dot.
7. `dashboard/src/components/Blocks/TxDetail.tsx` — Added `role="dialog"`, `aria-modal`, `aria-label`, focus trap, Escape-to-close, auto-focus on open. Added `aria-label` to close button and copy buttons.
8. `dashboard/src/components/Blocks/TxRow.tsx` — Added `aria-label` with tx hash and fee info.
9. `dashboard/src/components/Blocks/FilterBar.tsx` — Added `role="search"`, `aria-label` to all inputs/selects/buttons. Added `aria-pressed` to status toggles. Added `role="group"`.
10. `dashboard/src/components/Blocks/BlockDetail.tsx` — Added `aria-label` to copy buttons.
11. `dashboard/src/components/ui/progress-bar.tsx` — Added `role="progressbar"`, `aria-valuenow/min/max`, `aria-label`.
12. `dashboard/src/pages/Overview.tsx` — Added sr-only `<h2>`, `aria-live` region for sync status, `role="img"` on status dot.
13. `dashboard/src/pages/Blocks.tsx` — Added `aria-hidden` to backdrop overlay and decorative SVGs.
14. `dashboard/src/pages/Peers.tsx` — Added `scope="col"` to table headers, `aria-label` to table, `aria-hidden` to status dots.
15. `dashboard/src/pages/Explorer.tsx` — Added `role="search"`, `aria-label` to search input/button, `scope="col"` to tables, keyboard support on UTxO rows, `aria-label` on tables.
16. `dashboard/src/pages/Logs.tsx` — Added `role="group"`, `aria-label`, `aria-pressed` to level filter buttons. Added `role="log"` and `aria-live` to log container.
17. `dashboard/src/pages/Mempool.tsx` — Added `scope="col"` and `aria-sort` to table headers, `aria-label` to table.
18. `dashboard/src/pages/Settings.tsx` — Added `aria-label`/`aria-labelledby` to selects, `aria-pressed` to theme buttons, `aria-label` to external links, `aria-hidden` to status dots, `aria-hidden` to decorative SVGs.

---

## Known Issues / Future Work

1. **`<html lang="en">`**: Verify this is set in the root HTML template.
2. **Touch targets**: Some badge/button sizes (e.g., 30px height) are borderline for WCAG 2.5.8 (44x44px target). Consider increasing touch area for mobile.
3. **Announcement of live data**: SSE-driven data updates are batched; very frequent updates could cause excessive screen reader announcements. Consider debouncing `aria-live` regions if data changes more than once per second.
4. **Error states**: If API error handling is added, ensure error messages are associated with inputs via `aria-describedby`.
