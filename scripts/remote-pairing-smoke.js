#!/usr/bin/env node
'use strict';

const sodium = require('libsodium-wrappers');
const canonicalize = require('canonicalize');
const WebSocket = require('ws');

const localApi = process.env.VOPS_SMOKE_LOCAL_API || 'http://127.0.0.1:7789';
const session = process.env.VOPS_SMOKE_LOCAL_SESSION;
if (!session) throw new Error('VOPS_SMOKE_LOCAL_SESSION is required.');

const localHeaders = {
  'X-Vops-Session': session,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

async function main() {
  await sodium.ready;
  const pairing = await json(`${localApi}/api/remote/pairings`, {
    method: 'POST',
    headers: localHeaders,
    body: '{}',
  });
  const bootstrap = pairing.bootstrap;
  const signing = sodium.crypto_sign_keypair();
  const exchange = sodium.crypto_kx_keypair();
  const deviceRouteId = `device_${encode(sodium.randombytes_buf(24))}`;
  const transportToken = encode(sodium.randombytes_buf(32));
  const challengePayload = {
    protocol_version: 1,
    pairing_id: bootstrap.pairing_id,
    challenge: bootstrap.challenge,
    device_route_id: deviceRouteId,
    signing_public_key: encode(signing.publicKey),
    exchange_public_key: encode(exchange.publicKey),
    expires_at: bootstrap.expires_at,
  };
  const signature = encode(
    sodium.crypto_sign_detached(canonicalize(challengePayload), signing.privateKey),
  );
  const claimUrl =
    `${bootstrap.relay_url}/api/remote/pairings/` +
    `${encodeURIComponent(bootstrap.pairing_id)}/claim`;
  const claim = await json(claimUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ routeId: deviceRouteId, transportToken }),
  });
  const socketUrl = new URL(bootstrap.relay_url);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  socketUrl.pathname = `${socketUrl.pathname.replace(/\/$/, '')}/api/remote/socket`;
  socketUrl.searchParams.set('ticket', claim.ticket);
  const socket = new WebSocket(socketUrl);
  const confirmation = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('pairing confirmation timed out')), 15_000);
    socket.on('message', async (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'relay.ready') {
        socket.send(
          JSON.stringify({
            type: 'pairing.hello',
            pairing_id: bootstrap.pairing_id,
            device_route_id: deviceRouteId,
            signing_public_key: encode(signing.publicKey),
            exchange_public_key: encode(exchange.publicKey),
            challenge_signature: signature,
          }),
        );
      }
      if (frame.type !== 'envelope') return;
      try {
        const payload = decrypt(
          frame.envelope,
          exchange,
          bootstrap.node.exchange_public_key,
        );
        socket.send(JSON.stringify({ type: 'delivery.ack', message_id: frame.envelope.message_id }));
        clearTimeout(timeout);
        resolve(payload);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    socket.on('error', reject);
  });

  await waitForHello(bootstrap.pairing_id);
  await json(`${localApi}/api/remote/pairings/${encodeURIComponent(bootstrap.pairing_id)}/confirm`, {
    method: 'POST',
    headers: localHeaders,
    body: JSON.stringify({ label: 'Pairing smoke device', role: 'approver' }),
  });
  const decrypted = await confirmation;
  if (
    decrypted.type !== 'pairing.node_confirmation' ||
    decrypted.device.label !== 'Pairing smoke device' ||
    decrypted.device.role !== 'approver'
  ) {
    throw new Error('decrypted pairing confirmation has the wrong contract');
  }
  let outboundSequence = 0;
  const sendEncrypted = (channel, payload, ttlMs = 120_000) => {
    const now = new Date();
    const metadata = {
      protocol_version: 1,
      message_id: `msg_${encode(sodium.randombytes_buf(24))}`,
      sender_id: deviceRouteId,
      recipient_id: bootstrap.node.route_id,
      channel,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      key_id: decrypted.device.id && deviceKeyId(signing, exchange),
      sequence: ++outboundSequence,
    };
    socket.send(JSON.stringify({
      type: 'envelope',
      envelope: encrypt(metadata, payload, exchange, bootstrap.node.exchange_public_key),
    }));
  };

  const privateNotification = waitForPayload(
    socket,
    exchange,
    bootstrap.node.exchange_public_key,
    (payload) => payload.type === 'notification.event',
    15_000,
  );
  await json(
    `${localApi}/api/remote/devices/${encodeURIComponent(decrypted.device.id)}/notify`,
    {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({ message: 'Encrypted notification smoke test.' }),
    },
  );
  const notification = await privateNotification;
  if (
    notification.summary !== 'Encrypted notification smoke test.' ||
    notification.title !== 'vops'
  ) {
    throw new Error('private operational notification has the wrong encrypted contract');
  }

  const syncRequestId = `sync_${encode(sodium.randombytes_buf(12))}`;
  const sync = waitForPayload(
    socket,
    exchange,
    bootstrap.node.exchange_public_key,
    (payload) => payload.type === 'sync.snapshot' && payload.request_id === syncRequestId,
    15_000,
  );
  sendEncrypted('state_sync', { type: 'sync.request', request_id: syncRequestId });
  const snapshot = await sync;
  if (snapshot.control_node?.authority !== 'local' || !Array.isArray(snapshot.targets)) {
    throw new Error('remote sync snapshot has the wrong contract');
  }

  const chatRequestId = `chat_${encode(sodium.randombytes_buf(12))}`;
  const chat = collectChat(
    socket,
    exchange,
    bootstrap.node.exchange_public_key,
    chatRequestId,
  );
  sendEncrypted(
    'chat_request',
    {
      type: 'chat.user_message',
      request_id: chatRequestId,
      content: 'How many targets and applications are configured? Use vOps tools and answer in one sentence.',
    },
    10 * 60_000,
  );
  const chatResult = await chat;
  if (!chatResult.text.trim() || !chatResult.conversationId) {
    throw new Error('remote chat did not stream a completed assistant response');
  }

  const planRequestId = `chat_${encode(sodium.randombytes_buf(12))}`;
  const planChat = collectChat(
    socket,
    exchange,
    bootstrap.node.exchange_public_key,
    planRequestId,
  );
  sendEncrypted(
    'chat_request',
    {
      type: 'chat.user_message',
      request_id: planRequestId,
      conversation_id: chatResult.conversationId,
      content:
        'Create a governed plan, but do not execute it, to restart the application named demo. ' +
        'Use vops_propose_plan with capability application.restart and input {"name":"demo"}.',
    },
    10 * 60_000,
  );
  const planChatResult = await planChat;
  if (!planChatResult.text.trim()) throw new Error('plan proposal chat did not complete');

  const postChatSyncId = `sync_${encode(sodium.randombytes_buf(12))}`;
  const postChatSync = waitForPayload(
    socket,
    exchange,
    bootstrap.node.exchange_public_key,
    (payload) => payload.type === 'sync.snapshot' && payload.request_id === postChatSyncId,
    15_000,
  );
  sendEncrypted('state_sync', { type: 'sync.request', request_id: postChatSyncId });
  const current = await postChatSync;
  const proposedApproval = current.approvals.find(
    (entry) =>
      entry.status === 'pending' &&
      entry.plan?.steps?.some((step) => step.capability === 'application.restart'),
  );
  if (!proposedApproval?.plan) throw new Error('remote plan did not produce a structured pending approval');

  const staleIssuedAt = new Date();
  const stalePayload = {
    protocol_version: 1,
    command_id: `cmd_${encode(sodium.randombytes_buf(20))}`,
    device_id: decrypted.device.id,
    node_id: decrypted.node.nodeId,
    type: 'approval.decision',
    subject: {
      kind: 'approval',
      id: proposedApproval.id,
      version: proposedApproval.version,
    },
    plan_hash: '0'.repeat(64),
    issued_at: staleIssuedAt.toISOString(),
    expires_at: new Date(
      Math.min(staleIssuedAt.getTime() + 2 * 60_000, Date.parse(proposedApproval.expires_at)),
    ).toISOString(),
    nonce: encode(sodium.randombytes_buf(20)),
    parameters: { decision: 'approve', reason: 'Stale-plan rejection smoke test.' },
  };
  const staleSigned = signCommand(stalePayload, signing, exchange);
  const staleRequestId = `command_${encode(sodium.randombytes_buf(12))}`;
  const staleResultPromise = collectCommand(
    socket,
    exchange,
    bootstrap.node.exchange_public_key,
    staleRequestId,
  );
  sendEncrypted('remote_command', {
    type: 'remote.command',
    request_id: staleRequestId,
    signed_command: staleSigned,
  });
  const staleResult = await staleResultPromise;
  if (
    staleResult.type !== 'command.rejected' ||
    staleResult.error?.code !== 'VOPS_REMOTE_PLAN_HASH'
  ) {
    throw new Error('modified plan hash was not rejected');
  }

  const denyIssuedAt = new Date();
  const denyPayload = {
    ...stalePayload,
    command_id: `cmd_${encode(sodium.randombytes_buf(20))}`,
    plan_hash: proposedApproval.plan.hash,
    issued_at: denyIssuedAt.toISOString(),
    expires_at: new Date(
      Math.min(denyIssuedAt.getTime() + 2 * 60_000, Date.parse(proposedApproval.expires_at)),
    ).toISOString(),
    nonce: encode(sodium.randombytes_buf(20)),
    parameters: { decision: 'deny', reason: 'Exact-plan denial smoke test.' },
  };
  const denyRequestId = `command_${encode(sodium.randombytes_buf(12))}`;
  const denyResultPromise = collectCommand(
    socket,
    exchange,
    bootstrap.node.exchange_public_key,
    denyRequestId,
  );
  sendEncrypted('remote_command', {
    type: 'remote.command',
    request_id: denyRequestId,
    signed_command: signCommand(denyPayload, signing, exchange),
  });
  const denied = await denyResultPromise;
  if (denied.type !== 'command.completed' || denied.result?.status !== 'denied') {
    throw new Error('exact plan denial was not authoritatively committed');
  }

  const sessionToPause = current.agent_sessions.find(
    (entry) => entry.status === 'active' && entry.display_name === 'Remote assistant for Pairing smoke device',
  );
  if (!sessionToPause) throw new Error('governed remote agent session is missing from sync');

  const issuedAt = new Date();
  const commandPayload = {
    protocol_version: 1,
    command_id: `cmd_${encode(sodium.randombytes_buf(20))}`,
    device_id: decrypted.device.id,
    node_id: decrypted.node.nodeId,
    type: 'agent.pause_request',
    subject: {
      kind: 'agent_session',
      id: sessionToPause.id,
      version: sessionToPause.version,
    },
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 2 * 60_000).toISOString(),
    nonce: encode(sodium.randombytes_buf(20)),
    parameters: { reason: 'Signed-command smoke test.' },
  };
  const signedCommand = {
    payload: commandPayload,
    key_id: deviceKeyId(signing, exchange),
    signature: encode(
      sodium.crypto_sign_detached(canonicalize(commandPayload), signing.privateKey),
    ),
  };
  const commandRequestId = `command_${encode(sodium.randombytes_buf(12))}`;
  const commandResult = collectCommand(
    socket,
    exchange,
    bootstrap.node.exchange_public_key,
    commandRequestId,
  );
  sendEncrypted('remote_command', {
    type: 'remote.command',
    request_id: commandRequestId,
    signed_command: signedCommand,
  });
  const authoritative = await commandResult;
  if (authoritative.type !== 'command.completed' || authoritative.state !== 'executed') {
    throw new Error('signed command was not authoritatively completed');
  }

  const duplicateRequestId = `command_${encode(sodium.randombytes_buf(12))}`;
  const duplicateResult = collectCommand(
    socket,
    exchange,
    bootstrap.node.exchange_public_key,
    duplicateRequestId,
  );
  sendEncrypted('remote_command', {
    type: 'remote.command',
    request_id: duplicateRequestId,
    signed_command: signedCommand,
  });
  const duplicate = await duplicateResult;
  if (duplicate.type !== 'command.completed' || duplicate.duplicate !== true) {
    throw new Error('duplicate signed command did not return its authoritative prior result');
  }

  const reused = await fetch(claimUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routeId: `device_${encode(sodium.randombytes_buf(24))}`,
      transportToken: encode(sodium.randombytes_buf(32)),
    }),
  });
  if (reused.status !== 409) throw new Error(`reused pairing returned HTTP ${reused.status}, expected 409`);
  const revokedClose = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('revoked device socket stayed open')), 5_000);
    socket.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  await json(
    `${localApi}/api/remote/devices/${encodeURIComponent(decrypted.device.id)}/revoke`,
    {
      method: 'POST',
      headers: localHeaders,
      body: '{}',
    },
  );
  const revokedCloseCode = await revokedClose;
  const revokedTicket = await fetch(`${bootstrap.relay_url}/api/remote/tickets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${transportToken}`,
      'X-Vops-Route-Id': deviceRouteId,
      Accept: 'application/json',
    },
  });
  if (revokedTicket.status !== 401) {
    throw new Error(`revoked device ticket returned HTTP ${revokedTicket.status}, expected 401`);
  }
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        pairingId: bootstrap.pairing_id,
        deviceId: decrypted.device.id,
        e2ee: 'xchacha20-poly1305',
        privateNotification: 'encrypted',
        sync: {
          targets: snapshot.targets.length,
          applications: snapshot.applications.length,
        },
        chat: {
          provider: chatResult.provider,
          conversationId: chatResult.conversationId,
          response: chatResult.text,
        },
        signedCommand: {
          type: commandPayload.type,
          state: authoritative.state,
          duplicateSuppressed: duplicate.duplicate,
          modifiedPlanRejected: staleResult.error.code,
          exactPlanDecision: denied.result.status,
        },
        reusedQrStatus: reused.status,
        revokedDevice: {
          socketCloseCode: revokedCloseCode,
          ticketStatus: revokedTicket.status,
        },
      },
      null,
      2,
    ) + '\n',
  );
}

