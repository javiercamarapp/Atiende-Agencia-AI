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
import type {
  BreakGlassFinanzasResumen,
  BreakGlassLectorPaginacion,
  BreakGlassLectorResultado,
  BreakGlassLimpiezaResumen,
  BreakGlassMensajeriaResumen,
  BreakGlassPayoutResumen,
  BreakGlassPricingResumen,
  BreakGlassReservaResumen,
  BreakGlassSyncIcalResumen,
} from "./tipos.ts";

export interface BreakGlassRentasDataRepository {
  /** Todas las reservas directas (`capa='reserva'`) de un tenant, con el mínimo de
   *  datos de huésped que `rentas.guest_minimo` guarda.
   *
   *  `callerId` -- agregado junto con `rentas.list_reservas_for_break_glass`
   *  (`../../migrations/018_break_glass_wiring.sql`): el adaptador de Postgres real
   *  necesita el id del superadmin que llama para que la función `security definer`
   *  pueda atarlo a `auth.uid()` y exigir una `rentas.break_glass_session` VIGENTE
   *  para (callerId, organizationId) antes de devolver una sola fila -- ver el
   *  comentario de cabecera de `postgres-data-repository.ts` para el porqué esto ya
   *  NO se resuelve con una sesión `admin`/`service_role`.
   *
   *  `paginacion` -- agregado en Fase 10c (`../../migrations/
   *  020_break_glass_lectores.sql`): filtro opcional por propiedad + tope de
   *  página, mismo contrato que los 6 métodos nuevos de abajo. `undefined`/omitido
   *  se interpreta como "todo el tenant, primera página con el tope por defecto".
   *
   *  Devuelve `BreakGlassLectorResultado` (UNIFICADO con los 6 métodos de
   *  abajo -- antes de la paginación real (hallazgo BAJA de la auditoría a2)
   *  este método devolvía un array plano, un caso especial que
   *  `apps/api/.../superadmin-break-glass.ts::registrarLectorTenant` tenía
   *  que distinguir con `Array.isArray`; unificar el contrato es lo que hace
   *  posible exponer `hasMore` también para reservas sin duplicar esa rama).
   *  `disponible` es SIEMPRE `true` para este método -- reservas tiene un
   *  camino anterior real (la sobrecarga de 2 parámetros de
   *  `018_break_glass_wiring.sql`) que nunca deja de tener datos, a
   *  diferencia de los 6 recursos nuevos. */
  listReservasTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassReservaResumen>>;

  /** Fase 10c -- movimiento financiero por reserva (`rentas.reserva_financiero`,
   *  003_finanzas_schema.sql). Mismo contrato de sesión/paginación que
   *  `listReservasTenant`.
   *
   *  Devuelve `BreakGlassLectorResultado` (no un array plano): `disponible:
   *  false` cuando `rentas.list_finanzas_for_break_glass` todavía no existe en
   *  la base real (SQLSTATE 42883, migración 020 sin aplicar) -- ver el
   *  comentario de cabecera de `BreakGlassLectorResultado` en tipos.ts para el
   *  porqué esto es distinto de "el tenant de verdad no tiene datos". */
  listFinanzasTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassFinanzasResumen>>;

  /** Fase 10c -- payouts por canal (`rentas.payout_canal`,
   *  005_finanzas_statement_payout_schema.sql), nivel de canal (no de línea
   *  individual -- mismo criterio de resumen mínimo que el resto de este puerto).
   *  Mismo contrato de `disponible` que `listFinanzasTenant`. */
  listPayoutsTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassPayoutResumen>>;

  /** Fase 10c -- tarifa base vigente por unidad (`rentas.tarifa_base`,
   *  002_pricing_schema.sql). Mismo contrato de `disponible` que
   *  `listFinanzasTenant`. */
  listPricingTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassPricingResumen>>;

  /** Fase 10c -- resumen por conversación (`rentas.conversacion`,
   *  009_rentas_mensajeria_schema.sql), no el contenido de cada mensaje. Mismo
   *  contrato de `disponible` que `listFinanzasTenant`. */
  listMensajeriaTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassMensajeriaResumen>>;

  /** Fase 10c -- tareas operativas (`rentas.tarea_operativa`,
   *  010_rentas_limpieza_schema.sql): cubre limpieza, mantenimiento e inspección --
   *  las tres son el mismo `tipo` en la misma tabla. Mismo contrato de
   *  `disponible` que `listFinanzasTenant`. */
  listLimpiezaTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassLimpiezaResumen>>;

