// PostgresBreakGlassRentasDataRepository -- adaptador de producción de
// `BreakGlassRentasDataRepository`.
//
// CORRECCIÓN (ver ../../migrations/018_break_glass_wiring.sql, sección 3): la
// versión original de este archivo advertía que debía construirse sobre
// `ManagedPostgresEngine.admin` para "saltarse" las policies normales de
// `rentas.ocupacion`/`rentas.guest_minimo`. Verificado contra el código real antes
// de corregirlo (no asumido): `admin` NO es `service_role` -- es el MISMO rol de
// mínimo privilegio que `withAppSession`, sin ningún `bypassrls` (ver el comentario
// de cabecera de `packages/db/src/managed-postgres-engine.ts`, y la confirmación
// explícita en `apps/api/src/production/deps.ts`: "la confirmación de que
// engine.admin NO es service_role"). Una lectura de `rentas.ocupacion` bajo
// `admin` sigue sujeta a las policies normales de esa tabla (solo staff con
// membership real) -- así que, tal como estaba, este adaptador SIEMPRE habría
// devuelto CERO filas contra Postgres real: el mecanismo nunca pudo haber
// funcionado.
//
// SESIÓN REQUERIDA (ya corregido): la sesión del PROPIO superadmin
// (`engine.withAppSession({ userId: actor.userId }, ...)`) -- MISMO patrón que
// `PostgresBreakGlassAuditRepository` (misma carpeta) y que
// `ProductionRentasOwnerPortalRepository`. Cada función `security definer` que
// este adaptador invoca es dueña de su propia autorización completa
// (`auth.uid() = p_caller_id`, `rentas.is_platform_superadmin`, sesión de
// romper-cristal vigente) -- corre con el privilegio del DUEÑO de la función
// (quien aplicó la migración), nunca con el de `authenticated`.
//
// FASE 10c (ver ../../migrations/020_break_glass_lectores.sql) -- COMPATIBILIDAD
// CON LA BASE SIN MIGRAR: mergear a `main` despliega este código al instante, pero
// la base Supabase real va decenas de migraciones atrás y nadie las aplica al
// mergear (ver AGENTS.md de esta tarea). Las 6 funciones nuevas
// (`list_{finanzas,payouts,pricing,mensajeria,limpieza,sync_ical}_for_break_glass`)
// y la nueva sobrecarga de 5 parámetros de `list_reservas_for_break_glass` no
// existen todavía en una base que solo tiene `018_break_glass_wiring.sql`
// aplicada -- Postgres real lanza SQLSTATE 42883 (`undefined_function`) en ese
// caso, MISMO código que `packages/db/src/postgres-core-repository.ts` ya
// detecta para su propio fallback de Fase 3 de caller-binding (`isUndefinedFunctionError`,
// mismo patrón, replicado aquí porque este archivo vive en un paquete distinto sin
// esa utilidad compartida). Cada uno de los 6 métodos nuevos cae a un VACÍO
// HONESTO (`disponible: false` + lista vacía) -- no existe un "camino anterior"
// real para estos 6 recursos (nunca tuvieron lector antes de esta fase, a
// diferencia de reservas). `listReservasTenant` SÍ tiene un camino anterior real
// (la sobrecarga de 2 parámetros de `018_break_glass_wiring.sql`, que sigue
// existiendo intacta) -- cae a esa, y filtra/pagina el resultado en TypeScript
// para no perder el comportamiento pedido por el llamador solo porque la
// migración más reciente no se aplicó todavía.
//
// FIX hallazgo de revisión real (ronda 1 del PR #155, bloqueante 1) -- SAVEPOINT
// OBLIGATORIO antes de CUALQUIER llamada a una función nueva de esta fase, con
// `ROLLBACK TO SAVEPOINT` en el catch de 42883. La ruta que invoca a este
// adaptador (`apps/api/src/routes/superadmin-break-glass.ts::registrarLectorTenant`)
// envuelve TODO el handler en UN solo `deps.engine.withAppSession(...)`
// (`begin;`...`commit;` de `managed-postgres-engine.ts`, SIN savepoint propio) --
// sin este SAVEPOINT, un 42883 real deja la transacción COMPLETA abortada
// (Postgres: "current transaction is aborted, commands ignored until end of
// transaction block", SQLSTATE 25P02) y CUALQUIER sentencia posterior en la misma
// transacción falla con 25P02, incluidas (a) la query de respaldo de 2 parámetros
// de `listReservasTenant` y (b) el `INSERT` de la bitácora que `acceso.ts::
// leerDatosTenantBreakGlass` ejecuta después de una lectura "exitosa" -- ambos
// se habrían visto como un 500 genérico contra una base sin la migración 020
// aplicada, justo el estado que producción tiene garantizado al mergear (ver
// AGENTS.md de esta tarea). MISMO patrón ya establecido en
// `packages/domain-rentas/src/aplicacion/reservas.ts` (`crearReservaConfirmada`)
// y en `packages/domain-citas/src/postgres-repository.ts` (`upsertCustomer`).
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { BreakGlassRentasDataRepository } from "./data-repository.ts";
import { BreakGlassAccessDeniedError, BreakGlassPropertyNotFoundError } from "./errors.ts";
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
import { BREAK_GLASS_LECTOR_LIMIT_DEFAULT, BREAK_GLASS_LECTOR_LIMIT_MAX } from "./tipos.ts";

