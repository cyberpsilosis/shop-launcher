// Logging that cannot print a secret.
//
// Every value the launcher learns or makes (tokens, keys, webhook secrets,
// project refs, webhook ids) goes through mask() first. mask() emits the
// GitHub `::add-mask::` command, which the runner swallows and then replaces
// that value with *** in every later log line. On top of that, every line we
// print goes through redact(), which removes masked values and anything shaped
// like a provider secret, so a value we forgot to mask is still not printed.

export const SECRET_PATTERNS = [
  /whsec_[A-Za-z0-9+/=_-]+/g, // Stripe webhook signing secret
  /\b[rs]k_(?:test|live)_[A-Za-z0-9_]+/g, // Stripe restricted and secret keys
  /\bre_[A-Za-z0-9_]{6,}/g, // Resend API key
  /sb_secret_[A-Za-z0-9_-]+/g, // Supabase secret key
  /sbp_[A-Za-z0-9]{20,}/g, // Supabase access token
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // any JWT (legacy service_role)
];

export function createLog({ out = process.stdout } = {}) {
  const masked = new Set();

  function mask(value) {
    if (value === undefined || value === null) return;
    const v = String(value);
    if (v.length < 4 || masked.has(v)) return;
    masked.add(v);
    // One command per line: a value with a newline would otherwise leak its tail.
    for (const part of v.split(/\r?\n/)) if (part) out.write(`::add-mask::${part}\n`);
  }

  function redact(text) {
    let t = String(text);
    const values = [...masked].sort((a, b) => b.length - a.length);
    for (const v of values) t = t.split(v).join('***');
    for (const p of SECRET_PATTERNS) t = t.replace(p, '***');
    // A line that looks like a workflow command must not be forged by data we print.
    return t.replace(/^::/gm, ': :');
  }

  const line = (prefix) => (msg) => {
    for (const l of redact(msg).split('\n')) out.write(`${prefix}${l}\n`);
  };

  return {
    mask,
    redact,
    info: line(''),
    warn: line('::warning::'),
    error: line('::error::'),
    maskedCount: () => masked.size,
  };
}
