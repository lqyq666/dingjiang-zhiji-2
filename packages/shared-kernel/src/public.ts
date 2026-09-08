declare const tenantIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };

export function tenantId(value: string): TenantId {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error("TenantId cannot be empty");
  }

  return normalized as TenantId;
}
