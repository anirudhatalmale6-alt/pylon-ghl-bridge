# Live test — 27 August 2026

Run against the client's **real** GoHighLevel location (Inspire Sales Leads
pipeline). Everything below is a genuine record you can open
in the CRM right now.

Reproduce with `node scripts/live-test.js`. The raw console output is kept out
of this repo because it carries live record ids — it is sent directly instead.

## What is real and what is not

| | |
| --- | --- |
| GoHighLevel | **Real.** Real contact, real opportunity, real custom fields, real file upload, real timeline note. |
| Pylon | **Stood in locally.** Pylon has not enabled API access on the team yet, so the project and design lookups are served by the same stand-in the test suite uses. The webhook body, its HMAC signature and the whole processing path are identical to production. |

The point of this test is to prove the GoHighLevel half completely — field
mapping, contract value, stage move, PDF handling, payment behaviour — without
waiting on Pylon support.

## Records created

| | |
| --- | --- |
| Contact | "PYLON BRIDGE TEST RECORD" |
| Opportunity | "[PYLON BRIDGE TEST - safe to delete] 6.6 kW Solar + 10 kWh Battery - 1 Test Street" |

Both are safe to delete once you have looked at them.

## Acceptance criteria

### 1. No manual intervention once signed

The webhook was acknowledged in **13 ms**, well inside Pylon's 10-second budget.
Everything after that happened on its own.

### 2. All three data sets land in the specified fields

**Contract details** — on the opportunity:

| Field | Value |
| --- | --- |
| Contract Reference | `PYLON-TEST-0001` |
| Contract Value | `15600` |
| Contract Currency | `AUD` |
| Contract Signed Date | `2026-08-25` |
| System Size kW | `6.6` |
| Battery Storage kWh | `10` |
| Deposit Amount | `$1,560.00` |
| Amount Payable | `$14,040.00` |
| Web Proposal Link | (deep link) |
| Pylon Project Link | (deep link) |

**Client information** — on the contact: name, email, phone, address (line 1,
city, state, postcode, country), plus `Pylon Project Reference`,
`Pylon Project Link` and `Signed Contract PDF`. Tagged `contract-signed`.

**Payment data** — written by the second event, onto the same opportunity:

| Field | Value |
| --- | --- |
| Payment Received | `1560` |
| Payment Type | `Deposit` |
| Payment Date | `2026-08-25` |
| Payment Receipt Link | (receipt URL) |

**18 fields written** on the signature event, 4 more on the payment.

### 3. Clear error message when either system is unreachable

Covered by the test suite rather than by breaking the live account — see
"an unreachable GoHighLevel produces a plain-English failure" and "a bad token is
reported and not retried" in `test/integration.test.js`.

One of these fired for real during this session: the first live run pointed at
the stand-in with the wrong token and reported

> Pylon rejected the credentials (HTTP 401 on GET …/v1/solar_projects/rukSigcyTR).
> The API token is missing, expired, or lacks the required scope.

## The client's specific asks

### "the opportunity value changed to the contract value"

`monetaryValue` = **15600**, from Pylon's `pricing.total` of 1,560,000 cents.

Crucially, when the **deposit** of $1,560 arrived afterwards, the opportunity
value **stayed at 15600**. A deposit must never overwrite the contract value, so
the payment mapping deliberately has `"monetaryValue": null`.

### "updated in the contact opportunity in GHL"

The opportunity moved to the configured signed stage — **"Contract Signed -
Ready for finial approval"** — in the **Inspire Sales Leads** pipeline. Status stayed
`open`.

### "if the contract can be uploaded into customer opportunity that would be ideal"

**This works.** The signed PDF ends up in three places:

1. **On the opportunity, as a file.** The `Signed Contract File` opportunity
   field (FILE_UPLOAD) came back from GoHighLevel as:
   ```json
   [{"url":"https://assets.cdn.filesafe.space/<location>/media/<uuid>.pdf",
     "meta":{"mimetype":"application/pdf","name":"<uuid>.pdf","size":193},
     "deleted":false}]
   ```
2. **On the opportunity, as a link** — `Signed Contract PDF`, for anything that
   wants a plain URL.
3. **On the contact, as a real attachment** — a proper GoHighLevel document with
   its own `documentId`, downloadable from the contact record.

> Why re-host rather than link to Pylon? Pylon's
> `acceptance.latest_esignature_pdf_url` is valid for **one hour**. A link stored
> in the CRM would be dead the next morning. The bridge downloads the PDF and
> uploads it into your media library, so the CRM link never expires.

## Re-running does not create duplicates

The script was run twice against the same account. Both runs returned the *same*
contact id and the *same* opportunity id — the second run updated rather than
duplicated. Pylon retries a webhook up to five times over ~31 hours, so this
matters.

## Staged invoicing — RAISED FOR REAL (9 September)

Three real invoices now exist in the live GoHighLevel account, created by the
bridge, totalling exactly the contract:

