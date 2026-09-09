# Setup checklist

Roughly 20 minutes end to end. Steps 1–3 are things only you can do; the rest is
running commands on the server.

---

## 1. Pylon — API token

**API access is not on by default.** Pylon's own developer FAQ says:

> **How do I get access to Pylon's API?**
> Please visit the API Settings in your Team Settings and contact our support staff.

So if there is no "create token" button in **Team Settings → API Settings**, that
is expected — ask Pylon support to enable API access on the team. Their FAQ also
confirms it costs nothing extra.

Once it is enabled: create a token with **read** permission (the bridge never
writes to Pylon) and put it in `PYLON_API_TOKEN`.

### Running before that happens — webhook-only mode

Leave `PYLON_API_TOKEN` blank and the bridge still runs. Webhooks do not need a
token, so this all works from day one:

| Lands without a token | Needs the token |
| --- | --- |
| Contact created / matched on the signer's email | Contract value → opportunity value |
| Signer name and email | Site address, system size, battery size |
| Opportunity moved to the contract-signed stage | The signed contract PDF |
| Link back to the Pylon project | Deposit / amount payable |
| Timeline note on the contact | |
| Payment amount, type, date and receipt link | |

Anything in the right-hand column is **left unchanged** in GoHighLevel and
reported as a warning on the event — never blanked out, never guessed at. Once
the token is added, replay the events (`POST /events/{id}/replay`) and the rest
fills in.

`GET /health` reports which mode it is in.

## 2. GoHighLevel — Private Integration Token

**Settings → Private Integrations → Create new integration**

Tick these scopes:

| Scope | Why |
| --- | --- |
| `contacts.readonly`, `contacts.write` | create/update the customer record |
| `opportunities.readonly`, `opportunities.write` | find the deal, set its value and stage |
| `locations/customFields.readonly` | resolve your field names to ids |
| `locations/customFields.write` | only needed for `npm run bootstrap-fields` |
| `medias.write` | store the signed contract PDF |
| `forms.write` | attach the PDF to the contact record |
| `locations.readonly` | read your business details for invoices |
| `invoices.write` | **only if you want invoices raised** — see below |

Copy the token into `GHL_API_TOKEN`.

Then **Settings → Business Profile** and copy the **Location ID** (the
sub-account id, not the agency id) into `GHL_LOCATION_ID`.

### Invoices — the three payment stages (optional)

The business bills in three stages, so one signed contract produces three
invoices rather than one:

| Stage | Key | Share | Raised |
| --- | --- | --- | --- |
| Deposit | `deposit` | 10% | automatically, on signature |
| Pre-installation | `pre_install` | 60% | on demand |
| Final payment | `installation` | **the balance** | on demand |

The last stage is `"remainder": true` rather than a percentage, so the three
invoices always add up to exactly the contract however it rounds.

Set `GHL_CREATE_INVOICE=true` to switch invoicing on. It is **off by default**:
raising an invoice is a billing action, not a data sync.

#### Raising the later two stages

Only the deposit can come from Pylon — Pylon has no idea when you are about to
install. The other two are raised by calling the bridge:

```
POST https://your-server/invoices/pre_install
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{ "opportunityId": "the GoHighLevel opportunity id" }
```

`contactId` or `reference` (the Pylon reference number) work in place of
`opportunityId`. Use `installation` for the last stage.

The tidy way to drive this is a **GoHighLevel workflow**: trigger on the
opportunity entering "60% Deposit Required", action = Webhook, POST to that URL
with the admin token as an `Authorization` header. Then nobody has to remember.

Calling it twice is safe — a stage that has already been invoiced returns the
invoice that exists rather than billing the customer again.

#### Getting paid

**You do not need Stripe.** The invoice is created either way — Stripe only adds
a "pay now" button. On a bank-transfer business, leave it disconnected and put
your account details on the invoice instead.

That is what `invoices.termsNotes` in `config/mapping.json` is for. It is HTML,
and it takes the same `{{...}}` templates as everything else:

```json
"termsNotes": "<p>Payment by bank transfer.</p><p>Account name: …<br>BSB: …<br>Account number: …<br>Reference: {{project.reference_number}}</p>"
```

