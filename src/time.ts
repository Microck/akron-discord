export function utcNow(): string {
  return new Date().toISOString();
}

export function formatCatalogBackupTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}
