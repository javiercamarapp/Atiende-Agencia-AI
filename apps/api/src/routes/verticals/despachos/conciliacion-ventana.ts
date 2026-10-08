// D-P3-10 -- ventana de fechas de emisión de los CFDI que la conciliación carga para una sesión: el periodo (YYYY-MM) +- N días. El motor solo cruza un movimiento con
// CFDI de fecha cercana (tolerancia de 3 días), así que cargar todas las facturas del cliente era trabajo (y memoria) inútil que crecía con los años.
export const VENTANA_FACTURAS_DIAS = 35;

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** `YYYY-MM` -> { desde, hasta } (YYYY-MM-DD, inclusivos): del día 1 menos N días al último día más N días. */
export function ventanaFechasSesion(periodo: string, dias = VENTANA_FACTURAS_DIAS): { readonly desde: string; readonly hasta: string; readonly dias: number } {
  const [anio, mes] = periodo.split("-").map(Number) as [number, number];
  const primero = Date.UTC(anio, mes - 1, 1);
  const ultimo = Date.UTC(anio, mes, 0);
  const DIA = 86_400_000;
  return { desde: iso(new Date(primero - dias * DIA)), hasta: iso(new Date(ultimo + dias * DIA)), dias };
}
