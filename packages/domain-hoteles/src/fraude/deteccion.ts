// FRAUDE INTERNO — reglas deterministas que operan SOLO sobre datos que
// `folioEngine.ts`/`repository.ts` YA exponen en atiende-fusion Fase 1 (charge/folio)
// — puerto ESCOPADO de `hoteles/packages/domain-hotel/src/fraude/deteccion.ts`
// (H16-014, REQ-REC-014).
//
// ALCANCE (decisión explícita del encargo de Fase 5, no un olvido): el original trae
// CUATRO patrones. Aquí solo se portan los DOS que se resuelven enteramente con
// datos de folio/charge ya reales en domain-hoteles:
//   1. descuento_fuera_de_politica  — opera sobre `charge.concept='descuento'` +
//      `evaluateDiscountAuthorization` (folioEngine.ts), ya ported en Fase 1.
//   2. folio_reabierto_post_auditoria — opera sobre `folio.closedAt` +
//      `charge.createdAt` (FolioRecord/ChargeRecord, folios.ts ya ported en Fase 1).
//
// FUERA DE ALCANCE, documentado explícitamente aquí (NO portado, NO simulado):
//   3. cargo_fnb_no_posteado — requiere reconciliar contra un POS real
//      (`pms/fraudScan.ts::FnbPosSaleInput`, "insumo explícito de quien invoca el
//      escaneo" en el original). El conector PMS/POS está fuera del alcance de esta
//      fase (ver encargo: "pms/fraudScan.ts ... NO lo portes").
//   4. reembolso_tarjeta_distinta — el original la resuelve cruzando
//      `payment.token_ref` de TODOS los pagos capturados/reembolsados del folio vía
//      una consulta ad-hoc de `pms/fraudScan.ts`, la misma pieza fuera de alcance.
//
// "Folio reabierto después de un night-audit": el nombre del patrón en el criterio
// de REQ-REC-014 sugiere depender de un job de night-audit, pero VERIFICADO contra
// el original (`apps/api/src/pms/fraudScan.ts` líneas 79-105): la señal real es
// puramente `folio.closed_at IS NOT NULL AND charge.created_at > folio.closed_at` —
// "auditado" ahí significa "cerrado" (por CUALQUIER camino: cierre manual vía
// `POST .../folios/:folioId/cerrar`, ya ported en Fase 1, o un futuro night-audit
// que cierre folios en lote). La función no necesita ni asume que exista un
// night-audit — night-audit es solo UNA de las formas en que un folio llega a
// `closed_at IS NOT NULL`, no una precondición de esta regla. Por eso se implementa
// COMPLETA (no como stub), a diferencia de lo que el nombre del patrón podría
// sugerir — night-audit en sí (el JOB que audita habitaciones/tarifas por noche)
// sigue sin existir en fusion y no lo requiere esta regla para funcionar.
import { roundCurrency } from "../money.ts";
import type { HotelRole } from "../roles.ts";

export const FRAUD_PATTERNS = ["descuento_fuera_de_politica", "folio_reabierto_post_auditoria"] as const;
export type FraudPattern = (typeof FRAUD_PATTERNS)[number];

/** Tolerancia de un centavo — mismo criterio que folioEngine.ts/money.ts para no
 *  marcar como fraude un residuo de redondeo real. */
const AMOUNT_TOLERANCE = 0.01;

export interface FraudFinding {
  readonly pattern: FraudPattern;
  readonly folioId: string;
  readonly chargeId: string | null;
  readonly paymentId: string | null;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  /** Clave determinista de idempotencia de escaneo: re-escanear los mismos datos
   *  NUNCA debe producir una segunda alerta para el mismo hallazgo (ver
   *  migrations/007_fraude_alerta.sql, índice único `fraud_alert_dedupe_idx
   *  (property_id, dedupe_key)`). */
  readonly dedupeKey: string;
}

/** Roles a los que corresponde avisar cada patrón (REQ-REC-014: "alerta al
 *  destinatario correspondiente"). owner/gm siempre están porque son quienes
 *  responden por fraude interno frente al dueño del hotel; accountant se agrega
 *  cuando el patrón cae dentro de su función operativa de dinero. */
