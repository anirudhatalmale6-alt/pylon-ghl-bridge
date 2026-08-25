# Walk-through: what happens when a contract is signed

This is a real transcript. It was produced by `node scripts/demo.js`, which runs
the bridge against stand-in Pylon and GoHighLevel servers and prints every HTTP
request that crosses the wire. Run it yourself at any time — it touches no live
account.

The only differences from production are the host names and the field ids
(`cf_val`, `cf_ref`…), which in your account are the real GoHighLevel ids that
`npm run discover` prints.

---

## Part 1 — the customer signs the contract

Andre Rieu opens his proposal in Pylon, types his name and signs. Nobody
touches GoHighLevel.

```text
==============================================================================
STEP 1  Pylon delivers web_proposals.signed
==============================================================================
POST https://bridge.example.com/webhooks/pylon
Pylon-Webhook-Signature: hs256=<hmac-sha256 of "<timestamp>.<body>">
Pylon-Webhook-Timestamp: <unix seconds>

{
  "data": {
    "type": "events",
    "id": "oKcdQEqKvq962di",
    "attributes": {
      "name": "web_proposals.signed",
      "created_at": "2026-08-25T02:11:00+00:00",
      "description": "Andre Rieu signed proposal for 19 Parmesan Avenue",
      "customer_name": "Andre Rieu",
      "customer_email": "andre@example.com",
      "project_in_app_url": "https://app.getpylon.com/library/rukSigcyTR/view/RnlPy9NMNr"
    },
    "relationships": {
      "solar_design": {
  ...

<- HTTP 202 in 24ms  {"ok":true,"eventId":"oKcdQEqKvq962di","eventName":"web_proposals.signed","status":"accepted"}
   (acknowledged immediately — Pylon gives us 10 seconds; the work continues in the background)

==============================================================================
STEP 2  The bridge reads the detail from Pylon
==============================================================================
GET   /v1/solar_projects/rukSigcyTR
GET   /v1/solar_designs/RnlPy9NMNr
GET   /files/signed.pdf

==============================================================================
STEP 3  The bridge writes to GoHighLevel
==============================================================================
POST  /medias/upload-file?altId=loc-test&altType=location
      multipart, 633 bytes, form field "file", file "Signed Contract - PYL-0003-7789 - Andre Rieu.pdf"

GET   /locations/loc-test/customFields?model=all

GET   /opportunities/pipelines?locationId=loc-test

POST  /contacts/upsert
      {
        "locationId": "loc-test",
        "firstName": "Andre",
        "lastName": "Rieu",
        "name": "Andre Rieu",
        "email": "andre@example.com",
        "phone": "0400 000 000",
        "address1": "19 Parmesan Avenue",
        "city": "Glen Iris",
        "state": "Victoria",
        "postalCode": "3147",
        "country": "AU",
        "source": "Pylon - contract signed",
        "customFields": [
          {
            "id": "cf_c_ref",
            "value": "PYL-0003-7789"
          },
          {
            "id": "cf_c_link",
            "value": "https://app.getpylon.com/library/rukSigcyTR/view/RnlPy9NMNr"
          },
          {
            "id": "cf_c_pdf",
            "value": "https://storage.googleapis.com/ghl/media-1.pdf"
          }
        ],
        "tags": [
          "contract-signed"
        ]
      }

POST  /forms/upload-custom-files?contactId=contact-1&locationId=loc-test
      multipart, 450 bytes, form field "cf_c_file_<uuid>", file "Signed Contract - PYL-0003-7789 - Andre Rieu.pdf"

GET   /opportunities/search?location_id=loc-test&contact_id=contact-1&pipeline_id=pipe-1&status=all&limit=100

POST  /opportunities/
      {
        "locationId": "loc-test",
        "pipelineId": "pipe-1",
        "contactId": "contact-1",
        "name": "6.6 kW Solar + 10 kWh Battery - 19 Parmesan Avenue",
        "status": "open",
        "pipelineStageId": "stage-signed",
        "monetaryValue": 15600,
        "customFields": [
          {
            "id": "cf_ref",
            "fieldValue": "PYL-0003-7789"
          },
          {
            "id": "cf_val",
            "fieldValue": 15600
          },
          {
            "id": "cf_cur",
            "fieldValue": "AUD"
          },
          {
            "id": "cf_date",
            "fieldValue": "2026-08-25"
          },
          {
            "id": "cf_by",
            "fieldValue": "Andre Rieu"
          },
          {
            "id": "cf_byemail",
            "fieldValue": "andre@example.com"
          },
          {
            "id": "cf_pdf",
            "fieldValue": "https://storage.googleapis.com/ghl/media-1.pdf"
          },
          {
            "id": "cf_kw",
            "fieldValue": 6.6
          },
          {
            "id": "cf_kwh",
            "fieldValue": 10
          },
          {
            "id": "cf_dep",
            "fieldValue": "$1,560.00"
          },
          {
            "id": "cf_pay",
            "fieldValue": "$14,040.00"
          },
          {
            "id": "cf_addr",
            "fieldValue": "19 Parmesan Avenue, Glen Iris, Victoria, 3147"
          },
          {
            "id": "cf_plink",
            "fieldValue": "https://app.getpylon.com/library/rukSigcyTR/view/RnlPy9NMNr"
          },
          {
            "id": "cf_wlink",
            "fieldValue": "https://proposals.getpylon.test/p/RnlPy9NMNr"
          }
        ]
      }

POST  /contacts/contact-1/notes
      {
        "body": "Contract signed in Pylon on 2026-08-25.\nSigned by: Andre Rieu (andre@example.com)\nSystem: 16 x 415W panels, 5kW inverter, 10kWh battery\nContract value: $15,600.00\nDeposit: $1,560.00\nPylon reference: PYL-0003-7789\nSigned contract: https://storage.googleapis.com/ghl/media-1.pdf\nPylon project: https://app.getpylon.com/library/rukSigcyTR/view/RnlPy9NMNr"
      }

==============================================================================
STEP 4  The result, as recorded by the bridge
==============================================================================
GET https://bridge.example.com/events/oKcdQEqKvq962di   (Authorization: Bearer <ADMIN_TOKEN>)

{
  "id": "oKcdQEqKvq962di",
  "eventName": "web_proposals.signed",
  "status": "succeeded",
  "attempts": 1,
  "result": {
    "eventName": "web_proposals.signed",
    "contactId": "contact-1",
    "contactCustomFields": [
      "contact.pylon_project_reference",
      "contact.pylon_project_link",
      "contact.signed_contract_pdf"
    ],
    "opportunityId": "opp-new",
    "opportunityCreated": true,
    "opportunityStage": "Contract Signed",
    "pipeline": "Solar Sales",
    "monetaryValue": 15600,
    "currency": "AUD",
    "fieldsWritten": 17,
    "contractFileUrl": "https://storage.googleapis.com/ghl/media-1.pdf",
    "contractFileBytes": 193,
    "contractAttachedToContact": true,
    "noteAdded": true,
    "warnings": []
  }
}
```

