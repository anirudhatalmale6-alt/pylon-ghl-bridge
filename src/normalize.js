/**
 * Turns raw Pylon objects into ONE flat, stable shape that the field-mapping
 * file addresses with dot paths. Everything the client can map lives here — if
 * a value is not in this object it cannot be mapped, so this file and
 * docs/FIELD-MAPPING.md are kept in step.
 *
 * Pylon expresses all money in minor units (cents). We expose both:
 *   contract.total_amount        -> 15600      (major units, what GHL wants)
 *   contract.total_amount_cents  -> 1560000
 */

export function centsToMajor(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return null;
  return Math.round(Number(cents)) / 100;
}

function attrs(resource) {
  return resource?.attributes ?? {};
}

function relationshipId(resource, name) {
  return resource?.relationships?.[name]?.data?.id ?? null;
}

function formatMoney(amountMajor, currency) {
  if (amountMajor === null || amountMajor === undefined) return null;
  try {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: currency || 'AUD',
      currencyDisplay: 'narrowSymbol',
    }).format(amountMajor);
  } catch {
    return `${currency || ''} ${amountMajor.toFixed(2)}`.trim();
  }
}

function addressFrom(project) {
  const a = attrs(project).site_address ?? {};
  const parts = [a.line1, a.line2, a.city, a.state, a.zip].filter(Boolean);
  return {
    line1: a.line1 ?? '',
    line2: a.line2 ?? '',
    city: a.city ?? '',
    state: a.state ?? '',
    postcode: a.zip ?? '',
    country: a.country ?? '',
    country_code: attrs(project).site_country_code ?? '',
    full: parts.join(', '),
  };
}

function clientFrom(project, eventAttrs = {}) {
  const details = attrs(project).customer_details ?? {};
  // The signer's own name/email (from the event) is the more authoritative
  // record of who actually signed; the project record is the fallback.
  const name = eventAttrs.customer_name || details.name || '';
  const email = eventAttrs.customer_email || details.email || '';
  const { firstName, lastName } = splitName(name);
  return {
    name,
    first_name: firstName,
    last_name: lastName,
    email,
    phone: details.phone || '',
    project_contact_name: details.name || '',
    project_contact_email: details.email || '',
    address: addressFrom(project),
  };
}

/**
 * Converts a phone number to E.164 (+<country><number>), which the GoHighLevel
 * INVOICE api insists on:
 *   422 "contactDetails.Phone number must be in E.164 format (e.g., +1234567890)"
 *
 * Contacts accept a local number happily; invoices do not. Every customer phone
 * in the live Pylon account is an Australian local number like "0417522630", so
 * without this every single invoice fails.
 *
 * Returns null when the number cannot be converted confidently — the caller
 * omits the field rather than sending something wrong. A missing phone on an
 * invoice is a blank line; a wrong one is a wrong invoice.
 */
const DIALLING_CODES = { AU: '61', NZ: '64', GB: '44', IE: '353', US: '1', CA: '1', ZA: '27', SG: '65' };

export function toE164(raw, countryCode) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // Already international.
  if (text.startsWith('+')) {
    const digits = text.slice(1).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  let digits = text.replace(/\D/g, '');
  if (!digits) return null;

  // 00 is the international access prefix in most of the world.
  if (digits.startsWith('00')) {
    const rest = digits.slice(2);
    return rest.length >= 8 && rest.length <= 15 ? `+${rest}` : null;
  }

  const dial = DIALLING_CODES[String(countryCode ?? '').toUpperCase()];
  if (!dial) return null; // unknown country: guessing a dialling code invents a number

  // A leading 0 is the national trunk prefix and is dropped when going international.
  const national = digits.startsWith('0') ? digits.slice(1) : digits;
  const full = `${dial}${national}`;
  return full.length >= 8 && full.length <= 15 ? `+${full}` : null;
}

export function splitName(fullName) {
  const clean = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!clean) return { firstName: '', lastName: '' };
  const parts = clean.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
}

function projectFrom(project) {
  const a = attrs(project);
  const acceptance = a.acceptance ?? {};
  const site = a.site_details ?? {};
  return {
    id: project?.id ?? null,
    reference_number: a.reference_number ?? '',
    in_app_url: null, // filled from the event, which carries the deep link
    country_code: a.site_country_code ?? '',
    latitude: Array.isArray(a.site_location) ? a.site_location[1] ?? null : null,
    longitude: Array.isArray(a.site_location) ? a.site_location[0] ?? null : null,
    is_accepted: Boolean(acceptance.is_accepted),
    manually_sold: Boolean(acceptance.manually_sold),
    has_signed_esignature: Boolean(acceptance.latest_esignature),
    signed_pdf_url: acceptance.latest_esignature_pdf_url ?? null,
    job_sheet_url: a.job_sheet_url ?? null,
    is_committed: Boolean(a.is_committed),
    is_archived: Boolean(a.is_archived),
    roof_type: site.roof_type ?? '',
    storeys: site.number_of_storeys ?? null,
    power_phases: site.power_phases ?? '',
    building_classification: site.building_classification ?? '',
    nmi: site.nmi ?? '',
    mpan: site.mpan ?? '',
    meter_number: site.meter_number ?? '',
    energy_retailer: site.energy_retailer ?? '',
    energy_distributor: site.energy_distributor ?? '',
    dnsp_preapproval_number: site.dnsp_preapproval_number ?? '',
    created_at: a.created_at ?? null,
    updated_at: a.updated_at ?? null,
    owner_user_id: relationshipId(project, 'owner'),
  };
}

