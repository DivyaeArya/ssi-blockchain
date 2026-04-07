'use strict';
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { MerkleTree } = require('merkletreejs');
const SHA256 = (data) => crypto.createHash('sha256').update(data).digest();

require('dotenv').config();

const app = express();
app.use(express.json());

const FF = process.env.FIREFLY_URL;
const IID = process.env.FIREFLY_INTERFACE_ID;
const CH = process.env.FABRIC_CHANNEL;
const CC = process.env.FABRIC_CHAINCODE;
const VID = process.env.VERIFIER_ID;
const ISSUER = process.env.ISSUER_URL;
const CENTRE = process.env.CENTRE_URL;
const BATCH_MS = parseInt(process.env.BATCH_WINDOW_MS);

// Verifier signing keypair
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

let localLogs = [];

async function query(method, input) {
    const res = await axios.post(`${FF}/api/v1/contracts/query`, {
        interface: IID,
        location: { channel: CH, chaincode: CC },
        method:
            { name: method },
        input,
    });
    return res.data;
}

async function invoke(method, input) {
    const res = await axios.post(`${FF}/api/v1/contracts/invoke`, {
        interface: IID,
        location: { channel: CH, chaincode: CC },
        method:
            { name: method },
        input,
    });
    return res.data;
}

app.post('/verify', async (req, res) => {
    const proof = req.body;
    let decision = 'DENIED';
    let reason
        = '';

    try {
        // 1. Fetch issuer public key to validate issuerSignature
        const issuerKeyRes = await axios.get(`${ISSUER}/public-key`);
        const issuerPublicKey = issuerKeyRes.data.publicKey;

        // 2. Verify issuer signature on credential fields
        const verify = crypto.createVerify('SHA256');
        verify.update(JSON.stringify({
            credentialId: proof.credentialId,
            issuerId:
                proof.issuerId,
            role:
                proof.role,
            level:
                proof.level,
        }));
        verify.end();
        const sigValid = verify.verify(issuerPublicKey, proof.issuerSignature, 'base64');
        if (!sigValid) { reason = 'Invalid issuer signature'; throw new Error(reason); }

        // 3. Check credential status on-chain
        const credData = await query('queryCredentialStatus',
            { credentialId: proof.credentialId });
        const cred = typeof credData === 'string' ? JSON.parse(credData) : credData;
        if (cred.status !== 'active') {
            reason = 'Credential is revoked';
            throw new Error(reason);
        }

        // 4. Fetch policy for resource

        const policyData = await query('getPolicy', { resourceId: proof.resourceId });
        const policy = typeof policyData === 'string'
            ? JSON.parse(policyData) : policyData;

        // 5. Check role and level against policy
        if (proof.role !== policy.requiredRole) {
            reason = `Role mismatch: need ${policy.requiredRole}`;
            throw new Error(reason);
        }
        if (proof.level < policy.requiredLevel) {
            reason = `Insufficient level: need ${policy.requiredLevel}`;
            throw new Error(reason);
        }

        // 6. Verify ephemeral signature (proof of possession)
        const epVerify = crypto.createVerify('SHA256');
        const { ephemeralSignature, ...payloadWithoutSig } = proof;
        epVerify.update(JSON.stringify(payloadWithoutSig));
        epVerify.end();
        const epValid = epVerify.verify(
            proof.ephemeralPublicKey, ephemeralSignature, 'base64');
        if (!epValid) { reason = 'Invalid ephemeral signature'; throw new Error(reason); }
        decision = 'GRANTED';
        reason
            = 'All checks passed';
    } catch (e) {
        if (!reason) reason = e.message;
    }

    // 7. Build signed receipt
    const receipt = {
        receiptId:
            uuidv4(),
        verifierId:
            VID,
        credentialId: proof.credentialId,
        resourceId:
            proof.resourceId,
        ephemeralKey: proof.ephemeralPublicKey,
        decision,
        reason,
        timestamp:
            new Date().toISOString(),
    };
    const rsign = crypto.createSign('SHA256');
    rsign.update(JSON.stringify(receipt));
    rsign.end();
    receipt.verifierSignature = rsign.sign(privateKey, 'base64');

    // 8. Store log entry locally
    const logEntry = {
        logId:
            uuidv4(),
        timestamp:
            receipt.timestamp,
        resourceId:
            proof.resourceId,
        ephemeralKey: proof.ephemeralPublicKey,
        result:
            decision,
        proofHash:
            crypto.createHash('sha256')
                .update(JSON.stringify(proof)).digest('hex'),
        receiptSignature: receipt.verifierSignature,
        encryptedIdentity: proof.encryptedIdentity,
    };
    localLogs.push(logEntry);

    // Return receipt to user (user stores this)
    res.json({ decision, reason, receipt });
});

// Batch & submit Merkle root
async function submitBatch() {
    if (localLogs.length === 0) return;

    const batchLogs = [...localLogs];
    localLogs = [];
    const batchId = uuidv4();
    const now = new Date().toISOString();
    
    // 1. Calculate Merkle Root
    const leaves = batchLogs.map(log => SHA256(JSON.stringify(log)));
    const tree = new MerkleTree(leaves, SHA256);
    const root = tree.getRoot().toString('hex');

    console.log(`\n📦 Packaging batch ${batchId}...`);
    console.log(`Root: ${root}`);

    try {
        /**
         * 2. CONSOLIDATED CALL: "Pin" the logs to the blockchain
         * This replaces BOTH your 'invoke' and your 'axios.post(/private)' calls.
         */
        const response = await axios.post(`${FF}/api/v1/contracts/invoke`, {
            location: { 
                channel: 'firefly', 
                chaincode: 'ssi-contract' 
            },
            
            // Define the method inline to bypass the "params: NULL" Interface ID issue
            method: {
                name: "submitLogRoot",
                params: [
                    { "name": "verifierId", "schema": { "type": "string" } },
                    { "name": "batchId", "schema": { "type": "string" } },
                    { "name": "merkleRoot", "schema": { "type": "string" } },
                    { "name": "timestamp", "schema": { "type": "string" } }
                ]
            },

            // On-chain data: Note we removed the manual timestamp
            input: {
                verifierId: VID,
                batchId: batchId,
                merkleRoot: root,
                timelog: now
            },

            // Off-chain delivery: FireFly sends this privately to the Centre
            message: {
                header: { tag: 'log-batch' },
                group: { 
                    members: [{ identity: "org_0e95ec" }] // Recipient: Centre Node ID
                },
                data: [{
                    value: { 
                        batchId, 
                        merkleRoot: root, 
                        logs: batchLogs, 
                        verifierId: VID, 
                        timestamp: now
                    }
                }]
            }
        });

        console.log(`✅ Batch ${batchId} pinned on-chain and delivered to Centre.`);
        console.log(`Transaction ID: ${response.data.id}`);

    } catch (err) {
        console.error("❌ Batch Submission Failed!");
        console.error(err.response?.data?.error || err.message);
        // Put logs back into local queue so they aren't lost on failure
        localLogs = [...batchLogs, ...localLogs];
    }
}

// Run batch on time window
setInterval(submitBatch, BATCH_MS);
app.listen(process.env.PORT, () => {
    console.log(`Verifier node running on port ${process.env.PORT}`);
    console.log(`Batch window: ${BATCH_MS}ms`);
});