async function waitForHello(pairingId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await json(`${localApi}/api/remote/pairings`, {
      method: 'GET',
      headers: localHeaders,
    });
    const pairing = rows.find((row) => row.id === pairingId);
    if (pairing?.status === 'hello_received') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('control node did not receive pairing hello');
}

function decrypt(envelope, exchange, nodeExchangePublicKey) {
  const { sharedRx } = sodium.crypto_kx_client_session_keys(
    exchange.publicKey,
    exchange.privateKey,
    decode(nodeExchangePublicKey),
  );
  const packed = decode(envelope.ciphertext);
  const nonceLength = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = packed.slice(0, nonceLength);
  const ciphertext = packed.slice(nonceLength);
  const metadata = { ...envelope };
  delete metadata.ciphertext;
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    canonicalize(metadata),
    nonce,
    sharedRx,
    'text',
  );
  return JSON.parse(plain);
}

function encrypt(metadata, payload, exchange, nodeExchangePublicKey) {
  const { sharedTx } = sodium.crypto_kx_client_session_keys(
    exchange.publicKey,
    exchange.privateKey,
    decode(nodeExchangePublicKey),
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    canonicalize(payload),
    canonicalize(metadata),
    null,
    nonce,
    sharedTx,
  );
  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce);
  packed.set(ciphertext, nonce.length);
  return { ...metadata, ciphertext: encode(packed) };
}

