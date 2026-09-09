import { IntegrationError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { eventRelationships, normalizePaymentEvent, normalizeSignedEvent } from './normalize.js';
import { buildCustomFields, cleanCustomFields, indexCustomFields, render, renderObject, toIsoDate } from './mapping.js';

export const SIGNED_EVENT = 'web_proposals.signed';
export const PAYMENT_EVENT = 'gateway_payments.created';

/**
 * Does the actual work for one webhook: read from Pylon, write to GoHighLevel.
 * Kept free of HTTP concerns so it can be exercised directly by the tests.
 */
export class Processor {
  constructor({ config, pylon, ghl, mapping, store = null }) {
    this.config = config;
    this.pylon = pylon;
    this.ghl = ghl;
    this.mapping = mapping;
    // Optional. Used to remember which GHL records a Pylon project landed in so
    // a later payment event can find them without a Pylon lookup.
    this.store = store;
    this._targets = null;
  }

  /** True when a Pylon API token is configured and lookups are possible. */
  get canEnrich() {
    return Boolean(this.pylon?.enabled);
  }

  /**
   * Fetches the project and design behind an event, or returns nulls plus a
   * plain-English warning when no Pylon API token is configured. Never throws
   * for the no-token case — the point of webhook-only mode is that the parts
   * that CAN land still land.
   */
  async fetchContext({ solarProjectId, solarDesignId, warnings, missingFields }) {
    if (!this.canEnrich) {
      warnings.push(
        `No Pylon API token is configured, so ${missingFields} could not be read and were left unchanged in GoHighLevel. ` +
          'Everything the webhook itself carries was written. Ask Pylon support to enable API access on your team ' +
          '(Team Settings → API Settings), add the token as PYLON_API_TOKEN, and replay this event to fill the rest in.',
      );
      return { project: null, design: null };
    }
    const [project, design] = await Promise.all([
      solarProjectId ? this.pylon.getSolarProject(solarProjectId) : Promise.resolve(null),
      solarDesignId ? this.pylon.getSolarDesign(solarDesignId) : Promise.resolve(null),
    ]);
    return { project, design };
  }

  setMapping(mapping) {
    this.mapping = mapping;
  }

  /**
   * Resolves the configured pipeline and stage NAMES into ids once, and caches.
   * Doing it lazily means the service still starts when GHL is briefly down.
   */
  async resolveTargets({ fresh = false } = {}) {
    if (this._targets && !fresh) return this._targets;

    const pipelines = await this.ghl.listPipelines({ fresh });
    const { pipelineId, pipelineName, signedStageId, signedStageName, paidStageId, paidStageName } = this.config.ghl;

    const pipeline =
      pipelines.find((p) => p.id === pipelineId) ||
      pipelines.find((p) => p.name?.trim().toLowerCase() === pipelineName.trim().toLowerCase());

    if (!pipeline) {
      const available = pipelines.map((p) => p.name).join(', ') || '(none)';
      throw new IntegrationError(
        `Pipeline "${pipelineName || pipelineId}" was not found in GoHighLevel location ${this.config.ghl.locationId}. Pipelines available: ${available}.`,
        { kind: 'config', system: 'GoHighLevel', retryable: false },
      );
    }

    const stages = pipeline.stages ?? [];
    const findStage = (id, name, label, required) => {
      if (!id && !name) {
        if (required) {
          throw new IntegrationError(`No ${label} stage is configured.`, { kind: 'config', system: 'bridge' });
        }
        return null;
      }
      const stage =
        stages.find((s) => s.id === id) ||
        stages.find((s) => s.name?.trim().toLowerCase() === String(name).trim().toLowerCase());
      if (!stage) {
        if (!required) {
          logger.warn('optional stage not found, it will be left unchanged', { label, name, pipeline: pipeline.name });
          return null;
        }
        const available = stages.map((s) => s.name).join(', ') || '(none)';
        throw new IntegrationError(
          `The ${label} stage "${name || id}" was not found in pipeline "${pipeline.name}". Stages available: ${available}.`,
          { kind: 'config', system: 'GoHighLevel', retryable: false },
        );
      }
      return stage;
    };

    this._targets = {
      pipeline,
      signedStage: findStage(signedStageId, signedStageName, 'contract-signed', true),
      paidStage: findStage(paidStageId, paidStageName, 'payment-received', false),
    };
    logger.info('resolved GoHighLevel targets', {
      pipeline: pipeline.name,
      signedStage: this._targets.signedStage?.name,
      paidStage: this._targets.paidStage?.name ?? null,
    });
    return this._targets;
  }

  async fieldIndex({ fresh = false } = {}) {
    const fields = await this.ghl.listCustomFields('all', { fresh });
    return indexCustomFields(fields);
  }

  async handle(record) {
    const event = record.payload?.data;
    if (!event || event.type !== 'events') {
      throw new IntegrationError(
        'The webhook body did not contain a Pylon event object (expected {"data":{"type":"events",...}}).',
        { kind: 'validation', system: 'Pylon', retryable: false, detail: { received: Object.keys(record.payload ?? {}) } },
      );
    }

    const eventName = event.attributes?.name;
    switch (eventName) {
      case SIGNED_EVENT:
        return this.handleSigned(event);
      case PAYMENT_EVENT:
        return this.handlePayment(event);
      default:
        logger.info('ignoring event type that is not mapped', { eventName });
        return { skipped: true, reason: `No mapping is configured for "${eventName}", so nothing was written.`, eventName };
    }
  }

  // --------------------------------------------------------------- signed

  async handleSigned(event) {
    const mapping = this.mapping.events[SIGNED_EVENT];
    if (!mapping) {
      throw new IntegrationError(`config/mapping.json has no "${SIGNED_EVENT}" section.`, {
        kind: 'mapping',
        system: 'bridge',
        retryable: false,
      });
    }

    const { solarProjectId, solarDesignId } = eventRelationships(event);
    if (!solarProjectId) {
      throw new IntegrationError(
        'This web_proposals.signed event carries no solar_project relationship, so there is no customer record to sync.',
        { kind: 'validation', system: 'Pylon', retryable: false },
      );
    }

    const warnings = [];
    const { project, design } = await this.fetchContext({
      solarProjectId,
      solarDesignId,
      warnings,
      missingFields: 'the contract value, site address, system size and the signed contract PDF',
    });

    if (this.canEnrich && !project) {
      throw new IntegrationError(`Pylon returned no solar project for id ${solarProjectId}.`, {
        kind: 'not_found',
        system: 'Pylon',
        retryable: false,
      });
    }

    const payload = normalizeSignedEvent({ event, project, design });
    // In webhook-only mode there is no project object, but the event still tells
    // us which project it was — keep the id so it can be mapped and linked.
    payload.project.id = payload.project.id || solarProjectId;
    payload.contract.design_id = payload.contract.design_id || solarDesignId;

    // 1. Re-host the signed PDF before anything is mapped — the Pylon link is
    //    only valid for an hour, so the CRM must hold a copy, not a pointer.
    const contract = await this.storeContractPdf(payload);
    payload.contract.signed_pdf_stored_url = contract.url;
    payload.contract.signed_pdf_filename = contract.filename;

    const index = await this.fieldIndex();
    const targets = await this.resolveTargets();
    warnings.push(...contract.warnings);

    // 2. Contact.
    const contactResult = await this.writeContact({ mapping, payload, index, warnings });

    // 3. The actual PDF onto the contact record, if a file field is configured.
    let contactFileAttached = false;
    if (contract.buffer && this.config.ghl.uploadContractFile) {
      contactFileAttached = await this.attachContractToContact({
        contactId: contactResult.id,
        index,
        contract,
        warnings,
      });
    }

    // 4. Opportunity.
    const opportunityResult = await this.writeOpportunity({
      mapping,
      payload,
      index,
      warnings,
      contactId: contactResult.id,
      stage: targets.signedStage,
      pipeline: targets.pipeline,
    });

    // 5. Invoices for any payment stage triggered by the signature.
    const invoices = await this.raiseInvoices({
      mapping,
      payload,
      contactId: contactResult.id,
      warnings,
      trigger: 'signed',
    });

    // 6. Timeline note, so the change is visible without opening a field.
    let noteAdded = false;
    if (this.config.ghl.addNote && mapping.note) {
      const body = render(mapping.note, payload);
      if (body) {
        await this.ghl.createContactNote(contactResult.id, body);
        noteAdded = true;
      }
    }

    // Remember where this project landed so a later payment event — which
    // arrives with the project id but no customer details — can find it.
    this.store?.linkProject(payload.project.id, {
      contactId: contactResult.id,
      opportunityId: opportunityResult.id,
      contactName: payload.client.name,
      contactEmail: payload.client.email,
      signedAt: payload.contract.signed_at,
      contractTotal: payload.contract.total_amount,
      currency: payload.contract.currency,
      reference: payload.project.reference_number,
      contactPhone: payload.client.phone,
    });

    return {
      eventName: SIGNED_EVENT,
      mode: this.canEnrich ? 'full' : 'webhook-only',
      contactId: contactResult.id,
      contactCustomFields: contactResult.written,
      opportunityId: opportunityResult.id,
      opportunityCreated: opportunityResult.created,
      opportunityStage: targets.signedStage?.name,
      pipeline: targets.pipeline?.name,
      monetaryValue: opportunityResult.monetaryValue,
      currency: payload.contract.currency,
      fieldsWritten: contactResult.written.length + opportunityResult.written.length,
      contractFileUrl: contract.url,
      contractFileBytes: contract.bytes,
      contractAttachedToContact: contactFileAttached,
      invoices,
      invoicedTotal: invoices.reduce((sum, i) => sum + (i.amount ?? 0), 0),
      noteAdded,
      warnings,
    };
  }


  // -------------------------------------------------------------- payment

  async handlePayment(event) {
    const mapping = this.mapping.events[PAYMENT_EVENT];
    if (!mapping) {
      return { skipped: true, reason: `config/mapping.json has no "${PAYMENT_EVENT}" section.`, eventName: PAYMENT_EVENT };
    }

    const { solarProjectId, solarDesignId } = eventRelationships(event);
    if (!solarProjectId) {
      // Pylon's own docs show this event arriving with an empty relationships
      // block. Without a project there is no way to identify the customer.
      return {
        skipped: true,
        eventName: PAYMENT_EVENT,
        reason:
          'This gateway_payments.created event carried no solar_project relationship, so the payment could not be matched to a GoHighLevel contact. Nothing was written.',
      };
    }

    const warnings = [];
    const { project, design } = await this.fetchContext({
      solarProjectId,
      solarDesignId,
      warnings,
      missingFields: "the payer's name and email address",
    });

    const payload = normalizePaymentEvent({ event, project, design });
    payload.project.id = payload.project.id || solarProjectId;

    const index = await this.fieldIndex();
    const targets = await this.resolveTargets();

    // Without a Pylon token the payment event carries no customer details at
    // all, so fall back to the contact this project was linked to when the
    // contract was signed.
    const link = this.store?.lookupProject(solarProjectId) ?? null;
    if (!payload.client.email && !payload.client.phone && link?.contactId) {
      warnings.push(
        `The payer's details were not in the webhook, so this payment was matched to the contact recorded when project ${solarProjectId} was signed (${link.contactName || link.contactId}).`,
      );
      const linkedResult = await this.writePaymentToKnownContact({
        mapping,
        payload,
        index,
        warnings,
        link,
        targets,
      });
      return linkedResult;
    }

    if (!payload.client.email && !payload.client.phone) {
      return {
        skipped: true,
        eventName: PAYMENT_EVENT,
        mode: this.canEnrich ? 'full' : 'webhook-only',
        reason:
          `This payment carried no customer details, and project ${solarProjectId} has not been through a contract-signed event on this bridge, ` +
          'so there is nothing to match it to. Nothing was written. Once the signature for this project has been processed, replay this event and it will land.',
        warnings,
      };
    }

    const contactResult = await this.writeContact({ mapping, payload, index, warnings });
    const opportunityResult = await this.writeOpportunity({
      mapping,
      payload,
      index,
      warnings,
      contactId: contactResult.id,
      stage: targets.paidStage,
      pipeline: targets.pipeline,
      createIfMissing: false,
    });

    let noteAdded = false;
    if (this.config.ghl.addNote && mapping.note) {
      const body = render(mapping.note, payload);
      if (body) {
        await this.ghl.createContactNote(contactResult.id, body);
        noteAdded = true;
      }
    }

    return {
      eventName: PAYMENT_EVENT,
      contactId: contactResult.id,
      opportunityId: opportunityResult.id,
      opportunityStage: targets.paidStage?.name ?? null,
      amount: payload.payment.amount,
      currency: payload.payment.currency,
      purpose: payload.payment.purpose,
      fieldsWritten: contactResult.written.length + opportunityResult.written.length,
      noteAdded,
      warnings,
    };
  }

  /**
   * Raises the GoHighLevel invoices whose trigger matches.
   *
   * The business bills in stages (a deposit on signing, a larger payment before
   * installation, the balance on the day), so this raises one invoice per stage
   * rather than one for the whole contract. Only the "signed" stages fire from a
   * Pylon webhook; the later ones are raised through POST /invoices/:key, which
   * a GoHighLevel workflow can call when the opportunity reaches the right
   * stage.
   *
   * Never fails the event: a signature that reached the CRM is worth more than
   * an invoice that didn't, so every problem here degrades to a warning.
   */
  async raiseInvoices({ mapping, payload, contactId, warnings, trigger = 'signed', only = null }) {
    if (!this.config.ghl.createInvoice) return [];

    const section = mapping.invoices;
    if (!section?.stages?.length) {
      warnings.push('Invoicing is switched on but config/mapping.json has no "invoices.stages" for this event, so none was raised.');
      return [];
    }

    const contractTotal = toNumber(payload.contract.total_amount);
    if (contractTotal === null || contractTotal <= 0) {
      warnings.push(
        this.canEnrich
          ? 'No invoices were raised: the contract has no total value to take a percentage of.'
          : 'No invoices were raised, because the contract value is only readable through the Pylon API and no token is configured. Everything else still landed.',
      );
      return [];
    }

    const wanted = section.stages.filter((stage) =>
      only ? stage.key === only : (stage.trigger ?? 'manual') === trigger,
    );
    if (!wanted.length) return [];

    const business = await this.invoiceBusinessDetails();
    // The GoHighLevel location holds the TRADING name. A tax invoice has to
    // carry the legal entity and its ABN, which can differ, so both are
    // overridable from the mapping (and therefore from .env).
    const businessName = render(section.businessName, payload);
    if (businessName) business.name = businessName;
    const businessAbn = render(section.businessAbn, payload);
    const raised = [];
    // Computed across ALL stages, not just the ones being raised now — the
    // remainder stage needs to know what the others took.
    const amounts = stageAmounts(section.stages, contractTotal);

    for (const stage of wanted) {
      const already = this.store?.lookupProject(payload.project.id)?.invoices?.[stage.key];
      if (already) {
        // An invoice is a billing document. Pylon retries up to five times and a
        // workflow can fire more than once; neither may bill the customer twice.
        logger.info('payment stage already invoiced, skipping', { stage: stage.key, invoiceId: already.id });
        raised.push({ key: stage.key, id: already.id, amount: already.amount, alreadyExisted: true, sent: false });
        continue;
      }

      const amount = amounts.get(stage.key);
      if (amount === null || amount === undefined) {
        warnings.push(`Payment stage "${stage.key}" has no percent, amount or remainder, so no invoice was raised for it.`);
        continue;
      }
      if (amount <= 0) {
        warnings.push(
          `Payment stage "${stage.key}" worked out to ${amount}, so no invoice was raised. ` +
            'Check the percentages in config/mapping.json — the earlier stages may already cover the whole contract.',
        );
        continue;
      }

      const issueDate = toIsoDate(new Date().toISOString());
      const currency = render(section.currency, payload) || payload.contract.currency || 'AUD';
      const invoiceBody = {
        name: render(stage.name, payload) || `${stage.label ?? stage.key} - ${payload.project.reference_number ?? ''}`.trim(),
        currency,
        businessDetails: business,
        contactDetails: {
          id: contactId,
          name: payload.client.name,
          email: payload.client.email,
          phoneNo: payload.client.phone,
        },
        items: [
          {
            name: render(stage.name, payload) || stage.label || stage.key,
            description: render(stage.description, payload) || '',
            amount,
            qty: 1,
            // Required per line item as well as on the invoice; omitting it is
            // rejected with "items.0.currency should not be empty".
            currency,
          },
        ],
        discount: { type: 'percentage', value: 0 },
        issueDate,
        dueDate: addDays(issueDate, stage.dueDays ?? this.config.ghl.invoiceDueDays),
        liveMode: this.config.ghl.invoiceLiveMode,
        sentTo: { email: payload.client.email ? [payload.client.email] : [] },
      };

      // How to pay. On a bank-transfer business this is the only thing telling
      // the customer where to send the money, so it matters more than usual.
      let terms = render(stage.termsNotes ?? section.termsNotes, payload);
      // Appended rather than templated into termsNotes so that an unset ABN
      // leaves no dangling "ABN:" label on the invoice.
      if (businessAbn) terms = `${terms ?? ''}<p>ABN: ${businessAbn}</p>`;
      if (terms) invoiceBody.termsNotes = terms;

      // Only sent when a card/bank-debit preference is actually configured.
      // A business taking bank transfers has no Stripe account, and posting a
      // Stripe payment-method block for one would be noise at best.
      const bankDebitOnly = stage.bankDebitOnly ?? this.config.ghl.invoiceBankDebitOnly;
      if (bankDebitOnly !== null && bankDebitOnly !== undefined) {
        // Bank debit only means BECS in Australia, which Stripe caps at $3.50
        // rather than charging 1.7% of a five-figure instalment.
        invoiceBody.paymentMethods = { stripe: { enableBankDebitOnly: bankDebitOnly } };
      }

      let invoice;
      try {
        invoice = await this.ghl.createInvoice(invoiceBody);
      } catch (error) {
        warnings.push(
          error.status === 401
            ? `No invoice was raised for the "${stage.key}" stage: the GoHighLevel token is missing the "invoices.write" scope. Add it to the Private Integration and replay this event. Everything else landed.`
            : `No invoice was raised for the "${stage.key}" stage: ${error.message} Everything else landed.`,
        );
        logger.warn('invoice creation failed', { stage: stage.key, error });
        continue;
      }

      const id = invoice._id ?? invoice.id;
      this.store?.recordInvoice(payload.project.id, stage.key, { id, amount });

      let sent = false;
      if (this.config.ghl.invoiceSendAction !== 'none') {
        try {
          await this.ghl.sendInvoice(id, {
            action: this.config.ghl.invoiceSendAction,
            userId: this.config.ghl.invoiceUserId || undefined,
            liveMode: this.config.ghl.invoiceLiveMode,
          });
          sent = true;
        } catch (error) {
          warnings.push(`The "${stage.key}" invoice was created but could not be sent: ${error.message} It is on the contact as a draft.`);
          logger.warn('invoice send failed', { stage: stage.key, error });
        }
      }

      raised.push({ key: stage.key, label: stage.label ?? stage.key, id, amount, sent });
    }

    return raised;
  }

  async invoiceBusinessDetails() {
    try {
      const location = await this.ghl.getLocation();
      return {
        name: location?.name ?? '',
        // MUST be an object. A joined string is rejected with
        // "each value in nested property address must be either object or array".
        address: {
          addressLine1: location?.address ?? '',
          city: location?.city ?? '',
          state: location?.state ?? '',
          countryCode: location?.country ?? '',
          postalCode: location?.postalCode ?? '',
        },
        phoneNo: location?.phone ?? '',
        website: location?.website ?? '',
        logoUrl: location?.logoUrl || undefined,
      };
    } catch (error) {
      // Not fatal — GHL fills its own defaults if businessDetails is thin.
      logger.warn('could not read the location for invoice business details', { error });
      return {};
    }
  }

  /**
   * Writes a payment onto the contact and opportunity we already know about,
   * skipping the upsert entirely. This is the path taken in webhook-only mode,
   * where the payment event carries an amount but no way to identify the payer.
   */
  async writePaymentToKnownContact({ mapping, payload, index, warnings, link, targets }) {
    const writeEmpty = this.mapping.writeEmptyValues === true;

    const contactFields = buildCustomFields({
      mappingFields: mapping.contact?.customFields ?? {},
      source: payload,
      index,
      model: 'contact',
      valueKey: 'value',
      writeEmpty,
    });
    for (const reference of contactFields.unresolved) {
      warnings.push(`Contact field "${reference}" does not exist in GoHighLevel and was skipped.`);
    }
    if (contactFields.entries.length) {
      await this.ghl.updateContact(link.contactId, { customFields: cleanCustomFields(contactFields.entries) });
    }

    const tags = (mapping.contact?.tags ?? []).map((tag) => render(tag, payload)).filter(Boolean);
    await this.ghl.addContactTags(link.contactId, tags);

    const opportunityFields = buildCustomFields({
      mappingFields: mapping.opportunity?.customFields ?? {},
      source: payload,
      index,
      model: 'opportunity',
      valueKey: 'fieldValue',
      writeEmpty,
    });
    for (const reference of opportunityFields.unresolved) {
      warnings.push(`Opportunity field "${reference}" does not exist in GoHighLevel and was skipped.`);
    }

    let opportunityId = link.opportunityId ?? null;
    if (opportunityId) {
      const body = {};
      if (opportunityFields.entries.length) body.customFields = cleanCustomFields(opportunityFields.entries);
      if (targets.paidStage?.id) {
        body.pipelineStageId = targets.paidStage.id;
        body.pipelineId = targets.pipeline.id;
      }
      if (Object.keys(body).length) await this.ghl.updateOpportunity(opportunityId, body);
    } else {
      warnings.push(
        'No opportunity was recorded for this project when the contract was signed, so only the contact was updated.',
      );
    }

    let noteAdded = false;
    if (this.config.ghl.addNote && mapping.note) {
      const body = render(mapping.note, payload);
      if (body) {
        await this.ghl.createContactNote(link.contactId, body);
        noteAdded = true;
      }
    }

    return {
      eventName: PAYMENT_EVENT,
      mode: 'webhook-only',
      matchedVia: 'pylon-project-link',
      contactId: link.contactId,
      opportunityId,
      opportunityStage: opportunityId ? targets.paidStage?.name ?? null : null,
      amount: payload.payment.amount,
      currency: payload.payment.currency,
      purpose: payload.payment.purpose,
      fieldsWritten: contactFields.entries.length + (opportunityId ? opportunityFields.entries.length : 0),
      noteAdded,
      warnings,
    };
  }

  // ---------------------------------------------------------------- parts

  async storeContractPdf(payload) {
    const warnings = [];
    const sourceUrl = payload.project.signed_pdf_url || payload.contract.proposal_pdf_url;

    if (!sourceUrl) {
      // In webhook-only mode the caller has already said why nothing could be
      // read from Pylon; repeating it here would just be noise.
      if (this.canEnrich) {
        warnings.push(
          'Pylon returned no signed-contract PDF link for this project, so no document was uploaded. Check that the e-signature completed rather than the proposal simply being viewed.',
        );
      }
      return { url: null, buffer: null, filename: null, bytes: 0, warnings };
    }

    let download;
    try {
      download = await this.pylon.downloadPdf(sourceUrl);
    } catch (error) {
      // A missing document must not block the value/stage update — that is the
      // part the client cares most about — so this degrades to a warning.
      warnings.push(`Could not download the contract PDF from Pylon: ${error.message}`);
      logger.warn('contract PDF download failed', { error });
      return { url: null, buffer: null, filename: null, bytes: 0, warnings };
    }

    const filename = buildFilename(payload);
    try {
      const uploaded = await this.ghl.uploadMedia({
        buffer: download.buffer,
        filename,
        contentType: download.contentType,
        parentId: this.config.ghl.mediaFolderId || undefined,
      });
      return {
        url: uploaded?.url ?? null,
        fileId: uploaded?.fileId ?? null,
        buffer: download.buffer,
        contentType: download.contentType,
        filename,
        bytes: download.bytes,
        warnings,
      };
    } catch (error) {
      warnings.push(`Could not upload the contract PDF into the GoHighLevel media library: ${error.message}`);
      logger.warn('contract PDF upload failed', { error });
      return { url: null, buffer: download.buffer, contentType: download.contentType, filename, bytes: download.bytes, warnings };
    }
  }

  async attachContractToContact({ contactId, index, contract, warnings }) {
    const fieldKey = this.config.ghl.contractFileFieldKey;
    const field = index.lookup(fieldKey, 'contact');
    if (!field) {
      warnings.push(
        `No contact custom field matches "${fieldKey}", so the contract PDF was not attached to the contact record. Run \`npm run bootstrap-fields\` to create it, or point GHL_CONTRACT_FILE_FIELD_KEY at an existing field.`,
      );
      return false;
    }
    if (field.dataType !== 'FILE_UPLOAD') {
      warnings.push(
        `The contact field "${field.name}" is of type ${field.dataType}, not FILE_UPLOAD, so the PDF could not be attached to it. The permanent media-library link was still written.`,
      );
      return false;
    }
    try {
      await this.ghl.uploadContactCustomFile({
        contactId,
        customFieldId: field.id,
        buffer: contract.buffer,
        filename: contract.filename,
        contentType: contract.contentType,
      });
      return true;
    } catch (error) {
      warnings.push(`Could not attach the contract PDF to the contact record: ${error.message}`);
      logger.warn('contact file attach failed', { error });
      return false;
    }
  }

  async writeContact({ mapping, payload, index, warnings }) {
    const section = mapping.contact ?? {};
    const writeEmpty = this.mapping.writeEmptyValues === true;
    const standard = renderObject(section.standard ?? {}, payload, { writeEmpty });

    if (!standard.email && !standard.phone) {
      throw new IntegrationError(
        'Neither an email address nor a phone number came through for this customer, so GoHighLevel has nothing to match the contact on. Add the customer\'s contact details on the Pylon project and replay the event.',
        { kind: 'validation', system: 'bridge', retryable: false },
      );
    }

    const { entries, unresolved, skipped } = buildCustomFields({
      mappingFields: section.customFields ?? {},
      source: payload,
      index,
      model: 'contact',
      valueKey: 'value',
      writeEmpty,
    });

    for (const reference of unresolved) {
      warnings.push(`Contact field "${reference}" does not exist in GoHighLevel and was skipped.`);
    }
    if (skipped.length) {
      logger.debug('contact fields skipped (no value)', { skipped });
    }

    const body = { ...standard };
    if (entries.length) body.customFields = cleanCustomFields(entries);
    if (Array.isArray(section.tags) && section.tags.length) {
      body.tags = section.tags.map((tag) => render(tag, payload)).filter(Boolean);
    }

    const contact = await this.ghl.upsertContact(body);
    return { id: contact.id, written: entries.map((e) => e._key ?? e.id), body };
  }

  async writeOpportunity({ mapping, payload, index, warnings, contactId, stage, pipeline, createIfMissing = true }) {
    const section = mapping.opportunity ?? {};
    const writeEmpty = this.mapping.writeEmptyValues === true;

    const { entries, unresolved } = buildCustomFields({
      mappingFields: section.customFields ?? {},
      source: payload,
      index,
      model: 'opportunity',
      valueKey: 'fieldValue',
      writeEmpty,
    });
    for (const reference of unresolved) {
      warnings.push(`Opportunity field "${reference}" does not exist in GoHighLevel and was skipped.`);
    }

    const name = section.name ? render(section.name, payload) : null;
    const monetaryValue = section.monetaryValue ? toNumber(render(section.monetaryValue, payload)) : null;

    const existing = await this.findOpportunity({ contactId, pipelineId: pipeline?.id, payload, index });

    const body = {};
    if (name) body.name = name;
    if (monetaryValue !== null) body.monetaryValue = monetaryValue;
    if (stage?.id) body.pipelineStageId = stage.id;
    if (section.status) body.status = section.status;
    if (entries.length) body.customFields = cleanCustomFields(entries);

    if (!existing) {
      if (!createIfMissing) {
        warnings.push(
          'No matching opportunity was found for this contact in the configured pipeline, and this event is not allowed to create one. Only the contact record was updated.',
        );
        // Nothing was written, so do not report these fields as written.
        return { id: null, created: false, written: [], monetaryValue: null };
      }
      const created = await this.ghl.createOpportunity({
        pipelineId: pipeline.id,
        contactId,
        name: name || `${payload.client.name || 'Signed contract'}`,
        status: section.status || 'open',
        ...(stage?.id ? { pipelineStageId: stage.id } : {}),
        ...(monetaryValue !== null ? { monetaryValue } : {}),
        ...(entries.length ? { customFields: cleanCustomFields(entries) } : {}),
      });
      return { id: created.id, created: true, written: entries.map((e) => e._key ?? e.id), monetaryValue };
    }

    if (Object.keys(body).length === 0) {
      return { id: existing.id, created: false, written: [], monetaryValue };
    }

    // GHL requires pipelineId alongside a stage change.
    if (body.pipelineStageId) body.pipelineId = pipeline.id;
    await this.ghl.updateOpportunity(existing.id, body);
    return { id: existing.id, created: false, written: entries.map((e) => e._key ?? e.id), monetaryValue };
  }

  /**
   * Finds the opportunity this contract belongs to. Preference order:
   *   1. one already carrying this Pylon reference number
   *   2. the most recently updated open opportunity for the contact
   *   3. any opportunity for the contact
   */
  async findOpportunity({ contactId, pipelineId, payload, index }) {
    let opportunities = [];
    try {
      opportunities = await this.ghl.searchOpportunities({ contactId, pipelineId, status: 'all', limit: 100 });
    } catch (error) {
      logger.warn('opportunity search failed, will fall back to creating one', { error });
      return null;
    }
    if (!opportunities.length) return null;

    const reference = payload.project.reference_number;
    const referenceField = index.lookup('opportunity.contract_reference', 'opportunity');
    if (reference && referenceField) {
      const match = opportunities.find((opportunity) =>
        (opportunity.customFields ?? []).some(
          (field) => field.id === referenceField.id && String(field.fieldValue ?? field.value ?? '') === String(reference),
        ),
      );
      if (match) return match;
    }

    const open = opportunities.filter((o) => o.status === 'open');
    const pool = open.length ? open : opportunities;
    pool.sort((a, b) => new Date(b.updatedAt ?? b.dateUpdated ?? 0) - new Date(a.updatedAt ?? a.dateUpdated ?? 0));
    return pool[0];
  }
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildFilename(payload) {
  const parts = ['Signed Contract', payload.project.reference_number, payload.client.name].filter(Boolean);
  const base = parts.join(' - ').replace(/[^\w\s.-]/g, '').replace(/\s+/g, ' ').trim();
  return `${base || 'Signed Contract'}.pdf`;
}

/** Adds whole days to a YYYY-MM-DD string, staying in UTC. */
function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Works out what every payment stage is worth, as a Map of key -> amount.
 *
 * A stage is one of three things:
 *   amount:    a fixed figure
 *   percent:   that share of the contract total
 *   remainder: whatever is left after all the others
 *
 * The remainder exists because the business bills "10%, 60%, and the remaining
 * amount". Taking it literally rather than writing 30% means the three invoices
 * always add up to exactly the contract, whatever the contract is and however
 * the percentages round.
 */
export function stageAmounts(stages = [], contractTotal) {
  const amounts = new Map();
  const remainderStages = [];

  for (const stage of stages) {
    if (stage.remainder) {
      remainderStages.push(stage);
      continue;
    }
    if (stage.amount !== undefined && stage.amount !== null) {
      amounts.set(stage.key, toNumber(stage.amount));
      continue;
    }
    const percent = toNumber(stage.percent);
    amounts.set(stage.key, percent === null ? null : Math.round(contractTotal * percent) / 100);
  }

  if (remainderStages.length) {
    const spoken = [...amounts.values()].reduce((sum, value) => sum + (value ?? 0), 0);
    // Rounded to cents; without this, floating point leaves 4679.999999999999.
    const left = Math.round((contractTotal - spoken) * 100) / 100;
    // More than one remainder cannot be divided sensibly, so only the first is
    // filled and the rest are reported by checkInvoiceStages().
    amounts.set(remainderStages[0].key, left);
    for (const extra of remainderStages.slice(1)) amounts.set(extra.key, null);
  }

  return amounts;
}
