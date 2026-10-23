// The post-deploy smoke: seven checks against the shop as deployed, on Stripe
// test keys only. Each check reads the real system it names (the shop's pages,
// Stripe, the shop's orders table, Resend). Each one returns pass or fail with
// one plain line saying why, so the job summary reads as seven lines.
//
// Nothing here prints a value: ids are masked as soon as they are learned.

export const CHECKS = [
  { id: 'pages', title: 'Pages answer 200 and /api/version is main' },
  { id: 'pay', title: 'Test payment with 4242 4242 4242 4242 on Stripe Checkout' },
  { id: 'webhook', title: 'Stripe delivered the webhook (2xx)' },
  { id: 'order_row', title: 'One order row for that session' },
  { id: 'alert_email', title: 'Order alert email sent' },
  { id: 'tracking', title: 'Add tracking link saves a tracking number' },
  { id: 'refund', title: 'Test payment refunded and row marked test' },
];
export const TRACKING_NUMBER = 'LP00123456789CN';
// Resend's own test inbox: accepts mail and reaches no person (P3: test order
// emails go only to Elijah's alert address, never to anyone else).
export const BUYER_EMAIL = 'delivered@resend.dev';
export const TEST_MARK = 'test: shop-launcher smoke';

class CheckFailed extends Error {}
const fail = (m) => {
  throw new CheckFailed(m);
};

// Poll until fn returns a truthy value or the tries run out.
async function until(fn, { tries, sleep }) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    if (i < tries - 1) await sleep();
  }
  return null;
}

/**
 * deps:
 *   http        the launcher's HTTP client (counts writes)
 *   bases       provider API bases
 *   env         STRIPE_SECRET_KEY, RESEND_ADMIN_KEY, SUPABASE_ACCESS_TOKEN
 *   shopConfig  shops/<slug>.json (siteUrl, smoke.product)
 *   expectCommit  the shop main commit just deployed
 *   browser     { pay({ productUrl, email }) -> { sessionId } }  (Playwright in CI)
 *   sb          supabase provider (serviceKey)
 *   supabaseRef the shop's project ref
 *   fetchImpl, log, sleep, tries, now, runId
 */
