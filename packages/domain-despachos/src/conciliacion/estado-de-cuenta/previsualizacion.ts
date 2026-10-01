// Vista previa de una importación: movimientos parseados + conciliación contra los CFDI
// ya ingeridos de la property (REUTILIZA `conciliarMovimientos`, no un motor nuevo) +
// sugerencia de cobranza (cuenta por cobrar pendiente del CFDI conciliado con un abono).
// Es SOLO lectura: no persiste nada ni marca ninguna cuenta como pagada; eso lo decide
// una persona con rol de conciliación.
import { conciliarMovimientos } from "../matching-engine.ts";
import type { NivelCoincidencia, OpcionesMatchingEngine, RegistroConciliable, ResultadoConciliacion } from "../types.ts";
import type { MovimientoImportado, ResultadoParseoEstado } from "./types.ts";

/** El matching es O(movimientos x CFDI) con subset-sum en el nivel 3: por encima de
 * este tope se omite la conciliación (se sigue mostrando el parseo) para no agotar el
 * tiempo de la función. Se reporta como `conciliacionOmitida`, nunca en silencio. */
export const MAX_MOVIMIENTOS_CONCILIACION = 1_000;

export interface CuentaPorCobrarPendiente {
  readonly id: string;
  readonly invoiceId: string;
}

export interface CoincidenciaImportacion {
  readonly hash: string;
  readonly renglon: number;
  readonly nivel: NivelCoincidencia;
  readonly score: number;
  readonly detalle: string;
  /** Ids de CFDI (`invoice.id`); más de uno en el nivel 3 (un pago cubre varias facturas). */
  readonly registroIds: readonly string[];
  readonly folioFiscal: readonly string[];
  /** Cuenta por cobrar pendiente asociada (solo abonos); sugerencia, nunca se aplica sola. */
  readonly cobranzaPendienteIds: readonly string[];
}

export interface VistaPreviaImportacion {
  readonly parseo: ResultadoParseoEstado;
  /** Hashes de movimientos que ya se habían importado antes (no se vuelven a insertar). */
  readonly yaImportados: readonly string[];
  readonly nuevos: number;
  readonly conciliacion: ResultadoConciliacion | null;
  readonly conciliacionOmitida: string | null;
  readonly coincidencias: readonly CoincidenciaImportacion[];
  /** Cobranza consultada: false = la base aún no tiene esa tabla o no hay datos accesibles. */
  readonly cobranzaDisponible: boolean;
}

export interface EntradaVistaPrevia {
  readonly parseo: ResultadoParseoEstado;
  readonly registros: readonly RegistroConciliable[];
  /** null = cobranza no disponible todavía en esta base (honesto, no vacío engañoso). */
  readonly cuentasPorCobrarPendientes: readonly CuentaPorCobrarPendiente[] | null;
  readonly hashesYaImportados?: ReadonlySet<string>;
  readonly opciones?: OpcionesMatchingEngine;
}

export function construirVistaPreviaImportacion(entrada: EntradaVistaPrevia): VistaPreviaImportacion {
  const { parseo, registros } = entrada;
  const previos = entrada.hashesYaImportados ?? new Set<string>();
  const yaImportados = parseo.movimientos.filter((m) => previos.has(m.hash)).map((m) => m.hash);
  const porConciliar: readonly MovimientoImportado[] = parseo.movimientos.filter((m) => !previos.has(m.hash));

  let conciliacion: ResultadoConciliacion | null = null;
  let conciliacionOmitida: string | null = null;
  const coincidencias: CoincidenciaImportacion[] = [];

  if (porConciliar.length === 0) {
    conciliacionOmitida = parseo.movimientos.length === 0 ? "No hay movimientos válidos que conciliar." : "Todos los movimientos ya se habían importado.";
  } else if (porConciliar.length > MAX_MOVIMIENTOS_CONCILIACION) {
    conciliacionOmitida = `El archivo trae ${porConciliar.length} movimientos nuevos; la conciliación automática se limita a ${MAX_MOVIMIENTOS_CONCILIACION} por importación. Divide el archivo por periodos.`;
  } else if (registros.length === 0) {
    conciliacionOmitida = "No hay CFDI ingeridos en esta property contra los que conciliar.";
  } else {
    conciliacion = conciliarMovimientos(porConciliar, registros, entrada.opciones ?? {});
    const pendientesPorFactura = new Map<string, string[]>();
    for (const c of entrada.cuentasPorCobrarPendientes ?? []) {
      pendientesPorFactura.set(c.invoiceId, [...(pendientesPorFactura.get(c.invoiceId) ?? []), c.id]);
    }
    for (const m of conciliacion.matched) {
      const mov = porConciliar[m.movementIdx]!;
      const indices = m.registroIndices ?? (m.registroIdx === null ? [] : [m.registroIdx]);
      const recs = indices.map((i) => registros[i]!).filter(Boolean);
      coincidencias.push({
        hash: mov.hash,
        renglon: mov.renglon,
        nivel: m.level,
        score: m.score,
        detalle: m.detail,
        registroIds: recs.map((r) => r.id),
        folioFiscal: recs.map((r) => r.folioFiscal ?? "").filter((f) => f !== ""),
        cobranzaPendienteIds: mov.monto > 0 ? recs.flatMap((r) => pendientesPorFactura.get(r.id) ?? []) : [],
      });
    }
  }

  return {
    parseo,
    yaImportados,
    nuevos: porConciliar.length,
    conciliacion,
    conciliacionOmitida,
    coincidencias,
    cobranzaDisponible: entrada.cuentasPorCobrarPendientes !== null,
  };
}
