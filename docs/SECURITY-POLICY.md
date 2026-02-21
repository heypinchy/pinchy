# Pinchy — Security Policy

**Version:** 1.0
**Last Updated:** February 2026
**Provider:** Helmcraft GmbH, Vienna, Austria

---

## 1. Introduction

This document describes the security architecture, controls, and practices of the Pinchy AI agent platform. Pinchy is a **self-hosted** application — customers deploy and operate it on their own infrastructure. This policy covers security measures implemented in the software itself. Infrastructure-level security (server hardening, OS patching, network configuration, physical security) is the customer's responsibility.

---

## 2. Architecture Overview

Pinchy runs as a Docker Compose stack with three services on a single host:

| Service | Purpose | Communication |
|---|---|---|
| **Pinchy Web** | Next.js application (UI + API) | Serves HTTP/WebSocket to users |
| **PostgreSQL** | Data storage | Localhost only |
| **OpenClaw Gateway** | AI agent runtime | Localhost WebSocket bridge |

All inter-service communication occurs over **localhost**. No service is required to be exposed to the public internet except the Pinchy Web application (via reverse proxy configured by the customer).

---

## 3. Authentication

### 3.1 Authentication Provider

Pinchy uses **Auth.js v5** (NextAuth) with the **Credentials Provider** for password-based authentication.

### 3.2 Password Storage

Passwords are hashed using **bcrypt** before storage. Bcrypt is an adaptive hashing algorithm that incorporates a salt and a configurable work factor, providing resistance against brute-force and rainbow table attacks. Plain-text passwords are never stored.

### 3.3 Session Management

- Sessions are managed via **JSON Web Tokens (JWT)**
- JWTs are signed and validated server-side
- Session tokens are transmitted via secure cookies

### 3.4 User Provisioning

- New users are created through an **invite system** by administrators
- Self-registration is not available
- Only administrators can create, modify, or delete user accounts

---

## 4. Authorization

### 4.1 Role-Based Access Control

Pinchy implements two roles:

| Role | Capabilities |
|---|---|
| **Admin** | Full access: user management, agent management, system configuration, all chat functions |
| **User** | Chat with agents, view own sessions |

### 4.2 Current Limitations

- No granular permissions beyond the admin/user distinction
- No attribute-based access control (ABAC)
- No OAuth2/OIDC or SAML integration

---

## 5. Encryption

### 5.1 Encryption at Rest

| Data | Method |
|---|---|
| LLM provider API keys | **AES-256-GCM** — authenticated encryption with associated data. Keys are encrypted before database storage and decrypted only when needed for LLM API calls. |
| User passwords | **bcrypt** hash (one-way; not reversible) |
| Other database contents | Stored in PostgreSQL on local disk. Disk-level encryption (e.g., LUKS, FileVault) is the customer's responsibility. |

### 5.2 Encryption in Transit

| Path | Method |
|---|---|
| User → Pinchy Web | **HTTPS/WSS** — configurable by the customer via reverse proxy (e.g., nginx, Caddy, Traefik) |
| Pinchy Web → PostgreSQL | Localhost (no network transit) |
| Pinchy Web → OpenClaw Gateway | Localhost WebSocket (no network transit) |
| Pinchy Web → LLM Provider | **HTTPS** — standard TLS to the provider's API endpoint |

### 5.3 Key Management

- AES-256-GCM encryption keys are derived from environment configuration
- Customers are responsible for securing environment variables and Docker secrets

---

## 6. Data Isolation

### 6.1 Self-Hosted Architecture

Pinchy's self-hosted design provides inherent data isolation:

- **No multi-tenancy risk** — each customer runs their own isolated instance
- **No shared infrastructure** — no shared databases, no shared compute
- **No data commingling** — each instance contains only that customer's data

### 6.2 No External Data Collection

Pinchy does **not**:
- Collect telemetry or usage analytics
- Phone home to Helmcraft GmbH
- Include third-party tracking or advertising code
- Make any network requests except to the customer-configured LLM provider

### 6.3 LLM Provider Communication