export function recipientRolesForPattern(pattern: FraudPattern): readonly HotelRole[] {
  switch (pattern) {
    case "descuento_fuera_de_politica":
      return ["owner", "gm"];
    case "folio_reabierto_post_auditoria":
      return ["owner", "gm", "accountant"];
    default: {
      const exhaustive: never = pattern;
      throw new Error(`patrón de fraude desconocido: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1) Descuentos/cortesías fuera de política.
//
// `evaluateDiscountAuthorization` (folioEngine.ts) ya bloquea esto en el camino
// feliz de routes/folios.ts — esta función es la reconciliación INDEPENDIENTE
// (mismo principio que un night-audit reconcilia contra el POS en vez de solo
// confiar en lo que el PMS ya registró): detecta el caso en que un cargo
// `concept='descuento'` llegó a la tabla SIN pasar por esa validación (bypass del
// endpoint, corrección manual en base de datos, migración de otro PMS) —
// exactamente el tipo de fraude interno que una sola capa de validación en el
// camino feliz no puede detectar por definición, porque el atacante nunca pasó por
// esa capa.
//
// NOTA DE FIDELIDAD: el original resuelve `appliedByHasAdminRole` cruzando
// `audit_log` (`action='charge.discount_applied'`) + `hotel_staff.role` — una tabla
// de auditoría por actor que `hoteles.charge` de atiende-fusion Fase 1 NO tiene
// (migrations/001_hoteles_schema.sql: `charge` solo guarda
// `discount_authorized_by`, nunca quién aplicó el cargo). Agregar esa columna es un
// cambio de esquema fuera del alcance de "reglas internas sobre folioEngine.ts YA
// PORTADO" que pide este encargo. La función PURA sigue aceptando
// `appliedByHasAdminRole` (mismo contrato que el original, reusable si esa columna
// se agrega después); el llamador de apps/api (fraude.ts), que no puede resolver esa
// señal con el esquema actual, pasa SIEMPRE `false` — CONSERVADOR POR DISEÑO: sin
// saber quién aplicó el cargo, se prefiere escalarlo a la cola de revisión humana
// (un falso positivo se descarta con un clic) antes que dar por buena una excepción
// que nadie puede verificar.
export interface DiscountPolicyInput {
  readonly chargeId: string;
  readonly folioId: string;
  /** Monto del descuento tal como vive en `charge.amount` — la columna real lo
   *  permite negativo para `concept='descuento'`; se evalúa por magnitud, nunca por
   *  signo. */
  readonly discountAmount: number;
  /** `hoteles.tax_config.discount_threshold` del hotel (nunca un número fijo aquí). */
  readonly thresholdAmount: number;
  /** `charge.discount_authorized_by` — un tercero administrativo verificado. */
  readonly discountAuthorizedByStaffId: string | null;
  /** Si quien aplicó el cargo YA tenía rol administrativo (owner/gm) — ese caso NO
   *  requiere `discountAuthorizedByStaffId` (mismo criterio exacto que
   *  `evaluateDiscountAuthorization`). Ver NOTA DE FIDELIDAD arriba sobre por qué
   *  hoy siempre llega `false` desde apps/api. */
  readonly appliedByHasAdminRole: boolean;
}

export function detectDiscountOutsidePolicy(input: DiscountPolicyInput): FraudFinding | null {
  const magnitude = roundCurrency(Math.abs(input.discountAmount));
  if (magnitude <= input.thresholdAmount + AMOUNT_TOLERANCE) return null;
  if (input.appliedByHasAdminRole) return null;
  if (input.discountAuthorizedByStaffId) return null;

  return {
    pattern: "descuento_fuera_de_politica",
    folioId: input.folioId,
    chargeId: input.chargeId,
    paymentId: null,
    reason:
      `El descuento ${magnitude} del cargo ${input.chargeId} supera el umbral configurado ` +
      `(${input.thresholdAmount}) y no tiene autorización de un rol administrativo: ni quien lo aplicó ` +
      `tenía rol owner/gm, ni trae un discount_authorized_by verificado.`,
    evidence: { discountAmount: magnitude, thresholdAmount: input.thresholdAmount },
    dedupeKey: `descuento_fuera_de_politica:${input.chargeId}`,
  };
}

// ---------------------------------------------------------------------------
// 2) Folio reabierto después de cerrado ("post-auditoría").
//
// Ningún endpoint de folios.ts (Fase 1, ya ported) admite escribir un cargo con
// `folio.status !== 'abierto'` — TODOS (`cargos`/`descuentos`/`reverso`/
// `transferir`/`split`/`pagos`) verifican `folio.status === 'abierto'` antes de
// escribir (ver apps/api/src/routes/verticals/hoteles/folios.ts). Por eso, la única
// forma en que un cargo puede tener `createdAt` posterior a `folio.closedAt` es que
// el folio se haya escrito fuera del flujo normal (bypass de la aplicación, acceso
// directo a la base de datos, o un futuro endpoint que todavía no valide esto) —
// exactamente la señal que este patrón debe capturar, sin necesitar que exista un
// evento explícito "folio.reabierto" ni un job de night-audit (ver NOTA en la
// cabecera del archivo).
// ---------------------------------------------------------------------------
export interface FolioReopenInput {
  readonly folioId: string;
  /** ISO 8601. Siempre no-nulo cuando este chequeo aplica (el llamador solo trae
   *  folios con `closedAt != null`). */
  readonly folioClosedAt: string;
  readonly chargeId: string;
  readonly chargeCreatedAt: string;
}

export function detectFolioReopenedAfterAudit(input: FolioReopenInput): FraudFinding | null {
  const closedAtMs = new Date(input.folioClosedAt).getTime();
  const chargeCreatedAtMs = new Date(input.chargeCreatedAt).getTime();
  if (!(chargeCreatedAtMs > closedAtMs)) return null;

  return {
    pattern: "folio_reabierto_post_auditoria",
    folioId: input.folioId,
    chargeId: input.chargeId,
    paymentId: null,
    reason:
      `El folio ${input.folioId} se cerró el ${input.folioClosedAt}, pero el cargo ${input.chargeId} ` +
      `se creó después (${input.chargeCreatedAt}). Ningún endpoint de este sistema admite escribir ` +
      `cargos en un folio cerrado: esto solo es posible si el folio fue reabierto fuera del flujo normal.`,
    evidence: { folioClosedAt: input.folioClosedAt, chargeCreatedAt: input.chargeCreatedAt },
    dedupeKey: `folio_reabierto_post_auditoria:${input.chargeId}`,
  };
}
