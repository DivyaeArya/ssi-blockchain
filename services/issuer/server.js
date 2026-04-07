'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(express.json());

const FF = process.env.FIREFLY_URL;
const API_NAME = process.env.FIREFLY_API_NAME || 'ssi-api';
const CH = process.env.FABRIC_CHANNEL;
const CC = process.env.FABRIC_CHAINCODE;
const ISS = process.env.ISSUER_ID;
const IID = process.env.FIREFLY_INTERFACE_ID;

// RSA Keypair generation
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Helper: invoke chaincode via FireFly
async function invoke(method, input) {
    const res = await axios.post(`${FF}/api/v1/contracts/invoke`, {
        interface: IID, 
        location: { channel: CH, chaincode: CC },
        method: { name: method },
        input,
    });
    return res.data;
}

// Helper: query chaincode via FireFly
async function query(method, input) {
    const res = await axios.post(`${FF}/api/v1/contracts/query`, {
        interface: IID,
        location: { channel: CH, chaincode: CC },
        method: { name: method },
        input,
    });
    return res.data;
}

// Register issuer on-chain
app.post('/register', async (req, res) => {
    try {
        const result = await invoke('registerIssuer', {
            issuerId: ISS,
            publicKey,
            name: 'Org1 Issuer',
        });
        
        console.log(`\n✅ Issuer Registered: ${ISS}`);
        res.json({ success: true, result });
    } catch (e) {
        console.error(`\n❌ Registration Failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Issue a credential
app.post('/issue', async (req, res) => {
    try {
        const { userId, role, level, encryptedIdentity } = req.body;

        if (!userId || !role || level === undefined || level === null) {
            return res.status(400).json({ error: 'Missing fields' });
        }

        const credentialId = uuidv4();
        const credential = {
            credentialId,
            issuerId: ISS,
            userId,
            role,
            level: parseInt(level, 10),
            encryptedIdentity,
            issuedAt: new Date().toISOString(),
        };

        const payloadToSign = JSON.stringify({
            credentialId: credential.credentialId,
            issuerId: credential.issuerId,
            role: credential.role,
            level: credential.level,
        });

        const sign = crypto.createSign('SHA256');
        sign.update(payloadToSign);
        sign.end();
        credential.issuerSignature = sign.sign(privateKey, 'base64');

        // Pin to blockchain
        await invoke('issueCredential', {
            credentialId,
            issuerId: ISS,
            role,
            level: String(level),
        });

        // --- NEW LOGGING ---
        console.log(`\n📄 NEW CREDENTIAL ISSUED`);
        console.log(`   ID:    ${credentialId}`);
        console.log(`   User:  ${userId}`);
        console.log(`   Role:  ${role} (Level ${level})`);
        console.log(`   Time:  ${credential.issuedAt}`);
        // -------------------

        res.json({ success: true, credential });
    } catch (e) {
        console.error(`\n❌ Issuance Failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Revoke a credential
app.post('/revoke', async (req, res) => {
    try {
        const { credentialId } = req.body;
        if (!credentialId) {
            return res.status(400).json({ error: 'Missing credentialId' });
        }

        await invoke('revokeCredential', { credentialId });

        // --- NEW LOGGING ---
        console.log(`\n🚫 CREDENTIAL REVOKED`);
        console.log(`   ID:    ${credentialId}`);
        console.log(`   Status: Inactive on-chain`);
        // -------------------

        res.json({ success: true, credentialId, status: 'revoked' });
    } catch (e) {
        console.error(`\n❌ Revocation Failed for ${req.body.credentialId}: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/deanonymize', async (req, res) => {
    try {
        const { encryptedIdentity } = req.body;
        const decrypted = crypto.privateDecrypt(
            {
                key: privateKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            },
            Buffer.from(encryptedIdentity, 'base64')
        );

        console.log(`\n🔍 DEANONYMIZATION REQUEST PROCESSED`);
        res.json({ success: true, identity: decrypted.toString() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/public-key', (req, res) => {
    res.json({ issuerId: ISS, publicKey });
});

app.post('/policy', async (req, res) => {
    try {
        const { resourceId, requiredRole, requiredLevel } = req.body;
        const result = await invoke('upsertPolicy', {
            resourceId,
            requiredRole,
            requiredLevel: String(requiredLevel),
        });

        console.log(`\n⚖️  POLICY UPDATED: ${resourceId} (${requiredRole} Lvl ${requiredLevel})`);
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(process.env.PORT, () => {
    console.log(`\n🚀 Issuer Service running on port ${process.env.PORT}`);
    console.log(`   Issuer ID: ${ISS}`);
});