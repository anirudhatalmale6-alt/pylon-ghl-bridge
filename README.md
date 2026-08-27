# Pylon → GoHighLevel bridge

When a customer signs a proposal in [Pylon](https://getpylon.com), this service
pushes the contract, the client details and the payment information into
GoHighLevel, files the signed PDF against the record, and sets the opportunity's
value to the contract value — with no manual step in between.

```
 Pylon                       this service                    GoHighLevel
 ─────                       ────────────                    ───────────
 customer signs
   │
   │ web_proposals.signed  ──▶ verify HMAC signature
   │ (webhook, HMAC-SHA256)    202 Accepted (< 10s)
   │                           │
   │                           ├─ GET /v1/solar_projects/:id ──┐ client details,
   │◀──────────────────────────┤                               │ site address,
   │                           ├─ GET /v1/solar_designs/:id  ──┘ price, PDF link
   │                           │
   │                           ├─ download signed PDF (link expires in 1h)
   │                           │
   │                           ├─ POST /medias/upload-file ──────▶ permanent copy
   │                           ├─ POST /contacts/upsert ─────────▶ contact
   │                           ├─ POST /forms/upload-custom-files▶ PDF on contact
   │                           ├─ GET  /opportunities/search ────▶ find the deal
   │                           ├─ PUT  /opportunities/:id ───────▶ value + stage
   │                           │                                  + custom fields
   │                           └─ POST /contacts/:id/notes ──────▶ timeline note
   │
   │ gateway_payments.created ▶ same path, payment fields only
```

## What lands where

| Data set | Goes to |
| --- | --- |
| Client information | The GoHighLevel **contact** — name, email, phone, install address, plus the Pylon reference |
| Contract details | The **opportunity** — reference, value, currency, signed date, signer, system size, install address, proposal links |
| Payment data | The **opportunity** — deposit and amount payable at signing; amount, type, date and receipt link when a Pylon gateway payment arrives |
| The signed contract PDF | Uploaded to the GoHighLevel media library (permanent link on the opportunity) **and** attached as a file to the contact record |

Every value above is set in [`config/mapping.json`](config/mapping.json) and can
be changed without touching code — see [docs/FIELD-MAPPING.md](docs/FIELD-MAPPING.md).

## Why the PDF is copied rather than linked

Pylon's signed-contract URL is documented as valid for **one hour** after it is
issued. A link stored in the CRM would be dead by the next morning, so the
bridge downloads the PDF while the link is live and re-hosts it in GoHighLevel's
own media library. What lands in the CRM never expires.

## Requirements

- Node.js 20.11 or newer (no database, no other services)
- A Pylon webhook destination
- A GoHighLevel Private Integration Token for the sub-account
- *Optional but recommended:* a Pylon API token with `read` permission

## Two modes

Pylon does not hand out API tokens by default — their developer FAQ says API
access has to be switched on by their support team. So the bridge runs either
way:

| | **Webhook-only** (no `PYLON_API_TOKEN`) | **Full** (token configured) |
| --- | --- | --- |
| Contact created / matched | yes | yes |
| Signer name and email | yes | yes |
| Stage → contract signed | yes | yes |
| Link back to Pylon | yes | yes |
| Payment amount / type / receipt | yes | yes |
| **Opportunity value = contract value** | no | yes |
| Site address, system size, battery | no | yes |
| **Signed contract PDF** | no | yes |

In webhook-only mode the right-hand-column fields are **left unchanged** and
reported as a warning on the event — never blanked, never guessed at. Add the
token later and replay the events (`POST /events/{id}/replay`) to fill them in.

`GET /health` reports which mode it is in.

## Proof it works

[docs/LIVE-TEST.md](docs/LIVE-TEST.md) — a real run against a live GoHighLevel
account: contract value on the opportunity, the stage move, all three data sets
in their fields, and the signed PDF attached to both the opportunity and the
contact.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in
npm run discover          # prints your pipelines, stages and custom field keys
npm run bootstrap-fields  # shows which custom fields are missing
npm run bootstrap-fields -- --apply   # creates them
npm start
```

`npm run discover` writes `docs/discovery.md` — keep it, it is the id reference
for everything else.

### Point Pylon at the service

In Pylon, **API settings → Webhook destinations → Create**:

- URL: `https://your-server.example.com/webhooks/pylon`
- Events: `web_proposals.signed` and `gateway_payments.created`
- Copy the secret it shows you into `PYLON_WEBHOOK_SECRET`

Then prove the wiring without signing a real contract:

```bash
npm run simulate                       # a realistic signed-contract event
npm run simulate -- --event payment    # a gateway payment event
npm run simulate -- --bad-signature    # must be rejected with 401
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/webhooks/pylon` | Where Pylon delivers. Verifies the HMAC signature, then acknowledges with `202` |
| `GET` | `/health` | Liveness plus event counts. `?deep=1` also checks both API tokens and the pipeline config (admin token required) |
| `GET` | `/events?limit=50` | Recent deliveries with their outcome |
| `GET` | `/events/:id` | Everything about one delivery, including the raw Pylon payload |
| `POST` | `/events/:id/replay` | Re-run an event after fixing whatever broke |
| `GET` | `/mapping` | The field map resolved against the live account — shows which lines hit a real field |
| `POST` | `/mapping/reload` | Re-read `config/mapping.json` without a restart |

All of these except `/webhooks/pylon` and the shallow `/health` require
`Authorization: Bearer $ADMIN_TOKEN`.

## Error handling

Nothing fails silently.

- A webhook with a bad or missing signature, or a stale timestamp, gets `401`
  and a message saying exactly which check failed. Nothing is written.
- Once accepted, the event is processed on a queue with its own retries
  (10s → 1m → 5m → 30m → 1h by default). Anything unreachable, timed out, rate
  limited or 5xx is retried; a bad token or an invalid payload is not, because
  retrying will not fix it.
- Every failure carries a plain sentence, e.g.
  *"GoHighLevel is unreachable (services.leadconnectorhq.com/contacts/upsert,
  ECONNREFUSED). Check that the host is up and that this server has outbound
  network access."*
- Partial failures degrade rather than abort: if the contract PDF cannot be
  downloaded, the opportunity value and stage are still updated and the problem
  is recorded as a warning on the event.
- Set `BRIDGE_CALLBACK_URL` to get a signed JSON summary POSTed to you for every
  processed event, success or failure.

Pylon retries a failed delivery five times over ~31 hours. Events are recorded
by their Pylon event id, so a redelivery of an event that already succeeded is
acknowledged and ignored rather than processed twice.

## Data on disk

```
data/events.jsonl   append-only log, one line per state change
data/state.json     current state of each event, survives a restart
```

No customer data leaves the server other than to Pylon and GoHighLevel. Tokens
are redacted from all log output.

## Tests

```bash
npm test
```

40 tests. The end-to-end ones run real HTTP servers standing in for Pylon and
GoHighLevel, so the assertions are made against the actual requests that would
hit the live APIs — multipart bodies, headers, query strings and all.

## Deployment

Any Node host works. A systemd unit:

```ini
[Unit]
Description=Pylon to GoHighLevel bridge
After=network-online.target

[Service]
WorkingDirectory=/opt/pylon-ghl-bridge
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/pylon-ghl-bridge/.env
User=pylonbridge

[Install]
WantedBy=multi-user.target
```

Put it behind HTTPS — Pylon will only be sending to a public URL, and the
signed contract data should not travel in the clear.