Templating the Pylon reference in means an incoming transfer can be matched back
to the job.

The bank details themselves live in `.env`, not in `config/mapping.json`, so they
are never committed:

```
TPL_BANK_NAME=Your Company Pty Ltd
TPL_BANK_BSB=000-000
TPL_BANK_ACCOUNT=00000000
```

Only `TPL_*` variables are readable from the mapping, so a mistyped
`{{env.GHL_API_TOKEN}}` cannot write a credential into a customer record.

#### Whose name goes on the invoice

The GoHighLevel location holds your **trading** name. A tax invoice has to show
the seller's identity and ABN, and the legal entity is often not the trading
name, so both are settable:

```
TPL_BUSINESS_NAME=Legal Entity Pty Ltd (Trading as Your Brand)
TPL_BUSINESS_ABN=12 345 678 901
```

Leave `TPL_BUSINESS_NAME` blank to use the location's name. Leave
`TPL_BUSINESS_ABN` blank and no ABN line is printed at all — there is never a
dangling "ABN:" label.

> The ATO requires a tax invoice to show the seller's identity **and ABN**, and
> for sales of $1,000 or more the buyer's identity or ABN as well. The buyer's
> name and email are already on every invoice. Set the ABN before these go to
> real customers, and check the wording with your accountant.

With no payment provider connected, no Stripe payment-method block is sent at
all. Set `GHL_INVOICE_SEND_ACTION=email` if you want the customer to actually
receive the invoice; the default leaves it as a draft.

#### If you ever do connect Stripe

Any one of these routes:

- **Payments** → **Integrations** tab → **Connect** on Stripe
- **Settings** → **Integrations** → **Continue** on Stripe
- **Launchpad** → **Ecommerce** → **Start Collecting Payments with Stripe**

Stripe's published Australian rates:

| Method | Fee |
| --- | --- |
| Domestic card | 1.7% + A$0.30 |
| International card | 3.5% + A$0.30 |
| BECS Direct Debit / PayTo | 1% + A$0.30, **capped at A$3.50** |

On a $15,600 contract billed 10 / 60 / balance that is **$213.06** by card
against **$10.50** by bank debit — $159 of the difference sits on the 60%
instalment alone.

Each stage can carry `bankDebitOnly` in `config/mapping.json` to force the
cheaper method, and `GHL_INVOICE_BANK_DEBIT_ONLY` sets a default. Neither is set
by default, because unset is the honest value for a business with no Stripe
account.

#### Surcharging is not a way out

From **1 October 2026** the RBA is removing its prohibition on 'no-surcharge'
rules, and eftpos, Mastercard, Visa and American Express are all banning card
surcharging — prepaid, debit and credit. After that date card fees can only be
recovered by building them into your prices, not added at checkout.

Bank transfer, direct debit and BECS sit outside that framework, and businesses
may still offer a **discount** for paying by a cheaper method. That is the
supported way to steer customers off cards.

#### Scopes

`invoices.write` is **not** included in a Private Integration by default. Without
it the invoice step fails with:

> No invoice was raised for the "deposit" stage: the GoHighLevel token is missing
> the "invoices.write" scope. Add it to the Private Integration and replay this
> event. Everything else landed.

Everything else still lands — a signature never fails because of an invoice.

#### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `GHL_CREATE_INVOICE` | `false` | raise invoices at all |
| `GHL_INVOICE_SEND_ACTION` | `none` | `none` leaves a draft. `send_manually` marks it sent without contacting the customer. `email`, `sms`, `sms_and_email` actually contact them. |
| `GHL_INVOICE_DUE_DAYS` | `7` | fallback when a stage has no `dueDays` |
| `GHL_INVOICE_LIVE_MODE` | `true` | `false` for GoHighLevel test-mode invoices |
| `GHL_INVOICE_USER_ID` | — | who a send is recorded under; avoids needing `users.readonly` |
| `GHL_INVOICE_BANK_DEBIT_ONLY` | *unset* | default payment method for a stage with no `bankDebitOnly` of its own. Left unset means no Stripe payment-method block is sent at all. |

