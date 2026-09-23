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
// caso.
//
// f3-rentas-bitacora-y-guards -- ENDURECIDO (hallazgo de la revisión de #179,
// "guard 42883 a secas"): la comparación local que este archivo tenía
// (`code === "42883"`, sin más) trataba CUALQUIER 42883 como "migración
// pendiente" -- pero Postgres reutiliza ese mismo SQLSTATE para "operator does
// not exist: uuid = text" (un BUG REAL de tipos, nunca una migración sin
// aplicar), ver el comentario de cabecera de `packages/db/src/sql-errors.ts`
// para la demostración completa contra Postgres real. Se reemplaza por
// `isUndefinedFunctionError` de `@atiende/db` (la versión compartida y
// endurecida -- exige además que el MENSAJE tenga la forma "function ... does
// not exist", nunca "operator does not exist: ..."), con el nombre calificado
// de la función que cada método sondeó como `expectedFunctionName` -- cierra
// también el caso más angosto de una función INTERNA distinta que dispare
// 42883 con "function ... does not exist" pero mencionando OTRO nombre. Cada
// uno de los 6 métodos nuevos cae a un VACÍO
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
import { isUndefinedFunctionError } from "@atiende/db";
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

// Hallazgo de revisión real (ronda r5, no-bloqueante 2 del PR #167): antes de
// esto, `P0002`/`42501` se traducían al error tipado correspondiente SIN
// dejar ningún rastro del error ORIGINAL de Postgres -- `42501` es también el
// SQLSTATE de "permission denied for function/schema" (un `GRANT EXECUTE`
// faltante tras una migración a medias) y de violaciones de RLS reales, no
// solo del caso esperado de negocio (caller/superadmin/sesión de
// romper-cristal). Sin este log, ese fallo de CONFIGURACIÓN quedaría
// indistinguible para siempre de un 403 legítimo -- ningún rastro en logs
// para diagnosticarlo. Se loguea SQLSTATE + función ANTES de lanzar el error
// tipado (nunca se manda al cliente: `BreakGlassAccessDeniedError`/
// `BreakGlassPropertyNotFoundError` siguen con mensaje genérico, ver
// errors.ts). Deliberadamente SIN el gate de "una vez" de `advertirUnaVez` --
// a diferencia de 42883 (un estado binario: la migración está o no está
// aplicada), cada P0002/42501 es una decisión de autorización real que vale
// la pena poder correlacionar con el momento en que ocurrió.
function advertirErrorMapeado(fnName: string, sqlstate: "P0002" | "42501"): void {
  console.warn(
    `PostgresBreakGlassRentasDataRepository: ${fnName} lanzó SQLSTATE ${sqlstate} -- traducido a error tipado (nunca expuesto al cliente). ` +
      "Si esto NO corresponde a un caso esperado de negocio (propertyId de otra organización, o defensa en profundidad real de " +
      "caller/superadmin/sesión), revisa GRANTs y policies RLS: 42501 también es el código de 'permission denied' por un GRANT " +
      "EXECUTE faltante tras una migración a medias, o por una violación de RLS real.",
  );
}

// Hallazgo de revisión real (ronda r5, no-bloqueante 1 del PR #167): la ruta
// HTTP (`apps/api/src/routes/superadmin-break-glass.ts::parseOffsetQuery`) ya
// rechaza un `offset` mayor al máximo de un `integer` de Postgres con 400 --
// este `Math.min` es la SEGUNDA línea de defensa (defensa en profundidad,
// mismo criterio que el resto de este archivo) para cualquier otro llamador
// directo de este repositorio que no pase por esa validación: sin esto,
// `p_offset` (declarado `integer` en las 7 funciones de
// `020_break_glass_lectores.sql`) desbordaría con SQLSTATE `22003`/`22P02` --
// el mismo 500 genérico que este PR existe para eliminar.
const POSTGRES_INT32_MAX = 2147483647;

function resolverLimite(paginacion: BreakGlassLectorPaginacion | undefined): { limit: number; offset: number } {
  return {
    limit: Math.min(BREAK_GLASS_LECTOR_LIMIT_MAX, paginacion?.limit ?? BREAK_GLASS_LECTOR_LIMIT_DEFAULT),
    offset: Math.min(POSTGRES_INT32_MAX, Math.max(0, paginacion?.offset ?? 0)),
  };
}

