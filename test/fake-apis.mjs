// Local stand-ins for Supabase, Resend, Stripe and Cloudflare. No real
// account is touched. Each path the launcher calls behaves like the real API
// in the ways the launcher depends on: lists, creates, the one-time reveal of
// a webhook secret or key, names-only secret listings. Every request is
// logged (method, path) so tests can count writes.

import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

const rnd = (n = 12) => randomBytes(n).toString('hex');

export function newState() {
  return {
    requests: [],
    issued: [], // every secret value the fakes handed out, for the leak grep
    supabase: { projects: [], migrations: {}, keys: {}, missingPermissions: null },
    resend: { keys: [] },
    stripe: { endpoints: [] },
    cloudflare: { secrets: {}, tokenExpiresOn: null },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => resolve(b));
  });
}

function parseForm(text) {
  const out = { enabled_events: [], metadata: {} };
  for (const [k, v] of new URLSearchParams(text)) {
    let m;
    if ((m = k.match(/^enabled_events\[\d+\]$/))) out.enabled_events.push(v);
    else if ((m = k.match(/^metadata\[(.+)\]$/))) out.metadata[m[1]] = v;
    else out[k] = v;
  }
  return out;
}

export async function startFakes(state = newState()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const body = await readBody(req);
    state.requests.push({ method: req.method, path: p });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    let m;

    // ---- Supabase Management API -------------------------------------
    if (p.startsWith('/supabase/')) {
      const s = state.supabase;
      const q = p.slice('/supabase'.length);
      if (s.missingPermissions) return send(403, { message: 'Missing permissions', missing_permissions: s.missingPermissions });
      if (q === '/v1/projects' && req.method === 'GET') return send(200, s.projects);
      if (q === '/v1/projects' && req.method === 'POST') {
        const j = JSON.parse(body);
        const ref = 'fake' + rnd(8);
        const proj = { id: ref, ref, name: j.name, organization_id: j.organization_id, region: j.region, status: 'COMING_UP' };
        s.projects.push(proj);
        s.migrations[ref] = [];
        const secret = 'sb_secret_' + rnd(16);
        state.issued.push(secret);
        s.keys[ref] = [
          { name: 'anon', type: 'legacy', api_key: 'fake-anon-' + rnd(10) },
          { name: 'default', type: 'secret', api_key: secret },
        ];
        return send(201, { ...proj });
      }
      if ((m = q.match(/^\/v1\/projects\/([^/]+)$/)) && req.method === 'GET') {
        const proj = s.projects.find((x) => x.ref === m[1]);
        if (!proj) return send(404, { message: 'not found' });
        proj.status = 'ACTIVE_HEALTHY'; // healthy on the first poll
        return send(200, proj);
      }
      if ((m = q.match(/^\/v1\/projects\/([^/]+)\/database\/migrations$/))) {
        const list = s.migrations[m[1]];
        if (!list) return send(404, { message: 'not found' });
        if (req.method === 'GET') return send(200, list);
        if (req.method === 'POST') {
          const j = JSON.parse(body);
          const [version, ...rest] = j.name.split('_');
          list.push({ version, name: rest.join('_') });
          return send(200, {});
        }
      }
      if ((m = q.match(/^\/v1\/projects\/([^/]+)\/api-keys$/)) && req.method === 'GET') {
        const keys = s.keys[m[1]] || [];
        const reveal = url.searchParams.get('reveal') === 'true';
        return send(200, keys.map((k) => ({ ...k, api_key: reveal ? k.api_key : k.api_key.slice(0, 12) + '···' })));
      }
      return send(404, { message: 'no such fake route' });
    }

    // ---- Resend ----------------------------------------------------------
    if (p.startsWith('/resend/')) {
      const r = state.resend;
      const q = p.slice('/resend'.length);
      if (q === '/api-keys' && req.method === 'GET') return send(200, { data: r.keys.map(({ token, ...k }) => k) });
      if (q === '/api-keys' && req.method === 'POST') {
        const j = JSON.parse(body);
        if (j.permission !== 'sending_access') return send(422, { name: 'validation_error' });
        const k = { id: 'key-' + rnd(6), name: j.name, permission: j.permission, token: 're_' + rnd(16), created_at: new Date().toISOString() };
        state.issued.push(k.token);
        r.keys.push(k);
        return send(201, { id: k.id, token: k.token });
      }
      if ((m = q.match(/^\/api-keys\/([^/]+)$/)) && req.method === 'DELETE') {
        r.keys = r.keys.filter((k) => k.id !== m[1]);
        return send(200, {});
      }
      return send(404, { message: 'no such fake route' });
    }

    // ---- Stripe ------------------------------------------------------------
    if (p.startsWith('/stripe/')) {
      const st = state.stripe;
      const q = p.slice('/stripe'.length);
      const hide = ({ secret, ...e }) => e; // Stripe shows the secret only on create
      if (q === '/v1/webhook_endpoints' && req.method === 'GET') return send(200, { object: 'list', data: st.endpoints.map(hide) });
      if (q === '/v1/webhook_endpoints' && req.method === 'POST') {
        const f = parseForm(body);
        const e = { id: 'we_' + rnd(8), object: 'webhook_endpoint', url: f.url, enabled_events: f.enabled_events, metadata: f.metadata, status: 'enabled', secret: 'whsec_' + rnd(16) };
        state.issued.push(e.secret);
        st.endpoints.push(e);
        return send(200, e);
      }
      if ((m = q.match(/^\/v1\/webhook_endpoints\/([^/]+)$/))) {
        const e = st.endpoints.find((x) => x.id === m[1]);
        if (!e) return send(404, { error: { code: 'resource_missing' } });
        if (req.method === 'DELETE') {
          st.endpoints = st.endpoints.filter((x) => x.id !== m[1]);
          return send(200, { id: m[1], deleted: true });
        }
        if (req.method === 'POST') {
          e.enabled_events = parseForm(body).enabled_events;
          return send(200, hide(e));
        }
      }
      return send(404, { error: { code: 'resource_missing' } });
    }

    // ---- Cloudflare ------------------------------------------------------
    if (p.startsWith('/cloudflare/')) {
      const c = state.cloudflare;
      const q = p.slice('/cloudflare'.length);
      if (q === '/user/tokens/verify') return send(200, { success: true, result: { id: 'tok', status: 'active', expires_on: c.tokenExpiresOn } });
      if ((m = q.match(/^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/secrets$/))) {
        const w = c.secrets[m[2]];
        if (req.method === 'GET') {
          if (!w) return send(404, { success: false, errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }] });
          return send(200, { success: true, result: Object.keys(w).map((name) => ({ name, type: 'secret_text' })) });
        }
        if (req.method === 'PUT') {
          // Only the fake wrangler calls this, standing in for `wrangler deploy --secrets-file`.
          const j = JSON.parse(body);
          c.secrets[m[2]] = c.secrets[m[2]] || {};
          c.secrets[m[2]][j.name] = createHash('sha256').update(j.text).digest('hex');
          return send(200, { success: true });
        }
      }
      return send(404, { success: false });
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    base,
    env: {
      LAUNCHER_FAKE_APIS: '1',
      SUPABASE_API_URL: `${base}/supabase`,
      RESEND_API_URL: `${base}/resend`,
      STRIPE_API_URL: `${base}/stripe`,
      CLOUDFLARE_API_URL: `${base}/cloudflare`,
      FAKE_CF_URL: `${base}/cloudflare`,
    },
    writes: () => state.requests.filter((r) => r.method !== 'GET'),
    close: () => new Promise((r) => server.close(r)),
  };
}
