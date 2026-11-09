// ═══════════════════════════════════════════════════════════════════════════
// PLAN MEDIDO — factura de un periodo a partir de la tarifa del plan y del uso
// medido (packages/db/migrations/0103_cobro_planes_medidos.sql).
//
// Ningún precio vive aquí: la tarifa entra como datos (`TarifaPlanMedido`, la
// misma forma que devuelve `core.plan_tarifa_json`). Todo va en CENTAVOS
// enteros y el precio del plan es SIN IVA; el IVA se traslada encima con la
// tasa del plan (puntos base, 1600 = 16 %) — criterio explícito «IVA aparte»
// de `iva.ts`, nunca un lado adivinado.
//
// Reglas:
//   - Cuota fija (`cuotaFijaCentavos`) cada periodo.
//   - Sucursales: se cobran las ACTIVAS arriba de `sucursalesIncluidas` a
//     `precioSucursalCentavos` (null = no se cobra por sucursal).
//   - Minutos/conversaciones incluidos = fijos del plan + por sucursal × sucursales
//     cubiertas (las incluidas o las activas, la mayor).
//   - Excedente = usado − incluido, cobrado a su precio unitario (null = no se
//     cobra: solo se avisa).
//   - Uso justo (`usoJustoPct`, p. ej. 150): el excedente cobrable se topa en
//     `incluido × pct / 100`; lo que pasa del tope NO se cobra solo, se marca
//     `usoJustoExcedido` para que un humano renegocie (nunca se corta el servicio
//     desde aquí).
//   - Cuota de alta: solo cuando el llamador lo pide (primera factura).
// ═══════════════════════════════════════════════════════════════════════════

export type ModeloCobro = 'por_asiento' | 'medido';

/** Escalón del tabulador: el precio por sucursal se fija por el TOTAL de sucursales activas de la cuenta (no acumulado). */
export interface TramoSucursal {
  desde: number;
  /** null = sin límite superior. */
  hasta: number | null;
  /** null = a cotizar (la factura no se calcula sola). */
  precioCentavos: number | null;
  /** Bolsa por sucursal propia del tramo; null/ausente = la del plan. */
  minutosVozIncluidosPorSucursal?: number | null;
  conversacionesWaIncluidasPorSucursal?: number | null;
}

/** Banda de volumen mensual de la cuenta (precio GRADUADO: cada unidad paga la banda en la que cae). */
export interface BandaUso {
  metrica: 'minuto_voz' | 'conversacion_wa';
  desde: number;
  /** null = sin límite superior. */
  hasta: number | null;
  /** null = a cotizar: las unidades de esta banda no se facturan solas. */
  precioCentavos: number | null;
  /** Costo por unidad en esta banda (el costo también baja con el volumen); lo usa la revisión de margen. */
  costoUnitarioMxn: number;
}

export interface TarifaPlanMedido {
  planId: string;
  nombre: string;
  modeloCobro: ModeloCobro;
  cuotaFijaCentavos: number | null;
  precioSucursalCentavos: number | null;
  sucursalesIncluidas: number;
  minutosVozIncluidos: number;
  minutosVozIncluidosPorSucursal: number;
  precioMinutoVozExcedenteCentavos: number | null;
  conversacionesWaIncluidas: number;
  conversacionesWaIncluidasPorSucursal: number;
  precioConversacionWaExcedenteCentavos: number | null;
  usoJustoPct: number | null;
  cuotaAltaCentavos: number | null;
  /** Cuota de alta por sucursal activa (una vez). Ausente/null = sin cuota por sucursal. */
  cuotaAltaPorSucursalCentavos?: number | null;
  tasaIvaBp: number;
  organizacionExclusivaId: string | null;
  /** Tabulador por sucursal. Vacío/ausente = rige `precioSucursalCentavos`. */
  tramosSucursal?: readonly TramoSucursal[];
  /** Bandas de volumen: si hay de una métrica, su excedente se cobra graduado por banda en vez del precio plano. */
  bandasUso?: readonly BandaUso[];
  /** Margen bruto mínimo del plan (dato del plan; el cotizador lo usa). */
  margenMinimoPct?: number | null;
}

