// Rastro de una exportacion del Cerebro (ADM-8 de Likida: un clic descargaba toda la cartera, con telefonos y correos, sin dejar
// NINGUNA huella). El CSV se arma en el navegador con datos ya cargados; el unico paso obligado por el servidor es registrar la
// consulta en la bitacora de acceso del superadmin (core.cfo_access_log, accion `exportacion`, SQL de la migracion 0034) ANTES de
// armar el archivo. Aqui se sanea el cuerpo: solo la FORMA de la consulta (llaves conocidas, valores acotados), nunca datos de
// prospectos ni el texto libre buscado.

/** Llaves que el Cerebro manda como filtro; cualquier otra (incluidas `__proto__` o `constructor`) se descarta. */
export const LLAVES_FILTRO_EXPORTACION: ReadonlySet<string> = new Set([
  "verticales", "etapas", "subtipos", "tamanos", "fuentes", "minUrgencia", "minAjuste", "minCierre", "minCompletitud", "sinToqueDias",
  "soloTel", "soloDecisor", "soloContactable", "orden", "radioKm", "conBusqueda",
]);

const MAX_ELEMENTOS = 40;
const MAX_TEXTO = 80;
export const MAX_FILAS_EXPORTACION = 1_000_000;

function valorSeguro(v: unknown): string | number | boolean | readonly string[] | null | undefined {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") return v.slice(0, MAX_TEXTO);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").slice(0, MAX_ELEMENTOS).map((x) => x.slice(0, MAX_TEXTO));
  return undefined;
}

export type CuerpoExportacion = { readonly ok: true; readonly total: number; readonly filtros: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly error: string };

export function sanearExportacion(raw: unknown): CuerpoExportacion {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "El cuerpo debe ser un objeto." };
  const { total, filtros } = raw as { total?: unknown; filtros?: unknown };
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0 || total > MAX_FILAS_EXPORTACION) return { ok: false, error: "total debe ser un entero entre 0 y 1,000,000." };
  const salida: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (typeof filtros === "object" && filtros !== null && !Array.isArray(filtros)) {
    for (const [k, v] of Object.entries(filtros)) {
      if (!LLAVES_FILTRO_EXPORTACION.has(k)) continue;
      const limpio = valorSeguro(v);
      if (limpio !== undefined) salida[k] = limpio;
    }
  }
  return { ok: true, total, filtros: { ...salida } };
}
