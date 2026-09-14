// Catálogo de cuentas SAT (subset, 6 dígitos) + tabla de mapeo default —
// puerto EXACTO (mismos códigos y nombres) de
// `b2b_ai/features/bookkeeping/rules_engine.py::CATALOGO_CUENTAS_SAT` y
// `DEFAULT_MAPPINGS`. Datos puros, sin lógica.
import type { AccountMapping, PolizaType, TipoCfdiBookkeeping } from "./types.ts";

export const CATALOGO_CUENTAS_SAT: Readonly<Record<string, string>> = {
  // ACTIVO (1)
  "1020000": "Bancos",
  "1020100": "Bancos nacionales",
  "1020200": "Bancos extranjeros",
  "1050000": "Clientes",
  "1050100": "Clientes nacionales",
  "1050200": "Clientes extranjeros",
  "1080000": "Deudores diversos",
  "1100000": "Anticipos de clientes",
  "1130000": "Mercancías",
  "1500000": "Terrenos",
  "1520000": "Edificios",
  "1540000": "Maquinaria y equipo",
  "1560000": "Mobiliario y equipo de oficina",
  "1580000": "Equipo de transporte",
  "1600000": "Equipo de cómputo",
  "1900000": "Activo diferido",
  // PASIVO (2)
  "2010000": "Proveedores nacionales",
  "2020000": "Proveedores extranjeros",
  "2050000": "Cuentas por pagar a partes relacionadas",
  "2080000": "Acreedores diversos",
  "2600000": "Impuestos y derechos por pagar",
  "2600100": "ISR por pagar",
  "2600200": "IVA por pagar",
  "2600300": "IVA acreditable",
  "2600400": "IVA trasladado",
  "2600500": "ISR por retener (nómina)",
  "2670000": "Acreedores por pago de nómina",
  // CAPITAL (3)
  "3010000": "Capital social",
  "3040000": "Resultado de ejercicios anteriores",
  "3050000": "Resultado del ejercicio",
  // INGRESOS (4)
  "4010000": "Ventas",
  "4020000": "Devoluciones sobre ventas",
  "4080000": "Ingresos por servicios",
  "4100000": "Ingresos por arrendamiento",
  // COSTOS (5)
  "5010000": "Costo de lo vendido",
  "5020000": "Compras",
  // GASTOS (6)
  "6010100": "Sueldos y salarios",
  "6010200": "Sueldos y salarios (asimilados)",
  "6010300": "Sueldos y salarios (IMSS)",
  "6010400": "Sueldos y salarios (INFONAVIT)",
  "6010500": "Sueldos y salarios (SAR)",
  "6010600": "Sueldos y salarios (vacaciones)",
  "6010700": "Sueldos y salarios (prima vacacional)",
  "6010800": "Sueldos y salarios (aguinaldo)",
  "6010900": "Sueldos y salarios (PTU)",
  "6020100": "Servicios profesionales",
  "6020200": "Servicios administrativos",
  "6020300": "Servicios de mantenimiento",
  "6020400": "Rentas de inmuebles",
  "6020500": "Publicidad y propaganda",
  "6020600": "Gastos legales y jurídicos",
  "6020700": "Gastos de viaje y representación",
  "6030100": "Intereses bancarios",
  "6030200": "Comisiones bancarias",
  "6040100": "Pérdida por crédito incobrable",
  "6050100": "Pérdida cambiaria",
  "6070100": "Gastos por inflación",
  "6080100": "Seguros",
  "6090100": "Teléfono e internet",
  "6100100": "Gastos de transporte",
  "6110100": "Equipo de cómputo (gasto)",
};

function m(cargo: string, abono: string, ivaCargo: string | null = null, ivaAbono: string | null = null, polizaType: PolizaType = "egreso"): AccountMapping {
  return { cargo, abono, ivaCargo, ivaAbono, polizaType };
}

/** `DEFAULT_MAPPINGS` — clave `"tipoCfdi|categoria"` (el origen usa una
 * tupla `(tipo_cfdi, category)` como llave de dict; aquí se serializa a
 * string para poder usar un `Record` plano). */
export const DEFAULT_MAPPINGS: Readonly<Record<string, AccountMapping>> = {
  "I|servicios_profesionales": m("6020100", "2010000", "2600300"),
  "I|renta_oficina": m("6020400", "2010000", "2600300"),
  "I|materia_prima": m("5010000", "2010000", "2600300"),
  "I|papeleria": m("6020200", "2010000", "2600300"),
  "I|publicidad": m("6020500", "2010000", "2600300"),
  "I|honorarios_legales": m("6020600", "2010000", "2600300"),
  "I|comision_bancaria": m("6030200", "1020000", "2600300"),
  "I|intereses_bancarios": m("6030100", "1020000", null),
  "I|nomina": m("6010100", "2670000", null),
  "I|arrendamiento": m("6020400", "2010000", "2600300"),
  "I|seguros": m("6080100", "2010000", "2600300"),
  "I|telefonia": m("6090100", "2010000", "2600300"),
  "I|transporte": m("6100100", "2010000", "2600300"),
  "I|equipo_computo": m("1600000", "2010000", "2600300"),
  "I|mantenimiento": m("6020300", "2010000", "2600300"),
  "I|otros": m("6020200", "2010000", "2600300"),
  "E|venta_servicios": m("1050000", "4080000", null, "2600400", "ingreso"),
  "E|venta_mercancia": m("1050000", "4010000", null, "2600400", "ingreso"),
};

export function mappingKey(tipoCfdi: TipoCfdiBookkeeping, categoria: string): string {
  return `${tipoCfdi}|${categoria}`;
}