function isUndefinedFunctionError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "42883";
}

// Hallazgo de revisión real (ronda r5): `list_*_for_break_glass` (las 7
// funciones de `020_break_glass_lectores.sql`) lanzan SQLSTATE `P0002` ("la
// propiedad indicada no pertenece a esta organización") y `42501` (caller
// distinto de `auth.uid()` / no-superadmin / sin sesión de romper-cristal
// vigente -- defensa en profundidad, ver el comentario de cabecera de esa
// migración) -- ninguno de los dos se distinguía de un error real de
// Postgres antes de esto: ambos llegaban tal cual hasta `apps/api`, que
// tampoco los mapeaba, terminando en un 500 genérico.
function isPropertyNotFoundError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P0002";
}
function isAccessDeniedError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "42501";
}

/**
 * Recupera la transacción tras un error DENTRO del SAVEPOINT de `savepointName`
 * (cualquier excepción real de Postgres la deja "abortada" -- cualquier
 * sentencia posterior en la misma transacción compartida, incluida la propia
 * `COMMIT`/`ROLLBACK` final de `withAppSession`, seguiría funcionando bien
 * porque esa sí hace `ROLLBACK` de la transacción completa -- pero si el
 * LLAMADOR de este repositorio siguiera usando `db` para algo más ANTES de
 * eso, como el `INSERT` de bitácora que `acceso.ts` ejecuta tras una lectura
 * "exitosa", necesitaría la transacción sana) -- mismo patrón ya establecido
 * para SQLSTATE 42883 más abajo, generalizado para reutilizarse también con
 * `P0002`/`42501`.
 */
async function recuperarSavepoint(db: TenantDbSession, savepointName: string): Promise<void> {
  await db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  await db.exec(`RELEASE SAVEPOINT ${savepointName}`);
}

// Una sola advertencia por proceso y por función -- mismo criterio que
// `warnMissingOrgAdminFunctionsOnce` de `postgres-core-repository.ts`: evita
// inundar logs bajo tráfico real mientras `020_break_glass_lectores.sql` sigue
// pendiente de aplicar a mano.
const advertidos = new Set<string>();
function advertirUnaVez(fnName: string, mensaje: string): void {
  if (advertidos.has(fnName)) return;
  advertidos.add(fnName);
  console.warn(mensaje);
}

function resolverLimite(paginacion: BreakGlassLectorPaginacion | undefined): { limit: number; offset: number } {
  return {
    limit: Math.min(BREAK_GLASS_LECTOR_LIMIT_MAX, paginacion?.limit ?? BREAK_GLASS_LECTOR_LIMIT_DEFAULT),
    offset: Math.max(0, paginacion?.offset ?? 0),
  };
}

