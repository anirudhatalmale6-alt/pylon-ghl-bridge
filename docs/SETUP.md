# Setup checklist

Roughly 20 minutes end to end. Steps 1–3 are things only you can do; the rest is
running commands on the server.

---

## 1. Pylon — API token

**Pylon → Settings → API → API tokens → Create token**

- Permission needed: **read** (the bridge never writes to Pylon)
- Copy the token into `PYLON_API_TOKEN` in `.env`

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

Copy the token into `GHL_API_TOKEN`.

Then **Settings → Business Profile** and copy the **Location ID** (the
sub-account id, not the agency id) into `GHL_LOCATION_ID`.

## 3. GoHighLevel — pipeline and stage

Decide which pipeline the opportunity belongs to and which stage means
"contract signed". Put the names — exactly as they read in the CRM — into:

```
GHL_PIPELINE_NAME=Solar Sales
GHL_SIGNED_STAGE_NAME=Contract Signed
GHL_PAID_STAGE_NAME=Deposit Paid      # optional
```

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

## 6. Start it

```bash
npm start
```

It must be reachable from the public internet over HTTPS. Put it behind nginx,
Caddy, or deploy to any Node host.

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