/** Partes de [desde, hasta) que caen en cada banda. */
export function repartirEnBandas(bandas: readonly BandaUso[], desde: number, hasta: number): Array<{ banda: BandaUso; unidades: number }> {
  const out: Array<{ banda: BandaUso; unidades: number }> = [];
  if (hasta <= desde) return out;
  for (const b of bandas) {
    const fin = b.hasta ?? Number.POSITIVE_INFINITY;
    const u = Math.max(Math.min(hasta, fin) - Math.max(desde, b.desde), 0);
    if (u > 0) out.push({ banda: b, unidades: u });
  }
  return out;
}

export function bandasDe(t: TarifaPlanMedido, metrica: BandaUso['metrica']): BandaUso[] {
  return (t.bandasUso ?? []).filter((b) => b.metrica === metrica).sort((a, b) => a.desde - b.desde);
}

export interface UsoPeriodo {
  sucursalesActivas: number;
  minutosVoz: number;
  conversacionesWa: number;
}

export type ConceptoFactura = 'cuota_fija' | 'sucursales' | 'excedente_minutos_voz' | 'excedente_conversaciones_wa' | 'cuota_alta';

export interface RenglonFactura {
  concepto: ConceptoFactura;
  descripcion: string;
  cantidad: number;
  precioUnitarioCentavos: number;
  importeCentavos: number;
}

export interface ConsumoMedido {
  incluido: number;
  usado: number;
  excedente: number;
  /** Excedente que SÍ entra a la factura (después del tope de uso justo y si hay precio). */
  excedenteCobrado: number;
  /** null = el plan no tiene tope de uso justo. */
  topeUsoJusto: number | null;
  usoJustoExcedido: boolean;
  /** Porcentaje usado de lo incluido (null si no hay nada incluido). */
  porcentajeUsado: number | null;
}

export interface FacturaPlanMedido {
  planId: string;
  renglones: RenglonFactura[];
  subtotalCentavos: number;
  ivaCentavos: number;
  totalCentavos: number;
  tasaIvaBp: number;
  voz: ConsumoMedido;
  whatsapp: ConsumoMedido;
  /** Avisos legibles para el superadmin/dueño (sin PII). */
  avisos: string[];
}

export class TarifaInvalida extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarifaInvalida';
  }
}

function enteroNoNegativo(valor: number | null, campo: string): void {
  if (valor === null) return;
  if (!Number.isInteger(valor) || valor < 0) throw new TarifaInvalida(`${campo} debe ser un entero >= 0 (recibido: ${valor}).`);
}

export class SucursalesACotizar extends TarifaInvalida {
  constructor(sucursales: number) {
    super(`Con ${sucursales} sucursales el tabulador dice «a cotizar»: asigne un plan a la medida.`);
    this.name = 'SucursalesACotizar';
  }
}

/** Tramo del tabulador que contiene `sucursales` activas (null si el plan no tiene tabulador). */
export function tramoVigente(t: TarifaPlanMedido, sucursales: number): TramoSucursal | null {
  const tramos = t.tramosSucursal ?? [];
  if (tramos.length === 0) return null;
  const n = Math.max(sucursales, 1);
  const tramo = tramos.find((tr) => n >= tr.desde && (tr.hasta === null || n <= tr.hasta));
  if (!tramo) throw new TarifaInvalida(`El tabulador del plan ${t.planId} no cubre ${n} sucursales.`);
  return tramo;
}

/** Precio por sucursal que aplica a `sucursales` activas: el del tramo que las contiene o, sin tabulador, el del plan. */
export function precioSucursalVigente(t: TarifaPlanMedido, sucursales: number): number | null {
  const tramo = tramoVigente(t, sucursales);
  if (!tramo) return t.precioSucursalCentavos;
  if (tramo.precioCentavos === null) throw new SucursalesACotizar(Math.max(sucursales, 1));
  return tramo.precioCentavos;
}

