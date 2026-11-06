/**
 * The curated Odoo model catalog, with names a person reads. Pure data, so a
 * client component can import it without pulling odoo-node into the bundle
 * (`odoo-sync.ts` re-exports it for the server side).
 *
 * No ir.model access needed — the sync probes each via fields_get() which
 * only requires read access on the model itself.
 */

export interface ModelCategory {
  id: string;
  label: string;
  models: Array<{ model: string; name: string }>;
}

export const MODEL_CATEGORIES: ModelCategory[] = [
  {
    id: "sales",
    label: "Sales",
    models: [
      { model: "sale.order", name: "Orders" },
      { model: "sale.order.line", name: "Order Lines" },
      { model: "sale.order.template", name: "Quotation Templates" },
      { model: "sale.subscription.plan", name: "Subscription Plans" },
    ],
  },
  {
    id: "purchase",
    label: "Purchase",
    models: [
      { model: "purchase.order", name: "Orders" },
      { model: "purchase.order.line", name: "Order Lines" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    models: [
      { model: "stock.picking", name: "Transfers" },
      { model: "stock.move", name: "Moves" },
      { model: "stock.move.line", name: "Move Lines" },
      { model: "stock.quant", name: "Stock Levels" },
      { model: "stock.lot", name: "Lots/Serial Numbers" },
      { model: "stock.warehouse", name: "Warehouses" },
      { model: "stock.location", name: "Locations" },
    ],
  },
  {
    id: "products",
    label: "Products",
    models: [
      { model: "product.template", name: "Products" },
      { model: "product.product", name: "Variants" },
      { model: "product.category", name: "Categories" },
      { model: "product.pricelist", name: "Pricelists" },
      { model: "product.pricelist.item", name: "Pricelist Rules" },
      { model: "product.supplierinfo", name: "Supplier Prices" },
    ],
  },
  {
    id: "contacts",
    label: "Contacts",
    models: [
      { model: "res.partner", name: "Contacts" },
      { model: "res.company", name: "Companies" },
      { model: "res.country", name: "Countries" },
      { model: "res.country.state", name: "States" },
      { model: "res.users", name: "Users" },
    ],
  },
  {
    id: "accounting",
    label: "Accounting",
    models: [
      { model: "account.move", name: "Invoices & Entries" },
      { model: "account.move.line", name: "Journal Items" },
      { model: "account.payment", name: "Payments" },
      { model: "account.bank.statement.line", name: "Bank Transactions" },
      { model: "account.journal", name: "Journals" },
      { model: "account.account", name: "Accounts" },
      { model: "account.tax", name: "Taxes" },
      { model: "account.fiscal.position", name: "Fiscal Positions" },
      { model: "account.payment.term", name: "Payment Terms" },
      { model: "account.analytic.account", name: "Analytic Accounts" },
      { model: "account.analytic.line", name: "Analytic Lines" },
      { model: "res.currency", name: "Currencies" },
    ],
  },
  {
    id: "crm",
    label: "CRM",
    models: [
      { model: "crm.lead", name: "Leads & Opportunities" },
      { model: "crm.stage", name: "Stages" },
      { model: "crm.team", name: "Sales Teams" },
    ],
  },
  {
    id: "hr",
    label: "HR",
    models: [
      { model: "hr.employee", name: "Employees" },
      { model: "hr.department", name: "Departments" },
      { model: "hr.job", name: "Job Positions" },
      { model: "hr.contract", name: "Contracts" },
      { model: "hr.attendance", name: "Attendances" },
      { model: "hr.leave", name: "Time Off" },
      { model: "hr.leave.type", name: "Time Off Types" },
      { model: "hr.leave.allocation", name: "Time Off Allocations" },
      { model: "hr.expense", name: "Expenses" },
      { model: "hr.expense.sheet", name: "Expense Reports" },
      { model: "hr.applicant", name: "Applicants" },
      { model: "hr.recruitment.stage", name: "Recruitment Stages" },
      { model: "hr.recruitment.source", name: "Recruitment Sources" },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    models: [
      { model: "project.project", name: "Projects" },
      { model: "project.task", name: "Tasks" },
      { model: "project.task.type", name: "Task Stages" },
    ],
  },
  {
    id: "manufacturing",
    label: "Manufacturing",
    models: [
      { model: "mrp.production", name: "Manufacturing Orders" },
      { model: "mrp.workorder", name: "Work Orders" },
      { model: "mrp.bom", name: "Bills of Materials" },
      { model: "mrp.bom.line", name: "BoM Components" },
      { model: "mrp.workcenter", name: "Work Centers" },
    ],
  },
  {
    id: "pos",
    label: "Point of Sale",
    models: [
      { model: "pos.order", name: "POS Orders" },
      { model: "pos.order.line", name: "POS Order Lines" },
      { model: "pos.session", name: "POS Sessions" },
      { model: "pos.config", name: "POS Configurations" },
      { model: "pos.payment", name: "POS Payments" },
      { model: "pos.payment.method", name: "POS Payment Methods" },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    models: [
      { model: "mailing.mailing", name: "Mass Mailings" },
      { model: "mailing.list", name: "Mailing Lists" },
      { model: "mailing.contact", name: "Mailing Contacts" },
      { model: "mailing.trace", name: "Mailing Traces" },
      { model: "utm.campaign", name: "Campaigns" },
      { model: "utm.source", name: "UTM Sources" },
      { model: "utm.medium", name: "UTM Media" },
    ],
  },
  {
    id: "fleet",
    label: "Fleet",
    models: [
      { model: "fleet.vehicle", name: "Vehicles" },
      { model: "fleet.vehicle.model", name: "Vehicle Models" },
      { model: "fleet.vehicle.log.services", name: "Service Logs" },
      { model: "fleet.vehicle.log.contract", name: "Contract Logs" },
      { model: "fleet.service.type", name: "Service Types" },
    ],
  },
  {
    id: "approvals",
    label: "Approvals",
    models: [
      { model: "approval.request", name: "Approval Requests" },
      { model: "approval.category", name: "Approval Categories" },
    ],
  },
  {
    id: "website",
    label: "Website",
    models: [
      { model: "website", name: "Websites" },
      { model: "website.visitor", name: "Visitors" },
      { model: "website.track", name: "Visitor Tracks" },
    ],
  },
  {
    id: "mail",
    label: "Messaging",
    models: [
      { model: "mail.message", name: "Messages" },
      { model: "mail.activity", name: "Activities" },
      { model: "mail.compose.message", name: "Email Drafts" },
    ],
  },
  {
    id: "helpdesk",
    label: "Helpdesk",
    models: [{ model: "helpdesk.ticket", name: "Tickets" }],
  },
  {
    id: "notes",
    label: "Notes",
    models: [{ model: "note.note", name: "Notes" }],
  },
  {
    id: "files",
    label: "Files & Attachments",
    models: [{ model: "ir.attachment", name: "Attachments" }],
  },
];
