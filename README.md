# OMDAN Platform Rebuild — Firebase First

This package is a concrete rebuild starter based on the uploaded `appraiser-Pro` system.

## What is included
- Target platform architecture for **OMDAN Core + Property + Leak + Insurance**
- Firebase-first deployment model, including **Hosting, Auth, Firestore, Storage, Functions**
- Firestore collections blueprint
- Security rules starter
- Indexes starter
- Core case engine starter code
- Module-specific processors for Property / Leak / Insurance
- Multi-app web shell starter structure

## Platform principles locked in
1. Each OMDAN product stands on its own.
2. A customer can subscribe to one module or multiple modules.
3. Shared core exists only for auth, billing, memberships, access, and platform-level orchestration.
4. Business data stays module-specific.
5. Hosting is on Firebase.

## Current-system findings that drive the rebuild
From the uploaded project:
- UI, auth, Firestore access, billing, and business logic are mixed directly into HTML pages.
- There is no normalized **Case Engine**.
- Module boundaries are not explicit.
- Hosting config is incomplete for a multi-product platform.
- Firebase is present, but the project still behaves like a page-driven app rather than a platform.

## Recommended rollout
1. Create the shared Core collections and rules.
2. Deploy the new Functions skeleton.
3. Create Firebase Hosting sites for:
   - omdan-core
   - omdan-property
   - omdan-leak
   - omdan-insurance
4. Move legacy UI into module apps gradually.
5. Migrate existing appraisal cases into `propertyCases`.

## Suggested Firebase Hosting sites
Use one Firebase project with multiple Hosting sites or separate projects if billing/legal separation is required later.

Recommended site IDs:
- omdan-core
- omdan-property
- omdan-leak
- omdan-insurance

## Immediate implementation priority
- Property first (existing uploaded system)
- Leak second
- Insurance third