function waitForPayload(socket, exchange, nodeExchangePublicKey, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('encrypted response timed out'));
    }, timeoutMs);
    const onMessage = (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'envelope') return;
      try {
        const payload = decrypt(frame.envelope, exchange, nodeExchangePublicKey);
        socket.send(JSON.stringify({ type: 'delivery.ack', message_id: frame.envelope.message_id }));
        if (!predicate(payload)) return;
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(payload);
      } catch {
        // Another route or malformed envelope is not a matching response.
      }
    };
    socket.on('message', onMessage);
  });
}

function collectChat(socket, exchange, nodeExchangePublicKey, requestId) {
  return new Promise((resolve, reject) => {
    let text = '';
    let conversationId;
    let provider;
    let nextSequence = 1;
    let completed;
    const pending = new Map();
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('remote chat response timed out'));
    }, 100_000);
    const onMessage = (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'envelope') return;
      let payload;
      try {
        payload = decrypt(frame.envelope, exchange, nodeExchangePublicKey);
      } catch {
        return;
      }
      socket.send(JSON.stringify({ type: 'delivery.ack', message_id: frame.envelope.message_id }));
      if (payload.request_id !== requestId) return;
      if (payload.type === 'chat.accepted') {
        conversationId = payload.conversation_id;
        provider = payload.provider;
      }
      if (payload.type === 'chat.text_delta') {
        pending.set(payload.sequence, payload.delta);
        while (pending.has(nextSequence)) {
          text += pending.get(nextSequence);
          pending.delete(nextSequence);
          nextSequence += 1;
        }
      }
      if (payload.type === 'chat.failed') {
        clearTimeout(timeout);
        socket.off('message', onMessage);
        reject(new Error(`${payload.code}: ${payload.message}`));
      }
      if (payload.type === 'chat.completed') {
        completed = payload;
      }
      if (completed && nextSequence > completed.final_sequence) {
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve({ text, conversationId, provider });
      }
    };
    socket.on('message', onMessage);
  });
}

function collectCommand(socket, exchange, nodeExchangePublicKey, requestId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('remote command response timed out'));
    }, 20_000);
    const onMessage = (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'envelope') return;
      let payload;
      try {
        payload = decrypt(frame.envelope, exchange, nodeExchangePublicKey);
      } catch {
        return;
      }
      socket.send(JSON.stringify({ type: 'delivery.ack', message_id: frame.envelope.message_id }));
      if (payload.request_id !== requestId || !payload.type?.startsWith('command.')) return;
      if (payload.type === 'command.received') return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(payload);
    };
    socket.on('message', onMessage);
  });
}

function signCommand(payload, signing, exchange) {
  return {
    payload,
    key_id: deviceKeyId(signing, exchange),
    signature: encode(sodium.crypto_sign_detached(canonicalize(payload), signing.privateKey)),
  };
}

function deviceKeyId(signing, exchange) {
  return `key_${encode(sodium.crypto_generichash(
    18,
    `${encode(signing.publicKey)}.${encode(exchange.publicKey)}`,
    null,
  ))}`;
}

async function json(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function encode(value) {
  return sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function decode(value) {
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
