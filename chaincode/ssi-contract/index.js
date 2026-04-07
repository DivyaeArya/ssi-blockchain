'use strict';
const { Contract } = require('fabric-contract-api');

class SSIContract extends Contract {
    // Issuer Registery
    async registerIssuer(ctx, issuerId, publicKey, name) {
        const existing = await ctx.stub.getState('issuer::' + issuerId);
        if (existing && existing.length > 0) {
            throw new Error(`Issuer ${issuerId} already registered`);
        }
        const issuer = { issuerId, publicKey, name, active: true };
        await ctx.stub.putState('issuer::' + issuerId,
            Buffer.from(JSON.stringify(issuer)));
        return JSON.stringify(issuer);
    }
    async getIssuer(ctx, issuerId) {
        const data = await ctx.stub.getState('issuer::' + issuerId);
        if (!data || data.length === 0) throw new Error('Issuer not found');
        return data.toString();
    }

    // Verifier Registry
    async registerVerifier(ctx, verifierId, publicKey, endpoint) {
        const verifier = { verifierId, publicKey, endpoint, active: true };
        await ctx.stub.putState('verifier::' + verifierId,
            Buffer.from(JSON.stringify(verifier)));
        return JSON.stringify(verifier);
    }
    async getVerifier(ctx, verifierId) {
        const data = await ctx.stub.getState('verifier::' + verifierId);
        if (!data || data.length === 0) throw new Error('Verifier not found');
        return data.toString();
    }

    // Credential Status
    async issueCredential(ctx, credentialId, issuerId, role, level) {
        // Verify issuer is registered and active
        const issuerData = await ctx.stub.getState('issuer::' + issuerId);
        if (!issuerData || issuerData.length === 0)
            throw new Error('Unknown issuer');
        const issuer = JSON.parse(issuerData.toString());
        if (!issuer.active) throw new Error('Issuer is deactivated');
        const cred = {
            credentialId,
            issuerId,
            role,
            level: parseInt(level),
            status: 'active',
            issuedAt: new Date().toISOString(),
        };
        await ctx.stub.putState('credential::' + credentialId,
            Buffer.from(JSON.stringify(cred)));
        return JSON.stringify(cred);
    }
    async revokeCredential(ctx, credentialId) {
        const data = await ctx.stub.getState('credential::' + credentialId);
        if (!data || data.length === 0) throw new Error('Credential not found');
        const cred = JSON.parse(data.toString());
        cred.status = 'revoked';
        cred.revokedAt = new Date().toISOString();
        await ctx.stub.putState('credential::' + credentialId,
            Buffer.from(JSON.stringify(cred)));
        return JSON.stringify(cred);
    }
    async queryCredentialStatus(ctx, credentialId) {
        const data = await ctx.stub.getState('credential::' + credentialId);
        if (!data || data.length === 0) throw new Error('Credential not found');
        return data.toString();
    }

    // Policy
    async upsertPolicy(ctx, resourceId, requiredRole, requiredLevel) {
        const policy = {
            resourceId,
            requiredRole,
            requiredLevel: parseInt(requiredLevel),
            updatedAt: new Date().toISOString()
        };
        await ctx.stub.putState('policy::' + resourceId,
            Buffer.from(JSON.stringify(policy)));
        return JSON.stringify(policy);
    }
    async getPolicy(ctx, resourceId) {
        const data = await ctx.stub.getState('policy::' + resourceId);
        if (!data || data.length === 0) throw new Error('Policy not found');
        return data.toString();
    }

    // Log Merkle Roots
    async submitLogRoot(ctx, verifierId, batchId, merkleRoot, timestamp) {
        const entry = { verifierId, batchId, merkleRoot, timestamp };
        const key = `logroot::${verifierId}::${batchId}`;
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(entry)));
        // Emit an event so FireFly picks it up
        ctx.stub.setEvent('BatchPin', Buffer.from(JSON.stringify(entry)));
        return JSON.stringify(entry);
    }
    async getLogRoot(ctx, verifierId, batchId) {
        const key = `logroot::${verifierId}::${batchId}`;
        const data = await ctx.stub.getState(key);
        if (!data || data.length === 0) throw new Error('Log root not found');
        return data.toString();
    }
}

module.exports.contracts = [SSIContract];
