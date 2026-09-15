// Lógica de datos del resumen ejecutivo del Dashboard (Fase 16, hallazgo de
// auditoría severidad ALTA "No hay dashboard por tipo de usuario") — consume
// GET /hoteles/:propertyId/pl?desde=&hasta= (apps/api/src/routes/verticals/hoteles/
// pl.ts, REQ-BO-010, ya construido en Fase 10). Solo tipa el subconjunto de la
// respuesta que el Dashboard necesita para el resumen ejecutivo: los KPIs reales de
// ocupación/ADR/RevPAR y el TOTAL del P&L USALI del periodo. El desglose completo
// (diario/mensual/por departamento/gastos/owner's report) es la superficie de un
// /back-office de P&L propio — deliberadamente fuera de esta fase, ver comentario de
// cabecera de pages/Dashboard.tsx para la justificación completa.
//
// Solo owner/gm/accountant (PL_ROLES en domain-hoteles/src/roles.ts) pueden llamar
// esto sin que el servidor responda 403 — mismo criterio que el resto de lib/*.ts de
// este vertical: el gate real vive SIEMPRE en el servidor (`assertVerticalRole` en
// pl.ts), Dashboard.tsx solo evita ofrecer esta sección a quien el servidor
// rechazaría igual.
//
// Tipos REDECLARADOS aquí a propósito (nunca importados de @atiende/domain-hoteles):
// apps/web no depende de ningún paquete domain-* (ver package.json — solo
// react/react-dom/react-router-dom), mismo aislamiento que ya mantiene el resto de
// lib/*.ts de este vertical (ver comentario de cabecera de reservas-client.ts).
import { fetchJson } from "./admin-client.ts";

export interface PlKpis {
  readonly adr: number;
  readonly revpar: number;
  readonly occupancyPct: number;
  readonly occupiedRoomNights: number;
  readonly availableRoomNights: number;
}

/** Espejo parcial de `serializeUsaliPL` (pl.ts) — solo los campos-resumen que este
 * Dashboard muestra (ingresos/GOP/margen/EBITDA/utilidad neta). El desglose por
 * departamento (`departamentos`) y de gastos no distribuidos vive completo en la
 * respuesta real del servidor pero esta pantalla no lo consume. */
export interface PlTotalsSummary {
  readonly ingresosTotales: number;
  readonly gop: number;
  readonly gopMarginPct: number;
  readonly ebitda: number;
  readonly utilidadNeta: number;
}

export interface PlSummaryResponse {
  readonly periodo: { readonly desde: string; readonly hasta: string };
  readonly kpis: PlKpis;
  readonly total: PlTotalsSummary;
}

/** `desde`/`hasta` en formato YYYY-MM-DD (mismo formato que exige `DATE_RE` del
 * servidor en pl.ts) — el caller (Dashboard.tsx) es quien decide el rango, este
 * cliente nunca calcula fechas por su cuenta. */
export async function fetchPlSummary(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, desde: string, hasta: string): Promise<PlSummaryResponse> {
  return fetchJson<PlSummaryResponse>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pl?desde=${desde}&hasta=${hasta}`, token);
}