export async function runSmoke(deps) {
  const { http, bases, env, shopConfig, expectCommit, browser, sb, supabaseRef, log } = deps;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = deps.sleep || (() => new Promise((r) => setTimeout(r, 5000)));
  const tries = deps.tries ?? 36; // 3 minutes at 5 s
  const site = shopConfig.siteUrl.replace(/\/$/, '');
  const product = shopConfig.smoke?.product;
  const results = [];
  const ctx = { t0: Math.floor((deps.now ? deps.now() : new Date()).getTime() / 1000) - 60 };

  const stripeReq = (path, o = {}) => http.request('stripe', bases.stripe, path, { ...o, headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  const resendReq = (path, o = {}) => http.request('resend', bases.resend, path, { ...o, headers: { authorization: `Bearer ${env.RESEND_ADMIN_KEY}` } });
  const restBase = () => (bases.supabaseRest ? bases.supabaseRest(supabaseRef) : `https://${supabaseRef}.supabase.co`);
  const rest = async (path, o = {}) => {
    if (!ctx.serviceKey) {
      ctx.serviceKey = await sb.serviceKey(supabaseRef);
      log.mask(ctx.serviceKey);
    }
    return http.request('supabase_rest', restBase(), path, {
      ...o,
      headers: { apikey: ctx.serviceKey, authorization: `Bearer ${ctx.serviceKey}`, ...(o.headers || {}) },
    });
  };
  const readRows = async () => {
    const { data } = await rest(
      `/rest/v1/orders?stripe_session_id=eq.${encodeURIComponent(ctx.sessionId)}&select=id,stripe_session_id,stripe_payment_intent,status,alert_email_at,shipped_email_at,tracking_number,supplier_order_ref`,
    );
    return Array.isArray(data) ? data : [];
  };

  const steps = {
    async pages() {
      const paths = ['/', `/shop/${product}`, '/start', '/returns'];
      const bad = [];
      for (const p of paths) {
        const r = await fetchImpl(site + p, { redirect: 'manual' });
        await r.arrayBuffer().catch(() => null);
        if (r.status !== 200) bad.push(`${p} answered ${r.status}`);
      }
      const v = await fetchImpl(`${site}/api/version`).then((r) => r.json()).catch(() => null);
      const commit = v?.commit;
      if (bad.length) fail(bad.join(', '));
      if (!commit || commit !== expectCommit) fail(`/api/version says ${String(commit).slice(0, 7)}, main is ${String(expectCommit).slice(0, 7)}`);
      return `${paths.length} pages 200, /api/version ${commit.slice(0, 7)} = main`;
    },
    async pay() {
      const out = await browser.pay({ productUrl: `${site}/shop/${product}`, email: BUYER_EMAIL });
      if (!out?.sessionId || !/^cs_test_/.test(out.sessionId)) fail('Checkout did not return to /shop/thanks with a test session');
      ctx.sessionId = out.sessionId;
      log.mask(ctx.sessionId);
      const { data } = await stripeReq(`/v1/checkout/sessions/${ctx.sessionId}`);
      if (data?.livemode !== false) fail('the session is not test mode');
      if (data?.payment_status !== 'paid') fail(`Stripe says payment_status ${data?.payment_status}`);
      ctx.paymentIntent = data.payment_intent;
      log.mask(ctx.paymentIntent);
      return 'paid in test mode, returned to /shop/thanks';
    },
    async webhook() {
      // Stripe counts an event's undelivered webhooks in pending_webhooks; it
      // reaches 0 only when every endpoint answered 2xx.
      const ev = await until(async () => {
        const { data } = await stripeReq(`/v1/events?type=checkout.session.completed&created[gte]=${ctx.t0}&limit=100`);
        const e = (data?.data || []).find((x) => x.data?.object?.id === ctx.sessionId);
        return e && e.pending_webhooks === 0 ? e : null;
      }, { tries, sleep: deps.sleep || sleep });
      if (!ev) fail('Stripe still has an undelivered webhook for this session (no 2xx from /api/stripe/webhook)');
      // Cross-check from the shop's side: the shop records a delivery as its order row.
      const rows = await until(async () => {
        const r = await readRows();
        return r.length ? r : null;
      }, { tries, sleep });
      if (!rows) fail('Stripe says delivered, but the shop has no row for the session');
      ctx.rows = rows;
      return 'Stripe event delivered (pending_webhooks 0); the shop recorded it';
    },
    async order_row() {
      const rows = ctx.rows || (await readRows());
      const sessions = new Set(rows.map((r) => r.stripe_session_id));
      if (rows.length === 0) fail('no order row for the session');
      if (sessions.size !== 1) fail(`${sessions.size} sessions matched`);
      if (rows.some((r) => r.status !== 'paid')) fail(`row status ${rows.map((r) => r.status).join(',')}, expected paid`);
      ctx.orderId = rows[0].id;
      log.mask(ctx.orderId);
      return `1 session, ${rows.length} line${rows.length > 1 ? 's' : ''}, status paid`;
    },
    async alert_email() {
      const row = await until(async () => (await readRows()).find((r) => r.id === ctx.orderId && r.alert_email_at), { tries, sleep });
      if (!row) fail('alert_email_at is still empty on the row');
      const found = await until(async () => {
        const { data } = await resendReq('/emails?limit=100');
        for (const e of data?.data || []) {
          if (!/^New order /.test(e.subject || '') || Date.parse(e.created_at) / 1000 < ctx.t0) continue;
          const { data: full } = await resendReq(`/emails/${e.id}`);
          const m = String(full?.html || '').match(new RegExp(`https?://[^"'\\s<>]*/orders/${ctx.orderId}\\?t=([A-Za-z0-9]+)`));
          if (m) return { email: full, link: m[0].replace(/&amp;/g, '&'), token: m[1] };
        }
        return null;
      }, { tries, sleep });
      if (!found) fail('no "New order" email in Resend links to this order');
      log.mask(found.token);
      log.mask(found.email.id);
      if (['bounced', 'failed', 'complained'].includes(found.email.last_event)) fail(`Resend says the alert ${found.email.last_event}`);
      ctx.link = found.link;
      ctx.token = found.token;
      return `alert_email_at set; Resend has the email (${found.email.last_event || 'queued'})`;
    },
    async tracking() {
      // The same request the form on the alert's link sends.
      const page = await fetchImpl(ctx.link);
      if (page.status !== 200) fail(`the Add tracking link answered ${page.status}`);
      const body = new URLSearchParams({ t: ctx.token, carrier: 'Test', tracking_number: TRACKING_NUMBER, supplier_order_ref: '' });
      const r = await fetchImpl(`${site}/api/orders/${ctx.orderId}/ship`, { method: 'POST', body, redirect: 'manual' });
      if (r.status !== 303) fail(`saving the tracking number answered ${r.status}`);
      const row = await until(async () => (await readRows()).find((x) => x.id === ctx.orderId && x.tracking_number === TRACKING_NUMBER && x.shipped_email_at), { tries: 6, sleep });
      if (!row) fail('the row has no tracking number or no shipped_email_at after the form');
      return `${TRACKING_NUMBER} saved, shipped email sent`;
    },
    async refund() {
      if (!ctx.paymentIntent) fail('no payment to refund');
      const { data } = await stripeReq('/v1/refunds', { method: 'POST', form: [['payment_intent', ctx.paymentIntent], ['metadata[shop_launcher]', 'smoke']] });
      if (!['succeeded', 'pending'].includes(data?.status)) fail(`Stripe refund status ${data?.status}`);
      const mark = `${TEST_MARK} ${deps.runId || ''}`.trim();
      await rest(`/rest/v1/orders?stripe_session_id=eq.${encodeURIComponent(ctx.sessionId)}`, {
        method: 'PATCH',
        json: { status: 'refunded', supplier_order_ref: mark },
        headers: { prefer: 'return=minimal' },
      });
      const rows = await readRows();
      if (!rows.length || rows.some((r) => r.status !== 'refunded' || r.supplier_order_ref !== mark)) fail('the row is not marked refunded and test');
      return `refund ${data.status}; row refunded, marked "${TEST_MARK}"`;
    },
  };

  let stopped = null;
  for (const c of CHECKS) {
    if (stopped) {
      results.push({ id: c.id, title: c.title, ok: false, skipped: true, detail: `not run: ${stopped} failed first` });
      continue;
    }
    try {
      const detail = await steps[c.id]();
      results.push({ id: c.id, title: c.title, ok: true, detail: log.redact(detail) });
    } catch (e) {
      const why = e instanceof CheckFailed ? e.message : `error: ${e.message}`;
      results.push({ id: c.id, title: c.title, ok: false, detail: log.redact(why) });
      stopped = c.id;
    }
  }
  // A payment that went through is refunded even when a later check failed.
  if (stopped && ctx.paymentIntent && !results.find((r) => r.id === 'refund')?.ok) {
    try {
      await steps.refund();
      results.find((r) => r.id === 'refund').detail = 'refunded after the failure above; row marked test';
    } catch (e) {
      log.warn(`could not refund the test payment: ${log.redact(e.message)}`);
    }
  }
  return results;
}