// Hallazgo BAJA confirmado de la auditoría a2 (evidencia:
// auditoria-a2-resultado.json, tercer elemento de `confirmed`): los 7
// lectores devuelven como máximo `limit` filas (las más recientes) sin
// indicar si hay más -- un superadmin investigando un incidente cree que vio
// todo el tenant. Arreglo: pedir `limit + 1` filas reales ("peek") a la MISMA
// función SQL que ya acepta `p_limit` (sin migración nueva, sin un `COUNT(*)`
// aparte -- mandato de la tarea, "sin una consulta cara"), y recortar la fila
// de más ANTES de mapear/devolver -- nunca llega a `datos` ni a la bitácora
// de auditoría (`acceso.ts` audita `resultado.datos`, no las filas crudas de
// Postgres).
//
// CASO LÍMITE (hallazgo real, auditoría a3 / PR #172 no-bloqueante 3): las 7
// funciones de `020_break_glass_lectores.sql` acotan `p_limit` con
// `least(coalesce(p_limit, 100), 200)` DENTRO de la función -- un tope duro
// que esta capa NO puede pedirle que ignore sin una migración nueva de
// `packages/domain-rentas/migrations/`, fuera de alcance de este archivo esta
// tanda (otro constructor trabaja en el resto de `domain-rentas`, ver
// AGENTS.md de la tarea -- a diferencia de `core.list_authz_audit_log_for_
// superadmin`, que SÍ subió su tope duro interno a 201 en
// `packages/db/migrations/0022_superadmin_bitacoras_endurecimiento.sql`
// porque `packages/db/migrations` no tiene esa restricción de alcance esta
// tanda). Cuando el llamador ya pide exactamente `BREAK_GLASS_LECTOR_LIMIT_MAX`
// (200, el tope), pedir 201 no sirve de nada -- la función lo acotaría de
// vuelta a 200 -- así que el "peek" real queda deshabilitado en ese único
// caso límite. `partirConHasMore` (abajo) compensa con un `hasMore`
// CONSERVADOR en ese caso: nunca un falso "ya viste todo" (el hallazgo real),
// a costa de un posible falso "hay más" cuando el tenant tiene EXACTAMENTE
// 200 filas -- tradeoff aceptado, documentado, y estrictamente mejor que el
// comportamiento anterior (que SIEMPRE decía "no hay más" en este caso,
// incluso con una fila 201+ real).
function queryLimitConPeek(limit: number): number {
  return limit < BREAK_GLASS_LECTOR_LIMIT_MAX ? limit + 1 : limit;
}

/** Recorta la fila de más del "peek" (si la hubo) y calcula `hasMore` --
 *  compartido por los 7 métodos de abajo. `rows` ya viene en el orden que la
 *  función SQL define (más reciente primero); recortar del FINAL preserva ese
 *  orden para las filas que sí se devuelven.
 *
 *  `limit < BREAK_GLASS_LECTOR_LIMIT_MAX` (peek real, `rows` puede traer
 *  `limit+1`): `hasMore` es EXACTO (`rows.length > limit`).
 *
 *  `limit === BREAK_GLASS_LECTOR_LIMIT_MAX` (tope duro, ver comentario de
 *  `queryLimitConPeek` -- SIN peek real posible desde este archivo):
 *  CONSERVADOR -- `rows.length >= limit` (la página vino exactamente llena).
 *  Nunca un falso negativo ("no hay más" cuando sí las hay, el hallazgo
 *  real); si el tenant tiene EXACTAMENTE 200 filas, esto da un falso
 *  positivo ("hay más" cuando en realidad ya se vio todo) -- un botón
 *  "Cargar más" que trae 0 filas nuevas es un costo aceptable frente a creer
 *  que ya se vio todo un tenant que en realidad tiene más. */