// Hallazgo de revisión real (ronda r5): `fecha_payout`/`vigente_desde`/
// `fecha_check_in`/`fecha_check_out`/`programada_para` son columnas `date`
// (OID 1082, sin componente de hora ni zona horaria) -- el parser default del
// driver `pg` para ese OID construye un objeto `Date` en hora LOCAL del
// PROCESO (`new Date(year, month, day)`, medianoche local), nunca UTC, aunque
// los 4 `*Row`/`BreakGlassPricingResumen`/`BreakGlassPayoutResumen`/etc.
// declaraban el campo como `string` ("YYYY-MM-DD", ver tipos.ts) -- una
// mentira de tipos que, sin este normalizador, filtraba un objeto `Date` real
// a cualquier consumidor (incluida la serialización JSON de la ruta HTTP, que
// lo convertiría con `JSON.stringify` a un timestamp ISO CON hora, nunca la
// fecha simple que el tipo declarado promete). Leer sus componentes con
// `getUTCFullYear()`/`toISOString()` desplazaría la fecha un día completo en
// cualquier proceso con offset horario POSITIVO (Europa/Asia): medianoche
// LOCAL ahí cae en el día ANTERIOR al convertir a UTC. Este helper usa los
// getters LOCALES (`getFullYear`/`getMonth`/`getDate`), que devuelven
// exactamente los mismos año/mes/día con que el driver construyó el objeto --
// nunca pasa por UTC, cero desplazamiento sin importar la zona horaria del
// proceso (Vercel corre en UTC hoy, pero este repositorio no debe asumirlo).
function dateColumnToYmd(value: Date | string): string {
  if (typeof value === "string") return value; // ya normalizado (fixtures/tests, o un parser custom)
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateColumnToYmdOrNull(value: Date | string | null): string | null {
  return value === null ? null : dateColumnToYmd(value);
}

interface ReservaRow {
  ocupacion_id: string;
  property_id: string;
  unidad_id: string;
  check_in: string;
  check_out: string;
  estado: string;
  huesped_nombre: string | null;
  huesped_contacto: string | null;
}

function mapReservaRow(r: ReservaRow): BreakGlassReservaResumen {
  return {
    ocupacionId: r.ocupacion_id,
    propertyId: r.property_id,
    unidadId: r.unidad_id,
    checkIn: r.check_in,
    checkOut: r.check_out,
    estado: r.estado,
    huespedNombre: r.huesped_nombre,
    huespedContacto: r.huesped_contacto,
  };
}

interface FinanzasRow {
  id: string;
  ocupacion_id: string;
  property_id: string;
  moneda: string;
  monto_bruto_centavos: string; // bigint -> string vía driver pg
  comision_canal_centavos: string;
  comision_gestor_centavos: string;
  gastos_centavos: string;
  impuestos_centavos: string;
  neto_centavos: string;
  created_at: string;
}

interface PayoutRow {
  id: string;
  property_id: string;
  canal_id: string;
  referencia_externa: string | null;
  moneda: string;
  monto_total_centavos: string;
  // `date` (OID 1082) -- el driver `pg` la entrega como `Date`, nunca como
  // texto, ver `dateColumnToYmd` arriba.
  fecha_payout: Date | string;
  creado_en: string;
}

interface PricingRow {
  id: string;
  property_id: string;
  unidad_id: string;
  precio_noche_centavos: string;
  moneda: string;
  // `date` -- ver el comentario de `PayoutRow.fecha_payout`.
  vigente_desde: Date | string;
}

interface MensajeriaRow {
  id: string;
  property_id: string;
  unidad_id: string;
  canal_codigo: string;
  huesped_nombre: string | null;
  // `date`, nullable -- ver el comentario de `PayoutRow.fecha_payout`.
  fecha_check_in: Date | string | null;
  fecha_check_out: Date | string | null;
  reserva_confirmada: boolean;
  creado_en: string;
}

interface LimpiezaRow {
  id: string;
  property_id: string;
  unidad_id: string;
  tipo: string;
  estado: string;
  prioridad: string;
  // `date` -- ver el comentario de `PayoutRow.fecha_payout`.
  programada_para: Date | string;
  completada_en: string | null;
  creado_en: string;
}

interface SyncIcalRow {
  id: string;
  property_id: string;
  unidad_id: string;
  canal_id: string;
  url_importacion_enmascarada: string;
  activo: boolean;
  ultima_sincronizacion_exitosa_en: string | null;
  en_cuarentena_desde: string | null;
  intentos_fallidos_consecutivos: number;
  motivo_cuarentena: string | null;
}

export class PostgresBreakGlassRentasDataRepository implements BreakGlassRentasDataRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listReservasTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<readonly BreakGlassReservaResumen[]> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_reservas");
    try {
      const { rows } = await this.db.query<ReservaRow>(
        `select * from rentas.list_reservas_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, limit, offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_reservas");
      return rows.map(mapReservaRow);
    } catch (err) {
      // `p_property_id` con forma de UUID válida pero que no pertenece a esta
      // organización (P0002), o el resto de defensa en profundidad de la
      // función (42501) -- NUNCA debe caer al fallback de 2 parámetros de
      // abajo (ese camino no filtra por propiedad del lado de Postgres, así
      // que "recuperarse" tragándose el error real devolvería TODO el tenant
      // sin el filtro que el caller pidió, o datos a un caller que la propia
      // función acaba de rechazar). Se recupera la transacción y se relanza
      // como error tipado -- `apps/api` lo traduce a 404/403 explícitos.
      if (isPropertyNotFoundError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_reservas");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_reservas");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err)) throw err;
      // 42883 real deja la transacción abortada (25P02 en cualquier query
      // posterior) -- sin este ROLLBACK TO SAVEPOINT, la query de respaldo de
      // abajo (y el INSERT de bitácora que ejecuta el llamador después) fallarían
      // también. Ver comentario de cabecera de este archivo.
      await recuperarSavepoint(this.db, "sp_break_glass_reservas");
      advertirUnaVez(
        "list_reservas_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_reservas_for_break_glass(5 args) no existe todavía " +
          "(SQLSTATE 42883) -- degradando a la sobrecarga de 2 parámetros de 018_break_glass_wiring.sql " +
          "(sin filtro por propiedad ni paginado del lado de Postgres, aplicados aquí en TypeScript). " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql (o su espejo en " +
          "supabase/migrations/) para que Postgres haga el filtro/paginado real.",
      );
      const { rows } = await this.db.query<ReservaRow>(`select * from rentas.list_reservas_for_break_glass($1, $2);`, [callerId, organizationId]);
      const todas = rows.map(mapReservaRow);
      const filtradas = paginacion?.propertyId ? todas.filter((r) => r.propertyId === paginacion.propertyId) : todas;
      return filtradas.slice(offset, offset + limit);
    }
  }

  async listFinanzasTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassFinanzasResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_finanzas");
    try {
      const { rows } = await this.db.query<FinanzasRow>(
        `select * from rentas.list_finanzas_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, limit, offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_finanzas");
      return {
        disponible: true,
        datos: rows.map((r) => ({
          id: r.id,
          ocupacionId: r.ocupacion_id,
          propertyId: r.property_id,
          moneda: r.moneda,
          montoBrutoCentavos: Number(r.monto_bruto_centavos),
          comisionCanalCentavos: Number(r.comision_canal_centavos),
          comisionGestorCentavos: Number(r.comision_gestor_centavos),
          gastosCentavos: Number(r.gastos_centavos),
          impuestosCentavos: Number(r.impuestos_centavos),
          netoCentavos: Number(r.neto_centavos),
          createdAtMs: new Date(r.created_at).getTime(),
        })),
      };
    } catch (err) {
      if (isPropertyNotFoundError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_finanzas");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_finanzas");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err)) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_finanzas");
      advertirUnaVez(
        "list_finanzas_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_finanzas_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [] };
    }
  }

  async listPayoutsTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassPayoutResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_payouts");
    try {
      const { rows } = await this.db.query<PayoutRow>(
        `select * from rentas.list_payouts_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, limit, offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_payouts");
      return {
        disponible: true,
        datos: rows.map((r) => ({
          id: r.id,
          propertyId: r.property_id,
          canalId: r.canal_id,
          referenciaExterna: r.referencia_externa,
          moneda: r.moneda,
          montoTotalCentavos: Number(r.monto_total_centavos),
          fechaPayout: dateColumnToYmd(r.fecha_payout),
          creadoEnMs: new Date(r.creado_en).getTime(),
        })),
      };
    } catch (err) {
      if (isPropertyNotFoundError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_payouts");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_payouts");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err)) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_payouts");
      advertirUnaVez(
        "list_payouts_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_payouts_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [] };
    }
  }

  async listPricingTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassPricingResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_pricing");
    try {
      const { rows } = await this.db.query<PricingRow>(
        `select * from rentas.list_pricing_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, limit, offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_pricing");
      return {
        disponible: true,
        datos: rows.map((r) => ({
          id: r.id,
          propertyId: r.property_id,
          unidadId: r.unidad_id,
          precioNocheCentavos: Number(r.precio_noche_centavos),
          moneda: r.moneda,
          vigenteDesde: dateColumnToYmd(r.vigente_desde),
        })),
      };
    } catch (err) {
      if (isPropertyNotFoundError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_pricing");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_pricing");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err)) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_pricing");
      advertirUnaVez(
        "list_pricing_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_pricing_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [] };
    }
  }

  async listMensajeriaTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassMensajeriaResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_mensajeria");
    try {
      const { rows } = await this.db.query<MensajeriaRow>(
        `select * from rentas.list_mensajeria_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, limit, offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_mensajeria");
      return {
        disponible: true,
        datos: rows.map((r) => ({
          id: r.id,
          propertyId: r.property_id,
          unidadId: r.unidad_id,
          canalCodigo: r.canal_codigo,
          huespedNombre: r.huesped_nombre,
          fechaCheckIn: dateColumnToYmdOrNull(r.fecha_check_in),
          fechaCheckOut: dateColumnToYmdOrNull(r.fecha_check_out),
          reservaConfirmada: r.reserva_confirmada,
          creadoEnMs: new Date(r.creado_en).getTime(),
        })),
      };
    } catch (err) {
      if (isPropertyNotFoundError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_mensajeria");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_mensajeria");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err)) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_mensajeria");
      advertirUnaVez(
        "list_mensajeria_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_mensajeria_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [] };
    }
  }

  async listLimpiezaTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassLimpiezaResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_limpieza");
    try {
      const { rows } = await this.db.query<LimpiezaRow>(
        `select * from rentas.list_limpieza_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, limit, offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_limpieza");
      return {
        disponible: true,
        datos: rows.map((r) => ({
          id: r.id,
          propertyId: r.property_id,
          unidadId: r.unidad_id,
          tipo: r.tipo,
          estado: r.estado,
          prioridad: r.prioridad,
          programadaPara: dateColumnToYmd(r.programada_para),
          completadaEnMs: r.completada_en ? new Date(r.completada_en).getTime() : null,
          creadoEnMs: new Date(r.creado_en).getTime(),
        })),
      };
    } catch (err) {
      if (isPropertyNotFoundError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_limpieza");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_limpieza");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err)) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_limpieza");
      advertirUnaVez(
        "list_limpieza_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_limpieza_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [] };
    }
  }

  async listSyncIcalTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassSyncIcalResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_sync_ical");
    try {
      const { rows } = await this.db.query<SyncIcalRow>(
        `select * from rentas.list_sync_ical_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, limit, offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_sync_ical");
      return {
        disponible: true,
        datos: rows.map((r) => ({
          id: r.id,
          propertyId: r.property_id,
          unidadId: r.unidad_id,
          canalId: r.canal_id,
          urlImportacionEnmascarada: r.url_importacion_enmascarada,
          activo: r.activo,
          ultimaSincronizacionExitosaEnMs: r.ultima_sincronizacion_exitosa_en ? new Date(r.ultima_sincronizacion_exitosa_en).getTime() : null,
          enCuarentenaDesdeMs: r.en_cuarentena_desde ? new Date(r.en_cuarentena_desde).getTime() : null,
          intentosFallidosConsecutivos: r.intentos_fallidos_consecutivos,
          motivoCuarentena: r.motivo_cuarentena,
        })),
      };
    } catch (err) {
      if (isPropertyNotFoundError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_sync_ical");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_sync_ical");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err)) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_sync_ical");
      advertirUnaVez(
        "list_sync_ical_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_sync_ical_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [] };
    }
  }
}
