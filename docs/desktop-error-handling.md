# Desktop renderer failure audit

The audit covered the renderer entry point, router construction, root route and
provider layout, route error and not-found screens, React emergency boundary,
pre-mount DOM fallback, and their translation and reporting dependencies.

## Findings and changes

| Finding | Change |
| --- | --- |
| A route error screen can lose providers inside the root route layout. | `RendererLayout` owns baseline Lingui context above the router. The existing language-aware provider still applies the persisted preference inside the app; both use the same i18n instance. |
| TanStack's global catch boundary catches errors thrown by our fallback and displays its own unstyled screen. | `RendererRouter` disables that boundary. Errors escaping route handling reach `RendererErrorBoundary`. |
| Separate failure screens managed their own window spacing; the boot fallback lacked a reserved title-bar region. | Route errors, 404s, and the emergency boundary use `FailureLayout`. The pre-React DOM fallback shares its styles. |
| The old boot boundary also handled later renderer failures, but described every crash as a startup failure. | It is now `RendererErrorBoundary`, with generic recovery copy and error reporting to Sentry. |
| Long emergency diagnostics could push Reload below the initial viewport. | Recovery appears before diagnostics. Content scrolls below a fixed 48px drag region; diagnostics have their own height limit. |

The emergency boundary uses native elements and non-React translation calls. It
must not depend on router, authentication, IPC, or component-library providers.
Its layout uses inline styles so the title-bar clearance does not depend on
Tailwind or theme initialization. The normal route error page retains its richer
localized diagnostics, copy action, and home navigation.

## Regression guardrails

- `RendererLayout/renderer-safety.test.ts` traverses emergency UI imports and
  rejects unapproved external dependencies or React context hooks. It runs in
  the existing desktop test job.

## Validation

Focused tests, desktop TypeScript checking, changed-file lint, and strict i18n
extraction/compilation passed. Catalog changes remove the obsolete startup-only
React messages; the replacement copy already has translations in every locale.

An isolated Electron fixture bundled the real renderer wrapper and deliberately
crashed both a route and its error page. With the previous wrapper, the built-in
fallback heading appeared at y=8px. With the refactor, content starts at y=48px;
computed drag/no-drag regions, horizontal overflow, and actual Reload clicks
passed at 960×600 and 400×400, including a 32,000-character diagnostic. Screenshots
were captured and inspected. This was synthetic native-window validation, not a
reproduction of the original signed-in session.

## Scope limits

React boundaries contain render/lifecycle failures. Event-handler failures and
asynchronous operation errors still require handling at the operation's call
site. Module-load failures before boot handlers attach, native process crashes,
and an unavailable translation module are not made recoverable by this refactor.
A failing error page reports the secondary exception at the emergency boundary;
if the original fallback never commits, its reporting effect cannot run.

A subsequent real-app CDP sweep is documented in [the CDP verification report](desktop-error-cdp-verification.md). It found and fixed long-message overflow in the dashboard content fallback and added onscreen recovery to the pre-React boot fallback.

## Systematic follow-up

Settings and dashboard layouts share `ContentBoundary` and `ContentError`. The
sidebar, search banner, and title-bar region stay outside the boundary, so a
render error replaces only page content. The boundary resets on the router's
`loadedAt` commit marker, not the URL, so navigation does not retry the old
outlet. `renderer-safety.test.ts` checks that every outlet in both layouts sits
inside `ContentBoundary`.

Boot and emergency diagnostics share a nonthrowing formatter.
`failure-diagnostic.test.ts` covers null, primitives, circular objects,
throwing message getters, and revoked proxies.
