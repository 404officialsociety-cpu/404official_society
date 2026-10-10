# 404 Society — Store connected to Saleor

Admin panel = **Saleor Dashboard**. You add products, prices, photos, stock and see orders there.
This site reads the catalog from Saleor, takes payment with Cashfree, creates the paid order in Saleor, and sends it to Qikink.

Customer flow: catalog (from Saleor) → bag → Google sign-in → Cashfree → order in Saleor + Qikink → account & order history.
Checked with a simulated Saleor, Cashfree and Qikink (`npm test`, 21 checks) and in a real browser. Not tested against a real Saleor store or live keys.

## 1. Saleor (your admin panel)
Use Saleor Cloud (hosted; check saleor.io for current plans) or self-host Saleor. In the Dashboard:
1. **Configuration > Channels**: create or open a channel. Currency **INR**. Copy its **slug** (e.g. `default-channel`).
2. **Configuration > Attributes**: create **Size** (dropdown: S, M, L, XL). **Product types**: create "Apparel" with Size as the *variant selection* attribute.
3. **Products > Create**: name, description, category, photo. Add one **variant per size**:
   **SKU = the exact Qikink SKU** for that size, price in the channel, stock in a warehouse (or untick "track inventory").
   Make the product **published** and **available for purchase** in your channel.
4. **Configuration > Shipping zones**: a zone covering India, with your warehouse and channel. Add two *price based* rates to match the site:
   "Free shipping" for order value 0 – 2000 at Rs 0, and "Standard" for order value above 2000 at Rs 69. (Site rule: `SHIPPING` in `src/worker.js`.)
5. **Configuration > Apps > Create local app**, permission **Manage orders**. Copy its token.

Every change you make in the Dashboard shows on the site within about a minute.

## 2. Worker settings
In `wrangler.toml` set `SALEOR_API_URL` (your GraphQL address, ends in `/graphql/`) and `SALEOR_CHANNEL`.
Secrets (Worker > Settings > Variables and Secrets, type Secret): `SALEOR_APP_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` (40+ random letters/numbers, make your own),
`CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `QIKINK_CLIENT_ID`, `QIKINK_CLIENT_SECRET`.

## 3. Deploy (Cloudflare dashboard, from GitHub)
1. **D1**: create `404-society-orders`, open its Console, paste `schema.sql`, run. Put its Database ID in `wrangler.toml`.
   If you ran an older schema: add `saleor_order_id TEXT` to `orders` (`ALTER TABLE orders ADD COLUMN saleor_order_id TEXT;`) and use the new `customers` table.
2. Workers & Pages > Create > Import a repository. **Build command empty**, deploy command `npx wrangler deploy`.
3. **Google** OAuth client, redirect URI `https://YOUR-WORKER-URL/api/auth/callback` (exact).
4. **Cashfree** webhook: `https://YOUR-WORKER-URL/api/cashfree/webhook`.
5. Test in sandbox. Live: `CASHFREE_ENV = "production"`, `QIKINK_ENV = "live"`, live keys, and a Cloudflare rate-limit rule for `/api/*`.

## How orders are protected
- Price, stock and SKU are re-read from Saleor at checkout. The browser only sends variant ids and quantities (1–10).
- An order is PAID only after the server asks Cashfree and the amount matches.
- After payment: Saleor order (found by our order id first, so never duplicated) and the Qikink order. Each step is saved when it succeeds; failures are retried (max 5) without repeating finished steps.

## Check before launch
- The Saleor mutations (`draftOrderCreate`, `draftOrderComplete`, `orderMarkAsPaid`) follow Saleor's published API docs but were not run against a real Saleor. Place one test order and open it in Dashboard > Orders.
- Draft orders need stock in a warehouse that serves the shipping zone, otherwise Saleor refuses to complete the order (the site keeps the order PAID and shows the error in D1 `last_error`).
- The Qikink order call follows a developer write-up, not an official page. Compare one test order with Qikink's docs.
- Policy pages (Returns, Contact, Privacy, Terms) are placeholders in `public/index.html`.
