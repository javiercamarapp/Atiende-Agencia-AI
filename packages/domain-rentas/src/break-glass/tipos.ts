// Tipos del mecanismo de "romper cristal" (break-glass) -- ver ../../migrations/
// 012_break_glass_audit.sql para el porqué completo (gap verificado: el módulo
// genérico de impersonación de @atiende/core-authz YA identifica y firma "qué
// organización mira este superadmin", pero nunca captura una razón ni persiste a
// Postgres -- esta carpeta cierra exactamente esa brecha, acotada a lecturas de
// rentas, reusando `SuperadminActor` en vez de reinventar "quién es el actor").
import type { SuperadminActor } from "@atiende/core-authz";
export type { SuperadminActor } from "@atiende/core-authz";

/**
 * Categoría del dato de rentas que se leyó -- viaja a la bitácora (`resource_type`,
 * columna con CHECK en la migración -- mantener esta lista sincronizada con el CHECK
 * de 012_break_glass_audit.sql es responsabilidad de quien agregue una categoría
 * nueva, igual que RENTAS_VERTICAL_ROLES/el CHECK de core.membership.vertical_role no
 * están enlazados por un generador, solo por convención documentada).
 */
export const BREAK_GLASS_RESOURCE_TYPES = [
  "reservas",
  "ocupaciones",
  "finanzas",
  "owner_statements",
  "payouts",
  "pricing",
  "mensajeria",
  "limpieza",
  "sync_ical",
  "otro",
] as const;

export type BreakGlassResourceType = (typeof BREAK_GLASS_RESOURCE_TYPES)[number];

