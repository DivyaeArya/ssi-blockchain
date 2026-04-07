'use strict';
const crypto = require('crypto');
const fs = require('fs-extra');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const WALLET_FILE = path.join(__dirname, 'wallet-data.json');
const ISSUER_URL = 'http://localhost:3001';

// Helper: Load wallet data from local JSON file
async function loadWallet() {
  if (await fs.pathExists(WALLET_FILE)) {
    return fs.readJson(WALLET_FILE);
  }
  return { credentials: [], receipts: [] };
}

// Helper: Save wallet data to local JSON file
async function saveWallet(data) {
  await fs.writeJson(WALLET_FILE, data, { spaces: 2 });
}

// Request a credential from the issuer
async function requestCredential(userId, role, level) {
  // Generate a long-term keypair for this wallet
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Fetch issuer public key for encryption
  const issuerKeyRes = await axios.get(`${ISSUER_URL}/public-key`);
  const issuerPublicKey = issuerKeyRes.data.publicKey;

  // Encrypt real identity with issuer public key
  const identityBuffer = Buffer.from(JSON.stringify({ userId }));
  const encryptedIdentity = crypto.publicEncrypt(
    { key: issuerPublicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    identityBuffer
  ).toString('base64');

  // Request credential from issuer
  const res = await axios.post(`${ISSUER_URL}/issue`, {
    userId, role, level: parseInt(level), encryptedIdentity,
  });

  const wallet = await loadWallet();
  wallet.credentials.push({
    ...res.data.credential,
    walletPrivateKey: privateKey,
    walletPublicKey: publicKey,
  });
  await saveWallet(wallet);
  console.log('Credential received and stored:');
  console.log(' Credential ID:', res.data.credential.credentialId);
  console.log(' Role:', role, ' Level:', level);
}

// Generate an access proof to present to a verifier
async function generateProof(credentialId, resourceId) {
  const wallet = await loadWallet();
  const cred = wallet.credentials.find(c => c.credentialId === credentialId);
  if (!cred) throw new Error('Credential not found in wallet');

  // Generate ephemeral key for this session (unlinkability)
  const { privateKey: ephPriv, publicKey: ephPub } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const sessionId = uuidv4();
  const timestamp = new Date().toISOString();

  // Build proof payload
  const proofPayload = {
    sessionId,
    credentialId: cred.credentialId,
    issuerId: cred.issuerId,
    role: cred.role,
    level: cred.level,
    issuerSignature: cred.issuerSignature,
    encryptedIdentity: cred.encryptedIdentity,
    ephemeralPublicKey: ephPub,
    resourceId,
    timestamp,
  };

  // Sign proof with ephemeral key
  const sign = crypto.createSign('SHA256');
  sign.update(JSON.stringify(proofPayload));
  sign.end();
  proofPayload.ephemeralSignature = sign.sign(ephPriv, 'base64');

  console.log('Proof generated:');
  console.log(JSON.stringify(proofPayload, null, 2));
  return proofPayload;
}

// Store a receipt returned by verifier
async function storeReceipt(receipt) {
  const wallet = await loadWallet();
  wallet.receipts.push(receipt);
  await saveWallet(wallet);
  console.log('Receipt stored. Total receipts:', wallet.receipts.length);
}

// CLI entry point
const [,, command, ...args] = process.argv;
(async () => {
  try {
    if (command === 'request') {
      const [userId, role, level] = args;
      await requestCredential(userId, role, level);
    } else if (command === 'prove') {
      const [credentialId, resourceId] = args;
      const proof = await generateProof(credentialId, resourceId);
      // Send this proof to the verifier
      const res = await axios.post('http://localhost:3002/verify', proof);
      await storeReceipt(res.data.receipt);
    } else if (command === 'list') {
      const wallet = await loadWallet();
      console.log('Credentials:', wallet.credentials.length);
      wallet.credentials.forEach(c =>
        console.log(' ', c.credentialId, c.role, 'level', c.level));
    } else {
      console.log('Usage:');
      console.log(' node wallet.js request <userId> <role> <level>');
      console.log(' node wallet.js prove <credentialId> <resourceId>');
      console.log(' node wallet.js list');
    }
  } catch(e) {
    console.error('Error:', e.message);
  }
})();