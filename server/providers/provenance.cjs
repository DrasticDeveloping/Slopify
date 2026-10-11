function boundedText(value, maximumLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maximumLength) : null;
}

function safeURL(value, maximumLength = 8_192) {
  const text = boundedText(value, maximumLength);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isEphemeralProviderMediaURL(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 8_192) return false;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLocaleLowerCase();
    const path = url.pathname.toLocaleLowerCase();
    if (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) return true;
    if (host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")) {
      return path.includes("/videoplayback") || path.includes("/audio/") || path.includes("/video/");
    }
    if (host === "sndcdn.com" || host.endsWith(".sndcdn.com")) return true;
    if (host === "scdn.co" || host.endsWith(".scdn.co")) return true;
    if (host === "p.scdn.co" || host.endsWith(".p.scdn.co")) return true;
    if (host === "api-v2.soundcloud.com" && path.startsWith("/media/")) return true;
    return false;
  } catch {
    return false;
  }
}

function containsEphemeralProviderMediaURL(value) {
  const text = typeof value === "string" ? value : "";
  return /(?:googlevideo\.com|googleusercontent\.com|sndcdn\.com|scdn\.co)(?:[/:?#]|$)/i.test(text);
}

function canonicalSourceURL(value) {
  const source = safeURL(value);
  return source && !isEphemeralProviderMediaURL(source) ? source : null;
}

function preservedMediaSourceURL(value) {
  const source = canonicalSourceURL(value);
  if (!source) return null;
  try {
    return new URL(source).hash ? null : source;
  } catch {
    return null;
  }
}

function sanitizePersistedSourceIdentity(value, fallback = {}) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const identity = normalizeSourceIdentity(candidate, fallback);
  if (!identity) return null;
  const sanitize = (current) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    const sourcePageURL = canonicalSourceURL(current.sourcePageURL || current.sourceURL);
    const mediaSourceURL = canonicalSourceURL(current.mediaSourceURL);
    const aliases = Array.isArray(current.aliases)
      ? current.aliases.map(sanitize).filter(Boolean).slice(0, 8)
      : [];
    const normalized = {
      ...current,
      sourcePageURL,
      mediaSourceURL,
    };
    if (aliases.length) normalized.aliases = aliases;
    else delete normalized.aliases;
    return normalized;
  };
  return sanitize(identity);
}

function sanitizePersistedSourceIdentities(value, additional = []) {
  const candidates = [
    ...(Array.isArray(value) ? value : []),
    ...(Array.isArray(additional) ? additional : [additional]),
  ];
  const seen = new Set();
  const identities = [];
  for (const candidate of candidates) {
    const identity = sanitizePersistedSourceIdentity(candidate);
    if (!identity) continue;
    const key = JSON.stringify([
      identity.provider,
      identity.providerID,
      identity.sourcePageURL,
      identity.mediaSourceURL,
      identity.confidence,
      identity.score,
      identity.evidence,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push(identity);
    if (identities.length >= 8) break;
  }
  return identities;
}

function sanitizePersistedJSON(value) {
  if (typeof value === "string") return isEphemeralProviderMediaURL(value) ? null : value;
  if (Array.isArray(value)) return value.map(sanitizePersistedJSON);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !containsEphemeralProviderMediaURL(key))
      .map(([key, current]) => [key, sanitizePersistedJSON(current)]));
  }
  return value;
}

function boundedEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).slice(0, 24).flatMap(([key, candidate]) => {
    const safeKey = boundedText(key, 64);
    if (!safeKey) return [];
    if (typeof candidate === "string") return [[safeKey, candidate.slice(0, 500)]];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return [[safeKey, candidate]];
    if (typeof candidate === "boolean") return [[safeKey, candidate]];
    return [];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

function normalizeSingleSourceIdentity(value, fallback = {}) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const provider = boundedText(candidate.provider || fallback.provider, 64);
  const providerID = boundedText(candidate.providerID || candidate.providerId || fallback.providerID, 256);
  const sourcePageURL = safeURL(candidate.sourcePageURL || candidate.sourceURL || fallback.sourcePageURL || fallback.sourceURL);
  const mediaSourceURL = safeURL(candidate.mediaSourceURL || fallback.mediaSourceURL);
  const confidenceText = boundedText(candidate.confidence || fallback.confidence, 64);
  const rawScore = Number(candidate.score ?? fallback.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(1, rawScore)) : null;
  const evidence = boundedEvidence(candidate.evidence || fallback.evidence);
  if (!provider && !providerID && !sourcePageURL && !mediaSourceURL && !confidenceText && score === null && !evidence) return null;
  return {
    provider,
    providerID,
    sourcePageURL,
    mediaSourceURL,
    confidence: confidenceText,
    score,
    evidence,
  };
}

function normalizeSourceIdentities(value, additional = []) {
  const candidates = [
    ...(Array.isArray(value) ? value : []),
    ...(Array.isArray(additional) ? additional : [additional]),
  ];
  const seen = new Set();
  const identities = [];
  for (const candidate of candidates) {
    const identity = normalizeSingleSourceIdentity(candidate);
    if (!identity) continue;
    const key = JSON.stringify([
      identity.provider,
      identity.providerID,
      identity.sourcePageURL,
      identity.mediaSourceURL,
      identity.confidence,
      identity.score,
      identity.evidence,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push(identity);
    if (identities.length >= 8) break;
  }
  return identities;
}

function normalizeSourceIdentity(value, fallback = {}) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const identity = normalizeSingleSourceIdentity(candidate, fallback);
  if (!identity) return null;
  const aliases = normalizeSourceIdentities(candidate.aliases, fallback.aliases);
  return aliases.length ? { ...identity, aliases } : identity;
}

module.exports = {
  isEphemeralProviderMediaURL,
  normalizeSourceIdentity,
  normalizeSourceIdentities,
  preservedMediaSourceURL,
  sanitizePersistedJSON,
  sanitizePersistedSourceIdentities,
  sanitizePersistedSourceIdentity,
};
