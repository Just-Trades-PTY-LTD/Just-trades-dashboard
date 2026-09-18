import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { findLatestSale, findOriginalJob } from '../services/lookup.js';

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
    });
  });

  return router;
}
