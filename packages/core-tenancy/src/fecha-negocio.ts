// "Hoy" del lado del SERVIDOR, en el día de calendario del NEGOCIO — no en el
// día UTC del reloj del proceso. Vercel corre con `TZ=UTC`; entre las 18:00 y
// las 23:59 de America/Mexico_City (00:00-05:59 UTC) el día UTC ya es MAÑANA.
// Puerto server-side del mismo criterio que ya corrigió `apps/web/src/lib/
// formato-fecha.ts::hoyFechaSolo` (revisión de PR #164, "no bloqueante" #6) —
// ahí el bug era de FORMATO/browser; aquí es el mismo bug pero en el reloj del
// SERVIDOR: `new Date().toISOString().slice(0, 10)` (día UTC) usado como "hoy"
// para calcular `diasRestantes`/`diasVencido`, decidir si HOY toca un
// recordatorio/corte de cron, o precargar el default de una fecha que el
// staff no mandó explícita — sigue corriendo un día ADELANTE del real en
// CDMX en esa misma ventana de horas, exactamente cuando más tráfico de
// staff mexicano hay (fin de la tarde/noche).
//
// UN SOLO punto de este cálculo para TODO servidor (`apps/api`, `apps/worker`,
// `packages/domain-*`) — antes de este helper, cada ruta/job definía su
// propia `function todayIso()` idéntica (`despachos/vencimientos.ts`,
// `despachos/cobranza.ts`, `despachos/cierre-mensual.ts`,
// `hoteles/night-audit.ts`, `rentas/pricing-config.ts`,
// `citas/admin.ts`, `worker/jobs/despachos/cobranza-reminders.ts`,
// `domain-licitaciones/postgres-repository.ts`), todas con el mismo bug. Vive
// en `core-tenancy` (no en `apps/api`) porque `packages/domain-despachos` y
// `packages/domain-licitaciones` (paquetes, nunca deben depender de una app)
// también lo necesitan, y ambos ya dependen de este paquete.
export const ZONA_HORARIA_NEGOCIO_DEFAULT = "America/Mexico_City";

const CACHE_FORMATTER_HOY: Map<string, Intl.DateTimeFormat> = new Map();

function formatterHoy(zonaHoraria: string): Intl.DateTimeFormat {
  let formatter = CACHE_FORMATTER_HOY.get(zonaHoraria);
  if (!formatter) {
    // "en-CA" da "YYYY-MM-DD" directo (mismo truco que `hoyFechaSolo` de
    // `apps/web/src/lib/formato-fecha.ts`) -- nunca parsea texto localizado.
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zonaHoraria, year: "numeric", month: "2-digit", day: "2-digit" });
    CACHE_FORMATTER_HOY.set(zonaHoraria, formatter);
  }
  return formatter;
}

/**
 * "Hoy" como "YYYY-MM-DD" en el día de calendario del NEGOCIO — nunca el día
 * UTC del proceso. `zonaHoraria` default `America/Mexico_City`
 * (`ZONA_HORARIA_NEGOCIO_DEFAULT`) porque hoy es el único valor real que la
 * mayoría de las verticales tiene — ver `resolverZonaHorariaNegocio` de abajo
 * para el único punto de esta resolución cuando SÍ hay una zona real por
 * property/organización que pasar aquí.
 */
export function hoyFechaNegocio(zonaHoraria: string = ZONA_HORARIA_NEGOCIO_DEFAULT): string {
  return formatterHoy(zonaHoraria).format(new Date());
}

/**
 * ÚNICO punto del servidor donde se decide qué zona horaria usar para el
 * cálculo de "hoy"/vencimientos de una property/organización dada — para que
 * conectar una columna real de zona horaria a una vertical que hoy no la
 * tiene sea, en el futuro, un cambio de UN SOLO lugar (aquí), nunca de cada
 * call-site.
 *
 * Estado real (investigado en la ronda r6, ver knownGaps del PR): SOLO
 * `citas` (`citas.property.timezone`, fallback `citas.tenant_config.
 * default_timezone`) y `rentas` (`rentas.property_config.zona_horaria`, NOT
 * NULL) ya guardan una zona horaria real por property en el esquema hoy.
 * `hoteles`, `despachos`, `restaurantes` y `licitaciones` NO tienen ninguna
 * columna de zona horaria todavía — para esas verticales, cualquier caller
 * pasa `undefined`/omite `zonaHorariaProperty` y este helper cae al default
 * de plataforma. Ningún caller debe hardcodear `"America/Mexico_City"`
 * directo — todos pasan por aquí, aunque hoy el resultado sea el mismo valor,
 * para que agregar la columna real en cualquier vertical futura no obligue a
 * tocar cada ruta que hoy asume México.
 */
export function resolverZonaHorariaNegocio(zonaHorariaProperty: string | null | undefined): string {
  return zonaHorariaProperty && zonaHorariaProperty.trim() !== "" ? zonaHorariaProperty : ZONA_HORARIA_NEGOCIO_DEFAULT;
}
