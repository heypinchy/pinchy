# Data Processing Agreement

**pursuant to Art. 28 of the General Data Protection Regulation (GDPR)**

---

Between

**[Customer Name]**
[Customer Address]
(hereinafter "**Controller**")

and

**Helmcraft GmbH**
Vienna, Austria
Represented by: Clemens Helm, Managing Director
Email: hey@clemenshelm.com
(hereinafter "**Processor**")

collectively referred to as the "**Parties**"

**Effective Date:** [Date]

---

## 1. Subject Matter and Duration

### 1.1 Subject Matter

This Data Processing Agreement ("DPA") governs the processing of personal data by the Processor on behalf of the Controller in connection with the provision of the **Pinchy** self-hosted AI agent platform ("Service").

### 1.2 Nature of Processing

The Processor provides the Pinchy software, which the Controller deploys on its own infrastructure. The software processes personal data as described in Annex 1. The Processor does not have access to the Controller's Pinchy instance or the personal data processed therein unless explicitly granted access for support purposes.

### 1.3 Duration

This DPA is effective for the duration of the contractual relationship between the Parties regarding the Service. It terminates automatically upon termination of the underlying agreement.

---

## 2. Controller's Rights and Obligations

2.1 The Controller is responsible for ensuring that the processing of personal data through Pinchy complies with applicable data protection laws, including the GDPR.

2.2 The Controller determines the purposes and means of processing and is the data controller within the meaning of Art. 4(7) GDPR.

2.3 The Controller is responsible for:
- Configuring and operating the Pinchy instance on its own infrastructure
- Establishing and enforcing data retention policies
- Responding to data subject requests
- Selecting and contracting with LLM providers
- Securing the infrastructure on which Pinchy is deployed

---

## 3. Processor's Obligations

### 3.1 Instructions

The Processor shall process personal data only on documented instructions from the Controller (Art. 28(3)(a) GDPR), unless required to do so by Union or Member State law.

### 3.2 Confidentiality

The Processor ensures that persons authorized to process personal data have committed themselves to confidentiality or are under an appropriate statutory obligation of confidentiality (Art. 28(3)(b) GDPR).

### 3.3 Security Measures

The Processor shall implement appropriate technical and organizational measures as described in **Annex 2** to ensure a level of security appropriate to the risk (Art. 28(3)(c), Art. 32 GDPR).

### 3.4 Sub-processors

3.4.1 The Processor shall not engage another processor without prior specific or general written authorization of the Controller (Art. 28(2) GDPR).

3.4.2 As of the effective date of this DPA, the Processor does not use sub-processors for the Pinchy service. Pinchy is self-hosted software; no data is transmitted to Helmcraft GmbH or any sub-processor.

3.4.3 The Controller selects and contracts with LLM providers independently. LLM providers are **not** sub-processors of Helmcraft GmbH; they are separate controllers or processors engaged directly by the Controller.

### 3.5 Data Subject Rights

The Processor shall assist the Controller, insofar as possible, in fulfilling the Controller's obligation to respond to requests for exercising data subject rights (Art. 28(3)(e) GDPR). Given the self-hosted nature of Pinchy, this assistance is primarily provided through software functionality and documentation.

### 3.6 Assistance with Security and DPIA

The Processor shall assist the Controller in ensuring compliance with obligations pursuant to Art. 32–36 GDPR, taking into account the nature of processing and the information available to the Processor (Art. 28(3)(f) GDPR).

### 3.7 Deletion and Return of Data

Upon termination of the Service, the Processor shall, at the choice of the Controller, delete or return all personal data and delete existing copies, unless Union or Member State law requires storage of the personal data (Art. 28(3)(g) GDPR).

Since Pinchy is self-hosted, all data resides on the Controller's infrastructure. The Controller retains full control over data deletion at all times.

### 3.8 Audit Rights

The Processor shall make available to the Controller all information necessary to demonstrate compliance with the obligations laid down in Art. 28 GDPR and allow for and contribute to audits, including inspections, conducted by the Controller or another auditor mandated by the Controller (Art. 28(3)(h) GDPR).

---

## 4. Data Breach Notification

