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

## Not yet proven

The Pylon end. Nothing has been read from a real Pylon account, because no API
token exists yet, and no real Pylon webhook has been delivered, because the
destination has not been created. Both need:

1. Pylon support to enable API access on the team, then a read token, and
2. the bridge deployed on a public HTTPS URL so a webhook destination can point
   at it.
