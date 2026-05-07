// SimplePool factory with NIP-42 auto-AUTH.
// All bots and admin tools sign relay AUTH challenges automatically.
import { SimplePool, finalizeEvent } from 'nostr-tools';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);

export function createPool(sk) {
  return new SimplePool({
    automaticallyAuth: () => async (evt) => finalizeEvent(evt, sk),
  });
}

export function parseGroupTarget(input) {
  const [relay, groupId] = String(input ?? '').trim().split('|');
  if (!relay || !groupId) {
    throw new Error('group target must be in the form "wss://relay|<groupId>"');
  }
  return { relay: relay.trim(), groupId: groupId.trim() };
}

export function parseGroupList(envValue) {
  return String(envValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseGroupTarget);
}
