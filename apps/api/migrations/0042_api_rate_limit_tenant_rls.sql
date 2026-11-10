ALTER TABLE api_rate_limit_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_rate_limit_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_rate_limit_windows
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