### What just happened, in words

1. **Pylon delivered the event** with an HMAC-SHA256 signature. The bridge
   recomputed the signature over the exact bytes received and only then accepted
   the request. An unsigned or tampered request gets a `401` and nothing is
   written.
2. **It answered in 24 milliseconds.** Pylon's delivery times out after 10
   seconds; the real work runs behind the acknowledgement so a slow PDF upload
   can never make Pylon think the delivery failed.
3. **It read the project and the design from Pylon** — the customer's details
   and install address from the project, the price and system spec from the
   design the customer actually signed.
4. **It downloaded the signed PDF and re-hosted it.** Pylon's link expires an
   hour after it is issued, so the bridge grabs the file while the link is live
   and uploads it to your GoHighLevel media library. The URL that ends up in the
   CRM is permanent.
5. **It upserted the contact**, matching on email and phone so a repeat customer
   does not become a second record.
6. **It attached the PDF to the contact record** as a real file, not a link.
7. **It looked for an existing opportunity** for that contact in the pipeline.
   There wasn't one, so it created it — in the *Contract Signed* stage, worth
   **$15,600**, with fourteen contract fields filled in.
8. **It added a note to the timeline** so the change is visible at a glance.

Total: no human involvement between the signature and the CRM being right.

---

## Part 2 — the customer pays the deposit

Later the same customer pays their deposit through Pylon's gateway. This time
the opportunity already exists, so it is updated rather than duplicated.

