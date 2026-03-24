# Firestore Blueprint

## Core collections

### `/users/{uid}`
Platform user profile.

Suggested fields:
- displayName
- email
- phone
- city
- photoURL
- status
- createdAt
- updatedAt
- defaultOrgId

### `/organizations/{orgId}`
A business account, office, agency, or independent professional workspace.

Suggested fields:
- name
- type (`independent_appraiser` | `leak_company` | `insurance_agency` | `office`)
- ownerUid
- activeModules: `{ property: true, leak: true, insurance: false }`
- status
- createdAt
- updatedAt

### `/organizations/{orgId}/members/{uid}`
Membership + role.

Suggested fields:
- uid
- role (`owner` | `manager` | `staff` | `viewer`)
- modules: `{ property: 'full', leak: 'full', insurance: 'none' }`
- joinedAt
- status

### `/subscriptions/{subscriptionId}`
Module-level subscription record.

Suggested fields:
- orgId
- moduleKey (`property` | `leak` | `insurance`)
- planKey
- billingCycle (`monthly` | `annual`)
- status
- provider (`cardcom`)
- currentPeriodStart
- currentPeriodEnd
- seats
- customerVolumeLimit
- createdAt
- updatedAt

### `/moduleAccess/{orgId_moduleKey}`
Fast-read access cache.

Suggested fields:
- orgId
- moduleKey
- enabled
- planKey
- expiresAt
- limits
- updatedAt

### `/cases/{caseId}`
Shared case envelope for all products.

Suggested fields:
- orgId
- moduleKey
- caseType
- title
- status (`draft` | `intake` | `processing` | `review` | `completed` | `archived`)
- stateVersion
- createdBy
- assignedTo
- createdAt
- updatedAt
- lastProcessedAt
- summary
- classification
- refs: `{ moduleDocPath, reportDocPath }`

### `/caseEvents/{eventId}`
Audit trail.

Suggested fields:
- caseId
- orgId
- moduleKey
- action
- actorUid
- payload
- createdAt

## Module-specific collections

### Property
- `/propertyCases/{caseId}`
- `/propertyCases/{caseId}/items/{itemId}`
- `/propertyCases/{caseId}/photos/{photoId}`
- `/propertyReports/{caseId}`

### Leak
- `/leakCases/{caseId}`
- `/leakCases/{caseId}/areas/{areaId}`
- `/leakCases/{caseId}/photos/{photoId}`
- `/leakReports/{caseId}`

### Insurance
- `/insuranceClients/{clientId}`
- `/insurancePolicies/{policyId}`
- `/insuranceTasks/{taskId}`
- `/insuranceRenewals/{renewalId}`

## Storage paths

- `organizations/{orgId}/cases/{caseId}/raw/*`
- `organizations/{orgId}/cases/{caseId}/reports/*`
- `organizations/{orgId}/insurance/clients/{clientId}/*`
