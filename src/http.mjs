// One HTTP client for every provider.
//
// In plan mode it refuses anything but GET before a byte leaves the machine,
// so a bug in the plan path cannot write. It records every call (method, host,
// path; never headers or bodies) so the summary can state how many writes ran.
// Errors carry the provider, method, path and status, plus only the fields we
// know are safe (Supabase's missing_permissions, an error code). Response
// bodies are never printed.

export class HttpError extends Error {
  constructor({ provider, method, path, status, code, missingPermissions }) {
    super(`${provider} ${method} ${path} answered ${status}${code ? ` (${code})` : ''}`);
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.missingPermissions = missingPermissions || [];
  }
}

export class PlanWriteRefused extends Error {}

const FAKE_HOST = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

// Real endpoints. A test may point them at a local fake, and only at a local
// one, and only when LAUNCHER_FAKE_APIS=1; launch.yml never sets that.
export function apiBases(env) {
  const bases = {
    supabase: 'https://api.supabase.com',
    resend: 'https://api.resend.com',
    stripe: 'https://api.stripe.com',
    cloudflare: 'https://api.cloudflare.com/client/v4',
  };
  if (env.LAUNCHER_FAKE_APIS === '1') {
    for (const k of Object.keys(bases)) {
      const o = env[`${k.toUpperCase()}_API_URL`];
      if (o) {
        if (!FAKE_HOST.test(o)) throw new Error(`${k.toUpperCase()}_API_URL may only point at 127.0.0.1 or localhost`);
        bases[k] = o.replace(/\/$/, '');
      }
    }
  }
  return bases;
}

export function createHttp({ mode, fetchImpl = globalThis.fetch }) {
  const calls = [];

  async function request(provider, base, path, { method = 'GET', headers = {}, json, form, allow = [] } = {}) {
    const pathOnly = path.split('?')[0];
    if (mode === 'plan' && method !== 'GET') {
      throw new PlanWriteRefused(`plan mode refused ${method} ${provider} ${pathOnly}`);
    }
    let body;
    const h = { ...headers };
    if (json !== undefined) {
      body = JSON.stringify(json);
      h['content-type'] = 'application/json';
    } else if (form !== undefined) {
      body = new URLSearchParams(form).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const url = base + path;
    calls.push({ provider, method, host: new URL(url).host, path: pathOnly });
    const res = await fetchImpl(url, { method, headers: h, body });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok && !allow.includes(res.status)) {
      const missing = Array.isArray(data?.missing_permissions) ? data.missing_permissions.map(String) : [];
      const code = typeof data?.error?.code === 'string' ? data.error.code : typeof data?.code === 'string' ? data.code : undefined;
      throw new HttpError({ provider, method, path: pathOnly, status: res.status, code, missingPermissions: missing });
    }
    return { status: res.status, data };
  }

  return {
    request,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET').length,
  };
}
