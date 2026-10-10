import test from 'node:test';
import assert from 'node:assert';
import worker, { signSession } from '../src/worker.js';
const SECRET = 'k'.repeat(40);
function fakeDB() {
  const orders = new Map(), customers = new Map();
  return { orders, customers, prepare(sql) { return { b: [],
    bind(...a) { this.b = a; return this; },
    async run() { const a = this.b;
      if (sql.startsWith('INSERT INTO orders')) { orders.set(a[0], { id: a[0], status: a[1], amount: a[2], shipping: a[3], customer_json: a[4], items_json: a[5], customer_id: a[6], attempts: 0, created_at: '2026-10-10 10:00:00' }); return { meta: { changes: 1 } }; }
      if (sql.startsWith('INSERT INTO customers')) { customers.set(a[0], { ...(customers.get(a[0]) || {}), id: a[0], email: a[1], name: a[2] }); return { meta: { changes: 1 } }; }
      if (sql.startsWith('UPDATE customers')) { const c = customers.get(a[1]); if (c) c.address_json = a[0]; return { meta: { changes: 1 } }; }
      const id = a[a.length - 1], r = orders.get(id); if (!r) return { meta: { changes: 0 } };
      if (sql.includes("status='PAID' WHERE id=? AND status='PENDING'")) { if (r.status !== 'PENDING') return { meta: { changes: 0 } }; r.status = 'PAID'; return { meta: { changes: 1 } }; }
      if (sql.includes("status='FULFILLING'")) { if (r.status !== 'PAID') return { meta: { changes: 0 } }; r.status = 'FULFILLING'; r.attempts++; return { meta: { changes: 1 } }; }
      if (sql.startsWith('UPDATE orders SET saleor_order_id')) { r.saleor_order_id = a[0]; return { meta: { changes: 1 } }; }
      if (sql.startsWith('UPDATE orders SET qikink_order_id')) { r.qikink_order_id = a[0]; return { meta: { changes: 1 } }; }
      if (sql.startsWith('UPDATE orders SET status=?,last_error')) { r.status = a[0]; r.last_error = a[1]; return { meta: { changes: 1 } }; }
      if (sql.includes("status='FAILED'")) { r.status = 'FAILED'; return { meta: { changes: 1 } }; }
      return { meta: { changes: 0 } }; },
    async first() { const a = this.b;
      if (sql.includes('FROM customers')) return customers.get(a[0]) || null;
      if (sql.includes('customer_id FROM orders')) { const r = orders.get(a[0]); return r ? { customer_id: r.customer_id } : null; }
      if (sql.includes('AND customer_id=?')) { const r = orders.get(a[0]); return r && r.customer_id === a[1] ? r : null; }
      return orders.get(a[0]) || null; },
    async all() { return { results: [...orders.values()].filter(r => r.customer_id === this.b[0]) }; } }; } };
}
const cu = { firstName: 'A', phone: '9876543210', address1: '12 Main Street', city: 'Salem', province: 'Tamilnadu', zip: '636701' };
const V = { A: { id: 'VkFSSUFOVDpB', name: 'L', sku: 'SKU-HOOD-L', quantityAvailable: 5, price: 1499, product: 'Society Hoodie' }, B: { id: 'VkFSSUFOVDpC', name: 'M', sku: 'SKU-TEE-M', quantityAvailable: 0, price: 799, product: 'Essential Tee' } };
async function setup({ cfStatus = 'PAID', qOk = true, saleorFailFirst = false } = {}) {
  const db = fakeDB(), calls = { q: 0, draftCreate: 0, complete: 0, paid: 0 }, saleorOrders = new Map(), prices = { A: 1499 };
  let sFails = saleorFailFirst ? 1 : 0;
  const node = k => ({ id: V[k].id, name: V[k].name, sku: V[k].sku, quantityAvailable: V[k].quantityAvailable, pricing: { price: { gross: { amount: k === 'A' ? prices.A : V[k].price } } }, attributes: [{ attribute: { name: 'Size' }, values: [{ name: V[k].name }] }], product: { name: V[k].product } });
  globalThis.fetch = async (u, o) => { u = String(u);
    if (u.startsWith('https://saleor.test')) {
      const { query, variables: v } = JSON.parse(o.body), ok = d => new Response(JSON.stringify({ data: d }));
      if (query.includes('products(first:100')) return ok({ products: { pageInfo: { hasNextPage: false }, edges: [{ node: { id: 'p1', slug: 'society-hoodie', name: 'Society Hoodie', description: JSON.stringify({ blocks: [{ type: 'paragraph', data: { text: 'Heavy <b>fleece</b>' } }] }), category: { name: 'Hoodies' }, thumbnail: { url: 'https://img/x.jpg' }, media: [], variants: [node('A'), { ...node('B'), pricing: null }] } }] } });
      if (query.includes('productVariants')) return ok({ productVariants: { edges: v.ids.map(id => Object.keys(V).find(k => V[k].id === id)).filter(Boolean).map(k => ({ node: node(k) })) } });
      if (query.includes('channel(slug')) return ok({ channel: { id: 'Q2hhbm5lbDox' } });
      if (query.includes('order(externalReference')) return ok({ order: saleorOrders.get(v.e) || null });
      if (query.includes('draftOrderCreate')) { calls.draftCreate++; if (sFails-- > 0) return new Response(JSON.stringify({ errors: [{ message: 'boom' }] })); saleorOrders.set(v.i.externalReference, { id: 'T3JkZXI6MQ==', isPaid: false, lines: v.i.lines }); return ok({ draftOrderCreate: { order: { id: 'T3JkZXI6MQ==', shippingMethods: [{ id: 'sm1', name: 'Free', price: { amount: 0 } }, { id: 'sm2', name: 'Standard', price: { amount: 69 } }] }, errors: [] } }); }
      if (query.includes('draftOrderUpdate')) { calls.method = v.m; return ok({ draftOrderUpdate: { errors: [] } }); }
      if (query.includes('draftOrderComplete')) { calls.complete++; return ok({ draftOrderComplete: { order: { id: v.id }, errors: [] } }); }
      if (query.includes('orderMarkAsPaid')) { calls.paid++; for (const o of saleorOrders.values()) o.isPaid = true; return ok({ orderMarkAsPaid: { errors: [] } }); }
      throw new Error('unexpected saleor query ' + query.slice(0, 40));
    }
    if (u.includes('/pg/orders') && o?.method === 'POST') return new Response(JSON.stringify({ payment_session_id: 'ps_1' }));
    if (u.includes('/pg/orders/')) return new Response(JSON.stringify({ order_status: cfStatus, order_amount: db.orders.get(u.split('/').pop()).amount }));
    if (u.endsWith('/api/token')) return new Response(JSON.stringify({ Accesstoken: 't' }));
    if (u.endsWith('/api/order/create')) { calls.q++; calls.qBody = JSON.parse(o.body); return qOk ? new Response('{"order_id":777}') : new Response('{"error":"x"}', { status: 400 }); }
    if (u.includes('oauth2.googleapis.com/token')) return new Response('{"access_token":"at"}');
    if (u.includes('openidconnect.googleapis.com')) return new Response(JSON.stringify({ sub: 'g1', email: 'me@x.com', email_verified: true, name: 'Me User' }));
    throw new Error('unexpected ' + u); };
  const env = { DB: db, SESSION_SECRET: SECRET, SALEOR_API_URL: 'https://saleor.test/graphql/', SALEOR_CHANNEL: 'default-channel', SALEOR_APP_TOKEN: 'app', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gs', CASHFREE_CLIENT_ID: 'i', CASHFREE_CLIENT_SECRET: 's', QIKINK_CLIENT_ID: 'q', QIKINK_CLIENT_SECRET: 'z' };
  const cookieFor = async sub => 's404=' + await signSession({ sub, email: sub + '@x.com', name: sub }, SECRET);
  return { db, calls, env, prices, saleorOrders, cookieFor };
}
const get = (path, env, cookie) => worker.fetch(new Request('https://s' + path, { headers: cookie ? { cookie } : {} }), env);
const checkout = (env, cookie, items) => worker.fetch(new Request('https://s/api/checkout', { method: 'POST', headers: { origin: 'https://s', cookie }, body: JSON.stringify({ customer: { ...cu, email: 'evil@x.com' }, items: items || [{ variantId: V.A.id, qty: 2 }] }) }), env);

test('paid order is fulfilled exactly once with parallel status checks, and uses the Google email', async () => {
  const s = await setup(), c = await s.cookieFor('g1');
  const r = await (await checkout(s.env, c)).json(), row = s.db.orders.get(r.order_id);
  assert.equal(row.amount, 3067); assert.equal(row.customer_id, 'g1'); assert.equal(JSON.parse(row.customer_json).email, 'g1@x.com');
  await Promise.all([1, 2, 3].map(() => get('/api/order-status?order_id=' + r.order_id, s.env, c)));
  assert.equal(s.calls.q, 1); assert.equal(s.calls.draftCreate, 1); assert.equal(s.calls.complete, 1); assert.equal(s.calls.paid, 1);
  assert.equal(row.status, 'FULFILLED'); assert.equal(row.saleor_order_id, 'T3JkZXI6MQ==');
  assert.equal(s.calls.method, 'sm2'); // the Saleor shipping method matching the Rs 69 we charged
  assert.equal(s.calls.qBody.line_items[0].sku, 'SKU-HOOD-L'); // Qikink gets the SKU stored in Saleor
});
test('products come from Saleor: price, size label, photo and plain-text description', async () => {
  const s = await setup(); const j = await (await get('/api/products', s.env)).json();
  assert.equal(j.products.length, 1); const p = j.products[0];
  assert.deepEqual([p.id, p.name, p.category, p.price, p.image, p.description], ['society-hoodie', 'Society Hoodie', 'Hoodies', 1499, 'https://img/x.jpg', 'Heavy fleece']);
  assert.deepEqual(p.variants, [{ id: V.A.id, label: 'L', price: 1499, available: true }]); // variant with no channel price is hidden
});
test('price is taken from Saleor at checkout, not from the browser', async () => {
  const s = await setup(), c = await s.cookieFor('g1'); s.prices.A = 1200; // admin changes the price in the dashboard
  const r = await (await worker.fetch(new Request('https://s/api/checkout', { method: 'POST', headers: { origin: 'https://s', cookie: c }, body: JSON.stringify({ customer: cu, items: [{ variantId: V.A.id, qty: 1, price: 1 }] }) }), s.env)).json();
  assert.equal(s.db.orders.get(r.order_id).amount, 1200);
});
test('out-of-stock or unknown variants are refused', async () => {
  const s = await setup(), c = await s.cookieFor('g1');
  assert.equal((await checkout(s.env, c, [{ variantId: V.B.id, qty: 1 }])).status, 409);
  assert.equal((await checkout(s.env, c, [{ variantId: V.A.id, qty: 6 }])).status, 409);
  assert.equal((await checkout(s.env, c, [{ variantId: 'Tm9wZQ==', qty: 1 }])).status, 409);
  assert.equal(s.db.orders.size, 0);
});
test('Saleor outage: order stays PAID, Qikink still sent once, Saleor retried without duplicates', async () => {
  const s = await setup({ saleorFailFirst: true }), c = await s.cookieFor('g1'), r = await (await checkout(s.env, c)).json(), row = s.db.orders.get(r.order_id);
  await get('/api/order-status?order_id=' + r.order_id, s.env, c);
  assert.equal(row.status, 'PAID'); assert.equal(s.calls.q, 1); assert.ok(row.last_error.includes('saleor'));
  await get('/api/order-status?order_id=' + r.order_id, s.env, c);
  assert.equal(row.status, 'FULFILLED'); assert.equal(s.calls.q, 1); assert.equal(s.calls.complete, 1); assert.equal(row.saleor_order_id, 'T3JkZXI6MQ==');
});
test('a Saleor order that already exists is reused, never duplicated', async () => {
  const s = await setup(), c = await s.cookieFor('g1'), r = await (await checkout(s.env, c)).json();
  s.saleorOrders.set(r.order_id, { id: 'T3JkZXI6OQ==', isPaid: true });
  await get('/api/order-status?order_id=' + r.order_id, s.env, c);
  assert.equal(s.calls.draftCreate, 0); assert.equal(s.db.orders.get(r.order_id).saleor_order_id, 'T3JkZXI6OQ==');
});
test('unpaid order stays pending and is never sent to Qikink', async () => {
  const s = await setup({ cfStatus: 'ACTIVE' }), c = await s.cookieFor('g1'), r = await (await checkout(s.env, c)).json();
  await get('/api/order-status?order_id=' + r.order_id, s.env, c);
  assert.equal(s.calls.q, 0); assert.equal(s.db.orders.get(r.order_id).status, 'PENDING');
});
test('Qikink failure keeps order PAID with an error; Saleor order is kept and not repeated', async () => {
  const s = await setup({ qOk: false }), c = await s.cookieFor('g1'), r = await (await checkout(s.env, c)).json();
  for (let i = 0; i < 7; i++) await get('/api/order-status?order_id=' + r.order_id, s.env, c);
  const row = s.db.orders.get(r.order_id);
  assert.equal(row.status, 'PAID'); assert.ok(row.last_error.includes('qikink')); assert.equal(s.calls.q, 5); assert.equal(s.calls.draftCreate, 1);
});
test('a customer cannot see or poll another customer\'s order', async () => {
  const s = await setup(), a = await s.cookieFor('g1'), b = await s.cookieFor('g2'), r = await (await checkout(s.env, a)).json();
  assert.equal((await get('/api/order-status?order_id=' + r.order_id, s.env, b)).status, 404);
  assert.equal((await get('/api/orders?id=' + r.order_id, s.env, b)).status, 404);
  assert.equal((await (await get('/api/orders', s.env, b)).json()).orders.length, 0);
  assert.equal((await (await get('/api/orders', s.env, a)).json()).orders.length, 1);
  assert.equal((await get('/api/orders?id=' + r.order_id, s.env, a)).status, 200);
});
test('account endpoints need a session; forged or expired cookies are rejected', async () => {
  const s = await setup();
  for (const p of ['/api/account', '/api/orders', '/api/order-status?order_id=x']) assert.equal((await get(p, s.env)).status, 401);
  assert.equal((await get('/api/orders', s.env, 's404=abc.def')).status, 401);
  const old = 's404=' + await signSession({ sub: 'g1', email: 'a', name: 'a' }, SECRET, -10);
  assert.equal((await get('/api/orders', s.env, old)).status, 401);
  assert.equal((await get('/api/orders', s.env, 's404=' + await signSession({ sub: 'g1' }, 'other-secret-other-secret-other-secret'))).status, 401);
});
test('checkout address is saved to the account', async () => {
  const s = await setup(), c = await s.cookieFor('g1'); s.db.customers.set('g1', { id: 'g1' });
  await checkout(s.env, c);
  const a = await (await get('/api/account', s.env, c)).json();
  assert.equal(a.address.city, 'Salem'); assert.equal(a.user.email, 'g1@x.com');
});
test('Google sign-in: redirect, state check, session cookie', async () => {
  const s = await setup();
  const start = await get('/api/auth/google?next=checkout', s.env);
  assert.equal(start.status, 302); assert.ok(start.headers.get('location').startsWith('https://accounts.google.com/'));
  assert.ok(start.headers.get('location').includes(encodeURIComponent('https://s/api/auth/callback')));
  const oas = start.headers.get('set-cookie').split(';')[0], state = oas.split('=')[1].split('.')[0];
  const wrong = await get('/api/auth/callback?code=c&state=nope', s.env, oas); assert.equal(wrong.status, 400);
  const nocookie = await get('/api/auth/callback?code=c&state=' + state, s.env); assert.equal(nocookie.status, 400);
  const ok = await get('/api/auth/callback?code=c&state=' + state, s.env, oas);
  assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), '/#/checkout');
  const cookies = ok.headers.getSetCookie().join(';'); assert.ok(/s404=[^;]+/.test(cookies)); assert.ok(cookies.includes('HttpOnly') && cookies.includes('Secure') && cookies.includes('SameSite=Lax'));
  assert.equal(s.db.customers.get('g1').email, 'me@x.com');
  const me = await (await get('/api/auth/me', s.env, 's404=' + /s404=([^;]+)/.exec(cookies)[1])).json(); assert.equal(me.user.name, 'Me User');
});
test('unverified Google email is refused', async () => {
  const s = await setup(); const f = globalThis.fetch;
  globalThis.fetch = async (u, o) => String(u).includes('openidconnect') ? new Response(JSON.stringify({ sub: 'g1', email: 'a@b.c', email_verified: false })) : f(u, o);
  const start = await get('/api/auth/google', s.env), oas = start.headers.get('set-cookie').split(';')[0], state = oas.split('=')[1].split('.')[0];
  assert.equal((await get('/api/auth/callback?code=c&state=' + state, s.env, oas)).status, 400);
});
test('sign-out needs same origin and clears the cookie', async () => {
  const s = await setup();
  assert.equal((await worker.fetch(new Request('https://s/api/auth/logout', { method: 'POST', headers: { origin: 'https://evil.com' } }), s.env)).status, 403);
  const r = await worker.fetch(new Request('https://s/api/auth/logout', { method: 'POST', headers: { origin: 'https://s' } }), s.env);
  assert.ok(r.headers.get('set-cookie').includes('Max-Age=0'));
});
