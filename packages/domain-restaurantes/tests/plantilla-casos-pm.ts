// Casos del contrato dorado de PM: cada uno se arma por el camino HISTORICO (ctx directo a buildPmSystemPrompt / comportamientoVozPm) y por la
// plantilla (config + generador). Las huellas congeladas se capturaron del builder ANTES de parametrizarlo (tests/fixtures/plantilla-pm-huellas.json).
import { PM_RESTAURANTE_CONFIG } from "../src/plantilla/config-pm.ts";
import type { EntradaWhatsApp } from "../src/plantilla/generador.ts";
import type { RestauranteConfig } from "../src/plantilla/tipos.ts";
import type { BranchSummary } from "../src/types.ts";
import type { PerfilPmContexto } from "../src/whatsapp/perfil-pm.ts";

export const PM_NEGOCIO = {
  businessName: "Los Taquitos de PM",
  agentName: "el asistente virtual",
  deliveryTimeText: "a domicilio de 60 a 75 min (pico: 75 a 90); para recoger de 25 a 35 min (pico: 45 a 60)",
} as const;

/** Las sucursales activas de la config de PM, en el orden en que las arma el generador. */
export const RAMAS_ACTIVAS: readonly BranchSummary[] = [
  { propertyId: "p0", slug: "prol-montejo", name: "Prolongación Montejo", address: null },
  { propertyId: "p1", slug: "pensiones", name: "Pensiones", address: null },
  { propertyId: "p2", slug: "garcia-lavin", name: "García Lavín (Victory Platz)", address: null },
];

export interface CasoPm {
  readonly id: string;
  /** `voz` = comportamiento sembrado (comportamientoVozPm); `wa` = buildPmSystemPrompt (incluye canal voz en llamada). */
  readonly tipo: "wa" | "voz-sembrado";
  readonly ctx: PerfilPmContexto;
  readonly config: RestauranteConfig;
  readonly entrada: EntradaWhatsApp;
}

const base: PerfilPmContexto = { ...PM_NEGOCIO, saludo: "Buenas tardes", branches: RAMAS_ACTIVAS, entryBranch: null, customer: { isNew: true }, saludoPersonalizado: null, salsasTexto: null, promosTexto: null, motivosDesactivados: [] };

const conPoliticas = (p: Partial<RestauranteConfig["politicas"]>): RestauranteConfig => ({ ...PM_RESTAURANTE_CONFIG, politicas: { ...PM_RESTAURANTE_CONFIG.politicas, ...p } });

export const CASOS_PM: readonly CasoPm[] = [
  {
    id: "wa-sin-sucursal",
    tipo: "wa",
    ctx: { ...base, fechaHoraLocal: "lunes 14:00", diaSemana: "lunes" },
    config: PM_RESTAURANTE_CONFIG,
    entrada: { saludo: "Buenas tardes", fechaHoraLocal: "lunes 14:00", diaSemana: "lunes" },
  },
  {
    id: "wa-con-sucursal-y-estado",
    tipo: "wa",
    ctx: { ...base, entryBranch: { name: "Pensiones", slug: "pensiones" }, fechaHoraLocal: "sábado 20:15", diaSemana: "sábado", estadoSucursalAhora: "abierta, cierra a las 01:00", agregadosActivos: true },
    config: PM_RESTAURANTE_CONFIG,
    entrada: { saludo: "Buenas tardes", entryBranch: { name: "Pensiones", slug: "pensiones" }, fechaHoraLocal: "sábado 20:15", diaSemana: "sábado", estadoSucursalAhora: "abierta, cierra a las 01:00", agregadosActivos: true },
  },
  {
    id: "wa-prefijo-estable",
    tipo: "wa",
    ctx: { ...base, prefijoEstable: true, conocimientoBloque: "# CONOCIMIENTO\n- Dato de prueba." },
    config: PM_RESTAURANTE_CONFIG,
    entrada: { saludo: "Buenas tardes", prefijoEstable: true, conocimientoBloque: "# CONOCIMIENTO\n- Dato de prueba." },
  },
  {
    id: "wa-textos-propios",
    tipo: "wa",
    ctx: {
      ...base,
      agentName: "Lupita",
      saludoPersonalizado: "hola, qué gusto",
      salsasTexto: "roja y verde",
      promosTexto: "no hay promociones vigentes",
      pedidoGrandeTexto: "más de $3,000",
      urlFacturacion: "https://facturas.example/pm",
      motivosDesactivados: ["pedido_grande", "no_entiende"],
    },
    config: {
      ...conPoliticas({ salsasTexto: "roja y verde", promosTexto: "no hay promociones vigentes", pedidoGrandeTexto: "más de $3,000", urlFacturacion: "https://facturas.example/pm", motivosDesactivados: ["pedido_grande", "no_entiende"] }),
      marca: { ...PM_RESTAURANTE_CONFIG.marca, agente: "Lupita", saludo: "hola, qué gusto" },
    },
    entrada: { saludo: "Buenas tardes" },
  },
  {
    id: "voz-llamada",
    tipo: "wa",
    ctx: { ...base, canal: "voz", saludo: "buenas tardes", entryBranch: { name: "García Lavín (Victory Platz)", slug: "garcia-lavin" }, fechaHoraLocal: "martes 13:00", diaSemana: "martes" },
    config: PM_RESTAURANTE_CONFIG,
    entrada: { canal: "voz", saludo: "buenas tardes", entryBranch: { name: "García Lavín (Victory Platz)", slug: "garcia-lavin" }, fechaHoraLocal: "martes 13:00", diaSemana: "martes" },
  },
  {
    id: "voz-sembrado-pm",
    tipo: "voz-sembrado",
    ctx: { ...base, canal: "voz", saludo: "" },
    config: PM_RESTAURANTE_CONFIG,
    entrada: {},
  },
  {
    id: "voz-sembrado-textos-propios",
    tipo: "voz-sembrado",
    ctx: { ...base, canal: "voz", saludo: "", salsasTexto: "roja y verde", promosTexto: "no hay promociones vigentes" },
    config: conPoliticas({ salsasTexto: "roja y verde", promosTexto: "no hay promociones vigentes" }),
    entrada: {},
  },
];