Percentages, names, wording and due dates all live in the `invoices` section of
`config/mapping.json` — see [FIELD-MAPPING.md](FIELD-MAPPING.md). Your business
name, address, phone and website are read from your GoHighLevel location, so
there is nothing to type in.

## 3. GoHighLevel — pipeline and stage

Decide which pipeline the opportunity belongs to and which stage means
"contract signed". Put the names — exactly as they read in the CRM — into:

```
GHL_PIPELINE_NAME=Inspire Sales Leads
GHL_SIGNED_STAGE_NAME=Contract Signed - Ready for finial approval
GHL_PAID_STAGE_NAME=                  # optional, leave blank to not move on payment
```

> These are the real values for the Inspire Energy location. Note the
> pipeline is called **Inspire Sales Leads**, not "Inspire Sales Pipeline" —
> the names have to match the CRM exactly. `npm run discover` writes every
> pipeline, stage and field id to `discovery.md` if they ever change.

Names are fine; the bridge resolves them to ids at startup and tells you at
startup if it can't find them.

---

## 4. Server — install and configure

```bash
git clone <this repo> /opt/pylon-ghl-bridge
cd /opt/pylon-ghl-bridge
npm install --omit=dev
cp .env.example .env
# fill in .env with the values from steps 1-3
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # ADMIN_TOKEN
```

## 5. Create the custom fields

```bash
npm run discover                       # what exists today
npm run bootstrap-fields               # what is missing (dry run)
npm run bootstrap-fields -- --apply    # create the missing ones
```

Nothing is renamed or deleted; existing fields are left alone. If you would
rather create the fields by hand in the CRM, do that and then point
`config/mapping.json` at your names — see [FIELD-MAPPING.md](FIELD-MAPPING.md).

## 6. Deploy it

The repo carries a `render.yaml` blueprint. In Render: **New → Blueprint**,
point it at the repo, and it prompts for the secrets (everything marked
`sync: false` — those are never committed).

**Do not use the Free plan for this.** Two reasons, both real:

1. Free services **spin down after 15 minutes** idle and take about a minute to
   wake. Pylon allows a webhook **10 seconds**. The first signature after a
   quiet spell would time out. Pylon retries 5 times over ~31 hours so it would
   land eventually, but a signed contract could sit outside the CRM for hours.
2. Free instances have an **ephemeral filesystem** and cannot have a disk. This
   service keeps a small record of which contact, opportunity and invoices each
   Pylon project produced. Lose it and the 60% and final invoices can no longer
   find their job — and the guard that stops a stage being invoiced **twice**
   goes with it.

The blueprint therefore asks for a paid instance and a 1 GB disk mounted at
`/var/data`, with `DATA_DIR` pointed at it.

Alternatively run it anywhere that can host Node 20+: `npm ci --omit=dev`,
`npm start`, behind nginx or Caddy for TLS.

## 7. Pylon — webhook destination

**Pylon → Settings → API → Webhook destinations → Create**

- URL: `https://your-server.example.com/webhooks/pylon`
- Events: **`web_proposals.signed`** and **`gateway_payments.created`**
- Copy the secret Pylon shows you (it is shown once) into
  `PYLON_WEBHOOK_SECRET`, then restart the service.

> If there are no successful deliveries for 7 days Pylon marks the destination
> inactive and stops sending. It has to be reactivated by hand in the same
> screen, so don't leave a broken URL configured.

## 8. Prove it

```bash
curl -s "https://your-server/health?deep=1" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s  https://your-server/mapping       -H "Authorization: Bearer $ADMIN_TOKEN"
npm run simulate -- --url https://your-server/webhooks/pylon
npm run simulate -- --bad-signature --url https://your-server/webhooks/pylon   # must 401
curl -s  https://your-server/events        -H "Authorization: Bearer $ADMIN_TOKEN"
```

Then sign one real test proposal in Pylon and check the opportunity in
GoHighLevel.

---

## Optional: run it in dry-run first

Set `DRY_RUN=true` and restart. The bridge reads everything from Pylon and logs
exactly what it *would* send to GoHighLevel, without writing anything. Useful
for a first pass against live data.