| Stage | Amount | Raised by |
| --- | --- | --- |
| Deposit (10%) | $1,560.00 | the signature webhook, automatically |
| Pre-installation (60%) | $9,360.00 | `POST /invoices/pre_install` |
| Final payment (balance) | $4,680.00 | `POST /invoices/installation` |
| **Total** | **$15,600.00** | = the contract, to the cent |

Zero warnings on all three.

### The third stage is a remainder, not 30%

The business bills "10%, 60%, and the remaining amount", so the last stage is
`"remainder": true` rather than a hardcoded 30%. It takes the contract total
less whatever the earlier stages took. Two reasons that is better than 30%:

- the three invoices always add up to exactly the contract, whatever it is
- odd totals still balance. On $10,000.05 a fixed 30% leaves a cent stranded;
  the remainder does not.

Checked against $15,600, $10,000.05, $23,333.33, $7,000 and $0.03 — every one
sums to the contract exactly.

If the earlier stages ever come to 100% or more, the balance would be zero or
negative, so no invoice is raised and the event says why.

### Two bugs the live account found that the tests did not

The first live attempt came back `422 Unprocessable Entity`:

```
businessDetails.address.each value in nested property address must be either object or array
items.0.currency should not be empty
```

Both were real:

1. `businessDetails.address` must be an **object**, not a joined string.
2. Every line item needs its **own** `currency`, not just the invoice.

The test stand-in had accepted both happily, which is exactly how a bug ships
green. It now rejects them the same way the live API does — reverting either fix
fails six tests.

## Deployed and verified — 10 September 2026

Live at `https://pylon-ghl-bridge.onrender.com` on a Render Starter instance
with a 1 GB disk, deployed from the `render.yaml` blueprint by the client.

Checked against the running service, not a local copy:

| Check | Result |
| --- | --- |
| `GET /health?deep=1` | `ok: true`, `mode: full`, `dryRun: false` |
| Pylon API | connected |
| GoHighLevel API | connected |
| Pipeline + stage resolution | "Inspire Sales Leads" / "Contract Signed - Ready for finial approval" |
| `GET /mapping` | 23 mapping lines, **0 unresolved** against the real account |
| Unsigned webhook | **401**, nothing written |
| `/events` without the admin token | **401** |
| `/events` with the admin token | 200 |

### The deadlock this deploy nearly hit

The service used to refuse to start without `PYLON_WEBHOOK_SECRET`. But Pylon
only issues that secret when the webhook destination is created, and creating
the destination needs the deployed URL — so the first deploy would have
crash-looped with no URL to give Pylon.

It is now a startup warning. The failure mode was already safe: every webhook is
rejected with *"No PYLON_WEBHOOK_SECRET is configured on this server"*, which is
exactly what the live service returns today, and health stays green so the host
does not kill the deploy.

## Webhook signing verified live — 10 September 2026

The Pylon webhook destination now exists and `PYLON_WEBHOOK_SECRET` is set on
the running service. Verified against it directly:

| Request | Result |
| --- | --- |
| Correctly signed with the destination's secret | **202 accepted** |
| Same body, deliberately wrong signature | **401** — *"Signature does not match…"* |

The 401 control is the important half. Without it, a 202 only proves the service
answers, not that it is checking anything.

The signed request deliberately named a **non-existent** Pylon project, so it
could not touch a real customer. It was accepted, then failed exactly as it
should:

> Pylon could not find the requested record (HTTP 404 on GET
> api.getpylon.com/v1/solar_projects/ZZZ-does-not-exist).

Nothing was written to GoHighLevel. That one failed event is the only entry in
the production log and is expected.

## Staged invoicing PROVEN LIVE — 10 September 2026

Running commit `8c99ab1`. Both remaining stages raised through the deployed
service against the first real signed contract ($169):

| Stage | Amount | How |
| --- | --- | --- |
| Deposit (10%) | $16.90 | raised by hand while the phone fix was undeployed |
| Pre-installation (60%) | $101.40 | `POST /invoices/pre_install` |
| Final payment (30%) | $50.70 | `POST /invoices/installation` |
| **Total** | **$169.00** | = the contract, exactly |

Zero warnings on all three.

### The double-billing guard, tested on purpose

`POST /invoices/pre_install` was called **twice**. The second call returned the
**same invoice id** with `alreadyExisted: true` and created nothing.

That is the property worth having: in real use someone will drag a card back and
forth in the pipeline, or a workflow will fire twice, and neither can bill a
customer twice.

### Deep health at the same moment

`commit: 8c99ab1`, `mode: full`, `ok: true` — Pylon connected, GoHighLevel
connected, pipeline and stage resolved, **no warnings at all**.

## Everything is now proven end to end

Contract signed in Pylon → contact created or matched with an E.164 phone →
opportunity created, moved to the signed stage, value set to the contract value
→ signed PDF pulled from Pylon and filed in three places → deposit invoice
raised with the bank details, ABN and job reference → 60% and final invoices
raised on demand from a pipeline stage.

The only thing not exercised by a machine is a human dragging a card between
stages in GoHighLevel, which is what the two workflows in
[SETUP.md](SETUP.md) do.
