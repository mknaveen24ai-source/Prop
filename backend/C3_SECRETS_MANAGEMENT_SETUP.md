# C3: Secrets Management - Setup Guide

**CRITICAL SECURITY FIX**

## Problem

- Database credentials, API keys, JWT secrets stored in `.env` file
- `.env` file is plaintext and easily leaked
- Once leaked, credentials cannot be rotated without code changes
- `.env` typically committed to git history (permanent exposure)
- No audit trail of who accessed secrets
- No fine-grained access control per environment

**Risk:** Single `.env` leak = complete data breach + account takeover

---

## Solution

Use a dedicated secrets management system:
- **Development:** `.env` file (convenient for local development)
- **Production:** AWS Secrets Manager, HashiCorp Vault, or Azure Key Vault

## Setup Instructions

### LOCAL DEVELOPMENT (Using .env)

**This is fine for development. For production, skip to the next section.**

1. Create `.env` file in `backend/` directory:
```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/propfirm

# Redis
REDIS_URL=redis://localhost:6379

# JWT Secrets
JWT_SECRET=your-super-secret-jwt-key-min-32-chars-long-here
ADMIN_JWT_SECRET=another-secret-key-min-32-chars-long-here

# Optional APIs
SENDGRID_API_KEY=SG.xxx
STRIPE_SECRET_KEY=sk_test_xxx
```

2. **IMPORTANT:** Add `.env` to `.gitignore`:
```bash
# backend/.gitignore
.env
.env.local
.env.*.local
```

3. Verify never committed:
```bash
git status  # Should NOT show .env
```

---

### PRODUCTION - AWS Secrets Manager (Recommended)

**Best for AWS deployments**

#### Step 1: Create Secret in AWS Console

```bash
# Via AWS CLI:
aws secretsmanager create-secret \
  --name propfirm/production \
  --region us-east-1 \
  --secret-string '{
    "JWT_SECRET":"your-production-secret",
    "ADMIN_JWT_SECRET":"another-production-secret",
    "DATABASE_URL":"postgresql://...",
    "REDIS_URL":"redis://..."
  }'
```

#### Step 2: Set IAM Permissions

