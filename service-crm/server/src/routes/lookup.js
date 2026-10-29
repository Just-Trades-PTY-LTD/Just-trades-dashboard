import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { findLatestSale, findOriginalBookingCall, findOriginalJob, findReportingLeadCall } from '../services/lookup.js';

export function createLookupRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/job', (req, res) => {
    const job = findOriginalJob(req.query.jn || '');
    if (!job) return res.json({ found: false });
    res.json({
      found: true,
      tradeId: job.trade_id,
      trade: job.trade_name,
      jobTypeId: job.job_type_id,
      jobType: job.job_type_name,
      technicianId: job.technician_id,
      technician: job.technician_name,
      visitDate: job.visit_date,
      hadSaleAtVisit: !!job.had_sale_at_visit,
      convertedLater: !!job.converted_later,
      knockback: !!job.knockback,
      // Used by Call Back to auto-populate its own Credited (original work)
      // Technician with whoever actually completed the original work — the
      // job's own attending technician normally, or its separate Install
      // Technician when the job itself says the work was completed on a
      // different day. Every other consumer of this lookup ignores these.
      workCompletion: job.work_completion || '',
      installTechnicianId: job.install_technician_id || null,
      // Used by Existing Job — Upsell to auto-populate its own (independently
      // editable) Suburb from the original job — every other consumer of
      // this lookup ignores it.
      suburb: job.suburb || '',
    });
  });

  router.get('/sale', (req, res) => {
    const sale = findLatestSale(req.query.jn || '');
    if (!sale) return res.json({ found: false });
    res.json({
      found: true,
      invoiceNumber: sale.invoice_number,
      invoiceDate: sale.invoice_date,
      saleValueExGst: sale.sale_value_ex_gst,
      creditedTechnicianId: sale.credited_technician_id,
      creditedTechnician: sale.credited_technician_name,
      tradeId: sale.trade_id,
      trade: sale.trade_name,
      jobTypeId: sale.job_type_id,
      jobType: sale.job_type_name,
    });
  });

  // The earliest Calls & Contacts record sharing this Job Number — used to
  // auto-populate a brand-new job's Suburb, Trade and Job Type. `found: true`
  // just means a matching call exists; any of these can still legitimately
  // be blank/null if that call never recorded them (the caller should treat
  // that the same as no match — never fall through to a different, later
  // call, and never guess).
  router.get('/call', (req, res) => {
    const call = findOriginalBookingCall(req.query.jn || '');
    if (!call) return res.json({ found: false, leadCall: null });
    // The booked Lead call the reports take this Job Number's Lead Source
    // from (null = the job would report as "Unassigned"). Can differ from
    // `call` above: that's the earliest call of ANY type for this JN, which
    // still drives the suburb/trade/job type autofill exactly as before.
    const leadCall = findReportingLeadCall(req.query.jn || '');
    res.json({
      found: true,
      suburb: call.suburb || '',
      callId: call.id,
      callAt: call.call_at,
      callType: call.call_type || '',
      booked: call.booked || '',
      leadCall: leadCall ? { leadSource: leadCall.lead_source_name || '', callAt: leadCall.call_at } : null,
      // Staff already select these when logging the call — an exact
      // reference to this CRM's own Trade/Job Type lists, never a guess or
      // text match, same convention as job.trade_id/job.job_type_id above.
      tradeId: call.trade_id || null,
      jobTypeId: call.job_type_id || null,
    });
  });

  return router;
}
