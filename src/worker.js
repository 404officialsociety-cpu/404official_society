const enc = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ub64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hkey = (secret, use) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, use);
export async function signSession(obj, secret, ttl = 604800) {
  if (!secret) throw new Error('missing_secret');
  const body = b64u(enc.encode(JSON.stringify({ ...obj, exp: Math.floor(Date.now() / 1000) + ttl })));
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', await hkey(secret, ['sign']), enc.encode(body)));
}
async function verifySession(tok, secret) {
  if (!tok || !secret) return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await hkey(secret, ['verify']), ub64u(sig), enc.encode(body)))) return null;
    const o = JSON.parse(new TextDecoder().decode(ub64u(body)));
    return o.exp > Date.now() / 1000 ? o : null;
  } catch { return null; }
}
const cookies = req => Object.fromEntries((req.headers.get('cookie') || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
const cookie = (n, v, max) => `${n}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${max}`;
const sessionOf = (request, env) => verifySession(cookies(request).s404, env.SESSION_SECRET);

const API_VERSION = '2025-01-01';
const SHIPPING = { threshold: 2000, fee: 69 };   // Rs 0 up to the threshold, Rs fee above it. Mirror this in Saleor > Shipping zones.
const ID_RE = /^[A-Za-z0-9+/=_-]{6,120}$/;

// ---------- Saleor (catalog, prices, stock and orders live in the Saleor dashboard) ----------
async function saleor(env, query, variables = {}, auth = false) {
  if (!env.SALEOR_API_URL || !env.SALEOR_CHANNEL) throw new Error('saleor_not_configured');
  const headers = { 'content-type': 'application/json' };
  if (auth) { if (!env.SALEOR_APP_TOKEN) throw new Error('saleor_not_configured'); headers.authorization = 'Bearer ' + env.SALEOR_APP_TOKEN; }
  const r = await fetch(env.SALEOR_API_URL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error('saleor_graphql ' + JSON.stringify(j.errors || r.status).slice(0, 240));
  return j.data;
}
const plain = d => { try { const j = JSON.parse(d); return (j.blocks || []).map(b => String(b.data?.text || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')).filter(Boolean).join(' '); } catch { return String(d || '').replace(/<[^>]+>/g, ''); } };
const sizeOf = v => v.attributes?.find(a => /size/i.test(a.attribute?.name || ''))?.values?.[0]?.name || v.name || 'ONE SIZE';
const amount = v => v.pricing?.price?.gross?.amount;
const PRODUCTS_Q = `query($ch:String!,$after:String){ products(first:100, after:$after, channel:$ch){ pageInfo{hasNextPage endCursor} edges{ node{
  id slug name description category{name} thumbnail(size:1024){url} media{url type}
  variants{ id name sku quantityAvailable pricing{ price{ gross{ amount } } } attributes{ attribute{ name } values{ name } } } } } } }`;
async function loadCatalog(env) {
  const out = []; let after = null;
  for (let page = 0; page < 10; page++) {                       // up to 1000 products
    const d = (await saleor(env, PRODUCTS_Q, { ch: env.SALEOR_CHANNEL, after })).products;
    for (const { node: n } of d.edges) {
      const variants = (n.variants || []).filter(v => amount(v) != null).map(v => ({ id: v.id, label: sizeOf(v), price: Number(amount(v)), available: (v.quantityAvailable ?? 0) > 0 }));
      if (!variants.length) continue;
      out.push({ id: n.slug, name: n.name, category: n.category?.name || '', description: plain(n.description), price: Math.min(...variants.map(v => v.price)),
        image: n.thumbnail?.url || n.media?.find(m => m.type === 'IMAGE')?.url || '', variants });
    }
    if (!d.pageInfo.hasNextPage) break; after = d.pageInfo.endCursor;
  }
  return out;
}
async function cachedCatalog(env, ctx) {
  const key = new Request('https://catalog.internal/' + encodeURIComponent(env.SALEOR_CHANNEL));
  const c = typeof caches !== 'undefined' ? caches.default : null;
  const hit = c && await c.match(key); if (hit) return hit.json();
  const list = await loadCatalog(env);
  if (c) { const res = new Response(JSON.stringify(list), { headers: { 'cache-control': 'public, max-age=60' } }); ctx?.waitUntil ? ctx.waitUntil(c.put(key, res)) : await c.put(key, res); }
  return list;
}
const VARIANTS_Q = `query($ids:[ID!],$ch:String!){ productVariants(first:50, ids:$ids, channel:$ch){ edges{ node{ id name sku quantityAvailable pricing{ price{ gross{ amount } } } attributes{ attribute{ name } values{ name } } product{ name } } } } }`;
// Re-reads price, stock and SKU from Saleor at checkout. Nothing is trusted from the browser except variant ids and quantities.
async function resolveLines(items, env) {
  const d = await saleor(env, VARIANTS_Q, { ids: [...new Set(items.map(i => i.variantId))], ch: env.SALEOR_CHANNEL });
  const map = new Map(d.productVariants.edges.map(e => [e.node.id, e.node]));
  const lines = new Map();
  for (const i of items) {
    const v = map.get(i.variantId);
    if (!v || amount(v) == null) throw bad('An item in your bag is no longer available.', 409);
    const qty = Math.min(10, (lines.get(v.id)?.qty || 0) + i.qty);
    if ((v.quantityAvailable ?? 0) < qty) throw bad('Sorry, ' + v.product.name + ' (' + sizeOf(v) + ') is out of stock.', 409);
    lines.set(v.id, { v: v.id, name: v.product.name, size: sizeOf(v), sku: v.sku || '', qty, price: Number(amount(v)) });
  }
  return [...lines.values()];
}
let channelIdCache = {};
async function channelId(env) {
  if (channelIdCache[env.SALEOR_CHANNEL]) return channelIdCache[env.SALEOR_CHANNEL];
  const d = await saleor(env, 'query($s:String!){channel(slug:$s){id}}', { s: env.SALEOR_CHANNEL }, true);
  if (!d.channel?.id) throw new Error('saleor_channel_not_found');
  return (channelIdCache[env.SALEOR_CHANNEL] = d.channel.id);
}
const gerr = (r, k) => { const e = r?.[k]?.errors; if (e?.length) throw new Error('saleor_' + k + ' ' + JSON.stringify(e).slice(0, 200)); return r[k]; };
const MARK_PAID = 'mutation($id:ID!,$ref:String){ orderMarkAsPaid(id:$id, transactionReference:$ref){ errors{ field message code } } }';
// Creates the paid order inside Saleor so it shows in the dashboard. Looking it up by our order id first means a retry never makes a duplicate.
async function createSaleorOrder(row, env) {
  const found = (await saleor(env, 'query($e:String){order(externalReference:$e){id isPaid}}', { e: row.id }, true)).order;
  if (found?.id) { if (!found.isPaid) gerr(await saleor(env, MARK_PAID, { id: found.id, ref: row.id }, true), 'orderMarkAsPaid'); return found.id; }
  const cu = JSON.parse(row.customer_json), items = JSON.parse(row.items_json);
  const address = { firstName: cu.firstName, lastName: cu.lastName || '-', streetAddress1: cu.address1, streetAddress2: cu.address2 || '', city: cu.city, postalCode: cu.zip, country: 'IN', countryArea: cu.province, phone: '+91' + cu.phone };
  const created = gerr(await saleor(env, 'mutation($i:DraftOrderCreateInput!){ draftOrderCreate(input:$i){ order{ id shippingMethods{ id name price{ amount } } } errors{ field message code } } }',
    { i: { channelId: await channelId(env), userEmail: cu.email, externalReference: row.id, billingAddress: address, shippingAddress: address, lines: items.map(i => ({ variantId: i.v, quantity: i.qty })) } }, true), 'draftOrderCreate');
  const id = created.order.id, methods = [...(created.order.shippingMethods || [])].sort((a, b) => a.price.amount - b.price.amount);
  const method = methods.find(m => Math.abs(m.price.amount - row.shipping) < 0.01) || methods[0];   // Saleor's price-based rates decide which methods are offered
  if (method) gerr(await saleor(env, 'mutation($id:ID!,$m:ID){ draftOrderUpdate(id:$id, input:{shippingMethod:$m}){ errors{ field message code } } }', { id, m: method.id }, true), 'draftOrderUpdate');
  gerr(await saleor(env, 'mutation($id:ID!){ draftOrderComplete(id:$id){ order{ id } errors{ field message code } } }', { id }, true), 'draftOrderComplete');
  gerr(await saleor(env, MARK_PAID, { id, ref: row.id }, true), 'orderMarkAsPaid');
  return id;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const text = (v, a, b) => typeof v === 'string' && v.trim().length >= a && v.trim().length <= b;

export function validAddress(c) {
  return text(c?.firstName, 1, 40) && text(c?.address1, 5, 200) && text(c?.city, 2, 60) && text(c?.province, 2, 60) && /^\d{6}$/.test(c?.zip || '') && /^[6-9]\d{9}$/.test(c?.phone || '');
}
export function validate(p) {
  const c = p?.customer || {}, items = p?.items;
  if (!validAddress(c) || !text(c.email, 5, 120) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email))
    return 'Please check your name, 10-digit phone, address and 6-digit PIN code.';
  if (!Array.isArray(items) || !items.length || items.length > 20) return 'Your bag is empty.';
  for (const i of items) if (typeof i?.variantId !== 'string' || !ID_RE.test(i.variantId) || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 10) return 'An item in your bag is invalid.';
  return null;
}
// Totals are worked out in paise so decimals never drift. `lines` come from Saleor, never from the browser.
export function price(lines) {
  const sub = lines.reduce((a, l) => a + Math.round(l.price * 100) * l.qty, 0);
  const ship = sub > SHIPPING.threshold * 100 ? SHIPPING.fee * 100 : 0;
  return { subtotal: sub / 100, shipping: ship / 100, total: (sub + ship) / 100 };
}
const addressOf = c => ({ firstName: c.firstName.trim(), lastName: (c.lastName || '').toString().trim().slice(0, 40), phone: c.phone, address1: c.address1.trim(), address2: (c.address2 || '').toString().trim().slice(0, 100), city: c.city.trim(), province: c.province.trim(), zip: c.zip });

async function cashfree(path, env, opts = {}) {
  const base = env.CASHFREE_ENV === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
  const headers = { 'x-client-id': env.CASHFREE_CLIENT_ID, 'x-client-secret': env.CASHFREE_CLIENT_SECRET, 'x-api-version': API_VERSION, accept: 'application/json', 'content-type': 'application/json' };
  return fetch(base + path, { ...opts, headers });
}

async function createOrder(payload, env, origin, user) {
  payload.customer = { ...(payload.customer || {}), email: user.email }; // email always comes from the signed-in Google account
  const err = validate(payload); if (err) throw bad(err);
  const list = await resolveLines(payload.items, env), { shipping, total } = price(list);
  const id = '404' + crypto.randomUUID().replace(/-/g, '').slice(0, 12); // 15 chars (Qikink limit)
  const customer = { ...addressOf(payload.customer), email: user.email };
  await env.DB.prepare('INSERT INTO orders (id,status,amount,shipping,customer_json,items_json,customer_id) VALUES (?,?,?,?,?,?,?)').bind(id, 'PENDING', total, shipping, JSON.stringify(customer), JSON.stringify(list), user.sub).run();
  await env.DB.prepare('UPDATE customers SET address_json=? WHERE id=?').bind(JSON.stringify(addressOf(payload.customer)), user.sub).run();
  const r = await cashfree('/pg/orders', env, { method: 'POST', body: JSON.stringify({
    order_id: id, order_amount: total, order_currency: 'INR',
    customer_details: { customer_id: 'g_' + String(user.sub).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40), customer_name: [customer.firstName, customer.lastName].filter(Boolean).join(' '), customer_email: user.email, customer_phone: customer.phone },
    order_meta: { return_url: `${origin}/?payment=return&order_id={order_id}`, notify_url: `${origin}/api/cashfree/webhook` } }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.payment_session_id) { await env.DB.prepare("UPDATE orders SET status='FAILED',last_error=? WHERE id=?").bind('cashfree ' + r.status, id).run(); throw bad('Payments are unavailable right now.', 502); }
  return { order_id: id, payment_session_id: d.payment_session_id, mode: env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox' };
}

const qbase = env => env.QIKINK_ENV === 'live' ? 'https://api.qikink.com' : 'https://sandbox.qikink.com';
async function qikinkToken(env) {
  const r = await fetch(qbase(env) + '/api/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ClientId: env.QIKINK_CLIENT_ID, client_secret: env.QIKINK_CLIENT_SECRET }) });
  const d = await r.json().catch(() => ({}));
  if (!d.Accesstoken) throw new Error('qikink_auth_' + r.status);
  return d.Accesstoken;
}
async function sendToQikink(row, env) {
  const cu = JSON.parse(row.customer_json), items = JSON.parse(row.items_json);
  if (items.some(i => !i.sku)) throw new Error('missing_sku: set the Qikink SKU on every variant in Saleor');
  const token = await qikinkToken(env);
  const body = { order_number: row.id, qikink_shipping: '1', gateway: 'Prepaid', total_order_value: String(row.amount),
    line_items: items.map(i => ({ search_from_my_products: 1, quantity: String(i.qty), price: String(i.price), sku: i.sku })),
    shipping_address: { first_name: cu.firstName, last_name: cu.lastName || '-', address1: cu.address1, address2: cu.address2, phone: cu.phone, email: cu.email, city: cu.city, zip: cu.zip, province: cu.province, country_code: 'IN' } };
  const r = await fetch(qbase(env) + '/api/order/create', { method: 'POST', headers: { 'content-type': 'application/json', ClientId: env.QIKINK_CLIENT_ID, Accesstoken: token }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error || d.status === false) throw new Error('qikink_' + r.status + ' ' + JSON.stringify(d).slice(0, 160));
  return String(d.order_id || d.id || d.order_no || 'OK');
}
// Only one request can move PAID -> FULFILLING. Each step (Saleor order, Qikink order) is saved the moment it succeeds,
// so a retry only repeats the step that failed and never sends the same order twice.
async function fulfil(row, env) {
  const wantSaleor = !!env.SALEOR_APP_TOKEN, wantQikink = !!(env.QIKINK_CLIENT_ID && env.QIKINK_CLIENT_SECRET);
  if (!(wantSaleor || wantQikink) || row.attempts >= 5) return;
  const claim = await env.DB.prepare("UPDATE orders SET status='FULFILLING',attempts=attempts+1 WHERE id=? AND status='PAID'").bind(row.id).run();
  if (!claim.meta.changes) return;
  let sid = row.saleor_order_id, qid = row.qikink_order_id; const errs = [];
  if (wantSaleor && !sid) { try { sid = await createSaleorOrder(row, env); await env.DB.prepare('UPDATE orders SET saleor_order_id=? WHERE id=?').bind(sid, row.id).run(); } catch (e) { console.error(String(e)); errs.push(String(e.message).slice(0, 150)); } }
  if (wantQikink && !qid) { try { qid = await sendToQikink(row, env); await env.DB.prepare('UPDATE orders SET qikink_order_id=? WHERE id=?').bind(qid, row.id).run(); } catch (e) { console.error(String(e)); errs.push(String(e.message).slice(0, 150)); } }
  const done = (!wantSaleor || sid) && (!wantQikink || qid);
  await env.DB.prepare('UPDATE orders SET status=?,last_error=? WHERE id=?').bind(done ? 'FULFILLED' : 'PAID', errs.join(' | ') || null, row.id).run();
}
// Asks Cashfree directly (never trusts the browser or an unchecked webhook body).
async function settle(id, env) {
  let row = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  if (!row) return null;
  if (row.status === 'PENDING') {
    const r = await cashfree('/pg/orders/' + encodeURIComponent(id), env, { method: 'GET' });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.order_status === 'PAID' && Math.round(Number(d.order_amount) * 100) === Math.round(row.amount * 100))
      await env.DB.prepare("UPDATE orders SET status='PAID' WHERE id=? AND status='PENDING'").bind(id).run();
    else if (r.ok && ['EXPIRED', 'TERMINATED'].includes(d.order_status))
      await env.DB.prepare("UPDATE orders SET status='FAILED' WHERE id=? AND status='PENDING'").bind(id).run();
    row = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  }
  if (row.status === 'PAID') { await fulfil(row, env); row = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first(); }
  return row;
}
const publicOrder = r => ({ id: r.id, status: r.status, amount: r.amount, shipping: r.shipping, createdAt: r.created_at, items: JSON.parse(r.items_json).map(i => ({ name: i.name, size: i.size, qty: i.qty, price: i.price })) });

async function googleCallback(request, env, url) {
  const [st, next] = (cookies(request).oas || '').split('.'), clear = cookie('oas', '', 0);
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (!code || !state || !st || state !== st) return new Response('Invalid sign-in state. Please try again.', { status: 400, headers: { 'set-cookie': clear } });
  try {
    const t = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/api/auth/callback', grant_type: 'authorization_code' }) });
    if (!t.ok) throw new Error('google_token_' + t.status);
    const { access_token } = await t.json();
    const p = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: 'Bearer ' + access_token } })).json();
    if (!p.sub || !p.email || p.email_verified !== true) throw new Error('google_unverified_email');
    const user = { sub: String(p.sub), email: p.email, name: p.name || p.email };
    await env.DB.prepare('INSERT INTO customers (id,email,name) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name').bind(user.sub, user.email, user.name).run();
    const h = new Headers({ location: next === 'checkout' ? '/#/checkout' : '/#/account' });
    h.append('set-cookie', cookie('s404', await signSession(user, env.SESSION_SECRET), 604800)); h.append('set-cookie', clear);
    return new Response(null, { status: 302, headers: h });
  } catch (e) {
    console.error(String(e));
    return new Response('Sign-in failed. Please try again.', { status: 400, headers: { 'set-cookie': clear } });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), path = url.pathname, post = request.method === 'POST';
    const sameSite = () => request.headers.get('origin') === url.origin;
    try {
      if (path === '/api/products') {
        try { return new Response(JSON.stringify({ shipping: SHIPPING, products: await cachedCatalog(env, ctx) }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } }); }
        catch (e) { console.error(String(e)); return json({ error: 'catalog_unavailable', reason: String(e.message).split(' ')[0].slice(0, 40) }, 503); }
      }

      if (path === '/api/auth/google') {
        if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) return new Response('Google sign-in is not configured', { status: 503 });
        const state = crypto.randomUUID(), next = url.searchParams.get('next') === 'checkout' ? 'checkout' : 'account';
        const g = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        g.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/api/auth/callback', response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
        return new Response(null, { status: 302, headers: { location: g.toString(), 'set-cookie': cookie('oas', state + '.' + next, 600) } });
      }
      if (path === '/api/auth/callback') return googleCallback(request, env, url);
      if (path === '/api/auth/me') { const u = await sessionOf(request, env); return json({ user: u ? { name: u.name, email: u.email } : null }); }
      if (path === '/api/auth/logout' && post) {
        if (!sameSite()) return json({ error: 'Forbidden' }, 403);
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'set-cookie': cookie('s404', '', 0) } });
      }

      if (path === '/api/cashfree/webhook' && post) {
        const raw = await request.text(), sig = request.headers.get('x-webhook-signature'), ts = request.headers.get('x-webhook-timestamp');
        if (!sig || !ts || !env.CASHFREE_CLIENT_SECRET) return new Response('bad request', { status: 400 });
        const key = await hkey(env.CASHFREE_CLIENT_SECRET, ['sign']);
        const mac = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(ts + raw)))));
        if (!same(mac, sig)) return new Response('invalid signature', { status: 401 });
        let id; try { id = JSON.parse(raw)?.data?.order?.order_id; } catch { return new Response('bad request', { status: 400 }); }
        if (id) await settle(String(id), env);
        return new Response('OK');
      }

      // Everything below needs a signed-in customer and only ever touches that customer's own data.
      if (path.startsWith('/api/')) {
        const user = await sessionOf(request, env);
        if (!user) return json({ error: 'Please sign in.' }, 401);
        if (path === '/api/checkout' && post) {
          if (!sameSite()) return json({ error: 'Forbidden' }, 403);
          return json(await createOrder(await request.json().catch(() => ({})), env, url.origin, user));
        }
        if (path === '/api/account') {
          const c = await env.DB.prepare('SELECT address_json FROM customers WHERE id=?').bind(user.sub).first();
          return json({ user: { name: user.name, email: user.email }, address: c?.address_json ? JSON.parse(c.address_json) : null });
        }
        if (path === '/api/account/address' && post) {
          if (!sameSite()) return json({ error: 'Forbidden' }, 403);
          const a = await request.json().catch(() => ({}));
          if (!validAddress(a)) throw bad('Please check your name, 10-digit phone, address and 6-digit PIN code.');
          const clean = addressOf(a);
          await env.DB.prepare('UPDATE customers SET address_json=? WHERE id=?').bind(JSON.stringify(clean), user.sub).run();
          return json({ address: clean });
        }
        if (path === '/api/orders') {
          const id = url.searchParams.get('id');
          if (id) {
            if (!/^[\w-]{1,50}$/.test(id)) return json({ error: 'Not found' }, 404);
            const row = await env.DB.prepare('SELECT * FROM orders WHERE id=? AND customer_id=?').bind(id, user.sub).first();
            return row ? json({ order: publicOrder(row) }) : json({ error: 'Not found' }, 404);
          }
          const { results } = await env.DB.prepare('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 50').bind(user.sub).all();
          return json({ orders: results.map(publicOrder) });
        }
        if (path === '/api/order-status') {
          const id = url.searchParams.get('order_id') || '';
          if (!/^[\w-]{1,50}$/.test(id)) return json({ error: 'order_id required' }, 400);
          const own = await env.DB.prepare('SELECT customer_id FROM orders WHERE id=?').bind(id).first();
          if (!own || own.customer_id !== user.sub) return json({ error: 'Not found' }, 404);
          const row = await settle(id, env);
          return json({ id: row.id, status: row.status, amount: row.amount, shipping: row.shipping });
        }
        return json({ error: 'Not found' }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(String(e));
      return json({ error: e.status ? e.message : 'Something went wrong. Please try again.' }, e.status || 500);
    }
  }
};