/** Bolsa por sucursal vigente (la del tramo si la trae; si no, la del plan). */
export function bolsaPorSucursalVigente(t: TarifaPlanMedido, sucursales: number): { minutosVoz: number; conversacionesWa: number } {
  const tramo = tramoVigente(t, sucursales);
  return {
    minutosVoz: tramo?.minutosVozIncluidosPorSucursal ?? t.minutosVozIncluidosPorSucursal,
    conversacionesWa: tramo?.conversacionesWaIncluidasPorSucursal ?? t.conversacionesWaIncluidasPorSucursal,
  };
}

/** Valida la tarifa antes de facturar: una tarifa rota lanza, nunca factura una cifra inventada. */
export function validarTarifa(t: TarifaPlanMedido): void {
  if (t.modeloCobro !== 'medido') throw new TarifaInvalida(`El plan ${t.planId} no es medido (modelo ${t.modeloCobro}).`);
  enteroNoNegativo(t.cuotaFijaCentavos, 'cuotaFijaCentavos');
  enteroNoNegativo(t.precioSucursalCentavos, 'precioSucursalCentavos');
  enteroNoNegativo(t.sucursalesIncluidas, 'sucursalesIncluidas');
  enteroNoNegativo(t.minutosVozIncluidos, 'minutosVozIncluidos');
  enteroNoNegativo(t.minutosVozIncluidosPorSucursal, 'minutosVozIncluidosPorSucursal');
  enteroNoNegativo(t.precioMinutoVozExcedenteCentavos, 'precioMinutoVozExcedenteCentavos');
  enteroNoNegativo(t.conversacionesWaIncluidas, 'conversacionesWaIncluidas');
  enteroNoNegativo(t.conversacionesWaIncluidasPorSucursal, 'conversacionesWaIncluidasPorSucursal');
  enteroNoNegativo(t.precioConversacionWaExcedenteCentavos, 'precioConversacionWaExcedenteCentavos');
  enteroNoNegativo(t.cuotaAltaCentavos, 'cuotaAltaCentavos');
  enteroNoNegativo(t.cuotaAltaPorSucursalCentavos ?? null, 'cuotaAltaPorSucursalCentavos');
  for (const tr of t.tramosSucursal ?? []) {
    enteroNoNegativo(tr.minutosVozIncluidosPorSucursal ?? null, 'tramo.minutosVozIncluidosPorSucursal');
    enteroNoNegativo(tr.conversacionesWaIncluidasPorSucursal ?? null, 'tramo.conversacionesWaIncluidasPorSucursal');
    enteroNoNegativo(tr.desde, 'tramo.desde');
    enteroNoNegativo(tr.hasta, 'tramo.hasta');
    enteroNoNegativo(tr.precioCentavos, 'tramo.precioCentavos');
  }
  if (t.usoJustoPct !== null && (!Number.isInteger(t.usoJustoPct) || t.usoJustoPct < 100 || t.usoJustoPct > 1000)) {
    throw new TarifaInvalida(`usoJustoPct debe estar entre 100 y 1000 (recibido: ${t.usoJustoPct}).`);
  }
  if (!Number.isInteger(t.tasaIvaBp) || t.tasaIvaBp < 0 || t.tasaIvaBp > 10000) {
    throw new TarifaInvalida(`tasaIvaBp debe estar entre 0 y 10000 (recibido: ${t.tasaIvaBp}).`);
  }
  const algoQueCobrar = (t.cuotaFijaCentavos ?? 0) > 0 || (t.precioSucursalCentavos ?? 0) > 0 || (t.tramosSucursal ?? []).length > 0 || (t.bandasUso ?? []).length > 0;
  if (!algoQueCobrar) throw new TarifaInvalida(`El plan ${t.planId} no tiene cuota fija ni precio por sucursal: no hay nada que cobrar.`);
}

function validarUso(u: UsoPeriodo): void {
  for (const [campo, valor] of Object.entries(u)) {
    if (!Number.isFinite(valor) || valor < 0) throw new Error(`Uso inválido: ${campo} = ${valor} (se esperaba un número >= 0).`);
  }
}

