// EconomicProposalBuilder — Flujo 2, port literal de
// licitaciones/packages/expediente/src/economic-proposal.ts (ver diseño Fase 1
// §1.3/§4.2). Cálculo económico 100% determinista sobre tarifas APROBADAS y
// vigentes a la fecha del acto. Una tarifa no aprobada o vencida se rechaza
// (bloqueo), nunca se usa un precio "de todos modos". Regla dura (REQ-LIC-006,
// A8 del origen): un concepto sin tarifa aprobada/vigente bloquea el TOTAL
// COMPLETO, nunca un total parcial silencioso.
import type { CompanyDataService } from "./company-data.ts";
import { isResolved } from "./company-data.ts";
import { addCents, fromCents, multiplyQuantityHalfUp, multiplyRateHalfUp, sumCents, toCents } from "./money.ts";
import type { DecimalString } from "./money.ts";
import { centsToPesosWords } from "./number-to-words.ts";
import type { SourceRef } from "./types.ts";

export interface EconomicLineItemRequest {
  readonly requirementId?: string;
  readonly concept: string;
  readonly quantity: number;
}

export interface EconomicLineItemResolved {
  readonly concept: string;
  readonly quantity: number;
  readonly unitPriceCents: bigint;
  readonly subtotalCents: bigint;
  readonly sourceRef: SourceRef;
}

export interface EconomicLineItemBlocked {
  readonly concept: string;
  readonly status: "missing" | "blocked";
  readonly detail: string;
}

export interface EconomicTotals {
  readonly currency: "MXN";
  readonly subtotal: DecimalString;
  readonly ivaRate: number;
  readonly iva: DecimalString;
  readonly total: DecimalString;
  readonly totalInWords: string;
}

export interface EconomicProposalResult {
  readonly lineItems: EconomicLineItemResolved[];
  readonly blockedLineItems: EconomicLineItemBlocked[];
  readonly totals: EconomicTotals | null;
  /** Mismo objeto `totals` reflejado en dos "documentos" (carta y anexo) para probar consistencia estructural, no solo textual. */
  readonly cartaText: string | null;
  readonly anexoText: string | null;
}

export interface EconomicProposalConfig {
  readonly ivaRate: number; // p. ej. 0.16
  /** Cota superior aceptada para `ivaRate` (por defecto `DEFAULT_MAX_IVA_RATE`); ajustable solo cuando el llamador lo justifique explícitamente. */
  readonly maxIvaRate?: number;
}

/** Cota superior por defecto para `ivaRate` (REQ-LIC-007, EX-EXP-07 origen): cubre IVA general (16%) y tasas reducidas/especiales razonables, sin permitir errores de unidades (p. ej. "16" en vez de "0.16") o tasas absurdas (250%). */
export const DEFAULT_MAX_IVA_RATE = 0.3;

/** Valida que `ivaRate` sea una tasa fraccionaria razonable en `[0, maxRate]`: rechaza negativos, tasas > 100% y errores de unidades clásicos. */
export function assertValidIvaRate(ivaRate: number, maxRate: number = DEFAULT_MAX_IVA_RATE): void {
  if (!Number.isFinite(ivaRate) || ivaRate < 0 || ivaRate > maxRate) {
    throw new Error(`ivaRate fuera de rango válido [0, ${maxRate}]: ${ivaRate}. Verifique que no sea un error de unidades (p. ej. "16" en vez de "0.16") ni una tasa absurda.`);
  }
}

export class EconomicProposalBuilder {
  constructor(
    private readonly companyData: CompanyDataService,
    private readonly config: EconomicProposalConfig,
  ) {
    assertValidIvaRate(config.ivaRate, config.maxIvaRate ?? DEFAULT_MAX_IVA_RATE);
  }

  build(companyId: string, requests: EconomicLineItemRequest[], asOfIso: string): EconomicProposalResult {
    const lineItems: EconomicLineItemResolved[] = [];
    const blockedLineItems: EconomicLineItemBlocked[] = [];

    for (const request of requests) {
      const resolution = this.companyData.resolveApprovedRate(companyId, request.concept, asOfIso);
      if (!isResolved(resolution)) {
        blockedLineItems.push({
          concept: request.concept,
          status: resolution.status,
          detail: resolution.status === "missing" ? `No hay tarifa registrada para "${request.concept}".` : resolution.detail,
        });
        continue;
      }

      const rate = resolution.value;
      const unitPriceCents = toCents(rate.unitPrice);
      const subtotalCents = multiplyQuantityHalfUp(unitPriceCents, request.quantity);
      lineItems.push({
        concept: request.concept,
        quantity: request.quantity,
        unitPriceCents,
        subtotalCents,
        sourceRef: { kind: "company_data", refId: resolution.sourceRef.docId, capturedAt: resolution.sourceRef.capturedAt },
      });
    }

    if (blockedLineItems.length > 0 || lineItems.length === 0) {
      // Regla dura: si CUALQUIER concepto solicitado no resuelve a una tarifa
      // aprobada y vigente, la propuesta económica completa queda sin totales
      // (nunca un total parcial que omita en silencio el concepto bloqueado).
      return { lineItems, blockedLineItems, totals: null, cartaText: null, anexoText: null };
    }

    const subtotalCents = sumCents(lineItems.map((li) => li.subtotalCents));
    const ivaCents = multiplyRateHalfUp(subtotalCents, this.config.ivaRate);
    const totalCents = addCents(subtotalCents, ivaCents);

    const totals: EconomicTotals = {
      currency: "MXN",
      subtotal: fromCents(subtotalCents),
      ivaRate: this.config.ivaRate,
      iva: fromCents(ivaCents),
      total: fromCents(totalCents),
      totalInWords: centsToPesosWords(totalCents),
    };

    return {
      lineItems,
      blockedLineItems,
      totals,
      cartaText: renderCartaText(totals),
      anexoText: renderAnexoText(lineItems, totals),
    };
  }
}

function renderCartaText(totals: EconomicTotals): string {
  return [`Manifiesto bajo protesta de decir verdad que el importe total de mi propuesta es de $${totals.total} ${totals.currency} (IVA incluido).`, totals.totalInWords].join("\n");
}

function renderAnexoText(lineItems: EconomicLineItemResolved[], totals: EconomicTotals): string {
  const rows = lineItems.map((li) => `${li.concept} | cantidad: ${li.quantity} | precio unitario: $${fromCents(li.unitPriceCents)} | subtotal: $${fromCents(li.subtotalCents)}`).join("\n");
  return [rows, `Subtotal: $${totals.subtotal}`, `IVA (${(totals.ivaRate * 100).toFixed(0)}%): $${totals.iva}`, `Total: $${totals.total} ${totals.currency}`, totals.totalInWords].join("\n");
}
