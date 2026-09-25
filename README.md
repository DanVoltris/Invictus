# Invictus Golf — Booking Demo

A branded simulator-bay booking prototype with **embedded Stripe Checkout** (test mode).

## Two ways to run it

### 1. Quick look (no payments)
Just open `demo/index.html` in a browser. The checkout step runs in **simulated** mode — no server, no real charge.

### 2. Real Stripe (test mode)
You need [Node.js](https://nodejs.org) installed and a free [Stripe account](https://dashboard.stripe.com).

```bash
# from this folder
npm install

# add your TEST keys
cp .env.example .env
#   then edit .env and paste your keys from
#   https://dashboard.stripe.com/test/apikeys  (Test mode ON)

npm start
```

Then open **http://localhost:4242**.

Pay with Stripe's test card: **4242 4242 4242 4242**, any future expiry, any CVC, any postal code.

## How payment works (so it's secure)

- The browser never sets the price. The **server recomputes** the amount from the bay, date, and time using the same rate rules, then creates a **Stripe Checkout Session**.
- Card details go straight to Stripe (embedded on the page) — they never touch this server.
- A booking is only treated as paid when Stripe confirms it. To test the webhook locally:
  ```bash
  stripe listen --forward-to localhost:4242/api/webhook
  ```
  Put the printed `whsec_…` value in `.env` as `STRIPE_WEBHOOK_SECRET`.
- **Webhook events to enable** (Stripe dashboard → Developers → Webhooks → your endpoint):
  `payment_intent.succeeded`, `payment_intent.amount_capturable_updated`, `charge.refunded`,
  `checkout.session.completed`. Without `amount_capturable_updated`, a booking paid with a card
  *hold* is only saved if the customer's browser finishes checkout — close the tab and the slot
  looks free.

## Deploying to Vercel

This repo is Vercel-ready: the API runs as serverless functions in `/api`, the
booking page is the static file in `/demo`, and `vercel.json` serves it at `/`.

1. Push this repo to GitHub (already connected).
2. Go to **vercel.com → Add New → Project**, and import the GitHub repo.
3. Framework preset: **Other** (no build step needed). Click **Deploy**.
4. In the project's **Settings → Environment Variables**, add your **TEST** keys:
   - `STRIPE_SECRET_KEY` = `rk_test_…` (or `sk_test_…`)
   - `STRIPE_PUBLISHABLE_KEY` = `pk_test_…`
   - (optional) `STRIPE_WEBHOOK_SECRET` = `whsec_…`
5. Redeploy (Deployments → ⋯ → Redeploy) so the new env vars take effect.

> Keys live only in Vercel's env vars — never commit `.env` (it's gitignored).
> Live keys are refused by design; this prototype runs in Stripe **test mode** only.

## What's real vs. placeholder

- **Real:** bay names, opening hours, and rates (from joyhousegolf.com); the Stripe payment flow in test mode.
- **Placeholder:** which slots show as already booked (generated for the demo). In production these come from the database.

Built by Voltris AI.
