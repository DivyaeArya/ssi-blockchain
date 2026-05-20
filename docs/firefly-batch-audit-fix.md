# FireFly Batch Audit Error and Fix

## Context

The verifier batches local access logs, calculates a Merkle root, pins that root to the `ssi-contract` chaincode with `submitLogRoot`, and sends the raw batch logs privately to the centre over FireFly.

The centre receives the private `log-batch` message, queries the pinned root with `getLogRoot`, recomputes the Merkle root from the received logs, and marks the batch as verified only when:

- `computedRoot === onChainRoot`
- `merkleRoot === onChainRoot`

## Error Reproduced

When the verifier tried to pin the chaincode transaction and private message in one FireFly call:

```js
POST /api/v1/contracts/invoke
```

with both:

- `input` for `submitLogRoot`
- `message` for private log delivery

FireFly rejected the request.

Using `timelog` as the fourth chaincode argument produced:

```text
FF10445: Cannot provide a value for 'timelog' when pinning a message
```

Using `timestamp` produced the same class of error:

```text
FF10445: Cannot provide a value for 'timestamp' when pinning a message
```

So the problem was not only that `timestamp` can be a reserved or special FireFly field name. The deeper issue is that FireFly does not allow user-provided contract params for this style of message-pinning invoke request.

## Fix

The verifier now performs two explicit operations.

First, it pins the Merkle root on-chain:

```js
POST /api/v1/contracts/invoke
```

with inline method params:

```js
method: {
  name: 'submitLogRoot',
  params: [
    { name: 'verifierId', schema: { type: 'string' } },
    { name: 'batchId', schema: { type: 'string' } },
    { name: 'merkleRoot', schema: { type: 'string' } },
    { name: 'timelog', schema: { type: 'string' } }
  ]
}
```

Then, after the invoke succeeds, it sends the private log payload separately:

```js
POST /api/v1/messages/private
```

The private payload still keeps the audit timestamp field as `timestamp`, because that is off-chain application data consumed by the centre.

## Additional Audit Fix

The private message transport can normalize object key order. Because the Merkle tree was previously hashing:

```js
JSON.stringify(log)
```

the verifier and centre could hash the same logical log object into different byte strings after FireFly delivery.

Both services now use stable key ordering before hashing Merkle leaves. This makes the root independent of JSON object key order during transport.

## Centre Query Fix

The registered FireFly contract interface in this local stack existed, but did not include usable method parameter metadata for `getLogRoot`. Calling the query through the interface produced:

```text
Expected 2 parameters, but 0 have been supplied
```

The centre now queries `getLogRoot` with inline params, matching the verifier's inline invoke approach.

## Local Test Result

The fix was tested against the local `ssi-network` FireFly stack.

Observed successful verifier batch:

```text
Batch: 0bc0ff41-01a5-4644-9f17-1e904f53ce2b
Transaction ID: af276e24-285e-4e23-91d5-dd0cca9f2b39
Private Message ID: 1ba2bc60-2852-415b-b249-b8e0313c3541
```

Centre audit result:

```text
AUDIT PASSED: Logs match the blockchain anchor.
```

The centre `/logs/:batchId` response showed:

```json
{
  "verified": true,
  "merkleRoot": "8916b08d9c80bf7645616b1a6a8bde775313f9bee7c29e237535f580d612b9b5",
  "onChainRoot": "8916b08d9c80bf7645616b1a6a8bde775313f9bee7c29e237535f580d612b9b5",
  "computedRoot": "8916b08d9c80bf7645616b1a6a8bde775313f9bee7c29e237535f580d612b9b5"
}
```

## Local Environment Notes

For this local FireFly stack:

- member `0` on port `5000` is `org_0e95ec`
- member `1` on port `5001` is `org_182995`
- the verifier sends from member `1`
- the centre receives as member `0`
- `services/verifier/.env` should use `RECIPIENT_ORG=org_0e95ec`

On this Linux Docker setup, `host.docker.internal` did not resolve from the FireFly container. A working webhook callback used the Docker gateway IP:

```text
http://172.19.0.1:3003/receive-batch
```

