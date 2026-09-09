# Field mapping guide

Everything about *where a value lands in GoHighLevel* is decided by one file:

```
config/mapping.json
```

Nothing in that file is compiled in. Change it, run

```bash
curl -X POST https://your-server/mapping/reload -H "Authorization: Bearer $ADMIN_TOKEN"
```

(or just restart the service) and the next contract uses the new map.

---

## 1. How a mapping line reads

```json
"opportunity.contract_value": "{{contract.total_amount}}"
```

- **Left** — the GoHighLevel field to write to.
- **Right** — where the value comes from in the Pylon data.

The left side accepts any of three forms, whichever is easiest for you:

| Form | Example | Notes |
| --- | --- | --- |
| Field key | `opportunity.contract_value` | What GoHighLevel calls the field internally. Recommended — it survives renames. |
| Field name | `Contract Value` | Exactly as shown in the CRM. Breaks if you rename the field. |
| Field id | `6Ax9k2LmQpZ...` | Never changes, but unreadable. |

Run `npm run discover` to print all three for every field in your account.

## 2. The right-hand side

| You write | You get |
| --- | --- |
| `{{contract.total_amount}}` | the value, keeping its type (a number stays a number) |
| `{{client.email \|\| client.project_contact_email}}` | the first one that is not empty |
| `{{client.email \|\| "unknown@example.com"}}` | a literal fallback in quotes |
| `{{contract.name}} - {{client.address.city}}` | free text mixed with values |
| `{{contract.signed_at \| date}}` | run through a filter |

### Filters

| Filter | Turns | Into |
| --- | --- | --- |
| `date` | `2026-08-25T02:11:00+00:00` | `2026-08-25` |
| `datetime` | any date | full ISO-8601 |
| `number` | `"6.6"` | `6.6` |
| `upper` / `lower` / `trim` | text | text |
| `yesno` | `true` | `Yes` |
| `count` | a list | how many |
| `first` | a list | its first entry |
| `json` | anything | its JSON form |

### Two rules worth knowing

1. **An empty value is skipped, not written.** If Pylon has no phone number for
   this customer, the phone field in GoHighLevel is left exactly as it was
   rather than being blanked. Set `"writeEmptyValues": true` at the top of
   `mapping.json` if you want the opposite.
2. **A field that does not exist is reported, not guessed at.** The event
   succeeds, and the missing field is listed under `warnings` on
   `GET /events/:id`. Nothing is silently dropped.
