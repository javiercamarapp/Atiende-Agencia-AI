// PUERTO de `isTransientError` en Likida/src/lib/llm/openrouter.ts —
// clasifica por TIPO/status antes que por texto (un SDK aplasta fallas de
// red en un mensaje genérico "Connection error." y el detalle real vive en
// `.cause`), y solo cae a regex de texto como último recurso, con el mismo
// cuidado de no confundir un código HTTP con tres dígitos que aparecen
// dentro de OTRO dato (folio, monto).

export function isRetryableProviderError(err: unknown): boolean {
  const e = err as { name?: unknown; status?: unknown; retryable?: unknown; cause?: unknown } | null;
  if (e && typeof e === 'object') {
    if (typeof e.retryable === 'boolean') return e.retryable;
    if (typeof e.name === 'string' && /^APIConnection(Timeout)?Error$/.test(e.name)) return true;
    if (typeof e.status === 'number' && (e.status >= 500 || e.status === 429 || e.status === 408)) return true;
  }
  const texto = [err, e?.cause]
    .map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : ''))
    .join(' ')
    .toLowerCase();
  return (
    /(?<![$\-\w])(5\d\d|429|408)(?!\.\d)\b/.test(texto) ||
    /timeout|timed out|connection error|fetch failed|network|econnreset|enotfound|rate.?limit|overloaded|capacity/i.test(texto)
  );
}
