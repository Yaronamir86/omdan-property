# Target Architecture

## Platform shape

```text
OMDAN Platform
├── Core
│   ├── Auth
│   ├── Organizations / memberships
│   ├── Billing / subscriptions
│   ├── Module access
│   ├── Audit / notifications
│   └── Case orchestration
├── OMDAN Property
│   ├── appraisal cases
│   ├── insured events
│   ├── assets / BOQ / depreciation
│   └── reports
├── OMDAN Leak
│   ├── leak inspections
│   ├── photo findings
│   ├── moisture measurements
│   └── leak reports
└── OMDAN Insurance
    ├── agencies
    ├── clients
    ├── policies
    ├── renewals
    └── sales / service workflows
```

## Runtime flow

```text
UI → createCase() → validateCase() → classifyCase() → routeToModule() →
module processor → generate summary/report payload → persist → return case state
```

## Why this is different from the uploaded system

### Current uploaded system
- page-centric
- local logic mixed into HTML
- Firestore writes directly from UI
- business flow is implicit
- module boundaries are weak

### Rebuilt system
- case-centric
- module processors
- shared core services
- explicit state transitions
- multi-product subscription model
- Firebase Hosting for each product

## Product independence model
Each product remains independent:
- distinct navigation
- distinct data collections
- distinct reports
- distinct access grants
- can be sold separately

Shared only where justified:
- auth
- organization membership
- billing
- module access
- cross-module referrals