4.1 The Processor shall notify the Controller without undue delay after becoming aware of a personal data breach affecting data processed under this DPA (Art. 33(2) GDPR).

4.2 Given the self-hosted nature of Pinchy, data breaches are most likely to occur at the infrastructure level, which is under the Controller's responsibility. The Processor's notification obligation relates to security vulnerabilities in the Pinchy software itself.

4.3 The Processor shall provide a security contact and vulnerability reporting process (see [SECURITY-POLICY.md](SECURITY-POLICY.md)).

---

## 5. International Data Transfers

5.1 The Processor does not transfer personal data outside the EU/EEA.

5.2 Pinchy software does not transmit data to the Processor or any third party. The only external data transmission occurs when the Controller configures an LLM provider, which is the Controller's responsibility.

5.3 If the Controller configures an LLM provider located outside the EU/EEA, the Controller is responsible for ensuring appropriate transfer safeguards (e.g., Standard Contractual Clauses per Art. 46 GDPR).

---

## 6. Liability

Liability is governed by the underlying agreement between the Parties and applicable law, including Art. 82 GDPR.

---

## 7. Final Provisions

7.1 This DPA is governed by the laws of the Republic of Austria.

7.2 The courts of Vienna, Austria shall have exclusive jurisdiction.

7.3 In the event of any conflict between this DPA and the underlying agreement, this DPA shall prevail with respect to data protection matters.

7.4 Amendments to this DPA must be in writing.

---

## Annex 1: Description of Processing

| Element | Description |
|---|---|
| **Categories of Data Subjects** | Customer's employees, contractors, or other users of the Pinchy instance |
| **Categories of Personal Data** | Email addresses, display names, hashed passwords, chat messages, session data, agent configurations |
| **Sensitive Data** | None intentionally processed. Chat messages may incidentally contain sensitive data at the Controller's discretion. |
| **Processing Operations** | Storage of user accounts; processing of chat messages for AI agent interaction; storage of agent configurations; encrypted storage of API keys; file access from configured mount points |
| **Purpose of Processing** | Provision of the Pinchy AI agent platform |
| **Data Location** | Controller's own infrastructure (determined by Controller) |

---

## Annex 2: Technical and Organizational Measures (TOMs)

*The following measures are implemented in the Pinchy software as delivered. Infrastructure-level security (server hardening, network security, physical security) is the Controller's responsibility.*

### Access Control (Authentication)

- **Password-based authentication** via Auth.js v5 with Credentials Provider
- **Password hashing** using bcrypt (industry-standard adaptive hashing)
- **Session management** via signed JWT tokens
- **User invite system** — only administrators can create new user accounts

### Access Control (Authorization)

- **Role-based access control** with two roles: `admin` and `user`
- Administrators can manage users, agents, and system configuration
- Regular users can interact with assigned agents

### Encryption

- **API keys at rest:** Encrypted using AES-256-GCM before storage in the database
- **Passwords:** Stored as bcrypt hashes (not reversible)
- **Transport encryption:** HTTPS and WSS configurable by the Controller at the infrastructure level

### Data Isolation

- **Self-hosted deployment:** All data remains on the Controller's infrastructure
- **No telemetry or phone-home:** The software makes no connections to Helmcraft GmbH
- **Docker Compose isolation:** Services (web application, database, gateway) run in isolated containers on the same host
- **Localhost communication:** Internal services communicate via localhost only

### Input Control / File Access

- **Mount point validation:** File access is restricted to explicitly configured mount points
- **Directory traversal prevention:** Path validation prevents access outside configured directories

### Availability & Resilience

- **Docker Compose deployment** enables straightforward restart and recovery
- **Database backups:** The Controller is responsible for configuring PostgreSQL backups according to their requirements

### Measures Not Yet Implemented

The following measures are planned but not yet available in the current version:

- Audit logging of user actions
- Single Sign-On (OAuth2/OIDC, SAML)
- Granular role-based access control beyond admin/user

---

## Signatures

**Controller:**

Name: ____________________________
Title: ____________________________
Date: ____________________________
Signature: ________________________

**Processor (Helmcraft GmbH):**

Name: Clemens Helm
Title: Managing Director
Date: ____________________________
Signature: ________________________
