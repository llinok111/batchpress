/**
 * Error taxonomy.
 *
 * Retry is only safe for failures that did not change observable state:
 * lock contention, timeouts, and worker death. Everything that is a property
 * of the *input* (corrupt, unsupported, missing, permission) will fail again
 * identically, so retrying it only burns time and produces duplicate logs.
 */
const TRANSIENT_CODES = new Set(['EBUSY', 'EAGAIN', 'ETIMEDOUT', 'EWORKER_CRASH', 'EMFILE']);

const RULES = [
  {
    code: 'ENOSPC',
    test: (raw, msg) => raw === 'ENOSPC' || /no space left|ENOSPC/i.test(msg),
    retryable: false
  },
  {
    code: 'ETIMEDOUT',
    test: (raw, msg) => raw === 'ETIMEDOUT' || /exceeded .*ms/i.test(msg),
    retryable: true
  },
  {
    code: 'EWORKER_CRASH',
    test: (raw) => raw === 'EWORKER_CRASH',
    retryable: true
  },
  {
    code: 'EBUSY',
    test: (raw) => raw === 'EBUSY' || raw === 'EAGAIN',
    retryable: true
  },
  {
    code: 'ENOENT',
    test: (raw, msg) => raw === 'ENOENT' || /missing|no such file/i.test(msg),
    retryable: false
  },
  {
    code: 'EPERM',
    test: (raw) => raw === 'EACCES' || raw === 'EPERM',
    retryable: false
  },
  {
    code: 'EEMPTY',
    test: (_raw, msg) => /buffer is empty|file is empty|zero-length/i.test(msg),
    retryable: false
  },
  {
    code: 'EFORMAT',
    test: (_raw, msg) => /unsupported image format|Input buffer contains|unsupported.*format/i.test(msg),
    retryable: false
  },
  {
    code: 'ECORRUPT',
    test: (_raw, msg) =>
      /premature end|truncated|corrupt|invalid|VipsForeign|unable to load|bogus/i.test(msg),
    retryable: false
  },
  {
    // libvips sometimes surfaces a truncated JPEG as a bare "Unknown error"
    // instead of "premature end of JPEG image". Measured on the same 500-byte
    // truncation: 3 of 200 runs. That is a message-level flake inside the
    // decoder, not a different failure, so it belongs with ECORRUPT.
    //
    // The alternative -- letting it fall through to EUNKNOWN -- is worse: the
    // reported code for a byte-identical input would become non-deterministic,
    // and an operator comparing two runs would see the same file classified two
    // different ways.
    code: 'ECORRUPT',
    test: (_raw, msg) => /^unknown error$/i.test(msg.trim()),
    retryable: false
  }
];

export function classifyError(error, { retryUnknown = false } = {}) {
  const raw = String((error && error.code) || '');
  const msg = String((error && error.message) || error || '');
  for (const rule of RULES) {
    if (rule.test(raw, msg)) {
      return { code: rule.code, retryable: rule.retryable, message: msg || rule.code };
    }
  }
  if (TRANSIENT_CODES.has(raw)) return { code: raw, retryable: true, message: msg || raw };
  return { code: 'EUNKNOWN', retryable: retryUnknown, message: msg || 'unknown error' };
}

/** Exponential backoff with jitter, capped so a retry never stalls a batch. */
export function backoffMs(attempt, rand = Math.random) {
  const base = Math.min(3000, 150 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + 0.5 * rand()));
}
