import { all } from '../db/index.js';

// Read-only "Data health check" (Settings -> Data health, admins only).
// Lists the existing records each known data issue from the full bug test
// affects, so any fix can be judged against real data BEFORE it's built.
// Every query here is a SELECT: nothing is changed, linked, unlinked or
// recalculated by running these checks.
//
// Each check returns { id, finding, title, explanation, effect, columns,
// rows }; `finding` refers to the numbered findings in the bug test report.

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const sum = (rows, key) => money(rows.reduce((t, r) => t + (Number(r[key]) || 0), 0));

function check(def, rows) {
  return { ...def, count: rows.length, rows };
}

export function runDataHealthChecks() {
  const checks = [];

  // 5. Archived Sale Made job, sale still counted.
  {
    const rows = all(
      `SELECT j.job_number AS jobNumber, j.visit_date AS visitDate, t.name AS technician,
              s.invoice_number AS invoiceNumber, s.invoice_date AS invoiceDate, s.sale_value_ex_gst AS saleValue
       FROM jobs j
       JOIN sales s ON s.job_id = j.id AND s.source = 'sale_made_at_visit' AND s.archived = 0
       LEFT JOIN technicians t ON t.id = s.credited_technician_id
       WHERE j.archived = 1
       ORDER BY j.visit_date`
    );
    checks.push(
      check(
        {
          id: 'archivedJobActiveSale',
          finding: 5,
          title: 'Archived "Sale Made" jobs whose sale is still counted',
          explanation: 'The job was archived but its sale was not, so the sale still appears in sales totals, technician figures and Leads to Sales.',
          effect: rows.length ? `A fix would stop counting ${rows.length} sale(s) worth $${sum(rows, 'saleValue')} ex GST in the periods of their invoice dates.` : '',
          columns: ['jobNumber', 'visitDate', 'technician', 'invoiceNumber', 'invoiceDate', 'saleValue'],
        },
        rows
      )
    );
  }

  // 6. Knock-back marked converted, but the converting sale is gone.
  {
    const rows = all(
      `SELECT j.job_number AS jobNumber, j.visit_date AS visitDate, t.name AS technician,
              s.invoice_number AS invoiceNumber, s.sale_value_ex_gst AS saleValue,
              CASE WHEN s.id IS NULL THEN 'missing' WHEN s.archived = 1 THEN 'archived' END AS saleStatus
       FROM jobs j
       LEFT JOIN sales s ON s.id = j.converted_by_sale_id
       LEFT JOIN technicians t ON t.id = j.technician_id
       WHERE j.archived = 0 AND j.converted_later = 1 AND (s.id IS NULL OR s.archived = 1)
       ORDER BY j.visit_date`
    );
    checks.push(
      check(
        {
          id: 'convertedWithoutActiveSale',
          finding: 6,
          title: 'Knock-backs marked "Converted later" with no active converting sale',
          explanation: 'The Quote Approved Later sale that converted this knock-back was archived (or no longer exists), but the job still counts as converted.',
          effect: rows.length ? `A fix would count ${rows.length} job(s) as knock-backs again: knock-backs up by ${rows.length}, converted later down by ${rows.length}, for each job's own visit period.` : '',
          columns: ['jobNumber', 'visitDate', 'technician', 'invoiceNumber', 'saleValue', 'saleStatus'],
        },
        rows
      )
    );
  }

  // 7. Quote Approved Later sale's Job Number doesn't match the job it's linked to.
  {
    const rows = all(
      `SELECT s.job_number AS saleJobNumber, j.job_number AS linkedJobNumber, s.invoice_number AS invoiceNumber,
              s.invoice_date AS invoiceDate, s.sale_value_ex_gst AS saleValue
       FROM sales s
       JOIN jobs j ON j.id = s.job_id
       WHERE s.archived = 0 AND s.source = 'quote_approved_later' AND s.is_upsell = 0
         AND lower(trim(s.job_number)) <> lower(trim(j.job_number))
       ORDER BY s.invoice_date`
    );
    checks.push(
      check(
        {
          id: 'qalLinkMismatch',
          finding: 7,
          title: 'Quote Approved Later sales linked to a different job than their Job Number',
          explanation: "The sale's Job Number was edited after saving, but it is still linked to (and may have converted) the original job.",
          effect: rows.length ? `Each needs a person to decide which job is right; relinking would move "converted later" credit between jobs.` : '',
          columns: ['saleJobNumber', 'linkedJobNumber', 'invoiceNumber', 'invoiceDate', 'saleValue'],
        },
        rows
      )
    );
  }

  // 8. Stored knock-back flag disagrees with Lead / Sale Made.
  {
    const rows = all(
      `SELECT j.job_number AS jobNumber, j.visit_date AS visitDate, t.name AS technician, j.lead AS lead,
              CASE WHEN j.had_sale_at_visit = 1 THEN 'Yes' ELSE 'No' END AS saleMade,
              CASE WHEN j.knockback = 1 THEN 'Yes' ELSE 'No' END AS storedKnockback,
              CASE WHEN j.had_sale_at_visit = 0 AND j.lead = 'Qualified' THEN 'Yes' ELSE 'No' END AS expectedKnockback
       FROM jobs j
       LEFT JOIN technicians t ON t.id = j.technician_id
       WHERE j.archived = 0
         AND j.knockback <> CASE WHEN j.had_sale_at_visit = 0 AND j.lead = 'Qualified' THEN 1 ELSE 0 END
       ORDER BY j.visit_date`
    );
    checks.push(
      check(
        {
          id: 'knockbackFlagMismatch',
          finding: 8,
          title: 'Jobs whose stored knock-back flag disagrees with Lead and Sale Made',
          explanation:
            'Usually a Lead changed by an edit before this was fixed. Report knock-back and conversion figures are worked out from Lead and are NOT affected; the stored flag only drives the Job History "Knockback" filter, follow-up eligibility and the converted-later link.',
          effect: rows.length ? 'Correcting the flag would not change any report figure.' : '',
          columns: ['jobNumber', 'visitDate', 'technician', 'lead', 'saleMade', 'storedKnockback', 'expectedKnockback'],
        },
        rows
      )
    );
  }

  // 9. Sale Made job and its own sale disagree (technician, Job Number, trade, job type, date).
  {
    const rows = all(
      `SELECT j.job_number AS jobNumber, s.job_number AS saleJobNumber, j.visit_date AS visitDate, s.date_logged AS saleDateLogged,
              jt.name AS jobTechnician, st.name AS saleCreditedTechnician, s.sale_value_ex_gst AS saleValue,
              CASE WHEN COALESCE(j.trade_id, 0) <> COALESCE(s.trade_id, 0) THEN 'Yes' ELSE '' END AS tradeDiffers,
              CASE WHEN COALESCE(j.job_type_id, 0) <> COALESCE(s.job_type_id, 0) THEN 'Yes' ELSE '' END AS jobTypeDiffers
       FROM jobs j
       JOIN sales s ON s.job_id = j.id AND s.source = 'sale_made_at_visit' AND s.archived = 0
       LEFT JOIN technicians jt ON jt.id = j.technician_id
       LEFT JOIN technicians st ON st.id = s.credited_technician_id
       WHERE j.archived = 0 AND (
         COALESCE(j.technician_id, 0) <> COALESCE(s.credited_technician_id, 0)
         OR lower(trim(j.job_number)) <> lower(trim(s.job_number))
         OR COALESCE(j.trade_id, 0) <> COALESCE(s.trade_id, 0)
         OR COALESCE(j.job_type_id, 0) <> COALESCE(s.job_type_id, 0)
         OR j.visit_date <> s.date_logged)
       ORDER BY j.visit_date`
    );
    checks.push(
      check(
        {
          id: 'visitSaleMismatch',
          finding: 9,
          title: '"Sale Made" jobs whose sale shows different details from the job',
          explanation:
            "The job was edited (technician, Job Number, trade, job type or date) but its sale kept the old details. Reports credit the sale's own technician, trade and job type.",
          effect: rows.length
            ? `Bringing the sales into line would move $${sum(rows.filter((r) => r.jobTechnician !== r.saleCreditedTechnician), 'saleValue')} ex GST of sales between technicians (where the technician differs), and/or between trades / job types.`
            : '',
          columns: ['jobNumber', 'saleJobNumber', 'visitDate', 'saleDateLogged', 'jobTechnician', 'saleCreditedTechnician', 'saleValue', 'tradeDiffers', 'jobTypeDiffers'],
        },
        rows
      )
    );
  }

  // 14. Pending cancellation pointing at an upsell instead of the original sale.
  {
    const rows = all(
      `SELECT pc.job_number AS jobNumber, pc.date_logged AS dateLogged, t.name AS creditedTechnician,
              s.invoice_number AS invoiceNumber, s.sale_value_ex_gst AS upsellValue
       FROM pending_cancellations pc
       JOIN sales s ON s.id = pc.sale_id
       LEFT JOIN technicians t ON t.id = pc.credited_technician_id
       WHERE pc.archived = 0 AND s.is_upsell = 1
       ORDER BY pc.date_logged`
    );
    checks.push(
      check(
        {
          id: 'pendingCancellationOnUpsell',
          finding: 14,
          title: 'Pending cancellations linked to an upsell instead of the original sale',
          explanation: 'Editing the Pending Cancellation call after an upsell was added re-pointed the cancellation at the upsell.',
          effect: rows.length ? 'Pending cancellations are flag-only and never reduce sale figures, so relinking would not change any figure.' : '',
          columns: ['jobNumber', 'dateLogged', 'creditedTechnician', 'invoiceNumber', 'upsellValue'],
        },
        rows
      )
    );
  }

  // 15. Two or more active jobs sharing one Job Number.
  {
    const rows = all(
      `SELECT lower(trim(j.job_number)) AS jobNumber, COUNT(*) AS activeJobs,
              GROUP_CONCAT(j.visit_date || ' (' || COALESCE(t.name, '—') || ')', '; ') AS visits
       FROM jobs j
       LEFT JOIN technicians t ON t.id = j.technician_id
       WHERE j.archived = 0 AND trim(j.job_number) <> ''
       GROUP BY lower(trim(j.job_number))
       HAVING COUNT(*) > 1
       ORDER BY jobNumber`
    );
    checks.push(
      check(
        {
          id: 'duplicateJobNumbers',
          finding: 15,
          title: 'Job Numbers used by more than one active job',
          explanation: 'Each extra job counts as another job attended. Sales, calls and call backs on that Job Number link to the most recent visit only.',
          effect: rows.length ? 'Each needs a person to decide whether it is a genuine second visit (then usually a Call Back or Quote Approved Later) or a mistyped Job Number.' : '',
          columns: ['jobNumber', 'activeJobs', 'visits'],
        },
        rows
      )
    );
  }

  // Lead rules: Sale Made jobs saved as Not Qualified.
  {
    const rows = all(
      `SELECT j.job_number AS jobNumber, j.visit_date AS visitDate, t.name AS technician, s.sale_value_ex_gst AS saleValue
       FROM jobs j
       LEFT JOIN sales s ON s.job_id = j.id AND s.source = 'sale_made_at_visit' AND s.archived = 0
       LEFT JOIN technicians t ON t.id = j.technician_id
       WHERE j.archived = 0 AND j.had_sale_at_visit = 1 AND j.lead = 'Not Qualified'
       ORDER BY j.visit_date`
    );
    checks.push(
      check(
        {
          id: 'saleMadeNotQualified',
          finding: 'Lead rules',
          title: '"Sale Made" jobs saved as Not Qualified',
          explanation: 'A Sale Made job is always Qualified. These are flagged in Job History and must be set to Qualified before they can be edited.',
          effect: rows.length
            ? `Setting them to Qualified (by editing each one) adds ${rows.length} qualified job(s) and ${rows.length} conversion(s) in their visit periods; their sales are already counted.`
            : '',
          columns: ['jobNumber', 'visitDate', 'technician', 'saleValue'],
        },
        rows
      )
    );
  }

  // Lead rules: older Not Qualified jobs still holding Yes/No sheets.
  {
    const rows = all(
      `SELECT j.job_number AS jobNumber, j.visit_date AS visitDate, t.name AS technician,
              j.inspection_sheet AS inspectionSheet, j.option_sheet AS optionSheet
       FROM jobs j
       LEFT JOIN technicians t ON t.id = j.technician_id
       WHERE j.archived = 0 AND j.lead = 'Not Qualified'
         AND (j.inspection_sheet IN ('Yes', 'No') OR j.option_sheet IN ('Yes', 'No'))
       ORDER BY j.visit_date`
    );
    const noCount = rows.filter((r) => r.inspectionSheet === 'No' || r.optionSheet === 'No').length;
    checks.push(
      check(
        {
          id: 'notQualifiedWithSheets',
          finding: 'Lead rules',
          title: 'Not Qualified jobs saved with Yes/No sheets (before N/A)',
          explanation: 'These answers still count in the inspection-sheet and option-sheet percentages. Each can be set to N/A from its edit screen ("Set both to N/A").',
          effect: rows.length ? `Setting them to N/A removes them from the sheet percentages (${noCount} of them include a "No").` : '',
          columns: ['jobNumber', 'visitDate', 'technician', 'inspectionSheet', 'optionSheet'],
        },
        rows
      )
    );
  }

  // 10/11. The same invoice number on more than one active sale.
  {
    const rows = all(
      `SELECT lower(trim(s.invoice_number)) AS invoiceNumber, COUNT(*) AS sales,
              GROUP_CONCAT(s.job_number || ' $' || s.sale_value_ex_gst || ' (' || COALESCE(t.name, '—') || ')', '; ') AS entries
       FROM sales s
       LEFT JOIN technicians t ON t.id = s.credited_technician_id
       WHERE s.archived = 0 AND s.is_upsell = 0 AND trim(s.invoice_number) <> ''
       GROUP BY lower(trim(s.invoice_number))
       HAVING COUNT(*) > 1
       ORDER BY invoiceNumber`
    );
    checks.push(
      check(
        {
          id: 'duplicateInvoices',
          finding: '10, 11',
          title: 'Invoice numbers used on more than one sale',
          explanation:
            'Company totals count each invoice once, but a filtered or shorter-period view can count it again, and Leads to Sales adds every copy.',
          effect: rows.length ? 'How these should count is a reporting rule to agree first; each may also simply be a duplicate entry to archive.' : '',
          columns: ['invoiceNumber', 'sales', 'entries'],
        },
        rows
      )
    );
  }

  // 12. Booked Lead calls with no Job Number.
  {
    const rows = all(
      `SELECT substr(c.call_at, 1, 10) AS callDate, ls.name AS leadSource, u.name AS handledBy
       FROM calls c
       LEFT JOIN list_items ls ON ls.id = c.lead_source_id
       LEFT JOIN users u ON u.id = c.handled_by_user_id
       WHERE c.archived = 0 AND c.call_type = 'Lead' AND c.booked = 'Yes' AND trim(c.job_number) = ''
       ORDER BY c.call_at`
    );
    checks.push(
      check(
        {
          id: 'bookedLeadNoJobNumber',
          finding: 12,
          title: 'Booked Lead calls with no Job Number',
          explanation: 'They count as booked in the Calls KPIs but not in Leads to Sales, and can never be linked to a sale.',
          effect: rows.length ? 'Adding the Job Number on each call (from AroFlo) links it to its job and sale.' : '',
          columns: ['callDate', 'leadSource', 'handledBy'],
        },
        rows
      )
    );
  }

  // 13. Job Numbers with booked Lead calls from different Lead Sources.
  {
    const rows = all(
      `SELECT lower(trim(c.job_number)) AS jobNumber, COUNT(*) AS bookedLeadCalls,
              GROUP_CONCAT(substr(c.call_at, 1, 10) || ' ' || COALESCE(ls.name, 'no source'), '; ') AS calls
       FROM calls c
       LEFT JOIN list_items ls ON ls.id = c.lead_source_id
       WHERE c.archived = 0 AND c.call_type = 'Lead' AND c.booked = 'Yes' AND trim(c.job_number) <> ''
       GROUP BY lower(trim(c.job_number))
       HAVING COUNT(DISTINCT COALESCE(c.lead_source_id, 0)) > 1
       ORDER BY jobNumber`
    );
    checks.push(
      check(
        {
          id: 'conflictingLeadSources',
          finding: 13,
          title: 'Job Numbers with booked Lead calls from different Lead Sources',
          explanation: 'Which source gets credit for the sale can change with the report date range. Usually one call should not be a booked Lead.',
          effect: rows.length ? 'Correcting the duplicate call fixes the attribution; the reporting rule itself is a decision to agree first.' : '',
          columns: ['jobNumber', 'bookedLeadCalls', 'calls'],
        },
        rows
      )
    );
  }

  return { generatedAt: new Date().toISOString(), checks };
}
