# Portal visual refresh

The portal now shares a system-font design with soft surfaces, blue actions, consistent controls, icon navigation, and coordinated light/dark appearances. The dashboard adds a status visualization derived from its existing query results. Public, authentication, onboarding, device, site, storage, and organization screens use the same visual language.

Design reference: [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines), particularly its [foundations](https://developer.apple.com/design/human-interface-guidelines/foundations). This is an HIG-inspired web interface, not a native Apple UI implementation.

## Maintaining the design

- `src/app/globals.css` defines semantic colors, typography, surfaces, controls, responsive layouts, and accessibility preferences.
- Shared presentation classes: `surface`, `page-title`, `control`, `button-primary`, `button-secondary`, and `button-danger`.
- `src/components/brand.tsx` and `icon.tsx` provide the common brand and decorative SVG icons. Navigation icons retain visible labels; the active link uses `aria-current`.
- System fonts use the platform's native font without a font download. Appearance follows the operating-system preference.
- Primary controls have a minimum 44px height, mobile text fields use 16px type, keyboard focus is visible, and the app provides a skip link. Reduced motion, reduced transparency, and increased contrast preferences have explicit styles.
- Dashboard counts and status labels are available as text; the decorative ring is hidden from assistive technology.

## Scope

Server actions, database queries, migrations, role helpers, authentication handlers, form field names, validation, and dependencies are unchanged. Existing routes and permission gates remain in place. No deployment was performed.

## Review images

Screenshots use disposable local test records. The small Next.js development indicator is a local development overlay, not part of the design.

- [Dashboard, light](dashboard-light.png)
- [Dashboard, dark](dashboard-dark.png)
- [Dashboard, mobile](dashboard-mobile.png)
- [Home](home.png)
- [Sign in](sign-in.png)

## Verification

- Production build: compilation, TypeScript, and page generation pass.
- ESLint and all three existing redirect tests pass; `git diff --check` is clean.
- Browser verification: 23 recorded check groups pass, with zero browser runtime errors and zero automated WCAG A/AA violations on the scanned states. See [results](browser-results.json).
- All six workspace routes checked at 1440, 768, 375, and 320px in light and dark mode: no horizontal overflow.
- Home, sign-in, sign-up, forgot-password, and auth-error pages checked at 320px in both appearances.
- Functional checks: sign-in/out and protected redirects, organization creation, site creation/rename, prefilled device lookup and claim, device editing, and storage configuration creation.
- Interaction checks: mobile site/device editors, keyboard skip link, reduced motion, and viewer restrictions on device editing, site creation, claiming, and storage access.

Tests used local Supabase and Chrome with a disposable organization. The local organization and its test device, site, and storage reference remain for inspection. No hosted data or real device configuration was changed. Automated accessibility checks are targeted checks, not a comprehensive accessibility certification; external email delivery and cloud transfers were not retested for this presentation-only change.
