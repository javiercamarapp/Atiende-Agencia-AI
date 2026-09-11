// Tipos del motor de declaraciones (Fase 2) — puerto de los `@dataclass` de
// ~/Desktop/supabase/despachos/b2b_ai/features/declaraciones/engine.py
// (IsrResult, DiotRecord, DiotResult). Solo se portan los campos que isr-engine.ts y
// diot-aggregate.ts realmente producen — no se copian campos del Python que ningún
// consumidor de Fase 2 usa (ver diseño §6: XMLGenerator/DIOTGenerator quedan fuera de
// alcance, así que campos como `tipo_tercero`/`tipo_documento`/`num_reg_id_trib`, que
// solo existen para la serialización del archivo pipe-delimited del SAT, no se portan
// aquí — se anota como limitación de alcance, no como omisión accidental).
export type TipoContribuyente = "PF" | "PM";
export type TablaAplicadaIsr = "monthly" | "annual" | "pm_30%" | "pm_resico";

export interface IsrResultado {
  readonly baseGravable: number;
  readonly isrBruto: number;
  readonly tasaEfectiva: number;
  readonly tipoContribuyente: TipoContribuyente;
  readonly tablaAplicada: TablaAplicadaIsr;
  readonly isrNeto: number;
  readonly pagosProvisionales: number;
}

/** Tipo de operación DIOT tal como lo emite `_map_iva_tipo` del Python original —
 * NO es la "naturaleza de la operación" que el catálogo real del SAT espera (ver
 * diseño §2.4.2): aquí codifica la TASA de IVA de la factura, reutilizando el mismo
 * código de catálogo. Fidelidad literal al comportamiento de `engine.py`. */
export type DiotTipoOperacion = "03" | "06" | "85";

/** Entrada candidata a agregación DIOT — un CFDI ya persistido (o por persistir),
 * con los campos que `aggregate_diot` necesita por factura. Ver diseño §3.1: extiende
 * lo que `ProveedorReportableDiot` de Fase 1 ya guarda (rfcProveedor, nombreProveedor,
 * totalOperacion→ahora subtotal, ivaAcreditable, periodo) con los campos que faltaban
 * para poder agregar (tasaIva, ivaTrasladado, moneda, tipoCambio, fecha). */
export interface RegistroDiotCandidato {
  readonly rfcEmisor: string;
  readonly nombreEmisor: string;
  readonly subtotal: number;
  readonly ivaTrasladado: number;
  readonly ivaAcreditable: number;
  /** 0.16 / 0.08 / 0 / cualquier otra (exento). Default del Python si faltara: 0.16 —
   * este puerto lo exige explícito porque es el dato que decide `tipoOperacion` (ver
   * diseño §3.1: "sin tasaIva no se puede agregar nada"). */
  readonly tasaIva: number;
  readonly tipoCambio: number;
  readonly moneda: string;
  /** Fecha del CFDI (cualquier formato serializable; se porta tal cual, "last-wins"
   * dentro de un mismo grupo — ver diseño §2.4.4). */
  readonly fecha: string;
}

export interface DiotRegistroAgregado {
  readonly rfcTercero: string;
  readonly nombre: string;
  readonly tipoOperacion: DiotTipoOperacion;
  readonly moneda: string;
  readonly tipoCambio: number;
  readonly fecha: string;
  readonly montoNeto: number;
  readonly ivaTrasladado16: number;
  readonly ivaTrasladado0: number;
  readonly ivaAcreditable16: number;
  readonly ivaAcreditable0: number;
  /** Incluye IVA de tasa 8% frontera y de operaciones exentas/otras — no existe un
   * campo separado para 8% en el original (ver diseño §2.4.3), se porta igual. */
  readonly ivaExento: number;
  readonly count: number;
}

export interface DiotAgregado {
  readonly registros: readonly DiotRegistroAgregado[];
  readonly totalMontoNeto: number;
  readonly totalIvaTrasladado: number;
  readonly totalIvaAcreditable: number;
  readonly periodo: string;
  readonly rfcContribuyente: string;
}
