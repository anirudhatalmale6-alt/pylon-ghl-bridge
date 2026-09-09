import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixturesDir = path.join(here, '..', 'fixtures');

export function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

// A tiny but real PDF, so the upload path moves actual bytes rather than a stub.
export const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Stand-in for api.getpylon.com. Serves the fixtures and the contract PDF, and
 * records every request so the tests can assert on what was asked for.
 */
export async function startFakePylon({ failPdf = false, projectOverrides = {} } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });

    if (url.pathname === '/files/signed.pdf') {
      if (failPdf) {
        res.writeHead(403).end('expired');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(SAMPLE_PDF);
      return;
    }

    if (req.headers.authorization !== 'Bearer pylon-test-token') {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'bad token' }));
      return;
    }

    if (url.pathname === '/v1/users') {
      res.writeHead(200, { 'content-type': 'application/vnd.api+json' }).end(JSON.stringify({ data: [] }));
      return;
    }

    if (url.pathname.startsWith('/v1/solar_projects/')) {
      const project = readFixture('project.json');
      project.data.attributes.acceptance.latest_esignature_pdf_url = `${base}/files/signed.pdf`;
      Object.assign(project.data.attributes, projectOverrides);
      res.writeHead(200, { 'content-type': 'application/vnd.api+json' }).end(JSON.stringify(project));
      return;
    }

    if (url.pathname.startsWith('/v1/solar_designs/')) {
      res.writeHead(200, { 'content-type': 'application/vnd.api+json' }).end(JSON.stringify(readFixture('design.json')));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, calls, close: () => new Promise((r) => server.close(r)) };
}