export function isBreakGlassResourceType(value: string): value is BreakGlassResourceType {
  return (BREAK_GLASS_RESOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * Longitud mínima (tras `trim()`) de la razón obligatoria -- fuerza una justificación
 * real en vez de un placeholder de una palabra. Mismo valor que el CHECK
 * `char_length(btrim(reason)) >= 20` de la migración -- la barrera real es esta
 * constante (validada ANTES de tocar la base, ver acceso.ts::validarRazonBreakGlass),
 * el CHECK de Postgres es defensa en profundidad, no la única barrera.
 */
export const BREAK_GLASS_MIN_REASON_LENGTH = 20;

/** Lo que el llamador (una ruta de apps/api, ya con el superadmin resuelto en sesión --
 *  mismo contrato que `ResolveImpersonatedOrganizationInput.actor` de
 *  core-authz/impersonation/resolve.ts) debe declarar ANTES de que se ejecute la
 *  lectura real. */
export interface BreakGlassAccessInput {
  readonly actor: SuperadminActor;
  readonly organizationId: string;
  /** Razón obligatoria de negocio -- validada por `validarRazonBreakGlass` antes de
   *  ejecutar cualquier lectura (fail-closed: sin razón válida, ni la lectura corre). */
  readonly reason: string;
  readonly resourceType: BreakGlassResourceType;
  /** Alcance PEDIDO -- ej. `{ propertyId: "..." }`, o `{}` para "todo el tenant". Viaja
   *  tal cual a `resource_scope` (jsonb). */
  readonly resourceScope?: Readonly<Record<string, unknown>>;
}

/** Fila persistida de la bitácora -- lo que devuelve `BreakGlassAuditRepository.record`
 *  después del INSERT (con `seq`/`hash`/`prevHash` que solo el trigger de la migración
 *  puede calcular -- ver hash-chain en 012_break_glass_audit.sql). */
export interface BreakGlassAuditEntry {
  readonly id: string;
  readonly actorUserId: string;
  readonly actorEmail: string | null;
  readonly organizationId: string;
  readonly reason: string;
  readonly resourceType: BreakGlassResourceType;
  readonly resourceScope: Readonly<Record<string, unknown>>;
  /** Lo que REALMENTE se devolvió al llamador -- "qué datos exactos se vieron"
   *  (mandato del gap). Construido DESPUÉS de ejecutar la lectura real. */
  readonly resultSummary: Readonly<Record<string, unknown>>;
  readonly occurredAtMs: number;
  readonly seq: number;
  readonly prevHash: string | null;
  readonly hash: string;
}

/** Lo que `BreakGlassAuditRepository.record` recibe -- todo lo de `BreakGlassAuditEntry`
 *  MENOS lo que solo la base puede producir (id/seq/hash/prevHash). */
export interface NewBreakGlassAuditEntry {
  readonly actorUserId: string;
  readonly actorEmail: string | null;
  readonly organizationId: string;
  readonly reason: string;
  readonly resourceType: BreakGlassResourceType;
  readonly resourceScope: Readonly<Record<string, unknown>>;
  readonly resultSummary: Readonly<Record<string, unknown>>;
  readonly occurredAtMs: number;
}

/** Resumen mínimo de una reserva de un tenant, para la lectura concreta que esta fase
 *  compone (`leerReservasTenantBreakGlass`) sobre `rentas.ocupacion`
 *  (`capa='reserva'`) + `rentas.guest_minimo`. Deliberadamente mínimo -- ni el
 *  historial de pricing ni el movimiento financiero de la reserva (esos son
 *  `resourceType` distintos, cada uno con su propio lector cuando se construya, mismo
 *  criterio de "un flujo a la vez" que ya usa el resto de domain-rentas). */
export interface BreakGlassReservaResumen {
  readonly ocupacionId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly checkIn: string; // YYYY-MM-DD
  readonly checkOut: string; // YYYY-MM-DD
  readonly estado: string;
  readonly huespedNombre: string | null;
  readonly huespedContacto: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sesión de acceso (Fase 10b -- ver ../../migrations/018_break_glass_wiring.sql):
// la pieza de "duración acotada" que 012_break_glass_audit.sql nunca construyó --
// esa migración solo dejó un log por LECTURA, sin ningún concepto de "ventana de
// acceso vigente" contra la que gatear esas lecturas. `BreakGlassSession` es esa
// ventana: se abre con motivo + duración, se puede cerrar antes de vencer, y vence
// sola -- `rentas.list_reservas_for_break_glass` (la única lectura de tenant que
// este mecanismo sabe servir hoy) exige una fila vigente para el mismo
// actor+organización antes de devolver cualquier dato.
// ─────────────────────────────────────────────────────────────────────────────

/** Mínimo de minutos que puede durar un acceso de romper-cristal -- evita una
 *  "duración acotada" de 0 o negativa que en la práctica sería "sin ventana". */
export const BREAK_GLASS_MIN_DURATION_MINUTES = 5;

/** Máximo de minutos -- mismo valor que el CHECK `expires_at <= opened_at +
 *  interval '4 hours'` de la migración. Una ventana más larga deja de ser
 *  "romper cristal" (emergencia puntual) y empieza a parecerse a acceso
 *  permanente -- si algún día se necesita más, es una decisión de producto
 *  explícita (cambiar esta constante Y el CHECK de la migración en una
 *  migración nueva), nunca un default silencioso. */
export const BREAK_GLASS_MAX_DURATION_MINUTES = 240;

/** Fila persistida de una ventana de acceso -- lo que devuelven `open`/`close`/
 *  `listForActor` de `BreakGlassSessionRepository`. */
export interface BreakGlassSession {
  readonly id: string;
  readonly actorUserId: string;
  readonly actorEmail: string | null;
  readonly organizationId: string;
  readonly reason: string;
  readonly openedAtMs: number;
  readonly expiresAtMs: number;
  /** `null` mientras la ventana sigue abierta (vigente o ya vencida por tiempo --
   *  ver `esSesionBreakGlassActiva`, que distingue "vencida" de "cerrada"). */
  readonly closedAtMs: number | null;
  readonly closedBy: string | null;
}

/** Lo que `BreakGlassSessionRepository.open` recibe -- todo lo de `BreakGlassSession`
 *  MENOS lo que solo la base puede producir (id/openedAtMs/closedAtMs/closedBy). */
export interface NewBreakGlassSessionInput {
  readonly actor: SuperadminActor;
  readonly organizationId: string;
  readonly reason: string;
  readonly durationMinutes: number;
}

/** `true` solo si la ventana sigue sin cerrarse Y todavía no venció por tiempo --
 *  el criterio EXACTO que `rentas.list_reservas_for_break_glass` evalúa en SQL
 *  (`closed_at is null and expires_at > now()`), replicado aquí para que la capa
 *  de ruta pueda dar un 403 explícito y honesto ANTES de intentar la lectura real
 *  (mejor mensaje que dejar que Postgres sea la única fuente del rechazo). */
export function esSesionBreakGlassActiva(session: BreakGlassSession, nowMs: number = Date.now()): boolean {
  return session.closedAtMs === null && session.expiresAtMs > nowMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectores restantes (Fase 10c -- ver ../../migrations/020_break_glass_lectores.sql):
// las 6 categorías de dato de rentas que `BreakGlassReservaResumen` (arriba) dejó
// documentadas como pendientes -- `finanzas`, `payouts`, `pricing`, `mensajeria`,
// `limpieza` (cubre limpieza Y mantenimiento, ver `rentas.tarea_operativa.tipo`) y
// `sync_ical`. Mismo criterio de "resumen deliberadamente mínimo" que
// `BreakGlassReservaResumen` -- cada tipo trae solo lo que su propia función SQL
// devuelve, todos con un campo `id` (para que `acceso.ts::crearLectorTenantBreakGlass`
// pueda describir el resultado de forma genérica, mismo patrón que
// `leerReservasTenantBreakGlass` describe con `ocupacionIds`).
// ─────────────────────────────────────────────────────────────────────────────

/** Alcance opcional de paginado + filtro por propiedad, compartido por los 7
 *  lectores de tenant (reservas + los 6 de esta fase). `propertyId` viaja tal
 *  cual a `resourceScope.propertyId` de la bitácora (ver acceso.ts). */
export interface BreakGlassLectorPaginacion {
  readonly propertyId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Página por defecto cuando el llamador no pide una explícita -- mismo valor
 *  que el DEFAULT de `p_limit` en las funciones SQL de
 *  `020_break_glass_lectores.sql`. */
export const BREAK_GLASS_LECTOR_LIMIT_DEFAULT = 100;

/** Tope DURO de página -- mismo valor que `least(coalesce(p_limit, 100), 200)`
 *  en las funciones SQL; reforzado también aquí (defensa en profundidad, nunca
 *  la única barrera) para que la ruta HTTP nunca le pida a Postgres una página
 *  más grande que la que la propia función ya limitaría. */
export const BREAK_GLASS_LECTOR_LIMIT_MAX = 200;

/**
 * FIX hallazgo de revisión real (ronda 1 del PR #155, bloqueante 3) --
 * "vacío honesto" real para los 6 lectores nuevos: antes de este fix,
 * `PostgresBreakGlassRentasDataRepository` prometía en su comentario de
 * cabecera un vacío honesto (`disponible: false` + lista vacía) que NUNCA
 * existió en el código -- los 6 métodos devolvían `readonly T[]` sin forma de
 * distinguir "el tenant de verdad no tiene datos de este tipo" de "la función
 * SQL de la migración 020 todavía no está aplicada" (SQLSTATE 42883). Ambos
 * casos se veían IDÉNTICOS a la ruta HTTP y a la pestaña web -- un operador de
 * romper-cristal viendo "El tenant no tiene payouts registrados" durante una
 * investigación de emergencia no tenía forma de saber si eso era cierto o si
 * el lector simplemente no estaba disponible todavía.
 *
 * `disponible: false` viaja hasta la ruta (`c.json({ ..., disponible })`) y
 * hasta `BreakGlass.tsx` (mensaje explícito "lector no disponible todavía"
 * distinto de "el tenant no tiene datos"). También evita que
 * `acceso.ts::crearLectorTenantBreakGlass` audite una lectura que nunca
 * ocurrió de verdad -- ver ese archivo.
 *
 * `listReservasTenant` (el lector original de PR #132) NO usa este wrapper:
 * su fallback real a la sobrecarga de 2 parámetros de
 * `018_break_glass_wiring.sql` SIEMPRE produce datos reales (solo pierde el
 * filtro/paginado del lado de Postgres) -- nunca hay un estado "no disponible"
 * genuino para reservas, a diferencia de los 6 recursos que nunca tuvieron un
 * lector antes de esta fase.
 */
export interface BreakGlassLectorResultado<T> {
  /** `false` SOLO cuando la función SQL de `020_break_glass_lectores.sql` que
   *  sirve este recurso todavía no existe en la base real (SQLSTATE 42883) --
   *  nunca cuando la consulta corrió con éxito y de verdad no encontró filas. */
  readonly disponible: boolean;
  readonly datos: readonly T[];
}

export interface BreakGlassFinanzasResumen {
  readonly id: string;
  readonly ocupacionId: string;
  readonly propertyId: string;
  readonly moneda: string;
  readonly montoBrutoCentavos: number;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorCentavos: number;
  readonly gastosCentavos: number;
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
  readonly createdAtMs: number;
}

export interface BreakGlassPayoutResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly canalId: string;
  readonly referenciaExterna: string | null;
  readonly moneda: string;
  readonly montoTotalCentavos: number;
  readonly fechaPayout: string; // YYYY-MM-DD
  readonly creadoEnMs: number;
}

export interface BreakGlassPricingResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
  readonly vigenteDesde: string; // YYYY-MM-DD
}

export interface BreakGlassMensajeriaResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalCodigo: string;
  readonly huespedNombre: string | null;
  readonly fechaCheckIn: string | null; // YYYY-MM-DD
  readonly fechaCheckOut: string | null; // YYYY-MM-DD
  readonly reservaConfirmada: boolean;
  readonly creadoEnMs: number;
}

export interface BreakGlassLimpiezaResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly tipo: string; // 'limpieza' | 'mantenimiento' | 'inspeccion'
  readonly estado: string;
  readonly prioridad: string;
  readonly programadaPara: string; // YYYY-MM-DD
  readonly completadaEnMs: number | null;
  readonly creadoEnMs: number;
}

/** `urlImportacionEnmascarada` -- NUNCA la URL completa (mandato de esta fase:
 *  "nunca tokens de iCal/OTA... enmascara"): solo esquema+host, ver el
 *  `regexp_replace` de `rentas.list_sync_ical_for_break_glass`. */
export interface BreakGlassSyncIcalResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalId: string;
  readonly urlImportacionEnmascarada: string;
  readonly activo: boolean;
  readonly ultimaSincronizacionExitosaEnMs: number | null;
  readonly enCuarentenaDesdeMs: number | null;
  readonly intentosFallidosConsecutivos: number;
  readonly motivoCuarentena: string | null;
}