The only external network communication is to the LLM provider configured by the customer:

- Chat message content is sent to the LLM API for processing
- The customer selects the provider and provides API credentials
- Customers can use self-hosted LLM providers (e.g., Ollama, vLLM) to eliminate all external data transmission

---

## 7. File Access Controls

### 7.1 Pinchy Files Plugin

The Files Plugin allows AI agents to read files from the host filesystem within defined boundaries:

- **Mount point configuration:** Administrators define specific directories that agents can access
- **Path validation:** All file paths are validated to ensure they resolve within configured mount points
- **Directory traversal prevention:** Path components like `..` are detected and rejected to prevent escaping the configured boundaries
- **Read-only access:** The Files Plugin provides read access only

### 7.2 Recommendations

- Configure mount points with the principle of least privilege
- Avoid mounting sensitive directories (e.g., `/etc`, home directories, credential stores)
- Review mount point configurations regularly

---

## 8. Network Security

### 8.1 Default Configuration

- PostgreSQL and OpenClaw Gateway bind to **localhost only** — not exposed to the network
- Only the Pinchy Web service needs to be accessible to users
- No inbound connections are required from Helmcraft GmbH or any external service

### 8.2 Customer Responsibilities

- Deploy a reverse proxy (nginx, Caddy, Traefik) with TLS termination
- Configure firewall rules appropriate to the deployment environment
- Keep the host operating system and Docker runtime updated

---

## 9. Dependency Management

- Pinchy is built with **Next.js** and uses **npm** for dependency management
- Dependencies are version-locked via lockfile
- Docker images are built from defined base images
- Customers receive updates through new releases of the Docker images

---

## 10. Incident Response

### 10.1 Vulnerability Reporting

Security vulnerabilities in Pinchy should be reported to:

**Email:** hey@clemenshelm.com
**Subject line:** `[SECURITY] <brief description>`

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Your contact information (for follow-up)

### 10.2 Response Process

| Step | Target Timeline |
|---|---|
| Acknowledgment of report | 48 hours |
| Initial assessment | 5 business days |
| Fix for critical vulnerabilities | As soon as possible |
| Fix for non-critical vulnerabilities | Next scheduled release |
| Disclosure | Coordinated with reporter |

### 10.3 Customer-Side Incidents

Since Pinchy is self-hosted, most security incidents will occur at the infrastructure level. Customers are responsible for:

- Monitoring their Pinchy instance for anomalies
- Maintaining incident response procedures for their infrastructure
- Notifying affected parties in case of a data breach (per GDPR Art. 33/34)

---

## 11. Secure Development Practices

- Source code is maintained in a version-controlled repository
- Changes are reviewed before merging
- The application follows established security patterns from the Next.js and Auth.js ecosystems

---

## 12. Roadmap Items

The following security features are planned but **not yet implemented**:

| Feature | Status |
|---|---|
| Audit logging | Planned |
| SSO (OAuth2/OIDC) | Planned |
| SAML integration | Planned |
| Granular RBAC | Planned |

This document will be updated as these features become available.

---

## 13. Compliance

### 13.1 GDPR

Pinchy's self-hosted architecture supports GDPR compliance by design:

- Data stays on the customer's infrastructure (data sovereignty)
- No data sharing with the software vendor
- Customer has full control over data retention and deletion
- See [PRIVACY.md](PRIVACY.md) and [DPA.md](DPA.md) for details

### 13.2 Customer Compliance Responsibilities

As the data controller and infrastructure operator, the customer is responsible for:

- GDPR compliance for their specific use case
- Data protection impact assessments (DPIA) where required
- Establishing appropriate data retention policies
- Ensuring legal basis for processing
- Securing the deployment infrastructure

---

## 14. Contact

**Helmcraft GmbH**
Vienna, Austria
Email: hey@clemenshelm.com
Web: https://heypinchy.com
GitHub: https://github.com/heypinchy/pinchy

---

*This policy describes security measures implemented in the Pinchy software. It is not a guarantee of security for any specific deployment, as overall security depends on the customer's infrastructure and operational practices.*
