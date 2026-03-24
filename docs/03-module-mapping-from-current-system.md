# Mapping from Uploaded System to New Platform

## Uploaded system assets that should be preserved

### Preserve
- visual language from `index.html`, `form.html`, `pricing.html`, `register.html`
- existing Cardcom subscription direction from `functions/index.js`
- legal folder structure
- app assets and logo
- BOQ / appraisal semantics already embedded in `form.html`

### Replace / rebuild
- direct Firestore writes from HTML pages
- duplicated Firebase initialization across pages
- page-level business logic mixed with UI
- current single-system subscription assumptions
- generic settings pages without organization/module abstraction

## Property module — migration target
Current pages:
- `index.html` → becomes `apps/property/index.html`
- `form.html` → becomes `apps/property/case.html`
- `tax-form.html` → becomes either a Property sub-flow or future Tax module
- `account-billing.html`, `pricing.html`, `register.html`, `settings.html` → move under Core

## Leak module — new build target
To be built as an independent product using shared core.

## Insurance module — new build target
Business assumptions already agreed in chat:
- independent product
- agency-oriented
- up to 50 clients can be free for acquisition
- thereafter tiered pricing
- broad insurance category support, not only motor
