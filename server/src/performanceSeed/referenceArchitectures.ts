// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

export interface ReferenceContainerRole {
  name: string
  type: 'app' | 'store'
  technologies: readonly string[]
  responsibility: string
}

export interface ReferenceArchitecture {
  key: string
  name: string
  description: string
  actors: readonly string[]
  capabilities: readonly string[]
  containers: readonly ReferenceContainerRole[]
  componentRoles: readonly string[]
  documentationUrl: string
}

/**
 * Real-world reference architectures, not claims about one company's private
 * implementation. They encode established production patterns (edge/API,
 * command/query services, event processing, durable stores, cache and object
 * storage) with domain-specific names and documented technology families.
 */
export const REFERENCE_ARCHITECTURES: readonly ReferenceArchitecture[] = [
  {
    key: 'commerce',
    name: 'Global Commerce Platform',
    description: 'Multi-region catalog, cart, checkout, order and fulfilment platform.',
    actors: ['Shopper', 'Merchant operator', 'Customer support agent'],
    capabilities: ['Catalog', 'Pricing', 'Cart', 'Checkout', 'Orders', 'Fulfilment', 'Returns', 'Customer identity'],
    containers: [
      { name: 'Experience API', type: 'app', technologies: ['Node.js', 'GraphQL'], responsibility: 'aggregates channel-specific reads' },
      { name: 'Command Service', type: 'app', technologies: ['Java', 'REST'], responsibility: 'validates and executes business commands' },
      { name: 'Workflow Processor', type: 'app', technologies: ['Go', 'Kafka'], responsibility: 'coordinates long-running business workflows' },
      { name: 'Read Model Builder', type: 'app', technologies: ['Kotlin', 'Kafka'], responsibility: 'projects query-optimized views' },
      { name: 'Operational Database', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores transactional state' },
      { name: 'Low-latency Cache', type: 'store', technologies: ['Redis'], responsibility: 'serves hot sessions and lookups' },
      { name: 'Domain Event Stream', type: 'store', technologies: ['Kafka'], responsibility: 'retains ordered domain events' },
      { name: 'Document Archive', type: 'store', technologies: ['S3'], responsibility: 'stores invoices and immutable exports' },
    ],
    componentRoles: ['API handler', 'Authorization policy', 'Domain aggregate', 'Idempotency guard', 'Outbox publisher', 'Telemetry adapter'],
    documentationUrl: 'https://martinfowler.com/articles/patterns-of-distributed-systems/',
  },
  {
    key: 'banking',
    name: 'Digital Banking Platform',
    description: 'Regulated retail banking platform with ledger, payments and fraud controls.',
    actors: ['Account holder', 'Bank operations analyst', 'Compliance officer'],
    capabilities: ['Accounts', 'Ledger', 'Payments', 'Cards', 'Beneficiaries', 'Statements', 'Fraud detection', 'Regulatory reporting'],
    containers: [
      { name: 'Banking API Gateway', type: 'app', technologies: ['Kotlin', 'REST'], responsibility: 'enforces channel and consent policies' },
      { name: 'Transaction Service', type: 'app', technologies: ['Java', 'gRPC'], responsibility: 'executes strongly validated transactions' },
      { name: 'Risk Decision Engine', type: 'app', technologies: ['Python', 'Kafka'], responsibility: 'scores transactions in real time' },
      { name: 'Reconciliation Worker', type: 'app', technologies: ['Go', 'Kafka'], responsibility: 'reconciles internal and external balances' },
      { name: 'Double-entry Ledger', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores balanced immutable postings' },
      { name: 'Reference Data Cache', type: 'store', technologies: ['Redis'], responsibility: 'serves limits, rates and reference data' },
      { name: 'Transaction Event Stream', type: 'store', technologies: ['Kafka'], responsibility: 'distributes auditable transaction events' },
      { name: 'Regulatory Archive', type: 'store', technologies: ['S3'], responsibility: 'retains evidence and reports' },
    ],
    componentRoles: ['Consent validator', 'Posting engine', 'Limit policy', 'Sanctions adapter', 'Reconciliation rule', 'Audit emitter'],
    documentationUrl: 'https://www.postgresql.org/docs/current/transaction-iso.html',
  },
  {
    key: 'payments',
    name: 'Payment Processing Network',
    description: 'Authorization, capture, settlement, disputes and merchant reporting.',
    actors: ['Cardholder', 'Merchant', 'Payment operations specialist'],
    capabilities: ['Authorization', 'Capture', 'Settlement', 'Tokenization', 'Disputes', 'Merchant onboarding', 'Payouts', 'Reporting'],
    containers: [
      { name: 'Payments Edge', type: 'app', technologies: ['Go', 'REST'], responsibility: 'terminates merchant requests securely' },
      { name: 'Payment State Machine', type: 'app', technologies: ['Java', 'gRPC'], responsibility: 'applies payment lifecycle transitions' },
      { name: 'Network Connector', type: 'app', technologies: ['Rust', 'gRPC'], responsibility: 'connects to external payment rails' },
      { name: 'Settlement Projector', type: 'app', technologies: ['Scala', 'Kafka'], responsibility: 'builds settlement and payout views' },
      { name: 'Payment Ledger', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores payment and balance state' },
      { name: 'Token Vault Cache', type: 'store', technologies: ['Redis'], responsibility: 'serves short-lived token references' },
      { name: 'Payment Events', type: 'store', technologies: ['Kafka'], responsibility: 'streams lifecycle events' },
      { name: 'Evidence Store', type: 'store', technologies: ['S3'], responsibility: 'stores dispute and compliance evidence' },
    ],
    componentRoles: ['Request signer', 'Idempotency engine', 'Routing policy', 'Ledger poster', 'Network adapter', 'Webhook dispatcher'],
    documentationUrl: 'https://www.pcisecuritystandards.org/document_library/',
  },
  {
    key: 'streaming',
    name: 'Media Streaming Platform',
    description: 'Global media ingest, catalog, personalization, playback and telemetry.',
    actors: ['Subscriber', 'Content editor', 'Partner device'],
    capabilities: ['Content ingest', 'Catalog', 'Entitlements', 'Playback', 'Search', 'Recommendations', 'Advertising', 'Telemetry'],
    containers: [
      { name: 'Playback Gateway', type: 'app', technologies: ['Java', 'gRPC'], responsibility: 'authorizes and starts playback sessions' },
      { name: 'Catalog Service', type: 'app', technologies: ['Node.js', 'GraphQL'], responsibility: 'serves localized media metadata' },
      { name: 'Recommendation Pipeline', type: 'app', technologies: ['Python', 'Spark'], responsibility: 'produces ranked recommendations' },
      { name: 'Telemetry Processor', type: 'app', technologies: ['Flink', 'Kafka'], responsibility: 'processes playback telemetry' },
      { name: 'Metadata Database', type: 'store', technologies: ['Cassandra'], responsibility: 'stores distributed catalog metadata' },
      { name: 'Session Cache', type: 'store', technologies: ['Redis'], responsibility: 'stores active playback sessions' },
      { name: 'Playback Events', type: 'store', technologies: ['Kafka'], responsibility: 'streams playback and quality events' },
      { name: 'Media Object Store', type: 'store', technologies: ['S3'], responsibility: 'stores encoded media assets' },
    ],
    componentRoles: ['Entitlement evaluator', 'Manifest builder', 'Device policy', 'Ranking model adapter', 'Quality monitor', 'CDN selector'],
    documentationUrl: 'https://kafka.apache.org/documentation/',
  },
  {
    key: 'mobility',
    name: 'Mobility Marketplace',
    description: 'Real-time marketplace for riders, drivers, dispatch, pricing and safety.',
    actors: ['Rider', 'Driver', 'Safety operator'],
    capabilities: ['Trip request', 'Dispatch', 'Dynamic pricing', 'Routing', 'Driver supply', 'Payments', 'Safety', 'Support'],
    containers: [
      { name: 'Marketplace Gateway', type: 'app', technologies: ['Go', 'gRPC'], responsibility: 'handles location-aware marketplace requests' },
      { name: 'Dispatch Engine', type: 'app', technologies: ['Go', 'Redis'], responsibility: 'matches supply and demand' },
      { name: 'Trip Workflow', type: 'app', technologies: ['Java', 'Kafka'], responsibility: 'coordinates trip lifecycle state' },
      { name: 'Pricing Projector', type: 'app', technologies: ['Python', 'Flink'], responsibility: 'computes real-time marketplace signals' },
      { name: 'Trip Database', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores durable trip state' },
      { name: 'Geospatial Index', type: 'store', technologies: ['Redis'], responsibility: 'indexes active vehicles by location' },
      { name: 'Mobility Event Stream', type: 'store', technologies: ['Kafka'], responsibility: 'distributes trip and location events' },
      { name: 'Safety Evidence Store', type: 'store', technologies: ['S3'], responsibility: 'stores incident evidence' },
    ],
    componentRoles: ['Location validator', 'Matcher', 'Surge policy', 'ETA estimator', 'Trip aggregate', 'Safety rule'],
    documentationUrl: 'https://redis.io/docs/latest/develop/data-types/geospatial/',
  },
  {
    key: 'logistics',
    name: 'Logistics and Fulfilment Network',
    description: 'Warehouse, inventory, routing, carrier and last-mile operations.',
    actors: ['Warehouse associate', 'Delivery driver', 'Logistics planner'],
    capabilities: ['Inventory', 'Warehousing', 'Allocation', 'Routing', 'Carrier integration', 'Tracking', 'Returns', 'Capacity planning'],
    containers: [
      { name: 'Operations API', type: 'app', technologies: ['.NET', 'REST'], responsibility: 'serves warehouse and delivery workflows' },
      { name: 'Allocation Service', type: 'app', technologies: ['Java', 'gRPC'], responsibility: 'allocates inventory to orders' },
      { name: 'Route Optimizer', type: 'app', technologies: ['Python', 'Kafka'], responsibility: 'optimizes fulfilment routes' },
      { name: 'Tracking Projector', type: 'app', technologies: ['Go', 'Kafka'], responsibility: 'projects shipment milestones' },
      { name: 'Inventory Database', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores stock and reservations' },
      { name: 'Availability Cache', type: 'store', technologies: ['Redis'], responsibility: 'serves low-latency availability' },
      { name: 'Logistics Events', type: 'store', technologies: ['Kafka'], responsibility: 'streams inventory and shipment events' },
      { name: 'Shipping Documents', type: 'store', technologies: ['S3'], responsibility: 'stores labels and customs documents' },
    ],
    componentRoles: ['Reservation policy', 'Allocation solver', 'Carrier adapter', 'Milestone projector', 'Capacity rule', 'Label generator'],
    documentationUrl: 'https://microservices.io/patterns/data/saga.html',
  },
  {
    key: 'health',
    name: 'Digital Health Platform',
    description: 'Patient access, clinical workflows, scheduling and interoperability.',
    actors: ['Patient', 'Clinician', 'Care coordinator'],
    capabilities: ['Patient identity', 'Appointments', 'Clinical records', 'Orders', 'Results', 'Care plans', 'Messaging', 'Interoperability'],
    containers: [
      { name: 'Clinical API', type: 'app', technologies: ['C#', '.NET'], responsibility: 'serves governed clinical workflows' },
      { name: 'FHIR Adapter', type: 'app', technologies: ['Java', 'REST'], responsibility: 'exchanges interoperable health resources' },
      { name: 'Care Workflow', type: 'app', technologies: ['Kotlin', 'Kafka'], responsibility: 'coordinates longitudinal care activities' },
      { name: 'Notification Processor', type: 'app', technologies: ['Node.js', 'Kafka'], responsibility: 'delivers consent-aware notifications' },
      { name: 'Clinical Database', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores clinical and scheduling state' },
      { name: 'Consent Cache', type: 'store', technologies: ['Redis'], responsibility: 'serves current consent decisions' },
      { name: 'Clinical Event Stream', type: 'store', technologies: ['Kafka'], responsibility: 'distributes clinical workflow events' },
      { name: 'Imaging Archive', type: 'store', technologies: ['S3'], responsibility: 'stores large diagnostic assets' },
    ],
    componentRoles: ['Consent evaluator', 'FHIR mapper', 'Clinical validator', 'Care plan engine', 'Audit logger', 'Notification policy'],
    documentationUrl: 'https://www.hl7.org/fhir/',
  },
  {
    key: 'identity',
    name: 'Identity and Access Platform',
    description: 'Authentication, authorization, federation, directory and audit services.',
    actors: ['End user', 'Tenant administrator', 'Security analyst'],
    capabilities: ['Authentication', 'Authorization', 'Federation', 'Directory', 'Lifecycle', 'Secrets', 'Risk signals', 'Audit'],
    containers: [
      { name: 'Identity Edge', type: 'app', technologies: ['Go', 'REST'], responsibility: 'terminates authentication protocols' },
      { name: 'Token Service', type: 'app', technologies: ['Rust', 'gRPC'], responsibility: 'issues and validates signed tokens' },
      { name: 'Policy Decision Point', type: 'app', technologies: ['Java', 'gRPC'], responsibility: 'evaluates authorization policies' },
      { name: 'Audit Processor', type: 'app', technologies: ['Flink', 'Kafka'], responsibility: 'detects anomalous access patterns' },
      { name: 'Identity Directory', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores identities and credentials metadata' },
      { name: 'Session Store', type: 'store', technologies: ['Redis'], responsibility: 'stores revocable sessions' },
      { name: 'Security Event Stream', type: 'store', technologies: ['Kafka'], responsibility: 'distributes identity security events' },
      { name: 'Audit Archive', type: 'store', technologies: ['S3'], responsibility: 'retains immutable audit evidence' },
    ],
    componentRoles: ['Protocol handler', 'Credential verifier', 'Token signer', 'Policy evaluator', 'Risk adapter', 'Audit publisher'],
    documentationUrl: 'https://openid.net/specs/openid-connect-core-1_0.html',
  },
  {
    key: 'iot',
    name: 'Industrial IoT Platform',
    description: 'Device onboarding, telemetry, command, digital twin and analytics platform.',
    actors: ['Plant operator', 'Field engineer', 'Data scientist'],
    capabilities: ['Device registry', 'Telemetry ingest', 'Command and control', 'Digital twins', 'Rules', 'Alerts', 'Analytics', 'Firmware'],
    containers: [
      { name: 'Device Gateway', type: 'app', technologies: ['Rust', 'gRPC'], responsibility: 'authenticates and terminates device traffic' },
      { name: 'Twin Service', type: 'app', technologies: ['Go', 'REST'], responsibility: 'maintains current device state' },
      { name: 'Rules Processor', type: 'app', technologies: ['Flink', 'Kafka'], responsibility: 'evaluates streaming telemetry rules' },
      { name: 'Telemetry Projector', type: 'app', technologies: ['Scala', 'Kafka'], responsibility: 'builds operational telemetry views' },
      { name: 'Device Registry', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores device identity and configuration' },
      { name: 'Twin Cache', type: 'store', technologies: ['Redis'], responsibility: 'serves current twin state' },
      { name: 'Telemetry Stream', type: 'store', technologies: ['Kafka'], responsibility: 'retains ordered telemetry' },
      { name: 'Telemetry Lake', type: 'store', technologies: ['S3'], responsibility: 'stores analytical telemetry history' },
    ],
    componentRoles: ['Device authenticator', 'Schema decoder', 'Twin reducer', 'Rule evaluator', 'Command dispatcher', 'Telemetry exporter'],
    documentationUrl: 'https://kafka.apache.org/documentation/streams/',
  },
  {
    key: 'platform',
    name: 'Internal Developer Platform',
    description: 'Self-service delivery, runtime, observability and governance platform.',
    actors: ['Application developer', 'Platform engineer', 'Security engineer'],
    capabilities: ['Service catalog', 'Continuous delivery', 'Runtime', 'Configuration', 'Secrets', 'Observability', 'Cost management', 'Governance'],
    containers: [
      { name: 'Platform API', type: 'app', technologies: ['Go', 'REST'], responsibility: 'exposes self-service platform capabilities' },
      { name: 'Deployment Controller', type: 'app', technologies: ['Go', 'Docker'], responsibility: 'reconciles desired deployment state' },
      { name: 'Policy Controller', type: 'app', technologies: ['Rust', 'gRPC'], responsibility: 'enforces supply-chain and runtime policy' },
      { name: 'Telemetry Pipeline', type: 'app', technologies: ['Flink', 'Kafka'], responsibility: 'normalizes platform telemetry' },
      { name: 'Service Catalog Database', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores ownership and service metadata' },
      { name: 'Build Cache', type: 'store', technologies: ['Redis'], responsibility: 'accelerates builds and deployments' },
      { name: 'Platform Event Stream', type: 'store', technologies: ['Kafka'], responsibility: 'distributes delivery and runtime events' },
      { name: 'Artifact Store', type: 'store', technologies: ['S3'], responsibility: 'stores build artifacts and attestations' },
    ],
    componentRoles: ['Template renderer', 'Deployment reconciler', 'Policy evaluator', 'Secret broker', 'Telemetry collector', 'Cost allocator'],
    documentationUrl: 'https://kubernetes.io/docs/concepts/architecture/',
  },
  {
    key: 'travel',
    name: 'Travel Booking Platform',
    description: 'Search, availability, booking, ticketing and disruption management.',
    actors: ['Traveller', 'Travel agent', 'Operations controller'],
    capabilities: ['Search', 'Availability', 'Offers', 'Booking', 'Ticketing', 'Payments', 'Disruptions', 'Loyalty'],
    containers: [
      { name: 'Travel Experience API', type: 'app', technologies: ['Node.js', 'GraphQL'], responsibility: 'aggregates itinerary and offer views' },
      { name: 'Booking Service', type: 'app', technologies: ['Java', 'gRPC'], responsibility: 'manages booking lifecycle' },
      { name: 'Offer Engine', type: 'app', technologies: ['Kotlin', 'Kafka'], responsibility: 'prices and ranks travel offers' },
      { name: 'Disruption Processor', type: 'app', technologies: ['Go', 'Kafka'], responsibility: 'reacts to operational changes' },
      { name: 'Reservation Database', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores bookings and tickets' },
      { name: 'Availability Cache', type: 'store', technologies: ['Redis'], responsibility: 'serves hot availability' },
      { name: 'Travel Event Stream', type: 'store', technologies: ['Kafka'], responsibility: 'distributes itinerary events' },
      { name: 'Ticket Archive', type: 'store', technologies: ['S3'], responsibility: 'stores tickets and travel documents' },
    ],
    componentRoles: ['Search adapter', 'Offer composer', 'Booking aggregate', 'Ticket issuer', 'Disruption rule', 'Supplier connector'],
    documentationUrl: 'https://microservices.io/patterns/data/event-sourcing.html',
  },
  {
    key: 'saas',
    name: 'Multi-tenant SaaS Platform',
    description: 'Tenant lifecycle, subscription, workflow, reporting and integrations.',
    actors: ['Tenant user', 'Tenant administrator', 'Support engineer'],
    capabilities: ['Tenant management', 'Subscriptions', 'Workflow', 'Documents', 'Reporting', 'Integrations', 'Notifications', 'Audit'],
    containers: [
      { name: 'Tenant API', type: 'app', technologies: ['TypeScript', 'NestJS'], responsibility: 'serves tenant-scoped APIs' },
      { name: 'Workflow Service', type: 'app', technologies: ['Java', 'Kafka'], responsibility: 'executes configurable workflows' },
      { name: 'Integration Hub', type: 'app', technologies: ['Go', 'REST'], responsibility: 'connects external business systems' },
      { name: 'Reporting Projector', type: 'app', technologies: ['Python', 'Kafka'], responsibility: 'builds tenant reporting models' },
      { name: 'Tenant Database', type: 'store', technologies: ['PostgreSQL'], responsibility: 'stores tenant-isolated operational data' },
      { name: 'Tenant Cache', type: 'store', technologies: ['Redis'], responsibility: 'serves tenant sessions and configuration' },
      { name: 'SaaS Event Stream', type: 'store', technologies: ['Kafka'], responsibility: 'distributes tenant domain events' },
      { name: 'Document Store', type: 'store', technologies: ['S3'], responsibility: 'stores tenant documents and exports' },
    ],
    componentRoles: ['Tenant resolver', 'Entitlement policy', 'Workflow activity', 'Integration adapter', 'Report builder', 'Audit emitter'],
    documentationUrl: 'https://learn.microsoft.com/azure/architecture/guide/multitenant/overview',
  },
] as const
