import test from 'node:test';
import assert from 'node:assert';
import worker, { validate, price } from '../src/worker.js';
const cu = { firstName: 'A', email: 'a@b.co', phone: '9876543210', address1: '12 Main Street', city: 'Salem', province: 'Tamilnadu', zip: '636701' };
const ok = { customer: cu, items: [{ variantId: 'UHJvZHVjdFZhcmlhbnQ6MQ==', qty: 1 }] };
test('valid order passes', () => assert.equal(validate(ok), null));
test('negative / fractional / huge quantity rejected', () => { for (const qty of [-1, 0, 0.5, 99, '2']) assert.ok(validate({ ...ok, items: [{ variantId: 'UHJvZHVjdFZhcmlhbnQ6MQ==', qty }] }), String(qty)); });
test('bad variant id rejected', () => { for (const variantId of ['', 'a b', '<script>', 5, undefined]) assert.ok(validate({ ...ok, items: [{ variantId, qty: 1 }] })); });
test('bad phone / PIN / email rejected', () => { assert.ok(validate({ ...ok, customer: { ...cu, phone: '123' } })); assert.ok(validate({ ...ok, customer: { ...cu, zip: '12' } })); assert.ok(validate({ ...ok, customer: { ...cu, email: 'nope' } })); });
test('shipping: free up to 2000, 69 above; decimals do not drift', () => {
  assert.deepEqual(price([{ price: 799, qty: 1 }]), { subtotal: 799, shipping: 0, total: 799 });
  assert.deepEqual(price([{ price: 1000, qty: 2 }]), { subtotal: 2000, shipping: 0, total: 2000 });
  assert.deepEqual(price([{ price: 1499, qty: 2 }]), { subtotal: 2998, shipping: 69, total: 3067 });
  assert.equal(price([{ price: 0.1, qty: 3 }]).subtotal, 0.3);
});
test('webhook with bad signature is rejected', async () => {
  const r = await worker.fetch(new Request('https://s/api/cashfree/webhook', { method: 'POST', headers: { 'x-webhook-signature': 'x', 'x-webhook-timestamp': '1' }, body: '{}' }), { CASHFREE_CLIENT_SECRET: 's' });
  assert.equal(r.status, 401);
});
test('checkout without signing in is rejected', async () => {
  const r = await worker.fetch(new Request('https://s/api/checkout', { method: 'POST', headers: { origin: 'https://s' }, body: JSON.stringify(ok) }), { SESSION_SECRET: 'x'.repeat(40) });
  assert.equal(r.status, 401);
});