Your server needs IAM role with permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:ACCOUNT:secret:propfirm/*"
    }
  ]
}
```

#### Step 3: Update Environment Variables

In production deployment (ECS, Lambda, EC2):

```bash
export NODE_ENV=production
export SECRETS_BACKEND=aws
export AWS_REGION=us-east-1
```

#### Step 4: Deploy Application

When server starts:
1. Detects `SECRETS_BACKEND=aws`
2. Loads from AWS Secrets Manager
3. Validates all secrets present
4. Ready to serve requests

#### Step 5: Rotate Secrets

To rotate JWT secret without downtime:

```bash
# Update secret in AWS
aws secretsmanager update-secret \
  --secret-id propfirm/production \
  --secret-string '{...newly-updated-secret...}'

# Gradually roll out new deployments
# Old tokens still valid for their expiry period
# New tokens use new secret
```

---

### PRODUCTION - HashiCorp Vault

**Best for on-premise/multi-cloud deployments**

#### Step 1: Store Secrets in Vault

```bash
vault kv put secret/propfirm \
  JWT_SECRET="..." \
  ADMIN_JWT_SECRET="..." \
  DATABASE_URL="..." \
  REDIS_URL="..."
```

#### Step 2: Enable AppRole Authentication

```bash
vault auth enable approle

# Create app role
vault write auth/approle/role/propfirm \
  bind_secret_id=true \
  token_ttl=1h

# Get credentials
vault read auth/approle/role/propfirm/role-id
vault write -f auth/approle/role/propfirm/secret-id
```

#### Step 3: Set Environment Variables

```bash
export NODE_ENV=production
export SECRETS_BACKEND=vault
export VAULT_ADDR=https://vault.company.com:8200
export VAULT_TOKEN=s.xxxxxxxxxxxxxxxx
export VAULT_PATH=secret/data/propfirm
```

#### Step 4: Deploy

Server will auto-fetch secrets from Vault on startup.

---

### PRODUCTION - Azure Key Vault

**Best for Azure deployments**

#### Step 1: Create Key Vault

```bash
az keyvault create \
  --name propfirm-kv \
  --resource-group propfirm-rg
```

#### Step 2: Store Secrets

```bash
az keyvault secret set \
  --vault-name propfirm-kv \
  --name JWT-SECRET \
  --value "..."

az keyvault secret set \
  --vault-name propfirm-kv \
  --name DATABASE-URL \
  --value "..."
```

#### Step 3: Assign Identity

Assign Managed Identity to your service (App Service, Container Instances, etc.)

#### Step 4: Update Code

For Azure support, add to `utils/secrets.js`:

```javascript
async function loadSecretsFromAzure() {
  const { DefaultAzureCredential } = require("@azure/identity");
  const { SecretClient } = require("@azure/keyvault-secrets");

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(`https://propfirm-kv.vault.azure.net/`, credential);

  for (const key of SECRET_KEYS) {
    const secret = await client.getSecret(key);
    secrets[key] = secret.value;
  }
}
```

---

## Security Best Practices

### 1. Secret Rotation

**Set up automatic rotation:**

- AWS: Enable automatic rotation with Lambda function
- Vault: Configure secret lease period
- Azure: Use Key Vault rotation policies

**Recommended rotation schedule:**
- API keys: Every 90 days
- Database passwords: Every 180 days
- JWT signing keys: Only when compromised (old tokens expire naturally)

### 2. Access Auditing

Monitor who accessed secrets:

```bash
# AWS CloudTrail logs all access
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue

# Azure Activity Log
az monitor activity-log list --resource-group propfirm-rg

# Vault logs
vault audit list
```

### 3. Least Privilege

Each environment should have its own secrets:

```
aws secretsmanager create-secret --name propfirm/development
aws secretsmanager create-secret --name propfirm/staging
aws secretsmanager create-secret --name propfirm/production
```

Each with different values and access controls.

### 4. Encryption at Rest

All secrets should be encrypted:
- AWS KMS for Secrets Manager
- Vault uses transparent encryption
- Azure Key Vault encrypts by default

### 5. Encryption in Transit

Always use HTTPS/TLS:
- `vault.company.com:8200` (HTTPS only)
- `keyvault.azure.net` (HTTPS only)
- AWS API endpoints (HTTPS only)

### 6. Never Log Secrets

Sanitize logs automatically:

```javascript
// Good: Mask sensitive data in logs
logger.info('Connected to database', { url: 'postgresql://user@localhost:5432/db' })

// Bad: Logs full connection string with password
logger.info('Connected to database', { url: process.env.DATABASE_URL }))
```

Use `utils/secrets.js` - it automatically sanitizes logging.

---

## Migration Checklist

### Before Production Deployment

- [ ] Create secret store (AWS/Vault/Azure)
- [ ] Store all secrets in production secret store
- [ ] Set environment variables for secret backend
- [ ] Test secret loading locally with mock credentials
- [ ] Test graceful fallback if secret store unavailable
- [ ] Document secret rotation procedure
- [ ] Setup audit logging for secret access
- [ ] Ensure only production servers can access production secrets
- [ ] Revoke old `.env` credentials if any leaked
- [ ] Create runbook for emergency secret rotation
- [ ] Schedule regular security audit
- [ ] Train team on secret management procedures

### Post-Deployment

- [ ] Verify server loads secrets on startup
- [ ] Check logs show secrets loaded (but masked)
- [ ] Monitor secret access in CloudTrail/Activity Log/Vault audit
- [ ] Test secret rotation procedure
- [ ] Confirm old `.env` never accessible to engineers
- [ ] Setup alerts for failed secret retrievals

---

## Implementation Timeline

- **Immediate** (today): Deploy secrets utility to dev/staging
- **This week**: Test secrets rotation
- **Next sprint**: Implement automated rotation
- **Before production**: Complete security audit

---

## File Changes

**New Files:**
- `utils/secrets.js` - Secrets management utility

**Modified Files:**
- `server.js` - Use secrets utility for all sensitive config
- `.env.example` - Document all secrets needed
- `.gitignore` - Ensure .env never committed

**Configuration Files:**
- `.env` - Development only (never commit)
- AWS Secrets Manager - Production secrets
- HashiCorp Vault - Production secrets (alternative)
- Azure Key Vault - Production secrets (alternative)

---

## Troubleshooting

**Error: "Missing required secrets"**
- Check all SECRET_KEYS are set in secret store
- Verify IAM permissions if using AWS
- Check VAULT_TOKEN if using Vault

**Error: "Connection refused to Secret Manager"**
- Check internet connectivity
- Verify VAULT_ADDR is correct
- Check AWS region is set

**Secrets not loading?**
- Check `NODE_ENV=production`
- Verify `SECRETS_BACKEND` env var set
- Check logs for detailed error message

---

## References

- [AWS Secrets Manager Best Practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html)
- [HashiCorp Vault Security Model](https://www.vaultproject.io/docs/internals/security)
- [Azure Key Vault Best Practices](https://docs.microsoft.com/en-us/azure/key-vault/general/best-practices)
- [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

---

## Summary

| Environment | Storage | Security Level |
|-------------|---------|-----------------|
| Development | `.env` file | Low (local only) |
| Staging | AWS Secrets Manager | High |
| Production | AWS + KMS Encryption | Critical |

**Action Required:** Before deploying to production, implement secrets management per this guide.
