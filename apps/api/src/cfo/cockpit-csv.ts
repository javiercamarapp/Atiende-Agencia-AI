// CSV de la economia por cliente del cockpit CFO (UTF-8 con BOM para Excel). Una cifra sin fuente va
// VACIA (nunca 0) y la columna `fuente_costo` / `avisos` dice por que. Celdas neutralizadas contra
// formulas de hoja de calculo con `celdaCsv` (la misma del P&L).
import { celdaCsv } from "@atiende/billing";
import type { Cockpit } from "./cockpit.ts";

export const COLUMNAS_ECONOMIA = [
  "mes",
  "organizacion_id",
  "cliente",
  "vertical",
  "estado",
  "plan",
  "modelo_cobro",
  "sucursales",
  "mrr_mxn",
  "excedente_estimado_mxn",
  "ingreso_mxn",
  "llamadas",
  "minutos_voz",
  "duracion_promedio_min",
  "conversaciones_wa",
  "pedidos",
  "costo_voz_usd",
  "costo_llm_usd",
  "costo_whatsapp_usd",
  "costo_telefonia_usd",
  "costo_otros_usd",
  "costo_directo_mxn",
  "infra_prorrateada_mxn",
  "contribucion_mxn",
  "contribucion_pct",
  "margen_bruto_mxn",
  "margen_bruto_pct",
  "ingreso_proyectado_mxn",
  "costo_proyectado_mxn",
  "margen_proyectado_mxn",
  "pool_voz_pct",
  "pool_wa_pct",
  "fuente_costo",
  "banderas",
  "avisos",
] as const;

export function economiaACsv(c: Cockpit): string {
  const lineas = [COLUMNAS_ECONOMIA.map(celdaCsv).join(",")];
  for (const f of c.economia) {
    const fuentes = Object.entries(f.costo)
      .filter(([, v]) => v.fuente !== "sin_uso")
      .map(([k, v]) => `${k}:${v.fuente}`)
      .join(" ");
    const usd = (v: number | null) => (v === null ? null : Number(v.toFixed(4)));
    lineas.push(
      [
        c.mes,
        f.organizationId,
        f.nombre,
        f.vertical,
        f.orgStatus,
        f.planNombre,
        f.modeloCobro,
        f.sucursales,
        f.mrrMxn,
        f.excedenteMxn,
        f.ingresoMxn,
        f.uso.llamadas,
        f.uso.minutosVoz,
        f.uso.duracionPromedioMin,
        f.uso.conversacionesWa,
        f.uso.pedidos,
        usd(f.costo.voz.usd),
        usd(f.costo.llm.usd),
        usd(f.costo.whatsapp.usd),
        usd(f.costo.telefonia.usd),
        usd(f.costo.otros.usd),
        f.costoDirectoMxn,
        f.infraMxn,
        f.contribucionMxn,
        f.contribucionPct,
        f.margenBrutoMxn,
        f.margenBrutoPct,
        f.proyeccion.ingresoMxn,
        f.proyeccion.costoMxn,
        f.proyeccion.margenMxn,
        f.poolVoz?.pct ?? null,
        f.poolWa?.pct ?? null,
        fuentes,
        f.banderas.join(" "),
        f.avisos.join(" "),
      ]
        .map((v) => (typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : celdaCsv(v)))
        .join(","),
    );
  }
  return `\uFEFF${lineas.join("\r\n")}\r\n`;
}
