-- 0004_leads_paging_indexes: indexes matching GET /leads exactly, so every page is one index read.
--
-- The list is ordered newest first by (created_at, id) and continues "after" the last lead of the
-- previous page (keyset paging). These indexes hold leads in that same order per company, and per
-- company + status for the status filter.
--
-- In production on a large table, create indexes with CREATE INDEX CONCURRENTLY (outside a
-- transaction) so writes aren't blocked while they build.

DROP INDEX leads_tenant_created_idx;
CREATE INDEX leads_tenant_created_idx ON leads (tenant_id, created_at DESC, id DESC);
CREATE INDEX leads_tenant_status_created_idx ON leads (tenant_id, status, created_at DESC, id DESC);