function contractFrom(design, { project, eventAttrs = {} } = {}) {
  const a = attrs(design);
  const pricing = a.pricing ?? {};
  const summary = a.summary ?? {};
  const quote = a.proposal_quote ?? {};
  const currency = pricing.currency || quote.currency || '';
  const totalMajor = centsToMajor(pricing.total);

  return {
    design_id: design?.id ?? null,
    title: a.title ?? '',
    label: a.label ?? null,
    // What a human would call this deal.
    name: a.label || a.title || 'Signed contract',
    description: summary.description ?? '',
    system_size_kw: summary.dc_output_kw ?? null,
    storage_kwh: summary.storage_kwh ?? null,
    is_primary_design: Boolean(a.is_primary),

    currency,
    total_amount: totalMajor,
    total_amount_cents: pricing.total ?? null,
    total_includes_tax: pricing.total_includes_tax ?? null,
    total_amount_formatted: quote.total_price_formatted || formatMoney(totalMajor, currency),
    total_tax_formatted: quote.total_tax_formatted ?? null,
    deposit_amount_formatted: quote.deposit_amount_formatted ?? null,
    financed_amount_formatted: quote.financed_amount_formatted ?? null,
    amount_payable_formatted: quote.amount_payable_formatted ?? null,

    proposal_web_url: summary.web_proposal_url ?? null,
    proposal_pdf_url: summary.pdf_proposal_url ?? null,
    digital_handover_url: summary.digital_handover_url ?? null,
    single_line_diagram_url: summary.single_line_diagram_pdf_url ?? null,
    snapshot_image_url: summary.latest_snapshot_url ?? null,

    // Filled in by the handler once the PDF has been re-hosted in GHL.
    signed_pdf_url: attrs(project).acceptance?.latest_esignature_pdf_url ?? null,
    signed_pdf_stored_url: null,
    signed_pdf_filename: null,

    signer_name: eventAttrs.customer_name ?? '',
    signer_email: eventAttrs.customer_email ?? '',
    signed_at: eventAttrs.created_at ?? null,

    line_items: (a.line_items ?? []).map((item) => ({
      key: item.key,
      description: item.description,
      summary_line: item.included_in_summary_line,
      unit_amount: centsToMajor(item.unit_amount),
      quantity: item.quantity,
      total_amount: centsToMajor(item.total_amount),
      tax_amount: centsToMajor(item.tax_amount),
      component_type: item.component_type,
      component_id: item.component_id,
      hidden: Boolean(item.is_line_hidden),
    })),
  };
}

function eventFrom(event) {
  const a = attrs(event);
  return {
    id: event?.id ?? null,
    name: a.name ?? '',
    created_at: a.created_at ?? null,
    description: a.description ?? '',
    project_in_app_url: a.project_in_app_url ?? null,
    opportunity_in_app_url: a.opportunity_in_app_url ?? null,
    reference_number: a.project_reference_number ?? '',
  };
}

/** web_proposals.signed → canonical payload. */
export function normalizeSignedEvent({ event, project, design }) {
  const eventAttrs = attrs(event);
  const normalizedProject = projectFrom(project);
  normalizedProject.in_app_url = eventAttrs.project_in_app_url ?? null;

  return {
    event: eventFrom(event),
    client: clientFrom(project, eventAttrs),
    project: normalizedProject,
    contract: contractFrom(design, { project, eventAttrs }),
    payment: emptyPayment(),
  };
}

/** gateway_payments.created → canonical payload. */
export function normalizePaymentEvent({ event, project, design }) {
  const eventAttrs = attrs(event);
  const normalizedProject = project ? projectFrom(project) : emptyProject();
  normalizedProject.in_app_url = eventAttrs.project_in_app_url ?? normalizedProject.in_app_url;

  const amountMajor = centsToMajor(eventAttrs.amount);
  return {
    event: eventFrom(event),
    client: project ? clientFrom(project, {}) : emptyClient(),
    project: normalizedProject,
    contract: design ? contractFrom(design, { project: project ?? {}, eventAttrs: {} }) : emptyContract(),
    payment: {
      purpose: eventAttrs.purpose ?? '',
      // Pylon calls it "deposit" or "total"; spell it out for the CRM.
      purpose_label: eventAttrs.purpose === 'total' ? 'Balance / total' : 'Deposit',
      amount: amountMajor,
      amount_cents: eventAttrs.amount ?? null,
      currency: eventAttrs.currency ?? '',
      amount_formatted: formatMoney(amountMajor, eventAttrs.currency),
      receipt_url: eventAttrs.receipt_url || null,
      received_at: eventAttrs.created_at ?? null,
      is_paid: amountMajor !== null && amountMajor > 0,
    },
  };
}

function emptyPayment() {
  return {
    purpose: '',
    purpose_label: '',
    amount: null,
    amount_cents: null,
    currency: '',
    amount_formatted: null,
    receipt_url: null,
    received_at: null,
    is_paid: false,
  };
}

function emptyProject() {
  return projectFrom({ id: null, attributes: {} });
}

function emptyClient() {
  return clientFrom({ attributes: {} }, {});
}

function emptyContract() {
  return contractFrom({ id: null, attributes: {} }, { project: { attributes: {} }, eventAttrs: {} });
}

/** Reads the two relationship ids off any Pylon event. */
export function eventRelationships(event) {
  return {
    solarProjectId: relationshipId(event, 'solar_project'),
    solarDesignId: relationshipId(event, 'solar_design'),
    opportunityId: relationshipId(event, 'opportunity'),
  };
}