function consumo(incluido: number, usado: number, precio: number | null, usoJustoPct: number | null): ConsumoMedido {
  const excedente = Math.max(usado - incluido, 0);
  const topeUsoJusto = usoJustoPct === null ? null : Math.floor((incluido * usoJustoPct) / 100);
  const excedenteTopado = topeUsoJusto === null ? excedente : Math.max(Math.min(usado, topeUsoJusto) - incluido, 0);
  return {
    incluido,
    usado,
    excedente,
    excedenteCobrado: precio === null ? 0 : excedenteTopado,
    topeUsoJusto,
    usoJustoExcedido: topeUsoJusto !== null && usado > topeUsoJusto,
    porcentajeUsado: incluido > 0 ? Math.round((usado / incluido) * 1000) / 10 : null,
  };
}

/** IVA sobre centavos con redondeo al centavo (half-up); total = subtotal + iva por construcción. */
export function ivaCentavos(subtotalCentavos: number, tasaIvaBp: number): number {
  return Math.round((subtotalCentavos * tasaIvaBp) / 10000);
}

export function calcularFacturaPlanMedido(tarifa: TarifaPlanMedido, uso: UsoPeriodo, opts: { incluirCuotaAlta?: boolean } = {}): FacturaPlanMedido {
  validarTarifa(tarifa);
  validarUso(uso);
  const sucursalesActivas = Math.floor(uso.sucursalesActivas);
  const minutos = Math.ceil(uso.minutosVoz);
  const conversaciones = Math.floor(uso.conversacionesWa);

  const renglones: RenglonFactura[] = [];
  const avisos: string[] = [];

  if ((tarifa.cuotaFijaCentavos ?? 0) > 0) {
    renglones.push({ concepto: 'cuota_fija', descripcion: `${tarifa.nombre}: cuota mensual`, cantidad: 1, precioUnitarioCentavos: tarifa.cuotaFijaCentavos!, importeCentavos: tarifa.cuotaFijaCentavos! });
  }

  const precioSucursal = precioSucursalVigente(tarifa, sucursalesActivas);
  const sucursalesCobradas = precioSucursal === null ? 0 : Math.max(sucursalesActivas - tarifa.sucursalesIncluidas, 0);
  if (sucursalesCobradas > 0 && precioSucursal !== null) {
    renglones.push({
      concepto: 'sucursales',
      descripcion: `Sucursales activas (${sucursalesActivas}, ${tarifa.sucursalesIncluidas} incluidas)`,
      cantidad: sucursalesCobradas,
      precioUnitarioCentavos: precioSucursal,
      importeCentavos: sucursalesCobradas * precioSucursal,
    });
  }
  if (precioSucursal === null && sucursalesActivas > tarifa.sucursalesIncluidas && tarifa.sucursalesIncluidas > 0) {
    avisos.push(`Hay ${sucursalesActivas} sucursales activas y el plan incluye ${tarifa.sucursalesIncluidas}; el plan no tiene precio por sucursal adicional.`);
  }

  const sucursalesCubiertas = Math.max(sucursalesActivas, tarifa.sucursalesIncluidas);
  const bolsa = bolsaPorSucursalVigente(tarifa, sucursalesActivas);
  const voz = consumo(
    tarifa.minutosVozIncluidos + bolsa.minutosVoz * sucursalesCubiertas,
    minutos,
    bandasDe(tarifa, 'minuto_voz').length > 0 ? 0 : tarifa.precioMinutoVozExcedenteCentavos,
    tarifa.usoJustoPct,
  );
  const whatsapp = consumo(
    tarifa.conversacionesWaIncluidas + bolsa.conversacionesWa * sucursalesCubiertas,
    conversaciones,
    bandasDe(tarifa, 'conversacion_wa').length > 0 ? 0 : tarifa.precioConversacionWaExcedenteCentavos,
    tarifa.usoJustoPct,
  );

  const cobrarPorBandas = (metrica: BandaUso['metrica'], c: ConsumoMedido, concepto: ConceptoFactura, etiqueta: string): boolean => {
    const bandas = bandasDe(tarifa, metrica);
    if (bandas.length === 0) return false;
    const tope = c.topeUsoJusto === null ? c.usado : Math.min(c.usado, c.topeUsoJusto);
    let cobrado = 0;
    for (const { banda, unidades } of repartirEnBandas(bandas, c.incluido, tope)) {
      if (banda.precioCentavos === null) {
        avisos.push(`${unidades} ${etiqueta} arriba de ${banda.desde.toLocaleString('es-MX')} al mes: volumen a cotizar, no se cobra solo.`);
        continue;
      }
      cobrado += unidades;
      renglones.push({
        concepto,
        descripcion: `${etiqueta} de ${banda.desde.toLocaleString('es-MX')} a ${banda.hasta === null ? 'más' : banda.hasta.toLocaleString('es-MX')} al mes`,
        cantidad: unidades,
        precioUnitarioCentavos: banda.precioCentavos,
        importeCentavos: unidades * banda.precioCentavos,
      });
    }
    c.excedenteCobrado = cobrado;
    return true;
  };

  if (!cobrarPorBandas('minuto_voz', voz, 'excedente_minutos_voz', 'Minutos de voz') && voz.excedenteCobrado > 0) {
    renglones.push({
      concepto: 'excedente_minutos_voz',
      descripcion: `Minutos de voz adicionales (${voz.usado} usados, ${voz.incluido} incluidos)`,
      cantidad: voz.excedenteCobrado,
      precioUnitarioCentavos: tarifa.precioMinutoVozExcedenteCentavos!,
      importeCentavos: voz.excedenteCobrado * tarifa.precioMinutoVozExcedenteCentavos!,
    });
  }
  if (!cobrarPorBandas('conversacion_wa', whatsapp, 'excedente_conversaciones_wa', 'Conversaciones de WhatsApp') && whatsapp.excedenteCobrado > 0) {
    renglones.push({
      concepto: 'excedente_conversaciones_wa',
      descripcion: `Conversaciones de WhatsApp adicionales (${whatsapp.usado} usadas, ${whatsapp.incluido} incluidas)`,
      cantidad: whatsapp.excedenteCobrado,
      precioUnitarioCentavos: tarifa.precioConversacionWaExcedenteCentavos!,
      importeCentavos: whatsapp.excedenteCobrado * tarifa.precioConversacionWaExcedenteCentavos!,
    });
  }
  if (voz.excedente > 0 && tarifa.precioMinutoVozExcedenteCentavos === null && bandasDe(tarifa, 'minuto_voz').length === 0) avisos.push(`Excedente de ${voz.excedente} minutos de voz sin precio de excedente en el plan: no se cobra.`);
  if (whatsapp.excedente > 0 && tarifa.precioConversacionWaExcedenteCentavos === null && bandasDe(tarifa, 'conversacion_wa').length === 0) avisos.push(`Excedente de ${whatsapp.excedente} conversaciones de WhatsApp sin precio de excedente en el plan: no se cobra.`);
  if (voz.usoJustoExcedido) avisos.push(`Voz por encima del uso justo (${voz.usado} de ${voz.topeUsoJusto} minutos): lo que pasa del tope no se cobra solo; hay que renegociar o pasar a desborde.`);
  if (whatsapp.usoJustoExcedido) avisos.push(`WhatsApp por encima del uso justo (${whatsapp.usado} de ${whatsapp.topeUsoJusto} conversaciones): lo que pasa del tope no se cobra solo.`);

  if (opts.incluirCuotaAlta && (tarifa.cuotaAltaCentavos ?? 0) > 0) {
    renglones.push({ concepto: 'cuota_alta', descripcion: 'Cuota de alta (una sola vez)', cantidad: 1, precioUnitarioCentavos: tarifa.cuotaAltaCentavos!, importeCentavos: tarifa.cuotaAltaCentavos! });
  }
  const altaSucursal = tarifa.cuotaAltaPorSucursalCentavos ?? 0;
  if (opts.incluirCuotaAlta && altaSucursal > 0 && sucursalesActivas > 0) {
    renglones.push({ concepto: 'cuota_alta', descripcion: `Alta por sucursal (${sucursalesActivas}, una sola vez)`, cantidad: sucursalesActivas, precioUnitarioCentavos: altaSucursal, importeCentavos: altaSucursal * sucursalesActivas });
  }

  const subtotalCentavos = renglones.reduce((s, r) => s + r.importeCentavos, 0);
  const iva = ivaCentavos(subtotalCentavos, tarifa.tasaIvaBp);
  return {
    planId: tarifa.planId,
    renglones,
    subtotalCentavos,
    ivaCentavos: iva,
    totalCentavos: subtotalCentavos + iva,
    tasaIvaBp: tarifa.tasaIvaBp,
    voz,
    whatsapp,
    avisos,
  };
}

