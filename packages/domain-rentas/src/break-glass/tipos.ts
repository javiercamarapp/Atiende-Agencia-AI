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
