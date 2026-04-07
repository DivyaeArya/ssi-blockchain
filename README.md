## 1. FireFly Stack Setup
```bash
# Download and install FireFly CLI
curl -sSfL https://raw.githubusercontent.com/hyperledger/firefly-cli/main/scripts/install.sh | sh

# Initialize Fabric network
ff init fabric ssi-network --org 2

# Start the stack
ff start ssi-network
```

---

## 2. Smart Contract Deployment
```bash
# Navigate to contract directory
cd ~/ssi-blockchain/contract

# Install dependencies
npm install

# Package the chaincode
# Ensure peer binary is in path or use full path
peer lifecycle chaincode package ssi-contract.tar.gz --path . --lang node --label ssi-contract_1.0

# Deploy to FireFly stack (order of commands might be different here depending on version, the error output should give the corrected order)
ff deploy fabric ssi-network ssi-contract 1.0 ./ssi-contract.tar.gz
```

---

## 3. Register Contract Interfaces (FFI)
**Org 1 (Port 5000):**
```bash
curl -X POST http://localhost:5000/api/v1/contracts/interfaces \
  -H 'Content-Type: application/json' \
  -d @scripts/ff-contract-interface.json | jq -r .id
```
copy the top most ID from here^ and use it later for issuer and centre
---
**Org 2 (Port 5001):**
```bash
curl -X POST http://localhost:5001/api/v1/contracts/interfaces \
  -H 'Content-Type: application/json' \
  -d @scripts/ff-contract-interface.json | jq -r .id
```
copy the top most ID from here^ and use it later for verifier
(this command might need to be re run with explicit definitions for /submitLogRoot, if it gives error later, then we will have 2 interface IDs the other one only for the submit funciton)

---

## 4. Environment Configuration
**Folder: `/services/issuer/` & `/services/centre/`**
* File: `.env`
* Port: 5000
* Value: `FIREFLY_INTERFACE_ID=<ID_FROM_PORT_5000>`

**Folder: `/services/verifier/`**
* File: `.env`
* Port: 5001
* Value: `FIREFLY_INTERFACE_ID=<ID_FROM_PORT_5001>`

---

## 5. System Registration & Webhooks
**Register Issuer (Org 1):**
```bash
curl -X POST http://localhost:3001/register
```

**Register Policy (Org 1):**
```bash
curl -X POST http://localhost:3001/policy \
  -d '{"resourceId": "library-door-1", "requiredRole": "student", "requiredLevel": 1}'
```

**Register Verifier (Org 2):**
```bash
curl -X POST http://localhost:5001/api/v1/contracts/invoke \
  -d '{
    "interface": "<ID_FROM_PORT_5001>",
    "location": { "channel": "firefly", "chaincode": "ssi-contract" },
    "method": "registerVerifier",
    "input": {
      "verifierId": "verifier-door-1",
      "publicKey": "verifier-pub-key",
      "endpoint": "http://localhost:3002"
    }
  }'
```

**Register Webhook (Org 1):**
```bash
curl -X POST http://localhost:5000/api/v1/subscriptions \
  -d '{
    "name": "centre-log-receiver",
    "transport": "webhooks",
    "filter": { "tag": "log-batch" },
    "options": {
      "url": "http://host.docker.internal:3003/receive-batch",
      "method": "POST"
    }
  }'
```
(I tried both localhost:3003 and host.docker.internal:3003)
---

## 6. Wallet Operations
**Request Credential:**
```bash
node wallet.js request joe student 1
```

**Prove Identity:**
```bash
node wallet.js prove <CREDENTIAL_ID> library-door-1
```

**Revoke Credential:**
```bash
curl -X POST http://localhost:3001/revoke -d '{"credentialId": "<ID>"}'
```

**Audit Logs:**
```bash
curl http://localhost:3003/logs
```

Just for audit there is ```bash node wallet.js list``` to show issued credentials will be removed later.