  /** Fase 10c -- feeds de sincronización de calendario por canal
   *  (`rentas.canal_feed_externo`, 008_ical_sync_schema.sql). La URL de import
   *  SIEMPRE llega ya enmascarada (ver `BreakGlassSyncIcalResumen`). Mismo
   *  contrato de `disponible` que `listFinanzasTenant`. */
  listSyncIcalTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassSyncIcalResumen>>;
}

/**
 * Implementación en memoria -- se siembra con los datos que el test decida, no
 * simula ningún filtrado por organización más allá de lo que el propio array ya trae
 * marcado, igual criterio que el resto de adaptadores en memoria de este paquete
 * (ver ../sync/in-memory-repository.ts). Ignora `callerId` (sin sesión/RLS real que
 * simular) -- el contrato de "sesión vigente" que sí aplica el adaptador de Postgres
 * se prueba contra Postgres real en scripts/verify-rentas-break-glass/, no aquí.
 *
 * `paginacion` SÍ se aplica en memoria (filtro por `propertyId` + `offset`/`limit`,
 * mismo tope `BREAK_GLASS_LECTOR_LIMIT_MAX` que la función SQL) -- es lógica pura,
 * sin RLS de por medio, así que replicarla aquí no tiene el mismo riesgo que
 * replicar autorización (donde SÍ importa que solo Postgres real sea la fuente de
 * verdad). `hasMore` se calcula del lado del array COMPLETO ya filtrado
 * (`filtrados.length > offset + limit`) -- en memoria no hay ningún costo de
 * "consulta cara" que evitar con un peek, a diferencia del adaptador de
 * Postgres real (ver postgres-data-repository.ts).
 */
function paginar<T extends { readonly propertyId: string }>(items: readonly T[], paginacion?: BreakGlassLectorPaginacion): { readonly datos: readonly T[]; readonly hasMore: boolean } {
  const filtrados = paginacion?.propertyId ? items.filter((i) => i.propertyId === paginacion.propertyId) : items;
  const offset = Math.max(0, paginacion?.offset ?? 0);
  const limit = Math.min(200, paginacion?.limit ?? 100);
  return { datos: filtrados.slice(offset, offset + limit), hasMore: filtrados.length > offset + limit };
}

export class InMemoryBreakGlassRentasDataRepository implements BreakGlassRentasDataRepository {
  constructor(
    private readonly reservasPorOrganizacion: ReadonlyMap<string, readonly BreakGlassReservaResumen[]>,
    private readonly finanzasPorOrganizacion: ReadonlyMap<string, readonly BreakGlassFinanzasResumen[]> = new Map(),
    private readonly payoutsPorOrganizacion: ReadonlyMap<string, readonly BreakGlassPayoutResumen[]> = new Map(),
    private readonly pricingPorOrganizacion: ReadonlyMap<string, readonly BreakGlassPricingResumen[]> = new Map(),
    private readonly mensajeriaPorOrganizacion: ReadonlyMap<string, readonly BreakGlassMensajeriaResumen[]> = new Map(),
    private readonly limpiezaPorOrganizacion: ReadonlyMap<string, readonly BreakGlassLimpiezaResumen[]> = new Map(),
    private readonly syncIcalPorOrganizacion: ReadonlyMap<string, readonly BreakGlassSyncIcalResumen[]> = new Map(),
  ) {}

  async listReservasTenant(organizationId: string, _callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassReservaResumen>> {
    return { disponible: true, ...paginar(this.reservasPorOrganizacion.get(organizationId) ?? [], paginacion) };
  }

  async listFinanzasTenant(organizationId: string, _callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassFinanzasResumen>> {
    return { disponible: true, ...paginar(this.finanzasPorOrganizacion.get(organizationId) ?? [], paginacion) };
  }

  async listPayoutsTenant(organizationId: string, _callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassPayoutResumen>> {
    return { disponible: true, ...paginar(this.payoutsPorOrganizacion.get(organizationId) ?? [], paginacion) };
  }

  async listPricingTenant(organizationId: string, _callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassPricingResumen>> {
    return { disponible: true, ...paginar(this.pricingPorOrganizacion.get(organizationId) ?? [], paginacion) };
  }

  async listMensajeriaTenant(organizationId: string, _callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassMensajeriaResumen>> {
    return { disponible: true, ...paginar(this.mensajeriaPorOrganizacion.get(organizationId) ?? [], paginacion) };
  }

  async listLimpiezaTenant(organizationId: string, _callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassLimpiezaResumen>> {
    return { disponible: true, ...paginar(this.limpiezaPorOrganizacion.get(organizationId) ?? [], paginacion) };
  }

  async listSyncIcalTenant(organizationId: string, _callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassSyncIcalResumen>> {
    return { disponible: true, ...paginar(this.syncIcalPorOrganizacion.get(organizationId) ?? [], paginacion) };
  }
}
