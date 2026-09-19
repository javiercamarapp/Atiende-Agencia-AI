// Puerto de la LECTURA concreta que esta fase compone con la bitácora --
// `listReservasTenant`, la primera (y única, por ahora -- ver comentario de
// `BreakGlassReservaResumen` en tipos.ts) categoría de dato de rentas que el mecanismo
// de romper-cristal sabe servir. Deliberadamente SEPARADO de `RentasRepository`
// (../repository.ts): ese puerto está acotado a los 3 flujos elegidos de staff con
// membership real (ver su comentario de cabecera, "Deliberadamente acotado..."); este
// puerto es la contraparte para el camino de EMERGENCIA (superadmin SIN membership,
// bypass deliberado de RLS) -- mezclarlos en una sola interfaz confundiría "lectura
// normal de un flujo" con "lectura de emergencia auditada", que tienen semántica y
// requisitos de sesión distintos (ver PostgresBreakGlassRentasDataRepository).
import type { BreakGlassReservaResumen } from "./tipos.ts";

export interface BreakGlassRentasDataRepository {
  /** Todas las reservas directas (`capa='reserva'`) de un tenant, con el mínimo de
   *  datos de huésped que `rentas.guest_minimo` guarda. Sin paginar en esta fase --
   *  romper-cristal es una operación de investigación puntual, no un listado
   *  operativo diario; si un tenant real acumula un volumen que lo justifique, paginar
   *  es una extensión de este mismo método, no un rediseño.
   *
   *  `callerId` -- agregado junto con `rentas.list_reservas_for_break_glass`
   *  (`../../migrations/018_break_glass_wiring.sql`): el adaptador de Postgres real
   *  necesita el id del superadmin que llama para que la función `security definer`
   *  pueda atarlo a `auth.uid()` y exigir una `rentas.break_glass_session` VIGENTE
   *  para (callerId, organizationId) antes de devolver una sola fila -- ver el
   *  comentario de cabecera de `postgres-data-repository.ts` para el porqué esto ya
   *  NO se resuelve con una sesión `admin`/`service_role`. */
  listReservasTenant(organizationId: string, callerId: string): Promise<readonly BreakGlassReservaResumen[]>;
}

/**
 * Implementación en memoria -- se siembra con las reservas que el test decida, no
 * simula ningún filtrado por organización más allá de lo que el propio array ya trae
 * marcado, igual criterio que el resto de adaptadores en memoria de este paquete
 * (ver ../sync/in-memory-repository.ts). Ignora `callerId` (sin sesión/RLS real que
 * simular) -- el contrato de "sesión vigente" que sí aplica el adaptador de Postgres
 * se prueba contra Postgres real en scripts/verify-rentas-break-glass/, no aquí.
 */
export class InMemoryBreakGlassRentasDataRepository implements BreakGlassRentasDataRepository {
  constructor(private readonly reservasPorOrganizacion: ReadonlyMap<string, readonly BreakGlassReservaResumen[]>) {}

  async listReservasTenant(organizationId: string, _callerId: string): Promise<readonly BreakGlassReservaResumen[]> {
    return this.reservasPorOrganizacion.get(organizationId) ?? [];
  }
}