function partirConHasMore<T>(rows: readonly T[], limit: number): { readonly filas: readonly T[]; readonly hasMore: boolean } {
  if (limit < BREAK_GLASS_LECTOR_LIMIT_MAX) {
    const hasMore = rows.length > limit;
    return { filas: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }
  return { filas: rows, hasMore: rows.length >= limit };
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

  async listReservasTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassReservaResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_reservas");
    try {
      const { rows } = await this.db.query<ReservaRow>(
        `select * from rentas.list_reservas_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, queryLimitConPeek(limit), offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_reservas");
      const { filas, hasMore } = partirConHasMore(rows, limit);
      return { disponible: true, datos: filas.map(mapReservaRow), hasMore };
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
        advertirErrorMapeado("list_reservas_for_break_glass", "P0002");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_reservas");
        advertirErrorMapeado("list_reservas_for_break_glass", "42501");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err, "rentas.list_reservas_for_break_glass")) throw err;
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
      // Camino de respaldo: ya tiene el array COMPLETO en memoria (sin
      // paginado del lado de Postgres), así que `hasMore` se calcula exacto,
      // sin necesidad de ningún "peek" -- mismo criterio que el repositorio
      // en memoria (InMemoryBreakGlassRentasDataRepository::paginar).
      return { disponible: true, datos: filtradas.slice(offset, offset + limit), hasMore: filtradas.length > offset + limit };
    }
  }

  async listFinanzasTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassFinanzasResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_finanzas");
    try {
      const { rows } = await this.db.query<FinanzasRow>(
        `select * from rentas.list_finanzas_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, queryLimitConPeek(limit), offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_finanzas");
      const { filas, hasMore } = partirConHasMore(rows, limit);
      return {
        disponible: true,
        hasMore,
        datos: filas.map((r) => ({
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
        advertirErrorMapeado("list_finanzas_for_break_glass", "P0002");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_finanzas");
        advertirErrorMapeado("list_finanzas_for_break_glass", "42501");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err, "rentas.list_finanzas_for_break_glass")) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_finanzas");
      advertirUnaVez(
        "list_finanzas_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_finanzas_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [], hasMore: false };
    }
  }

  async listPayoutsTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassPayoutResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_payouts");
    try {
      const { rows } = await this.db.query<PayoutRow>(
        `select * from rentas.list_payouts_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, queryLimitConPeek(limit), offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_payouts");
      const { filas, hasMore } = partirConHasMore(rows, limit);
      return {
        disponible: true,
        hasMore,
        datos: filas.map((r) => ({
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
        advertirErrorMapeado("list_payouts_for_break_glass", "P0002");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_payouts");
        advertirErrorMapeado("list_payouts_for_break_glass", "42501");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err, "rentas.list_payouts_for_break_glass")) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_payouts");
      advertirUnaVez(
        "list_payouts_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_payouts_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [], hasMore: false };
    }
  }

  async listPricingTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassPricingResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_pricing");
    try {
      const { rows } = await this.db.query<PricingRow>(
        `select * from rentas.list_pricing_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, queryLimitConPeek(limit), offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_pricing");
      const { filas, hasMore } = partirConHasMore(rows, limit);
      return {
        disponible: true,
        hasMore,
        datos: filas.map((r) => ({
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
        advertirErrorMapeado("list_pricing_for_break_glass", "P0002");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_pricing");
        advertirErrorMapeado("list_pricing_for_break_glass", "42501");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err, "rentas.list_pricing_for_break_glass")) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_pricing");
      advertirUnaVez(
        "list_pricing_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_pricing_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [], hasMore: false };
    }
  }

  async listMensajeriaTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassMensajeriaResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_mensajeria");
    try {
      const { rows } = await this.db.query<MensajeriaRow>(
        `select * from rentas.list_mensajeria_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, queryLimitConPeek(limit), offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_mensajeria");
      const { filas, hasMore } = partirConHasMore(rows, limit);
      return {
        disponible: true,
        hasMore,
        datos: filas.map((r) => ({
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
        advertirErrorMapeado("list_mensajeria_for_break_glass", "P0002");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_mensajeria");
        advertirErrorMapeado("list_mensajeria_for_break_glass", "42501");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err, "rentas.list_mensajeria_for_break_glass")) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_mensajeria");
      advertirUnaVez(
        "list_mensajeria_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_mensajeria_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [], hasMore: false };
    }
  }

  async listLimpiezaTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassLimpiezaResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_limpieza");
    try {
      const { rows } = await this.db.query<LimpiezaRow>(
        `select * from rentas.list_limpieza_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, queryLimitConPeek(limit), offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_limpieza");
      const { filas, hasMore } = partirConHasMore(rows, limit);
      return {
        disponible: true,
        hasMore,
        datos: filas.map((r) => ({
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
        advertirErrorMapeado("list_limpieza_for_break_glass", "P0002");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_limpieza");
        advertirErrorMapeado("list_limpieza_for_break_glass", "42501");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err, "rentas.list_limpieza_for_break_glass")) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_limpieza");
      advertirUnaVez(
        "list_limpieza_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_limpieza_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [], hasMore: false };
    }
  }

  async listSyncIcalTenant(organizationId: string, callerId: string, paginacion?: BreakGlassLectorPaginacion): Promise<BreakGlassLectorResultado<BreakGlassSyncIcalResumen>> {
    const { limit, offset } = resolverLimite(paginacion);
    await this.db.exec("SAVEPOINT sp_break_glass_sync_ical");
    try {
      const { rows } = await this.db.query<SyncIcalRow>(
        `select * from rentas.list_sync_ical_for_break_glass($1, $2, $3, $4, $5);`,
        [callerId, organizationId, paginacion?.propertyId ?? null, queryLimitConPeek(limit), offset],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_break_glass_sync_ical");
      const { filas, hasMore } = partirConHasMore(rows, limit);
      return {
        disponible: true,
        hasMore,
        datos: filas.map((r) => ({
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
        advertirErrorMapeado("list_sync_ical_for_break_glass", "P0002");
        throw new BreakGlassPropertyNotFoundError();
      }
      if (isAccessDeniedError(err)) {
        await recuperarSavepoint(this.db, "sp_break_glass_sync_ical");
        advertirErrorMapeado("list_sync_ical_for_break_glass", "42501");
        throw new BreakGlassAccessDeniedError();
      }
      if (!isUndefinedFunctionError(err, "rentas.list_sync_ical_for_break_glass")) throw err;
      await recuperarSavepoint(this.db, "sp_break_glass_sync_ical");
      advertirUnaVez(
        "list_sync_ical_for_break_glass",
        "PostgresBreakGlassRentasDataRepository: rentas.list_sync_ical_for_break_glass no existe todavía " +
          "(SQLSTATE 42883) -- lector marcado como NO disponible (disponible: false), nunca como vacío real. " +
          "Aplica packages/domain-rentas/migrations/020_break_glass_lectores.sql para habilitarlo.",
      );
      return { disponible: false, datos: [], hasMore: false };
    }
  }
}