export const GHL_FIELDS = [
  { id: 'cf_ref', name: 'Contract Reference', fieldKey: 'opportunity.contract_reference', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_val', name: 'Contract Value', fieldKey: 'opportunity.contract_value', dataType: 'MONETORY', model: 'opportunity' },
  { id: 'cf_cur', name: 'Contract Currency', fieldKey: 'opportunity.contract_currency', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_date', name: 'Contract Signed Date', fieldKey: 'opportunity.contract_signed_date', dataType: 'DATE', model: 'opportunity' },
  { id: 'cf_by', name: 'Signed By', fieldKey: 'opportunity.signed_by', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_byemail', name: 'Signed By Email', fieldKey: 'opportunity.signed_by_email', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_pdf', name: 'Signed Contract PDF', fieldKey: 'opportunity.signed_contract_pdf', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_o_file', name: 'Signed Contract File', fieldKey: 'opportunity.signed_contract_file', dataType: 'FILE_UPLOAD', model: 'opportunity' },
  { id: 'cf_kw', name: 'System Size kW', fieldKey: 'opportunity.system_size_kw', dataType: 'NUMERICAL', model: 'opportunity' },
  { id: 'cf_kwh', name: 'Battery Storage kWh', fieldKey: 'opportunity.battery_storage_kwh', dataType: 'NUMERICAL', model: 'opportunity' },
  { id: 'cf_dep', name: 'Deposit Amount', fieldKey: 'opportunity.deposit_amount', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_pay', name: 'Amount Payable', fieldKey: 'opportunity.amount_payable', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_addr', name: 'Install Address', fieldKey: 'opportunity.install_address', dataType: 'LARGE_TEXT', model: 'opportunity' },
  { id: 'cf_plink', name: 'Pylon Project Link', fieldKey: 'opportunity.pylon_project_link', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_wlink', name: 'Web Proposal Link', fieldKey: 'opportunity.web_proposal_link', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_prec', name: 'Payment Received', fieldKey: 'opportunity.payment_received', dataType: 'MONETORY', model: 'opportunity' },
  { id: 'cf_ptype', name: 'Payment Type', fieldKey: 'opportunity.payment_type', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_pdate', name: 'Payment Date', fieldKey: 'opportunity.payment_date', dataType: 'DATE', model: 'opportunity' },
  { id: 'cf_precpt', name: 'Payment Receipt Link', fieldKey: 'opportunity.payment_receipt_link', dataType: 'TEXT', model: 'opportunity' },
  { id: 'cf_c_ref', name: 'Pylon Project Reference', fieldKey: 'contact.pylon_project_reference', dataType: 'TEXT', model: 'contact' },
  { id: 'cf_c_link', name: 'Pylon Project Link', fieldKey: 'contact.pylon_project_link', dataType: 'TEXT', model: 'contact' },
  { id: 'cf_c_pdf', name: 'Signed Contract PDF', fieldKey: 'contact.signed_contract_pdf', dataType: 'TEXT', model: 'contact' },
  { id: 'cf_c_file', name: 'Signed Contract File', fieldKey: 'contact.signed_contract_file', dataType: 'FILE_UPLOAD', model: 'contact' },
];

/**
 * Stand-in for services.leadconnectorhq.com. Records every request body so the
 * tests can assert exactly what would have been written to the real CRM.
 */
export async function startFakeGhl({ existingOpportunities = [], fields = GHL_FIELDS, failUpload = false, invoiceScope = true } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const bodyBuffer = await readBody(req);
    const contentType = req.headers['content-type'] || '';
    let body = null;
    if (contentType.includes('application/json') && bodyBuffer.length) {
      try {
        body = JSON.parse(bodyBuffer.toString('utf8'));
      } catch {
        body = bodyBuffer.toString('utf8');
      }
    } else if (contentType.includes('multipart/form-data')) {
      body = { multipart: true, bytes: bodyBuffer.length, raw: bodyBuffer.toString('latin1') };
    }

    const call = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { version: req.headers.version, authorization: req.headers.authorization },
      body,
    };
    calls.push(call);

    if (req.headers.authorization !== 'Bearer ghl-test-token') {
      return json(res, 401, { message: 'Invalid token' });
    }
    // Invoices are versioned separately by the real API, so they are checked
    // against their own value inside the route rather than here.
    if (!url.pathname.startsWith('/invoices/') && req.headers.version !== '2021-07-28') {
      return json(res, 400, { message: 'Missing Version header' });
    }

    if (req.method === 'GET' && /\/locations\/[^/]+\/customFields$/.test(url.pathname)) {
      const model = url.searchParams.get('model') || 'all';
      const filtered = model === 'all' ? fields : fields.filter((f) => f.model === model);
      return json(res, 200, { customFields: filtered });
    }

    if (req.method === 'GET' && url.pathname === '/opportunities/pipelines') {
      return json(res, 200, {
        pipelines: [
          {
            id: 'pipe-1',
            name: 'Solar Sales',
            stages: [
              { id: 'stage-lead', name: 'New Lead' },
              { id: 'stage-quoted', name: 'Quoted' },
              { id: 'stage-signed', name: 'Contract Signed' },
              { id: 'stage-paid', name: 'Deposit Paid' },
            ],
          },
        ],
      });
    }

    if (req.method === 'GET' && /^\/locations\/[^/]+$/.test(url.pathname)) {
      return json(res, 200, {
        location: {
          id: url.pathname.split('/').pop(),
          name: 'Test Solar Co',
          address: '1 Business Road',
          city: 'Newcastle',
          state: 'NSW',
          postalCode: '2300',
          phone: '+61200000000',
          website: 'https://example.com',
          logoUrl: '',
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/invoices/') {
      if (invoiceScope === false) {
        return json(res, 401, { statusCode: 401, message: 'The token is not authorized for this scope.' });
      }
      // The real API is versioned separately; assert the client honours that.
      if (req.headers.version !== '2021-04-15') {
        return json(res, 400, { message: `invoices need Version 2021-04-15, got ${req.headers.version}` });
      }
      // These two rejections are copied from what the LIVE API actually returned.
      // A fake that accepts anything hides the bug by construction — both of
      // these shipped green against a permissive stand-in.
      const errors = [];
      if (body?.businessDetails?.address !== undefined && typeof body.businessDetails.address !== 'object') {
        errors.push('businessDetails.address.each value in nested property address must be either object or array');
      }
      for (const [i, item] of (body?.items ?? []).entries()) {
        if (!item.currency) errors.push(`items.${i}.currency should not be empty`);
      }
      if (errors.length) return json(res, 422, { status: 422, message: 'Unprocessable Entity Exception', error: errors });
      return json(res, 200, { invoice: { _id: 'inv-1', ...body } });
    }

    if (req.method === 'POST' && /^\/invoices\/[^/]+\/send$/.test(url.pathname)) {
      return json(res, 200, { invoice: { _id: url.pathname.split('/')[2], status: 'sent' } });
    }

    if (req.method === 'POST' && url.pathname === '/contacts/upsert') {
      return json(res, 200, { contact: { id: 'contact-1', email: body?.email }, new: true });
    }

    if (req.method === 'GET' && url.pathname === '/opportunities/search') {
      return json(res, 200, { opportunities: existingOpportunities });
    }

    if (req.method === 'POST' && url.pathname === '/opportunities/') {
      return json(res, 200, { opportunity: { id: 'opp-new', ...body } });
    }

    if (req.method === 'PUT' && /^\/opportunities\/[^/]+$/.test(url.pathname)) {
      return json(res, 200, { opportunity: { id: url.pathname.split('/').pop(), ...body } });
    }

    if (req.method === 'POST' && url.pathname === '/medias/upload-file') {
      if (failUpload) return json(res, 500, { message: 'storage unavailable' });
      return json(res, 200, { fileId: 'media-1', url: 'https://storage.googleapis.com/ghl/media-1.pdf' });
    }

    if (req.method === 'POST' && url.pathname === '/forms/upload-custom-files') {
      return json(res, 200, { contact: { id: url.searchParams.get('contactId') } });
    }

    if (req.method === 'POST' && /^\/contacts\/[^/]+\/notes$/.test(url.pathname)) {
      return json(res, 200, { note: { id: 'note-1', body: body?.body } });
    }

    if (req.method === 'POST' && /^\/contacts\/[^/]+\/tags$/.test(url.pathname)) {
      return json(res, 200, { tags: body?.tags ?? [] });
    }

    if (req.method === 'PUT' && /^\/contacts\/[^/]+$/.test(url.pathname)) {
      return json(res, 200, { contact: { id: url.pathname.split('/').pop(), ...body } });
    }

    return json(res, 404, { message: `no fake route for ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    base,
    calls,
    find: (method, pathname) => calls.find((c) => c.method === method && c.path === pathname),
    findAll: (method, pathname) => calls.filter((c) => c.method === method && c.path === pathname),
    close: () => new Promise((r) => server.close(r)),
  };
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}