```text
==============================================================================
STEP 1  Pylon delivers gateway_payments.created
==============================================================================
POST https://bridge.example.com/webhooks/pylon
Pylon-Webhook-Signature: hs256=<hmac-sha256 of "<timestamp>.<body>">
Pylon-Webhook-Timestamp: <unix seconds>

{
  "data": {
    "type": "events",
    "id": "D1yqsg0HLER0sMiS",
    "attributes": {
      "name": "gateway_payments.created",
      "created_at": "2026-08-25T04:30:00+00:00",
      "description": "Payment received",
      "purpose": "deposit",
      "amount": 156000,
      "currency": "AUD",
      "receipt_url": "https://receipts.getpylon.test/D1yqsg0HLER0sMiS"
    },
    "relationships": {
  ...

<- HTTP 202 in 24ms  {"ok":true,"eventId":"D1yqsg0HLER0sMiS","eventName":"gateway_payments.created","status":"accepted"}
   (acknowledged immediately — Pylon gives us 10 seconds; the work continues in the background)

==============================================================================
STEP 2  The bridge reads the detail from Pylon
==============================================================================
GET   /v1/solar_projects/rukSigcyTR
GET   /v1/solar_designs/RnlPy9NMNr

==============================================================================
STEP 3  The bridge writes to GoHighLevel
==============================================================================
GET   /locations/loc-test/customFields?model=all

GET   /opportunities/pipelines?locationId=loc-test

POST  /contacts/upsert
      {
        "locationId": "loc-test",
        "email": "andre@example.com",
        "phone": "0400 000 000",
        "tags": [
          "payment-received"
        ]
      }

GET   /opportunities/search?location_id=loc-test&contact_id=contact-1&pipeline_id=pipe-1&status=all&limit=100

PUT   /opportunities/opp-7788
      {
        "pipelineStageId": "stage-paid",
        "customFields": [
          {
            "id": "cf_prec",
            "fieldValue": 1560
          },
          {
            "id": "cf_ptype",
            "fieldValue": "Deposit"
          },
          {
            "id": "cf_pdate",
            "fieldValue": "2026-08-25"
          },
          {
            "id": "cf_precpt",
            "fieldValue": "https://receipts.getpylon.test/D1yqsg0HLER0sMiS"
          }
        ],
        "pipelineId": "pipe-1"
      }

POST  /contacts/contact-1/notes
      {
        "body": "Payment received through Pylon on 2026-08-25.\nType: Deposit\nAmount: $1,560.00\nReceipt: https://receipts.getpylon.test/D1yqsg0HLER0sMiS\nPylon reference: PYL-0003-7789"
      }

==============================================================================
STEP 4  The result, as recorded by the bridge
==============================================================================
GET https://bridge.example.com/events/D1yqsg0HLER0sMiS   (Authorization: Bearer <ADMIN_TOKEN>)

{
  "id": "D1yqsg0HLER0sMiS",
  "eventName": "gateway_payments.created",
  "status": "succeeded",
  "attempts": 1,
  "result": {
    "eventName": "gateway_payments.created",
    "contactId": "contact-1",
    "opportunityId": "opp-7788",
    "opportunityStage": "Deposit Paid",
    "amount": 1560,
    "currency": "AUD",
    "purpose": "deposit",
    "fieldsWritten": 4,
    "noteAdded": true,
    "warnings": []
  }
}
```

Note what the bridge **does not** do here: it leaves `monetaryValue` alone. A
$1,560 deposit must never overwrite a $15,600 contract value.

---

## Part 3 — when something goes wrong

### The webhook signature does not match

```text
POST /webhooks/pylon
<- HTTP 401
{"ok":false,"error":"Signature does not match. The webhook secret on this
  server does not match the one Pylon is signing with."}
```

Nothing is read from Pylon and nothing is written to GoHighLevel. Prove this for
yourself with `npm run simulate -- --bad-signature`.

### GoHighLevel is unreachable

The event is accepted, then fails on the write and is retried on a schedule of
10s → 1m → 5m → 30m → 1h. `GET /events/<id>` shows:

```json
{
  "status": "retrying",
  "attempts": 2,
  "error": {
    "kind": "unreachable",
    "summary": "GoHighLevel is unreachable (services.leadconnectorhq.com/contacts/upsert, ECONNREFUSED). Check that the host is up and that this server has outbound network access. Retrying in 60s."
  }
}
```

### The GoHighLevel token is wrong or has lost a scope

```json
{
  "status": "failed",
  "error": {
    "kind": "auth",
    "retryable": false,
    "summary": "GoHighLevel rejected the credentials (HTTP 401 on POST services.leadconnectorhq.com/contacts/upsert). The API token is missing, expired, or lacks the required scope."
  }
}
```

This one is deliberately **not** retried — a bad token will still be bad in an
hour. Fix the token, then:

```bash
curl -X POST https://bridge.example.com/events/<id>/replay \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

The event re-runs from the stored payload. Pylon does not need to re-send it.

### The contract PDF could not be fetched

The value, the stage and every field still update. The event succeeds with a
warning recorded against it:

```json
"warnings": [
  "Could not download the contract PDF from Pylon: these links expire one hour after they are issued..."
]
```

The money landing matters more than the document, so a document problem never
blocks it.

### Pylon delivers the same event twice

Pylon retries a failed delivery up to five times over about 31 hours. Events are
keyed by their Pylon event id, so a redelivery of something already processed
returns `200 {"duplicate": true}` and is ignored. No double opportunity, no
double note.

---

## Part 4 — proving it on your own account

Before a real contract goes through:

```bash
# 1. Are both sets of credentials good, and does the pipeline config resolve?
curl -s "https://bridge.example.com/health?deep=1" -H "Authorization: Bearer $ADMIN_TOKEN"

# 2. Does every mapping line point at a field that actually exists?
curl -s https://bridge.example.com/mapping -H "Authorization: Bearer $ADMIN_TOKEN"

# 3. Fire a realistic event at it end to end.
npm run simulate -- --url https://bridge.example.com/webhooks/pylon

# 4. Confirm the guard works — this MUST be rejected.
npm run simulate -- --bad-signature --url https://bridge.example.com/webhooks/pylon

# 5. Read what happened.
curl -s https://bridge.example.com/events -H "Authorization: Bearer $ADMIN_TOKEN"
```

Then run one genuine test contract through Pylon end to end and check the
opportunity in GoHighLevel.
