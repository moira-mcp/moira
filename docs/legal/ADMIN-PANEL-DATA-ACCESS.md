# Admin Panel Data Access Documentation

This document describes what personal user data is accessible through the Moira admin panel and justifies this access for GDPR compliance.

## 1. Data List

### User Profile Data

| Field                              | Source   | Admin Page                              |
| ---------------------------------- | -------- | --------------------------------------- |
| User ID                            | Database | User Management, User Detail            |
| Email                              | Database | User Management, User Detail, Audit Log |
| Name                               | Database | User Management, User Detail, Audit Log |
| Account creation date              | Database | User Management, User Detail            |
| Account update date                | Database | User Detail                             |
| Admin status                       | Database | User Management, User Detail            |
| Email verification status          | Database | User Management, User Detail            |
| Blocked status                     | Database | User Management, User Detail            |
| Block reason                       | Database | User Detail                             |
| Block timestamp                    | Database | User Detail                             |
| Blocked by (admin ID)              | Database | User Detail                             |
| Password reset required flag       | Database | User Detail                             |
| Password reset requested timestamp | Database | User Detail                             |
| Password reset requested by        | Database | User Detail                             |

### Session Data

| Field                     | Source               | Admin Page             |
| ------------------------- | -------------------- | ---------------------- |
| Session ID                | Database             | User Detail            |
| Session token (hashed)    | Database             | User Detail            |
| IP address                | HTTP request headers | User Detail, Audit Log |
| User agent                | HTTP request headers | User Detail, Audit Log |
| Country (derived from IP) | GeoIP lookup         | User Detail, Audit Log |
| Session creation date     | Database             | User Detail            |
| Session expiration date   | Database             | User Detail            |

### OAuth Connection Data

| Field           | Source   | Admin Page  |
| --------------- | -------- | ----------- |
| OAuth client ID | Database | User Detail |
| OAuth scopes    | Database | User Detail |
| Consent status  | Database | User Detail |
| Token count     | Database | User Detail |
| Connection date | Database | User Detail |

### Email History

| Field                     | Source   | Admin Page  |
| ------------------------- | -------- | ----------- |
| Email type                | Database | User Detail |
| Recipient address         | Database | User Detail |
| Email subject             | Database | User Detail |
| Send status               | Database | User Detail |
| Error message (if failed) | Database | User Detail |
| Send timestamp            | Database | User Detail |

### Activity Data

| Field                 | Source   | Admin Page                   |
| --------------------- | -------- | ---------------------------- |
| Workflow count        | Database | User Management, User Detail |
| Active sessions count | Database | User Detail                  |
| OAuth tokens count    | Database | User Detail                  |
| Emails sent count     | Database | User Detail                  |

### Audit Log Data

| Field                       | Source               | Admin Page |
| --------------------------- | -------------------- | ---------- |
| Action performed            | Application          | Audit Log  |
| Action timestamp            | Application          | Audit Log  |
| Resource type               | Application          | Audit Log  |
| Resource ID                 | Application          | Audit Log  |
| Source (web/mcp/api/system) | Application          | Audit Log  |
| IP address                  | HTTP request headers | Audit Log  |
| Country                     | GeoIP lookup         | Audit Log  |
| User agent                  | HTTP request headers | Audit Log  |
| Metadata (action context)   | Application          | Audit Log  |
| Changes (field-level diff)  | Application          | Audit Log  |

### Execution Data

| Field                | Source   | Admin Page       |
| -------------------- | -------- | ---------------- |
| Execution ID         | Database | Admin Executions |
| Workflow ID          | Database | Admin Executions |
| User email           | Database | Admin Executions |
| User name            | Database | Admin Executions |
| Execution status     | Database | Admin Executions |
| Current node ID      | Database | Admin Executions |
| Creation timestamp   | Database | Admin Executions |
| Update timestamp     | Database | Admin Executions |
| Completion timestamp | Database | Admin Executions |
| Error message        | Database | Admin Executions |

## 2. Purpose

### Alpha Testing Support

During the alpha testing phase, admin access to user data serves the following purposes:

1. **Debugging Issues**
   - Investigate user-reported problems by examining their session state
   - Trace execution flow through audit logs
   - Identify failed email deliveries and their error messages
   - Understand OAuth connection issues

2. **User Support**
   - Manually verify email addresses when verification emails fail
   - Reset passwords for users who cannot access their email
   - Unblock incorrectly blocked accounts
   - Revoke compromised sessions

3. **Security Monitoring**
   - Detect suspicious login patterns via IP/country analysis
   - Identify potential account compromise through session monitoring
   - Track admin actions for accountability
   - Monitor for abuse patterns

4. **System Health**
   - Monitor active executions across all users
   - Track email delivery success rates
   - Identify problematic workflows causing errors
   - Ensure system stability during testing

### Legal Basis

- **Legitimate Interest**: Admin access is necessary for system operation, security, and user support
- **Contract Performance**: Users agree to admin access in Terms of Service for troubleshooting purposes
- **Legal Compliance**: Audit logs support compliance with legal obligations

## 3. Production Plan

### Data Minimization

For production release, the following restrictions will be implemented:

1. **IP Address Anonymization**
   - Truncate last octet of IPv4 addresses (192.168.1.XXX)
   - Truncate last 80 bits of IPv6 addresses
   - Retain only country-level geolocation

2. **Session Token Handling**
   - Never display session tokens in admin UI
   - Use token hashes only for revocation purposes

3. **Email Content**
   - Store only email type and status, not subject or content
   - Implement automatic purge after 30 days

### Access Controls

1. **Role-Based Access**
   - Separate "viewer" and "admin" roles
   - Viewers can see aggregated data only
   - Full data access requires explicit justification

2. **Access Logging**
   - Log every admin data access with reason
   - Require written justification for accessing specific user data
   - Regular audit of access logs

3. **Time-Limited Access**
   - Auto-expire admin access to specific user data after 24 hours
   - Require re-authorization for extended access

### Data Retention

1. **Audit Logs**
   - Retain for 90 days in production
   - Anonymize user identifiers after retention period
   - Aggregate statistics preserved indefinitely

2. **Session Data**
   - Delete expired sessions automatically
   - Remove IP/user agent data from expired sessions

3. **Email Logs**
   - Retain for 30 days
   - Delete content, keep only delivery status statistics

### User Rights

1. **Access Request**
   - Provide export of all data associated with user account
   - Include audit log of admin access to their data

2. **Erasure Request**
   - Delete all personal data on request
   - Retain anonymized audit entries for legal compliance

3. **Portability**
   - Export workflows in standard JSON format
   - Export execution history with personal data

### Technical Measures

1. **Encryption**
   - Encrypt database at rest
   - TLS for all data in transit
   - Additional encryption for sensitive fields (email content)

2. **Access Monitoring**
   - Alert on unusual admin access patterns
   - Rate limit admin data access requests
   - Automatic account lockout on suspicious activity

---

Document Version: 1.0
Last Updated: 2025-12-17
Related Issue: #200