/** Lee la forma JSON de `core.plan_tarifa_json` (claves camelCase) sin confiar en tipos: lo inválido lanza. */
export function tarifaDesdeJson(raw: unknown): TarifaPlanMedido {
  if (typeof raw !== 'object' || raw === null) throw new TarifaInvalida('La tarifa no es un objeto.');
  const o = raw as Record<string, unknown>;
  const n = (k: string): number | null => {
    const v = o[k];
    if (v === null || v === undefined) return null;
    const num = typeof v === 'string' ? Number(v) : v;
    if (typeof num !== 'number' || !Number.isFinite(num)) throw new TarifaInvalida(`${k} no es numérico.`);
    return num;
  };
  const modelo = o.modeloCobro;
  if (modelo !== 'por_asiento' && modelo !== 'medido') throw new TarifaInvalida('modeloCobro desconocido.');
  if (typeof o.planId !== 'string' || typeof o.nombre !== 'string') throw new TarifaInvalida('Falta planId o nombre.');
  return {
    planId: o.planId,
    nombre: o.nombre,
    modeloCobro: modelo,
    cuotaFijaCentavos: n('cuotaFijaCentavos'),
    precioSucursalCentavos: n('precioSucursalCentavos'),
    sucursalesIncluidas: n('sucursalesIncluidas') ?? 0,
    minutosVozIncluidos: n('minutosVozIncluidos') ?? 0,
    minutosVozIncluidosPorSucursal: n('minutosVozIncluidosPorSucursal') ?? 0,
    precioMinutoVozExcedenteCentavos: n('precioMinutoVozExcedenteCentavos'),
    conversacionesWaIncluidas: n('conversacionesWaIncluidas') ?? 0,
    conversacionesWaIncluidasPorSucursal: n('conversacionesWaIncluidasPorSucursal') ?? 0,
    precioConversacionWaExcedenteCentavos: n('precioConversacionWaExcedenteCentavos'),
    usoJustoPct: n('usoJustoPct'),
    cuotaAltaCentavos: n('cuotaAltaCentavos'),
    cuotaAltaPorSucursalCentavos: n('cuotaAltaPorSucursalCentavos'),
    tasaIvaBp: n('tasaIvaBp') ?? 1600,
    organizacionExclusivaId: typeof o.organizacionExclusivaId === 'string' ? o.organizacionExclusivaId : null,
    margenMinimoPct: n('margenMinimoPct'),
    bandasUso: Array.isArray(o.bandasUso)
      ? o.bandasUso.map((b: unknown) => {
          const x = (b ?? {}) as Record<string, unknown>;
          const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
          return {
            metrica: x.metrica === 'conversacion_wa' ? ('conversacion_wa' as const) : ('minuto_voz' as const),
            desde: num(x.desde) ?? 0,
            hasta: num(x.hasta),
            precioCentavos: num(x.precioCentavos),
            costoUnitarioMxn: num(x.costoUnitarioMxn) ?? 0,
          };
        })
      : [],
    tramosSucursal: Array.isArray(o.tramosSucursal)
      ? o.tramosSucursal.map((tr: unknown) => {
          const x = (tr ?? {}) as Record<string, unknown>;
          const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
          return {
            desde: num(x.desde) ?? 1,
            hasta: num(x.hasta),
            precioCentavos: num(x.precioCentavos),
            minutosVozIncluidosPorSucursal: num(x.minutosVozIncluidosPorSucursal),
            conversacionesWaIncluidasPorSucursal: num(x.conversacionesWaIncluidasPorSucursal),
          };
        })
      : [],
  };
}
