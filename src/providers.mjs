// Read and write calls for each provider. Reads are used by plan and apply
// alike; writes run in apply only (the HTTP client refuses them in plan).
// Every resource is found by a name or tag that comes from the shop slug, so a
// second run finds what the first one made.

export const WEBHOOK_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

export function supabase(http, base, env) {
  const auth = { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` };
  const req = (path, o = {}) => http.request('supabase', base, path, { ...o, headers: auth });
  return {
    async findProject(name, orgId) {
      const { data } = await req('/v1/projects');
      const list = Array.isArray(data) ? data : [];
      return list.find((p) => p.name === name && (!orgId || p.organization_id === orgId || p.organization_slug === orgId)) || null;
    },
    async createProject({ name, orgId, region, dbPass }) {
      const { data } = await req('/v1/projects', {
        method: 'POST',
        json: { name, organization_id: orgId, region, db_pass: dbPass },
      });
      return data;
    },
    async getProject(ref) {
      const { data } = await req(`/v1/projects/${ref}`);
      return data;
    },
    async listMigrations(ref) {
      const { data } = await req(`/v1/projects/${ref}/database/migrations`);
      return Array.isArray(data) ? data : [];
    },
    async applyMigration(ref, { name, query }) {
      await req(`/v1/projects/${ref}/database/migrations`, { method: 'POST', json: { name, query } });
    },
    // Returns the server-side key. Called only when a Cloudflare secret needs it.
    async serviceKey(ref) {
      const { data } = await req(`/v1/projects/${ref}/api-keys?reveal=true`);
      const keys = Array.isArray(data) ? data : [];
      const k = keys.find((x) => x.type === 'secret') || keys.find((x) => x.name === 'service_role');
      if (!k?.api_key) throw new Error('supabase: no secret or service_role key on the project');
      return k.api_key;
    },
  };
}

export function resend(http, base, env) {
  const auth = { authorization: `Bearer ${env.RESEND_ADMIN_KEY}` };
  const req = (path, o = {}) => http.request('resend', base, path, { ...o, headers: auth });
  return {
    async findKeys(name) {
      const { data } = await req('/api-keys');
      const list = Array.isArray(data?.data) ? data.data : [];
      return list.filter((k) => k.name === name);
    },
    async createKey({ name, domainId }) {
      const json = { name, permission: 'sending_access' };
      if (domainId) json.domain_id = domainId;
      const { data } = await req('/api-keys', { method: 'POST', json });
      return data; // { id, token }
    },
    async deleteKey(id) {
      await req(`/api-keys/${id}`, { method: 'DELETE' });
    },
  };
}

export function stripe(http, base, env) {
  const auth = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  const req = (path, o = {}) => http.request('stripe', base, path, { ...o, headers: auth });
  return {
    async findEndpoints(url, shop) {
      const { data } = await req('/v1/webhook_endpoints?limit=100');
      const list = Array.isArray(data?.data) ? data.data : [];
      return list.filter((e) => e.url === url && e.metadata?.shop === shop);
    },
    async createEndpoint(url, shop) {
      const form = [['url', url], ['metadata[shop]', shop], ['description', `shop-launcher ${shop}`]];
      WEBHOOK_EVENTS.forEach((e, i) => form.push([`enabled_events[${i}]`, e]));
      const { data } = await req('/v1/webhook_endpoints', { method: 'POST', form });
      return data; // { id, secret }
    },
    async setEvents(id) {
      const form = [];
      WEBHOOK_EVENTS.forEach((e, i) => form.push([`enabled_events[${i}]`, e]));
      await req(`/v1/webhook_endpoints/${id}`, { method: 'POST', form });
    },
    async deleteEndpoint(id) {
      await req(`/v1/webhook_endpoints/${id}`, { method: 'DELETE' });
    },
    // Live rollback: the endpoint stays (its history with it) but Stripe stops sending.
    async disableEndpoint(id) {
      await req(`/v1/webhook_endpoints/${id}`, { method: 'POST', form: [['disabled', 'true']] });
    },
  };
}

export function cloudflare(http, base, env) {
  const auth = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  const req = (path, o = {}) => http.request('cloudflare', base, path, { ...o, headers: auth });
  return {
    // Names only: Cloudflare never returns a secret's value.
    async secretNames(worker) {
      const { status, data } = await req(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}/secrets`, { allow: [404] });
      if (status === 404) return { exists: false, names: new Set() };
      return { exists: true, names: new Set((data?.result || []).map((s) => s.name)) };
    },
    // The version serving 100% now (or the largest share), from the latest deployment.
    async activeVersion(worker) {
      const { status, data } = await req(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}/deployments`, { allow: [404] });
      if (status === 404) return null;
      const d = (data?.result?.deployments || [])[0];
      const v = [...(d?.versions || [])].sort((a, b) => (b.percentage || 0) - (a.percentage || 0))[0];
      return v?.version_id || null;
    },
    // Every version id in the deployment history, newest deployment first.
    async deployedVersions(worker) {
      const { status, data } = await req(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}/deployments`, { allow: [404] });
      if (status === 404) return [];
      const ids = [];
      for (const d of data?.result?.deployments || []) for (const v of d.versions || []) if (!ids.includes(v.version_id)) ids.push(v.version_id);
      return ids;
    },
    // Binding names of one version (Cloudflare never returns a secret's value).
    async bindingNames(worker, versionId) {
      const { data } = await req(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}/versions/${versionId}`);
      return new Set((data?.result?.resources?.bindings || []).map((b) => b.name));
    },
    async tokenExpiry() {
      const { data } = await req('/user/tokens/verify');
      return { status: data?.result?.status, expiresOn: data?.result?.expires_on || null };
    },
  };
}
