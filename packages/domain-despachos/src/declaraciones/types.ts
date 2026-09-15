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

/** Tipo de operación DIOT — catálogo REAL de la Regla 3.10.7 RMF vigente
 * (ver `DIOT_TIPO_OPERACION`/`esDiotTipoOperacionValido` en
 * cfdi/catalogs-avanzados.ts): "03" Prestación de servicios profesionales,
 * "06" Arrendamiento de inmuebles, "85" Otros.
 *
 * CORRECCIÓN FISCAL (auditoría, hallazgo ALTO "DIOT con tasa mal
 * codificada"): antes de esta corrección, `agregarDiot()` NO leía este
 * campo — lo DERIVABA de la tasa de IVA de la factura (16%->"03", 0%->"06",
 * cualquier otra->"85"), confundiendo la TASA de IVA con la NATURALEZA de
 * la operación. Esa derivación era doblemente incorrecta: (a) la tasa de
 * IVA no dice nada sobre si el gasto fue un servicio profesional o un
 * arrendamiento — un servicio profesional facturado con IVA 0% (exportación
 * de servicios) se clasificaba como "06" (arrendamiento), una categoría que
 * ni siquiera aplicaba; (b) el catálogo real de DIOT ya vive correctamente
 * documentado a un archivo de distancia (`catalogs-avanzados.ts`), y esta
 * derivación lo ignoraba por completo.
 *
 * Un CFDI, por sí mismo, NO dice de forma confiable si el gasto fue
 * servicios profesionales, arrendamiento u otro — es una clasificación de
 * negocio que debe darla quien captura/revisa el proveedor. Por eso este
 * campo es un OVERRIDE EXPLÍCITO opcional (`RegistroDiotCandidato.tipoOperacion`):
 * si no se provee, `agregarDiot()` usa "85" (Otros) — el único código del
 * catálogo que no afirma una naturaleza económica falsa — en vez de adivinar
 * a partir de la tasa de IVA. */
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
  /** Naturaleza real de la operación (ver `DiotTipoOperacion`), si quien captura el
   * proveedor ya la conoce. Ausente/null -> `agregarDiot()` usa "85" (Otros); NUNCA
   * se deriva de `tasaIva` (ver corrección del hallazgo "DIOT con tasa mal
   * codificada" en la documentación de `DiotTipoOperacion`). */
  readonly tipoOperacion?: DiotTipoOperacion | null;
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
