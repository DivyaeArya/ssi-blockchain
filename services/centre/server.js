'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { MerkleTree } = require('merkletreejs');
require('dotenv').config();

const app = express();
app.use(express.json());

// SHA256 Helper for Merkle Tree [cite: 1099]
const SHA256 = (data) => crypto.createHash('sha256').update(data).digest();

function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

const FF = process.env.FIREFLY_URL; // http://localhost:5000 [cite: 1106]
const CH = process.env.FABRIC_CHANNEL; // firefly [cite: 1109]
const CC = process.env.FABRIC_CHAINCODE; // ssi-contract [cite: 1110]
const IID = process.env.FIREFLY_INTERFACE_ID; // From Port 5000 [cite: 1108]
const ISSUER_URL = process.env.ISSUER_URL || 'http://localhost:3001'; 

// In-memory global log store [cite: 1113]
const globalLogs = {}; 

/**
 * Helper: Query chaincode via FireFly [cite: 1114-1121]
 */
async function query(method, input) {
    const res = await axios.post(`${FF}/api/v1/contracts/query`, {
        interface: IID, 
        location: { channel: CH, chaincode: CC },
        method: { name: method },
        input,
    });
    return res.data;
}

async function queryLogRoot(verifierId, batchId) {
    const res = await axios.post(`${FF}/api/v1/contracts/query`, {
        location: { channel: CH, chaincode: CC },
        method: {
            name: 'getLogRoot',
            params: [
                { name: 'verifierId', schema: { type: 'string' } },
                { name: 'batchId', schema: { type: 'string' } }
            ]
        },
        input: { verifierId, batchId },
    });
    return res.data;
}

/**
 * Webhook Endpoint: Receives batch logs from Verifiers [cite: 1122-1124]
 */
app.post('/receive-batch', async (req, res) => {
    console.log('\n--- 📥 BATCH RECEIVED AT CENTRE ---');

    // 1. Unwrap the FireFly Message Envelope 
    let payload = req.body;
    if (req.body.data && req.body.data[0] && req.body.data[0].value) {
        payload = req.body.data[0].value;
        console.log('📦 Unwrapped FireFly Private Message');
    }

    const { batchId, merkleRoot, logs, verifierId } = payload;

    // Heartbeat check
    if (!batchId) {
        console.log('⚠️ Ignoring empty heartbeat message.');
        return res.status(200).send('OK');
    }

    console.log(`🆔 Batch: ${batchId} | From: ${verifierId}`);

    try {
        // 2. Fetch the On-Chain Root for this batch [cite: 1125-1128]
        const rootData = await queryLogRoot(verifierId, batchId);
        const parsed = typeof rootData === 'string' ? JSON.parse(rootData) : rootData;
        const onChainRoot = parsed.merkleRoot;

        // 3. Recompute Merkle Root from received logs [cite: 1137-1143]
        const leaves = logs.map(log => SHA256(stableStringify(log)));
        const tree = new MerkleTree(leaves, SHA256);
        const computedRoot = tree.getRoot().toString('hex');

        // 4. Audit: Compare Computed vs On-Chain vs Reported [cite: 1144-1145]
        const verified = (computedRoot === onChainRoot && merkleRoot === onChainRoot);

        if (!verified) {
            console.warn('⚠️ ALERT: ROOT MISMATCH! TAMPERING DETECTED.');
            console.warn(`   On-Chain: ${onChainRoot}`);
            console.warn(`   Computed: ${computedRoot}`);
        } else {
            console.log('✅ AUDIT PASSED: Logs match the blockchain anchor.');
        }

        // 5. Store for auditing/UI [cite: 1146-1152]
        globalLogs[batchId] = {
            verifierId,
            merkleRoot,
            onChainRoot,
            computedRoot,
            verified,
            logs,
            receivedAt: new Date().toISOString()
        };

        res.status(200).json({ received: true, verified, batchId }); 

    } catch (e) {
        console.error('❌ Verification Failed:', e.message);
        res.status(500).json({ error: 'Audit failed', details: e.message });
    }
});

// View all logs [cite: 1171-1172]
app.get('/logs', (req, res) => {
    res.json(globalLogs);
});

// View specific batch [cite: 1174-1178]
app.get('/logs/:batchId', (req, res) => {
    const batch = globalLogs[req.params.batchId];
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    res.json(batch);
});

/**
 * Deanonymize a specific log entry [cite: 1180-1182]
 */
app.post('/deanonymize', async (req, res) => {
    const { batchId, logId } = req.body;
    const batch = globalLogs[batchId];

    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    const log = batch.logs.find(l => l.logId === logId);
    if (!log || !log.encryptedIdentity) {
        return res.status(404).json({ error: 'Encrypted identity not found' });
    }

    try {
        // Request Issuer to decrypt [cite: 1189-1192]
        const result = await axios.post(`${ISSUER_URL}/deanonymize`, {
            encryptedIdentity: log.encryptedIdentity
        });

        res.json({
            logId,
            batchId,
            identity: result.data.identity,
            timestamp: log.timestamp
        });
    } catch (e) {
        res.status(500).json({ error: 'Decryption failed' });
    }
});

const PORT = process.env.PORT || 3003;

// Listen on 0.0.0.0 to allow communication from FireFly Docker container 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Centre Node running on port ${PORT}`);
    console.log(`Auditing logs for channel: ${CH}`);
});
