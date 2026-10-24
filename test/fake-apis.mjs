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
    stripe: { endpoints: [], sessions: [], events: [], refunds: [] },
    cloudflare: { secrets: {}, versions: {}, active: {}, tokenExpiresOn: null },
    resendEmails: [],
    rows: [], // the shop's orders table
    // The fake shop: what its Worker does with a payment. Tests flip these to force a failure.
    shop: { webhookAnswers: 200, writeRow: true, sendAlert: true, product: 'orb', pagesFail: [] },
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
    // ---- Resend emails (read) ---------------------------------------------
    if (p === '/resend/emails' && req.method === 'GET') {
      return send(200, { object: 'list', data: state.resendEmails.map(({ html, ...e }) => e) });
    }
    if ((m = p.match(/^\/resend\/emails\/([^/]+)$/)) && req.method === 'GET') {
      const e = state.resendEmails.find((x) => x.id === m[1]);
      return e ? send(200, e) : send(404, {});
    }

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
      // Test and live mode are separate worlds in one account: a key sees only its own mode's endpoints.
      const livemode = /^Bearer rk_live_/.test(req.headers.authorization || '');
      if (livemode) state.liveKeyCalls = (state.liveKeyCalls || 0) + 1;
      const mine = (e) => !!e.livemode === livemode;
      if (q === '/v1/webhook_endpoints' && req.method === 'GET') return send(200, { object: 'list', data: st.endpoints.filter(mine).map(hide) });
      if (q === '/v1/webhook_endpoints' && req.method === 'POST') {
        const f = parseForm(body);
        const e = { id: 'we_' + rnd(8), created: Math.floor(Date.now() / 1000) + st.endpoints.length, object: 'webhook_endpoint', url: f.url, enabled_events: f.enabled_events, metadata: f.metadata, status: 'enabled', livemode, secret: 'whsec_' + rnd(16) };
        state.issued.push(e.secret);
        st.endpoints.push(e);
        return send(200, e);
      }
      if ((m = q.match(/^\/v1\/webhook_endpoints\/([^/]+)$/))) {
        const e = st.endpoints.find((x) => x.id === m[1] && mine(x));
        if (!e) return send(404, { error: { code: 'resource_missing' } });
        if (req.method === 'DELETE') {
          st.endpoints = st.endpoints.filter((x) => x.id !== m[1]);
          return send(200, { id: m[1], deleted: true });
        }
        if (req.method === 'POST') {
          const f = parseForm(body);
          if (f.disabled !== undefined) e.status = f.disabled === 'true' ? 'disabled' : 'enabled';
          if (f.enabled_events.length) e.enabled_events = f.enabled_events;
          return send(200, hide(e));
        }
      }
      if ((m = q.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
        const ss = st.sessions.find((x) => x.id === m[1]);
        return ss ? send(200, ss) : send(404, { error: { code: 'resource_missing' } });
      }
      if (q === '/v1/events' && req.method === 'GET') {
        const type = url.searchParams.get('type');
        return send(200, { object: 'list', data: st.events.filter((e) => !type || e.type === type) });
      }
      if (q === '/v1/refunds' && req.method === 'POST') {
        const f = parseForm(body);
        const ss = st.sessions.find((x) => x.payment_intent === f.payment_intent);
        if (!ss) return send(400, { error: { code: 'resource_missing' } });
        const rf = { id: 're_fake' + rnd(4), object: 'refund', payment_intent: f.payment_intent, status: 'succeeded' };
        st.refunds.push(rf);
        return send(200, rf);
      }
      return send(404, { error: { code: 'resource_missing' } });
    }

    // ---- The shop's PostgREST ----------------------------------------------
    if (p === '/rest/v1/orders') {
      if (!/^sb_secret_/.test(req.headers.apikey || '')) return send(401, { message: 'no service key' });
      const sid = (url.searchParams.get('stripe_session_id') || '').replace(/^eq\./, '');
      const hits = state.rows.filter((r) => r.stripe_session_id === sid);
      if (req.method === 'GET') return send(200, hits);
      if (req.method === 'PATCH') {
        const j = JSON.parse(body);
        for (const r of hits) Object.assign(r, j);
        res.writeHead(204);
        return res.end();
      }
    }

    // ---- The fake shop (its Worker, served from the active version) ----------
    if (p.startsWith('/site')) {
      const q = p.slice('/site'.length) || '/';
      const w = 'orb-shop';
      const v = (state.cloudflare.versions[w] || []).find((x) => x.id === state.cloudflare.active[w]);
      const sh = state.shop;
      if (q === '/api/version') return send(200, { commit: v?.commit || 'local', branch: 'main', build: 'fake' });
      if (q === '/api/probe') return send(200, { probe: v?.secrets?.PROBE || null });
      if (['/', `/shop/${sh.product}`, '/start', '/returns'].includes(q)) return send(sh.pagesFail.includes(q) ? 500 : 200, { page: q });
      if ((m = q.match(/^\/orders\/([^/]+)$/)) && req.method === 'GET') return send(url.searchParams.get('t') === 'tok' + m[1].slice(-6) ? 200 : 403, {});
      if ((m = q.match(/^\/api\/orders\/([^/]+)\/ship$/)) && req.method === 'POST') {
        const f = new URLSearchParams(body);
        const row = state.rows.find((r) => r.id === m[1]);
        if (!row || f.get('t') !== 'tok' + m[1].slice(-6)) return send(403, {});
        Object.assign(row, { status: 'shipped', tracking_number: f.get('tracking_number'), carrier: f.get('carrier'), shipped_email_at: new Date().toISOString() });
        res.writeHead(303, { location: `/orders/${row.id}?done=sent` });
        return res.end();
      }
      if (q === '/__fake_pay' && req.method === 'POST') {
        // Stripe Checkout, then Stripe calling the shop's webhook, then the shop's work.
        const j = JSON.parse(body);
        const ss = { id: 'cs_test_' + rnd(8), object: 'checkout.session', livemode: false, payment_status: 'paid', payment_intent: 'pi_' + rnd(8), customer_email: j.email };
        state.stripe.sessions.push(ss);
        const delivered = sh.webhookAnswers >= 200 && sh.webhookAnswers < 300;
        state.stripe.events.unshift({ id: 'evt_' + rnd(6), type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), pending_webhooks: delivered ? 0 : 1, data: { object: { id: ss.id } } });
        if (delivered && sh.writeRow) {
          const row = { id: 'ord' + rnd(6), stripe_session_id: ss.id, stripe_payment_intent: ss.payment_intent, status: 'paid', email: j.email, alert_email_at: null, shipped_email_at: null, tracking_number: null, supplier_order_ref: null };
          state.rows.push(row);
          if (sh.sendAlert) {
            row.alert_email_at = new Date().toISOString();
            state.resendEmails.unshift({ id: 'em_' + rnd(6), subject: 'New order ABC123: buy 1 orb', created_at: new Date().toISOString(), last_event: 'delivered', html: `<a href="${base}/site/orders/${row.id}?t=tok${row.id.slice(-6)}">Add tracking</a>` });
          }
        }
        return send(200, { sessionId: ss.id });
      }
      return send(404, {});
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
      }
      if ((m = q.match(/^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/deployments$/))) {
        if (!c.active[m[2]]) return send(404, { success: false });
        // Newest first, as Cloudflare lists them; a rollback is a deployment too.
        const ids = c.history?.[m[2]] || [c.active[m[2]]];
        return send(200, { success: true, result: { deployments: ids.map((id, i) => ({ id: 'dep' + i, versions: [{ version_id: id, percentage: 100 }] })) } });
      }
      if ((m = q.match(/^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/versions\/([^/]+)$/)) && req.method === 'GET') {
        const ver = (c.versions[m[2]] || []).find((x) => x.id === m[3]);
        if (!ver) return send(404, { success: false });
        return send(200, { success: true, result: { id: ver.id, resources: { bindings: Object.keys(ver.secrets).map((name) => ({ type: 'secret_text', name })) } } });
      }
      // Fake wrangler only: `wrangler deploy` makes a new version holding the
      // earlier version's secrets plus the new ones (as Workers does), and
      // `wrangler rollback <id>` makes an old version active again.
      if (q === '/fake/deploy' && req.method === 'POST') {
        const j = JSON.parse(body);
        const vs = (c.versions[j.worker] = c.versions[j.worker] || []);
        const cur = vs.find((x) => x.id === c.active[j.worker]);
        const secrets = { ...(cur?.secrets || {}) };
        for (const [k, v] of Object.entries(j.secrets || {})) secrets[k] = createHash('sha256').update(v).digest('hex');
        const ver = { id: 'ver-' + rnd(6), commit: j.commit || cur?.commit || 'local', secrets };
        vs.push(ver);
        c.active[j.worker] = ver.id;
        (c.history = c.history || {})[j.worker] = [ver.id, ...(c.history[j.worker] || [])];
        c.secrets[j.worker] = secrets;
        return send(200, { success: true, result: { id: ver.id } });
      }
      if (q === '/fake/rollback' && req.method === 'POST') {
        const j = JSON.parse(body);
        const ver = (c.versions[j.worker] || []).find((x) => x.id === j.version);
        if (!ver) return send(404, { success: false });
        c.active[j.worker] = ver.id;
        c.secrets[j.worker] = ver.secrets;
        (c.history = c.history || {})[j.worker] = [ver.id, ...(c.history[j.worker] || [])];
        return send(200, { success: true });
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
      SUPABASE_REST_URL: base,
      SHOP_SITE_URL: `${base}/site`,
      STRIPE_API_URL: `${base}/stripe`,
      CLOUDFLARE_API_URL: `${base}/cloudflare`,
      FAKE_CF_URL: `${base}/cloudflare`,
    },
    writes: () => state.requests.filter((r) => r.method !== 'GET'),
    close: () => new Promise((r) => server.close(r)),
  };
}
