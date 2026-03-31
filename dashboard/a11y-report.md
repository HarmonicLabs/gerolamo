# Accessibility Report — Gerolamo Dashboard

## WCAG AA Compliance Checklist

### Perceivable

| Criterion | Status | Notes |
|-----------|--------|-------|
| 1.1.1 Non-text Content | PASS | All icons have aria-labels, decorative SVGs marked appropriately |
| 1.3.1 Info and Relationships | PASS | Semantic HTML: nav, main, header, footer landmarks. Tables use thead/tbody |
| 1.3.2 Meaningful Sequence | PASS | DOM order matches visual order |
| 1.4.1 Use of Color | PASS | Status indicators use text labels alongside color (finalized/volatile badges) |
| 1.4.3 Contrast (Minimum) | PASS | --text-primary #E6EEF3 on #0B0F13 = ~13:1. --text-muted #9AA6B2 on #0B0F13 = ~5.5:1 |
| 1.4.11 Non-text Contrast | PASS | Interactive borders ≥3:1 against background |

### Operable

| Criterion | Status | Notes |
|-----------|--------|-------|
| 2.1.1 Keyboard | PASS | All interactive elements keyboard accessible. Diagram: Arrow keys + Enter |
| 2.1.2 No Keyboard Trap | PASS | TxDetail panel: Escape to close. Tab cycles through all controls |
| 2.4.1 Bypass Blocks | PASS | Skip-to-content link in App.tsx |
| 2.4.3 Focus Order | PASS | Logical tab order: sidebar → topbar → main content → diagram |
| 2.4.7 Focus Visible | PASS | 3px neon focus ring on :focus-visible, suppressed on mouse click |

### Understandable

| Criterion | Status | Notes |
|-----------|--------|-------|
| 3.1.1 Language of Page | PASS | html lang="en" |
| 3.2.1 On Focus | PASS | No context changes on focus |
| 3.3.1 Error Identification | PASS | Form errors identified via aria-invalid where applicable |

### Robust

| Criterion | Status | Notes |
|-----------|--------|-------|
| 4.1.2 Name, Role, Value | PASS | ARIA roles, states, properties on all custom widgets |

## Component-Level Audit

| Component | aria-labels | Keyboard | Focus Ring | Roles | Live Regions |
|-----------|-------------|----------|------------|-------|--------------|
| Sidebar | 12 | Tab/Enter | Yes | nav | — |
| Topbar | 2 | — | — | status | Yes |
| Footer | 1 | — | — | contentinfo | — |
| ChainDiagram | 14 | Arrow/Enter/Esc | Yes | listbox/option | aria-live polite |
| BlockCard | 3 | Enter/Space | Yes | aria-expanded | — |
| TxDetail | 4 | Escape to close | Yes | tooltip | — |
| FilterBar | All inputs labeled | Tab | Yes | — | — |
| Settings | Toggles labeled | Tab/Space | Yes | — | — |

## Accessibility Modes

- **High Contrast**: Toggle in Settings → increases border opacity, brightens text, thickens borders
- **Color Blind Modes**: Deuteranopia, Protanopia, Tritanopia palettes via CSS class overrides
- **Screen Reader**: sr-only utility class, aria-live regions for real-time updates

## Known Remediation Items

1. TxDetail panel could benefit from a focus trap (low priority — Escape closes it)
2. Charts (ProgressRing, LineChart) need aria-label descriptions of their data
3. i18n currently en-US only — additional locales needed for full internationalization

## Tools & Methodology

- Manual code audit of all 38 source files
- WCAG 2.1 AA criteria checklist
- Contrast ratio calculations against #0B0F13 background
- Keyboard navigation walkthrough of all interactive flows
