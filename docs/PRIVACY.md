# Pinchy — Privacy & Data Protection Documentation

**Effective Date:** February 2025
**Last Updated:** February 2026
**Provider:** Helmcraft GmbH, Vienna, Austria
**Contact:** hey@clemenshelm.com

---

## 1. Overview

Pinchy is a **self-hosted** AI agent platform. All data processing occurs entirely on infrastructure owned and operated by the customer. Helmcraft GmbH provides the software; the customer is the **data controller** for all personal data processed through their Pinchy instance.

Pinchy does **not** collect telemetry, does **not** phone home, and does **not** transmit any data to Helmcraft GmbH or any third party. The only external data transmission occurs when the customer explicitly configures an LLM provider (e.g., OpenAI, Anthropic) — in which case chat messages are sent to that provider as directed by the customer.

---

## 2. Data Categories

### 2.1 User Account Data

| Data Field | Purpose | Storage |
|---|---|---|
| Email address | Authentication, user identification | PostgreSQL (customer's server) |
| Hashed password | Authentication | PostgreSQL (bcrypt hash) |
| Display name | UI display | PostgreSQL |
| Role (admin/user) | Authorization | PostgreSQL |

### 2.2 Chat & Session Data

| Data Field | Purpose | Storage |
|---|---|---|
| Chat messages (user input) | AI agent interaction | PostgreSQL |
| AI agent responses | Conversation history | PostgreSQL |
| Session metadata | Conversation grouping | PostgreSQL |

### 2.3 Agent Configuration Data

| Data Field | Purpose | Storage |
|---|---|---|
| Agent names & settings | Agent management | PostgreSQL |
| System prompts | Agent behavior configuration | PostgreSQL |
| LLM provider API keys | External LLM access | PostgreSQL (AES-256-GCM encrypted) |

### 2.4 File Access Data

| Data Field | Purpose | Storage |
|---|---|---|
| Configured mount points | File plugin configuration | PostgreSQL |
| File paths accessed | Agent file reading | Processed in memory; not persisted beyond session |

---

## 3. Data Storage & Location

All data is stored in a **PostgreSQL database** running on the customer's own infrastructure. Pinchy runs as a set of Docker containers (web application, database, OpenClaw gateway) on a single host controlled by the customer.

- **No cloud dependency** — Pinchy does not require any cloud service to function.
- **No data replication** — Data is not replicated to external systems.
- **Customer controls location** — The customer determines the physical and jurisdictional location of their server.

---

## 4. Third-Party Data Sharing

### 4.1 LLM Providers

When a user interacts with an AI agent, the **chat message content** is sent to the LLM provider configured by the customer (e.g., OpenAI, Anthropic, a self-hosted model). This is the **only external data transmission** initiated by Pinchy.

- The customer chooses the LLM provider.
- The customer provides their own API keys.
- The customer is responsible for reviewing the LLM provider's data processing terms.
- API keys are stored encrypted with AES-256-GCM.

### 4.2 No Other Third-Party Sharing

Pinchy does **not**:
- Send analytics or telemetry to Helmcraft GmbH or any third party
- Include tracking pixels, advertising SDKs, or similar technologies
- Make any network requests other than to the customer-configured LLM provider
- Phone home for license checks, update notifications, or usage reporting

---

## 5. Data Retention

Since Pinchy is self-hosted, data retention is **entirely under the customer's control**.

- **Chat messages** remain in the database until the customer deletes them.
- **User accounts** remain until deleted by an administrator.
- **Agent configurations** remain until deleted by an administrator.
- **Database backups** are the customer's responsibility and follow the customer's backup policies.

**Recommendation:** Customers should establish their own data retention policy consistent with applicable data protection laws and their organizational requirements.

---

## 6. Data Subject Rights (GDPR Art. 15–22)

As the data controller, the customer is responsible for fulfilling data subject requests. Pinchy supports the following rights through its administrative features:

| Right | How to Fulfill |
|---|---|
| **Access** (Art. 15) | Export user data from the PostgreSQL database |
| **Rectification** (Art. 16) | Update user profile via admin interface |
| **Erasure** (Art. 17) | Delete user account and associated data via admin interface or database |
| **Restriction** (Art. 18) | Disable user account |
| **Data Portability** (Art. 20) | Export data from PostgreSQL in standard format |
| **Objection** (Art. 21) | Delete user account or cease processing |

---

## 7. Security Measures

See [SECURITY-POLICY.md](SECURITY-POLICY.md) for detailed technical and organizational security measures. Key highlights:

- **Encryption at rest:** API keys encrypted with AES-256-GCM
- **Password hashing:** bcrypt
- **Authentication:** Auth.js v5 with JWT sessions
- **Role-based access:** Admin and user roles
- **Network isolation:** All services communicate on localhost; no inbound connections required
- **File access controls:** Mount point validation with directory traversal prevention

---

## 8. Legal Basis for Processing (GDPR Art. 6)

The legal basis for processing depends on the customer's use case. Common bases include:

- **Art. 6(1)(b)** — Performance of a contract (e.g., providing AI agent services to employees)
- **Art. 6(1)(f)** — Legitimate interests (e.g., internal business operations)
- **Art. 6(1)(a)** — Consent (where applicable)

The customer, as data controller, is responsible for determining and documenting the applicable legal basis.

---

## 9. International Data Transfers

Pinchy itself does not transfer data internationally. However, if the customer configures an LLM provider whose servers are located outside the EU/EEA, the customer is responsible for ensuring appropriate safeguards (e.g., Standard Contractual Clauses) are in place with that provider.

---

## 10. Contact

For questions about Pinchy's data handling:

**Helmcraft GmbH**
Vienna, Austria
Email: hey@clemenshelm.com
Web: https://heypinchy.com

---

*This document describes the data processing characteristics of the Pinchy software. As Pinchy is self-hosted, the customer (data controller) is responsible for their own privacy policy toward their end users.*
