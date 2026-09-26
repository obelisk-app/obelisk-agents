// Zap parsing shared by zap-bot and ranks-bot.
//
// A zap reaches a NIP-29 group either as a kind 9735 receipt (h tag on the
// receipt or inside its embedded kind 9734 request) or as a group-local
// kind 7 "⚡" reaction carrying bolt11/amount metadata. zapCandidate()
// normalizes both into { type, groupIds, senderHex, recipient, sats, eTag }.

export const ZAP_KINDS = [7, 9735];

// ── BOLT-11 amount parser ───────────────────────────────────────────
// Spec: `ln{network}{amount}{multiplier}1{data}` where multiplier ∈ {m,u,n,p}.
// 1 BTC = 1e8 sats = 1e11 msats. Returns msats or null.
export function bolt11AmountMsat(bolt11) {
  if (!bolt11) return null;
  const m = /^ln[a-z]{2,5}(?:(\d+)([munp]?))?1/i.exec(bolt11);
  if (!m || !m[1]) return null;
  const amount = BigInt(m[1]);
  switch ((m[2] || '').toLowerCase()) {
    case 'm': return Number(amount * 100_000_000n);
    case 'u': return Number(amount * 100_000n);
    case 'n': return Number(amount * 100n);
    case 'p': return Number(amount / 10n);
    case '':  return Number(amount * 100_000_000_000n);
    default:  return null;
  }
}

export function tagValue(tags, name) {
  if (!Array.isArray(tags)) return null;
  const t = tags.find((x) => x[0] === name);
  return t ? t[1] : null;
}

function tagByName(tags, name) {
  if (!Array.isArray(tags)) return null;
  return tags.find((x) => x[0] === name) || null;
}

function parseDescription(desc) {
  if (!desc) return null;
  try {
    const v = JSON.parse(desc);
    return v && typeof v === 'object' && Array.isArray(v.tags) ? v : null;
  } catch { return null; }
}

function amountValueSats(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const normalized = String(unit || '').toLowerCase();
  const sats = ['sat', 'sats', 'satoshi', 'satoshis'].includes(normalized)
    ? v
    : v / 1000;
  const wholeSats = Math.floor(sats);
  return wholeSats > 0 ? wholeSats : null;
}

function amountTagSats(tags, name, defaultUnit = 'msat') {
  const t = tagByName(tags, name);
  if (!t) return null;
  return amountValueSats(t[1], t[2] || defaultUnit);
}

function receiptAmountSats(receipt, zapReq) {
  const r1 = amountTagSats(receipt.tags, 'amount');
  if (r1) return r1;
  if (zapReq) {
    const r2 = amountTagSats(zapReq.tags, 'amount');
    if (r2) return r2;
  }
  const msat = bolt11AmountMsat(tagValue(receipt.tags, 'bolt11'));
  if (msat) return Math.floor(msat / 1000);
  return null;
}

function reactionAmountSats(reaction) {
  const bolt11 = bolt11AmountMsat(tagValue(reaction.tags, 'bolt11'));
  if (bolt11) {
    const sats = Math.floor(bolt11 / 1000);
    if (sats > 0) return sats;
  }
  return amountTagSats(reaction.tags, 'amount')
    || amountTagSats(reaction.tags, 'msat')
    || amountTagSats(reaction.tags, 'msats')
    || amountTagSats(reaction.tags, 'millisats')
    || amountTagSats(reaction.tags, 'sat', 'sat')
    || amountTagSats(reaction.tags, 'sats', 'sat');
}

export function isZapReaction(ev) {
  return ev.kind === 7 && typeof ev.content === 'string' && ev.content.includes('⚡');
}

export function zapCandidate(ev) {
  if (ev.kind === 9735) {
    const zapReq = parseDescription(tagValue(ev.tags, 'description'));
    return {
      type: 'receipt',
      groupIds: [tagValue(ev.tags, 'h'), zapReq && tagValue(zapReq.tags, 'h')].filter(Boolean),
      senderHex: tagValue(ev.tags, 'P') || (zapReq && zapReq.pubkey) || null,
      recipient: tagValue(ev.tags, 'p'),
      sats: receiptAmountSats(ev, zapReq),
      eTag: tagValue(ev.tags, 'e'),
    };
  }

  if (isZapReaction(ev)) {
    return {
      type: 'reaction',
      groupIds: [tagValue(ev.tags, 'h')].filter(Boolean),
      senderHex: ev.pubkey,
      recipient: tagValue(ev.tags, 'p'),
      sats: reactionAmountSats(ev),
      eTag: tagValue(ev.tags, 'e'),
    };
  }

  return null;
}