3. **Without a Pylon API token, only some paths have values.** The webhook body
   carries `event.*`, the signer's name and email, the Pylon deep link, and the
   whole of `payment.*`. Everything else — `project.*`, `contract.*` and the
   client's address and phone — needs a lookup. Those come out empty, so by rule
   1 the CRM field is left unchanged and rule 2 puts a warning on the event.
   See [SETUP.md](SETUP.md#running-before-that-happens--webhook-only-mode).

### The payment stages

The `invoices` section of a signed-event mapping defines how a contract is
billed. Each stage becomes one GoHighLevel invoice:

```json
"invoices": {
  "currency": "{{contract.currency || 'AUD'}}",
  "stages": [
    { "key": "deposit",      "label": "Deposit",          "percent": 10, "trigger": "signed", "dueDays": 7,
      "name": "Deposit (10%) - {{project.reference_number}}",
      "description": "10% deposit on signing." },
    { "key": "pre_install",  "label": "Pre-installation", "percent": 60, "trigger": "manual", "dueDays": 7, "...": "..." },
    { "key": "installation", "label": "Final payment", "remainder": true, "trigger": "manual", "dueDays": 0, "...": "..." }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `key` | how you refer to the stage in `POST /invoices/{key}`. Must be unique — it is what stops a stage being billed twice. |
| `percent` | share of the contract total. Rounded to cents. |
| `amount` | a fixed figure instead of a percentage. Wins over `percent`. |
| `remainder` | `true` means "whatever is left of the contract after the other stages". Use this for a final balance rather than writing a percentage — it always adds up, and it survives odd totals that a percentage rounds badly. Only one stage may have it. |
| `trigger` | `signed` raises it the moment the contract is signed. `manual` waits for `POST /invoices/{key}`. |
| `dueDays` | days from the invoice being raised to its due date. `0` means due immediately. |
| `name`, `description` | templates, same syntax as everywhere else. |

`invoices.termsNotes` (HTML, templated) is printed on every invoice — this is
where bank-transfer details go when no payment provider is connected. A stage
may override it with its own `termsNotes`.

#### Keeping bank details out of the repo

`{{env.NAME}}` reads a value from the environment instead of from this file, so
account details never get committed:

```json
"termsNotes": "<p>Account name: {{env.BANK_NAME}}<br>BSB: {{env.BANK_BSB}}<br>Account number: {{env.BANK_ACCOUNT}}<br>Reference: {{project.reference_number}}</p>"
```

with the real values in `.env`, which is gitignored:

```
TPL_BANK_NAME=Your Company Pty Ltd
TPL_BANK_BSB=000-000
TPL_BANK_ACCOUNT=00000000
```

**Only variables named `TPL_*` are visible**, with the prefix stripped. That is a
deliberate whitelist: this file writes into customer records, so an unfiltered
`{{env.…}}` would let a mistyped `{{env.GHL_API_TOKEN}}` publish a credential
into the CRM. Anything not named `TPL_` renders as empty.

**The percentages are checked.** If the stages do not add up to 100% the bridge
says so at startup and on `GET /health`, with the shortfall in dollars. A
`remainder` stage makes the total 100% by construction, so there is nothing to
warn about — unless the stages before it already reach 100%, which would leave
the balance at zero. Without a remainder, a total that is not 100% is reported
but not enforced: a business may invoice part of a job elsewhere. Duplicate
`key`s are reported the same way.

To change the split, edit `percent` and restart (or `POST /mapping/reload`).

The business name, address, phone and website come from your GoHighLevel
location, not from this file.

### The signed contract PDF

Three mapping lines, three different things:

| Mapping line | Field type | What lands |
| --- | --- | --- |
| `opportunity.signed_contract_file` | FILE_UPLOAD | the PDF **as a file on the opportunity** |
| `opportunity.signed_contract_pdf` | TEXT | a permanent link to it |
| `contact.signed_contract_file` | FILE_UPLOAD | the PDF as an attachment on the contact |

All three read from `{{contract.signed_pdf_stored_url}}` — the URL in *your*
media library, not Pylon's. Never map a CRM field to
`{{contract.signed_pdf_url}}`: that is Pylon's own link and it expires after an
hour.

## 3. Checking your map against the live account

```bash
curl -s https://your-server/mapping -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

Every line comes back with `"resolved": true|false` and the field id it will
write to. Anything showing `false` is a typo or a field that no longer exists.

---

## 4. What ships by default

### `web_proposals.signed` — a customer signs the contract

**Contact** (standard fields)

| GoHighLevel | From Pylon |
| --- | --- |
| First name | `client.first_name` |
| Last name | `client.last_name` |
| Email | `client.email`, falling back to the project's contact email |
| Phone | `client.phone` |
| Address / City / State / Postcode / Country | the install address on the Pylon project |
| Source | `Pylon - contract signed` |
| Tag | `contract-signed` |

**Contact** (custom fields)

| GoHighLevel field key | From Pylon |
| --- | --- |
| `contact.pylon_project_reference` | `project.reference_number` |
| `contact.pylon_project_link` | `project.in_app_url` |
| `contact.signed_contract_pdf` | `contract.signed_pdf_stored_url` |
| `contact.signed_contract_file` | the PDF itself, uploaded as a file |

**Opportunity**

| GoHighLevel | From Pylon |
| --- | --- |
| Name | `{{contract.name}} - {{client.address.line1}}` |
| **Value** | `contract.total_amount` — the signed contract total |
| Stage | whatever `GHL_SIGNED_STAGE_NAME` is set to |
| Status | `open` (set `GHL_STATUS_ON_SIGNED=won` to close it as won instead) |
| `opportunity.contract_reference` | `project.reference_number` |
| `opportunity.contract_value` | `contract.total_amount` |
| `opportunity.contract_currency` | `contract.currency` |
| `opportunity.contract_signed_date` | `contract.signed_at` as a date |
| `opportunity.signed_by` | `contract.signer_name` |
| `opportunity.signed_by_email` | `contract.signer_email` |
| `opportunity.signed_contract_pdf` | the permanent GoHighLevel copy of the PDF |
| `opportunity.system_size_kw` | `contract.system_size_kw` |
| `opportunity.battery_storage_kwh` | `contract.storage_kwh` |
| `opportunity.deposit_amount` | `contract.deposit_amount_formatted` |
| `opportunity.amount_payable` | `contract.amount_payable_formatted` |
| `opportunity.install_address` | `client.address.full` |
| `opportunity.pylon_project_link` | `project.in_app_url` |
| `opportunity.web_proposal_link` | `contract.proposal_web_url` |

A note is also added to the contact timeline summarising the signature.

### `gateway_payments.created` — a customer pays through Pylon

| GoHighLevel | From Pylon |
| --- | --- |
| Stage | `GHL_PAID_STAGE_NAME`, if set |
| `opportunity.payment_received` | `payment.amount` |
| `opportunity.payment_type` | Deposit or Balance / total |
| `opportunity.payment_date` | `payment.received_at` as a date |
| `opportunity.payment_receipt_link` | `payment.receipt_url` |

The opportunity **value is deliberately left alone** on a payment — a $1,560
deposit must not overwrite a $15,600 contract.

---

## 5. Everything you can map

These are all the source paths available. Money is in major units (dollars)
unless the name says `_cents`; Pylon's own API returns cents everywhere.

### `event.*`

| Path | Example |
| --- | --- |
| `event.id` | `oKcdQEqKvq962di` |
| `event.name` | `web_proposals.signed` |
| `event.created_at` | `2026-08-25T02:11:00+00:00` |
| `event.description` | `Andre Rieu signed proposal for 19 Parmesan Avenue` |
| `event.project_in_app_url` | link to the project in Pylon |

### `client.*`

| Path | Example |
| --- | --- |
| `client.name` | `Andre Rieu` |
| `client.first_name` | `Andre` |
| `client.last_name` | `Rieu` |
| `client.email` | `andre@example.com` |
| `client.phone` | `0400 000 000` |
| `client.project_contact_name` | the name on the Pylon project (may differ from the signer) |
| `client.project_contact_email` | the email on the Pylon project |
| `client.address.line1` | `19 Parmesan Avenue` |
| `client.address.line2` | |
| `client.address.city` | `Glen Iris` |
| `client.address.state` | `Victoria` |
| `client.address.postcode` | `3147` |
| `client.address.country` | `Australia` |
| `client.address.country_code` | `AU` |
| `client.address.full` | `19 Parmesan Avenue, Glen Iris, Victoria, 3147` |

### `project.*`

| Path | Example |
| --- | --- |
| `project.id` | `rukSigcyTR` |
| `project.reference_number` | `PYL-0003-7789` |
| `project.in_app_url` | link to the project in Pylon |
| `project.latitude` / `project.longitude` | `-37.851`, `145.071` |
| `project.is_accepted` | `true` |
| `project.manually_sold` | `false` |
| `project.has_signed_esignature` | `true` |
| `project.signed_pdf_url` | Pylon's link — **expires after 1 hour**, use `contract.signed_pdf_stored_url` instead |
| `project.job_sheet_url` | link to the job sheet |
| `project.is_committed` / `project.is_archived` | `true` / `false` |
| `project.roof_type` | `tile` |
| `project.storeys` | `2` |
| `project.power_phases` | `one` |
| `project.building_classification` | `residential` |
| `project.nmi` | `6203785492` (Australia) |
| `project.mpan` | UK meter point reference |
| `project.meter_number` | `M12345` |
| `project.energy_retailer` | `AGL` |
| `project.energy_distributor` | `United Energy` |
| `project.dnsp_preapproval_number` | `DNSP-99182` |
| `project.created_at` / `project.updated_at` | timestamps |

### `contract.*`

| Path | Example |
| --- | --- |
| `contract.design_id` | `RnlPy9NMNr` |
| `contract.title` | `6.6 kW Solar + 10 kWh Battery` |
| `contract.label` | the custom label, if one was set |
| `contract.name` | the label if there is one, otherwise the title |
| `contract.description` | `16 x 415W panels, 5kW inverter, 10kWh battery` |
| `contract.system_size_kw` | `6.6` |
| `contract.storage_kwh` | `10` |
| `contract.currency` | `AUD` |
| **`contract.total_amount`** | `15600` — **this is the contract value** |
| `contract.total_amount_cents` | `1560000` |
| `contract.total_amount_formatted` | `$15,600.00` |
| `contract.total_includes_tax` | `true` |
| `contract.total_tax_formatted` | `$1,418.18` |
| `contract.deposit_amount_formatted` | `$1,560.00` |
| `contract.financed_amount_formatted` | `$0.00` |
| `contract.amount_payable_formatted` | `$14,040.00` |
| `contract.proposal_web_url` | the customer-facing proposal page |
| `contract.proposal_pdf_url` | the proposal as a PDF |
| `contract.digital_handover_url` | the handover page |
| `contract.single_line_diagram_url` | the SLD PDF |
| `contract.snapshot_image_url` | the panel layout image |
| `contract.signed_pdf_url` | Pylon's link — expires after 1 hour |
| **`contract.signed_pdf_stored_url`** | the permanent GoHighLevel copy |
| `contract.signed_pdf_filename` | `Signed Contract - PYL-0003-7789 - Andre Rieu.pdf` |
| `contract.signer_name` | `Andre Rieu` |
| `contract.signer_email` | `andre@example.com` |
| `contract.signed_at` | `2026-08-25T02:11:00+00:00` |
| `contract.line_items` | the full quote breakdown (see below) |

Line items are a list; address them by index, e.g.
`{{contract.line_items.0.description}}`. Each has `key`, `description`,
`summary_line`, `unit_amount`, `quantity`, `total_amount`, `tax_amount`,
`component_type`, `component_id`, `hidden`.

### `payment.*`

Populated on `gateway_payments.created`; empty on a signature event.

| Path | Example |
| --- | --- |
| `payment.purpose` | `deposit` or `total` |
| `payment.purpose_label` | `Deposit` or `Balance / total` |
| `payment.amount` | `1560` |
| `payment.amount_cents` | `156000` |
| `payment.currency` | `AUD` |
| `payment.amount_formatted` | `$1,560.00` |
| `payment.receipt_url` | link to the receipt |
| `payment.received_at` | `2026-08-25T04:30:00+00:00` |
| `payment.is_paid` | `true` |

---

## 6. Worked examples

**Put the system size into the opportunity name**

```json
"name": "{{contract.system_size_kw}}kW - {{client.name}} - {{client.address.city}}"
```

**Write the deposit as a number rather than formatted text**

```json
"opportunity.deposit_amount": "{{contract.total_amount_cents}}"
```
…or add a `Deposit Amount` field of type Monetary and map
`"{{contract.deposit_amount_formatted}}"` to a text field instead.

**Only fill the NMI for Australian jobs, with a placeholder otherwise**

```json
"opportunity.nmi": "{{project.nmi || \"n/a\"}}"
```

**Send the customer's own proposal link, not the internal one**

```json
"opportunity.web_proposal_link": "{{contract.proposal_web_url}}"
```

**Close the deal as won on signature** — set `GHL_STATUS_ON_SIGNED=won` in
`.env`, or `"status": "won"` in the opportunity section of the map.
