// ═══════════════════════════════════════════════════════════════════════════
// CATÁLOGOS SAT — puerto de
// ~/Desktop/supabase/despachos/b2b_ai/cfdi/catalogs.py
//
// Fuente: Anexo 20, Guía de llenado CFDI 4.0 (DOF 20-ene-2022). Códigos
// validados contra la documentación oficial del SAT en el repo de despachos,
// que es el dominio que YA vive de facturación fiscal mexicana real — este
// motor de billing los reutiliza en vez de reinventar el catálogo.
// ═══════════════════════════════════════════════════════════════════════════

export const TIPOS_COMPROBANTE: Record<string, string> = {
  I: 'Ingreso',
  E: 'Egreso',
  T: 'Traslado',
  P: 'Pago',
  N: 'Nomina',
};

export const METODOS_PAGO: Record<string, string> = {
  PUE: 'Pago en una sola exhibicion',
  PPD: 'Pago en parcialidades o diferido',
};

export const FORMAS_PAGO: Record<string, string> = {
  '01': 'Efectivo',
  '02': 'Cheque nominativo',
  '03': 'Transferencia electronica de fondos',
  '04': 'Tarjeta de credito',
  '05': 'Monedero electronico',
  '06': 'Dinero electronico',
  '08': 'Vales de despensa',
  '12': 'Dacion en pago',
  '13': 'Pago por subrogacion',
  '14': 'Pago por consignacion',
  '15': 'Condonacion',
  '17': 'Compensacion',
  '23': 'Novacion',
  '24': 'Confusion',
  '25': 'Remision de deuda',
  '26': 'Prescripcion o caducidad',
  '27': 'A satisfaccion del acreedor',
  '28': 'Tarjeta de debito',
  '29': 'Tarjeta de servicio',
  '30': 'Aplicacion de anticipos',
  '31': 'Intermediario pagos',
  '99': 'Por definir',
};

// c_UsoCFDI (CFDI 4.0). P01 existía en 3.3 y fue removido en 4.0.
export const USOS_CFDI: Record<string, string> = {
  G01: 'Adquisicion de mercancias',
  G02: 'Devoluciones, descuentos o bonificaciones',
  G03: 'Gastos en general',
  G05: 'Mobiliario y equipo de oficina por inversiones',
  G06: 'Equipo de transporte',
  G08: 'Otros maquinaria y equipo',
  G09: 'Otros bienes o servicios',
  G10: 'Cargos, arrendamientos y accesorios',
  I01: 'Construcciones',
  I02: 'Mobiliario y equipo de oficina',
  I03: 'Equipo de transporte',
  I04: 'Equipo de computo y accesorios',
  I05: 'Dados, troqueles, moldes, matrices y herramental',
  I06: 'Comunicaciones telefonicas',
  I07: 'Comunicaciones satelitales',
  I08: 'Otra maquinaria y equipo',
  S01: 'Sin efectos fiscales',
  CP01: 'Pagos',
  CN01: 'Nomina',
  D01: 'Honorarios medicos, dentales y gastos hospitalarios',
  D02: 'Gastos medicos por incapacidad o discapacidad',
  D03: 'Gastos funerales',
  D04: 'Donativos',
  D05: 'Intereses reales de creditos hipotecarios (casa habitacion)',
  D06: 'Aportaciones voluntarias al SAR',
  D07: 'Primas por seguros de gastos medicos',
  D08: 'Gastos de transporte escolar obligatorio',
  D09: 'Depositos en cuentas para el ahorro, planes de pensiones',
  D10: 'Pagos por servicios educativos (colegiaturas)',
};

export const REGIMENES_FISCALES: Record<string, string> = {
  '601': 'General de Ley Personas Morales',
  '603': 'Personas Morales con Fines no Lucrativos',
  '605': 'Sueldos y Salarios e Ingresos Asimilados a Salarios',
  '606': 'Arrendamiento',
  '607': 'Regimen de Enajenacion o Adquisicion de Bienes',
  '608': 'Demas ingresos',
  '610': 'Residentes en el Extranjero sin Establecimiento Permanente en Mexico',
  '611': 'Ingresos por Dividendos (socios y accionistas)',
  '612': 'Personas Fisicas con Actividades Empresariales y Profesionales',
  '614': 'Ingresos por intereses',
  '615': 'Regimen de los ingresos por obtencion de premios',
  '616': 'Sin obligaciones fiscales',
  '620': 'Sociedades Cooperativas de Produccion',
  '621': 'Incorporacion Fiscal',
  '622': 'Actividades Agricolas, Ganaderas, Silvicolas y Pesqueras',
  '623': 'Opcional para Grupos de Sociedades',
  '624': 'Coordinados',
  '625': 'Regimen de Actividades Empresariales con ingresos por Plataformas Tecnologicas',
  '626': 'Regimen Simplificado de Confianza',
  '628': 'Hidrocarburos',
  '629': 'De los Regimenes Fiscales Preferentes y de las Empresas Multinacionales',
  '630': 'Enajenacion de acciones en bolsa de valores',
};

export const IMPUESTOS: Record<string, string> = {
  '001': 'ISR',
  '002': 'IVA',
  '003': 'IEPS',
  '004': 'ISH',
};

export function esUsoCfdiValido(codigo: string): boolean {
  return codigo in USOS_CFDI;
}
export function esFormaPagoValida(codigo: string): boolean {
  return codigo in FORMAS_PAGO;
}
export function esMetodoPagoValido(codigo: string): boolean {
  return codigo in METODOS_PAGO;
}
export function esTipoComprobanteValido(codigo: string): boolean {
  return codigo in TIPOS_COMPROBANTE;
}
export function esRegimenValido(codigo: string): boolean {
  return codigo in REGIMENES_FISCALES;
}
