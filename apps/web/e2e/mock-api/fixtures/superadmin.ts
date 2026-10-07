// Fixtures del back office de plataforma (/superadmin/*). Solo la persona `plataforma-superadmin` ve estas rutas.
import { conStatus, fallo, ndjson } from "../respuestas.ts";
import { orgDe } from "../personas.ts";
import type { Ruta, Vertical } from "../tipos.ts";
import { rutasCerebro } from "./cerebro.ts";

const VERTICALES: readonly Vertical[] = ["restaurantes", "hoteles", "rentas", "despachos", "licitaciones", "citas"];

function organizaciones() {
  return VERTICALES.map((v, i) => {
    const org = orgDe(v);
    return { id: org.id, vertical: v, name: org.nombre, slug: org.slug, status: i === 5 ? "trial" : "active", createdAt: `2026-0${3 + (i % 5)}-1${i}T15:00:00.000Z`, staffCount: 4 + i };
  });
}

interface Prospecto {
  id: string;
  empresa: string;
  vertical: string;
  ciudad: string | null;
  contactoNombre: string | null;
  telefono: string | null;
  correo: string | null;
  estado: string;
  fuente: string | null;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
}

const PROSPECTOS: Prospecto[] = [
  { id: "prs-1", empresa: "Marisqueria La Playita", vertical: "restaurantes", ciudad: "Progreso", contactoNombre: "Elena Tun", telefono: "+529995550301", correo: "elena.tun@example.test", estado: "contactado", fuente: "referido", notas: null, createdAt: "2026-09-20T16:00:00.000Z", updatedAt: "2026-09-22T16:00:00.000Z" },
];

// Consola de superadmin (SA-L-05/SA-L-06): misma forma que apps/api/src/routes/superadmin-consola.ts. Solo existe en la API
// simulada de e2e; en produccion la respuesta sale de las funciones core.get_consola_*_for_superadmin.
const HOY_CONSOLA = "2026-09-30";
function diasConsola(): string[] {
  const out: string[] = [];
  for (let i = 13; i >= 0; i--) out.push(new Date(Date.UTC(2026, 8, 30 - i)).toISOString().slice(0, 10));
  return out;
}
const razonSinFuente = "Sin fuente: despachos no guarda un registro de CFDI conciliados (la conciliación bancaria no se persiste).";

function resumenConsola() {
  const dias = diasConsola();
  const cantidad = (i: number, base: number) => base + (i % 4);
  const serieRest = dias.map((dia, i) => ({ dia, cantidad: cantidad(i, 6) }));
  const serieHot = dias.map((dia, i) => ({ dia, cantidad: cantidad(i, 2) }));
  const serieCit = dias.map((dia, i) => ({ dia, cantidad: cantidad(i, 3) }));
  const suma = (s: Array<{ cantidad: number }>) => s.reduce((a, x) => a + x.cantidad, 0);
  return {
    disponible: true,
    generadoEn: "2026-09-30T18:00:00.000Z",
    hoy: HOY_CONSOLA,
    organizaciones: { valor: { total: 6, demo: 1, porVertical: VERTICALES.map((v) => ({ vertical: v, total: 1, demo: v === "restaurantes" ? 1 : 0 })) } },
    gastoIa: {
      valor: {
        totalUsd: 41.82, llmUsd: 36.1, otrosUsd: 5.72,
        porCategoria: [{ categoria: "voz", usd: 3.9 }, { categoria: "whatsapp", usd: 1.82 }],
        serie14d: { valor: dias.map((dia, i) => ({ dia, usd: 1.5 + i * 0.1 })) },
        delta7d: { valor: { actualUsd: 14.7, previoUsd: 12.6, deltaUsd: 2.1, pct: 16.67 } },
      },
    },
    tokens: { valor: { total: 5_400_000, entrada: 4_100_000, salida: 1_300_000 } },
    operaciones: {
      valor: {
        total: suma(serieRest) + suma(serieHot) + suma(serieCit),
        porVertical: [
          { vertical: "restaurantes", total: suma(serieRest), serie14d: serieRest },
          { vertical: "hoteles", total: suma(serieHot), serie14d: serieHot },
          { vertical: "rentas", total: null, codigo: "fuente_no_migrada", razon: "No disponible aún: la migración de esta vertical no está aplicada en este despliegue.", serie14d: null },
          { vertical: "citas", total: suma(serieCit), serie14d: serieCit },
          { vertical: "despachos", total: null, codigo: "sin_fuente", razon: razonSinFuente, serie14d: null },
          { vertical: "licitaciones", total: 0, serie14d: dias.map((dia) => ({ dia, cantidad: 0 })) },
        ],
        serie14d: dias.map((dia, i) => ({ dia, cantidad: serieRest[i]!.cantidad + serieHot[i]!.cantidad + serieCit[i]!.cantidad })),
        verticalesSinFuente: ["rentas", "despachos"],
      },
    },
    vozMinutos: { valor: 318.5 },
    sucursales: { valor: 11 },
    usuarios: { valor: { total: 27, staff: 26, superadmins: 1 } },
    conversacionesWa: {
      valor: {
        total: 214,
        porVertical: [
          { vertical: "restaurantes", total: 120 }, { vertical: "hoteles", total: 64 },
          { vertical: "rentas", total: null, codigo: "sin_whatsapp", razon: "Sin fuente: esta vertical no guarda conversaciones de WhatsApp." },
          { vertical: "citas", total: 30 },
          { vertical: "despachos", total: null, codigo: "sin_whatsapp", razon: "Sin fuente: esta vertical no guarda conversaciones de WhatsApp." },
          { vertical: "licitaciones", total: null, codigo: "sin_whatsapp", razon: "Sin fuente: esta vertical no guarda conversaciones de WhatsApp." },
        ],
      },
    },
    resueltasSinHumano: { valor: { dia: HOY_CONSOLA, resueltas: 18, total: 24, porcentaje: 75, nota: "medido solo en restaurantes" } },
    mrr: { valor: { totalMxn: 48_900, organizacionesConPrecio: 4, organizacionesSinPrecio: 2 } },
    politicaMrr: { requiereStepUp: false, recursoBitacora: "resumen_mrr", desglosePorCliente: false },
  };
}

function agentesConsola() {
  return {
    disponible: true,
    hoy: HOY_CONSOLA,
    agentes: {
      valor: [
        { vertical: "restaurantes", role: "restaurantes:whatsapp_agent", historico: { llamadas: 1840, costoUsd: 21.4, fallbacks: 12 }, ultimos30Dias: { llamadas: 610, costoUsd: 7.2, fallbacks: 3 } },
        { vertical: "hoteles", role: "hoteles:whatsapp_agent", historico: { llamadas: 920, costoUsd: 9.8, fallbacks: 5 }, ultimos30Dias: { llamadas: 300, costoUsd: 3.1, fallbacks: 1 } },
        { vertical: "despachos", role: "despachos:conciliacion_llm_agent", historico: { llamadas: 140, costoUsd: 2.2, fallbacks: 0 }, ultimos30Dias: { llamadas: 40, costoUsd: 0.6, fallbacks: 0 } },
      ],
    },
    ultimaCorrida: {
      valor: [
        { cron: "/internal/citas/confirmacion-cita", vertical: "citas", nombre: "Recordatorios de citas", estado: "ok", terminoEn: "2026-09-30T17:30:02.000Z", duracionMs: 2100, fallosConsecutivos: 0, tareas: "no medido" },
        { cron: "/internal/rentas/ical-sync", vertical: "rentas", nombre: "Sincronización iCal de rentas", estado: "error", terminoEn: "2026-09-30T17:45:01.000Z", duracionMs: 900, fallosConsecutivos: 2, tareas: "no medido" },
        { cron: "/internal/licitaciones/discover-tenders", vertical: "licitaciones", nombre: "Descubrimiento de convocatorias", estado: "ok", terminoEn: "2026-09-30T05:00:40.000Z", duracionMs: 40_000, fallosConsecutivos: 0, tareas: "no medido" },
        { cron: "/internal/superadmin/resumen-diario", vertical: "plataforma", nombre: "Parte diario", estado: "ok", terminoEn: "2026-09-30T15:00:11.000Z", duracionMs: 11_000, fallosConsecutivos: 0, tareas: "no medido" },
      ],
    },
    notas: ["«tareas x/y» no se mide: el latido de cron no registra tareas; la bitácora de corridas real es SA-L-07."],
  };
}

// Fichas de agente (SA-L-09) y Model Ops (SA-L-10): misma forma que apps/api/src/routes/superadmin-agentes-fichas.ts. Solo existe en la
// API simulada de e2e; en produccion sale de las funciones core.get_fichas_*_for_superadmin (0049) y de core.llm_usage_daily.
function serieFicha(): Array<{ dia: string; llamadas: number; costoUsd: number }> {
  return Array.from({ length: 7 }, (_, i) => ({ dia: new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10), llamadas: 3 + i * 2, costoUsd: Math.round((0.05 + i * 0.02) * 100) / 100 }));
}
function fichaBase(ficha: string, nombre: string, roles: string[], llamadas: number, totalUsd: number) {
  return {
    disponible: true,
    ficha,
    nombre,
    nombreConfirmado: false,
    generadoEn: "2026-09-30T18:00:00.000Z",
    hoy: HOY_CONSOLA,
    roles,
    gastado: { valor: { totalUsd, llmUsd: totalUsd, vozUsd: null } },
    llamadas: { valor: llamadas },
    fallbacks: { valor: { total: Math.round(llamadas / 50), tasaPct: 2 } },
    costoPorModelo: {
      valor: [
        { proveedor: "openai", modelo: "openai/gpt-6-luna", llamadas: Math.round(llamadas * 0.2), fallbacks: 1, costoUsd: Math.round(totalUsd * 0.1 * 100) / 100, tokensEntrada: 52_000, tokensSalida: 14_000 },
        { proveedor: "deepinfra", modelo: "deepseek/deepseek-v4.1-flash", llamadas: Math.round(llamadas * 0.05), fallbacks: 0, costoUsd: Math.round(totalUsd * 0.02 * 100) / 100, tokensEntrada: 9_000, tokensSalida: 3_000 },
      ],
    },
    serie7d: { valor: serieFicha() },
  };
}
function fichaAgente(ficha: string) {
  if (ficha === "extractor") {
    return {
      ...fichaBase("extractor", "Agente extractor", ["licitaciones:requirement_extractor"], 50, 2.5),
      documentosExtraidos: { valor: { documentos: 6, requisitos: 41, licitaciones: 3 } },
      precision: { valor: null, codigo: "sin_verdad_de_terreno", razon: "Sin verdad de terreno todavía: no hay un conjunto de documentos etiquetados a mano contra el cual medir la precisión del extractor." },
      notas: ["La precisión del extractor no está medida: no existe un conjunto de documentos con verdad de terreno."],
    };
  }
  if (ficha === "conciliacion") {
    return {
      ...fichaBase("conciliacion", "Agente de conciliación", ["despachos:conciliacion_llm_agent"], 140, 2.2),
      movimientosConciliados: { valor: { total: 30, porMotor: 20, porLlmAprobado: 6, porManual: 4, sugerenciasPendientes: 2, sugerenciasTotal: 9 } },
    };
  }
  return {
    ...fichaBase("whatsapp", "Agente de WhatsApp y voz", ["hoteles:whatsapp_agent", "restaurantes:whatsapp_agent", "restaurantes:whatsapp_agent_escalated"], 2760, 31.2),
    gastado: { valor: { totalUsd: 35.1, llmUsd: 31.2, vozUsd: 3.9 } },
    conversaciones: { valor: 214 },
    minutosVoz: { valor: 318.5 },
    escalamiento: { valor: { escaladas: 160, total: 2760, tasaPct: 5.8 } },
    porVertical: {
      valor: [
        { vertical: "hoteles", llamadas: 920, costoLlmUsd: 9.8, escaladas: 160, conversaciones: { valor: 94 }, minutosVoz: { valor: 0 }, costoVozUsd: { valor: 0 } },
        { vertical: "restaurantes", llamadas: 1840, costoLlmUsd: 21.4, escaladas: 0, conversaciones: { valor: 120 }, minutosVoz: { valor: 318.5 }, costoVozUsd: { valor: 3.9 } },
        { vertical: "rentas", llamadas: 0, costoLlmUsd: 0, escaladas: 0, conversaciones: { valor: null, codigo: "sin_whatsapp", razon: "Sin fuente: esta vertical no guarda conversaciones de WhatsApp." }, minutosVoz: { valor: 0 }, costoVozUsd: { valor: 0 } },
      ],
    },
  };
}
function modelOps() {
  const escalera = (modelos: string[]) => modelos.map((modelo, i) => ({ orden: i + 1, modelo, razonamiento: "low", proveedores: i === 0 ? ["openai", "azure"] : ["deepinfra", "together"] }));
  const rol = (role: string, llamadas: number, costo: number, fallback: number | null) => ({
    role,
    vertical: role.slice(0, role.indexOf(":")),
    modelo: "openai/gpt-6-luna",
    proveedores: ["openai", "azure"],
    escalera: escalera(["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash"]),
    carril: llamadas > 0 ? { valor: ["interactive"] } : { valor: null },
    llamadas30d: { valor: llamadas },
    costo30dUsd: { valor: costo },
    tasaFallbackPct: fallback === null ? { valor: null, codigo: "sin_llamadas", razon: "Sin llamadas en el periodo: no hay base para calcular la tasa." } : { valor: fallback },
    circuitBreaker: { valor: null, codigo: "breaker_no_legible", razon: "No legible: el circuit breaker vive en memoria de cada instancia (o en Upstash) y este endpoint no lo consulta." },
  });
  return {
    disponible: true,
    generadoEn: "2026-09-30T18:00:00.000Z",
    hoy: HOY_CONSOLA,
    desde: "2026-09-01",
    fichas: [rol("despachos:conciliacion_llm_agent", 40, 0.6, 0), rol("hoteles:whatsapp_agent", 300, 3.1, 1.7), rol("restaurantes:whatsapp_agent", 610, 7.2, 2.1), rol("citas:data_chat", 0, 0, null)],
    porAgente: { valor: [{ role: "restaurantes:whatsapp_agent", costoUsd: 7.2 }, { role: "hoteles:whatsapp_agent", costoUsd: 3.1 }, { role: "despachos:conciliacion_llm_agent", costoUsd: 0.6 }] },
    porModelo: { valor: [{ modelo: "openai/gpt-6-luna", costoUsd: 8.9 }, { modelo: "deepseek/deepseek-v4.1-flash", costoUsd: 2 }] },
    notas: ["Esta pantalla no versiona prompts ni cambia modelos: el modelo de cada rol se cambia con LLM_MODELS_JSON (ver docs/LLM-GATEWAY.md) y se despliega como configuración."],
  };
}

const AGENTES_PANEL = [
  { id: "restaurantes:whatsapp_agent", nombre: "Agente de WhatsApp de restaurantes", vertical: "restaurantes", canal: "whatsapp", disparador: "Mensaje entrante de un comensal", estado: "vivo", modelo: "deepseek/deepseek-v4.1-flash", ultimaCorrida: { en: "2026-09-30T17:20:00.000Z", estado: "ok" }, exito30d: { corridas: 3, ok: 2, porcentaje: 66.7 }, costo30dUsd: 0.02, llamadas30d: 2, presupuestoDiaUsd: null, insumos: "fuera de alcance" },
  { id: "hoteles:whatsapp_agent", nombre: "Agente de WhatsApp de hoteles", vertical: "hoteles", canal: "whatsapp", disparador: "Mensaje entrante de un huesped", estado: "vivo", modelo: "deepseek/deepseek-v4.1-flash", ultimaCorrida: null, exito30d: { corridas: 0, ok: 0, porcentaje: null }, costo30dUsd: 0, llamadas30d: 0, presupuestoDiaUsd: 5, insumos: "fuera de alcance" },
];

const CORRIDAS_AGENTES = [
  { id: "run-1", agente: "restaurantes:whatsapp_agent", vertical: "restaurantes", organizationId: null, disparo: "whatsapp", estado: "ok", tareasHechas: null, tareasTotal: null, costoUsd: null, error: null, iniciadoEn: "2026-09-30T17:20:00.000Z", terminadoEn: "2026-09-30T17:20:02.000Z", duracionMs: 2000 },
  { id: "run-2", agente: "/internal/rentas/ical-sync", vertical: "rentas", organizationId: null, disparo: "cron", estado: "fallo", tareasHechas: null, tareasTotal: null, costoUsd: null, error: "timeout del proveedor de calendario", iniciadoEn: "2026-09-30T17:45:00.000Z", terminadoEn: "2026-09-30T17:45:01.000Z", duracionMs: 900 },
];


// Copiloto de plataforma (CHAT-17): misma forma que apps/api/src/routes/superadmin-copiloto.ts. Solo existe en la API simulada de e2e.
interface ConvCopilotoMock {
  id: string;
  titulo: string;
  actualizadaEn: string;
  mensajes: Array<Record<string, unknown>>;
}
const AGENTE_COPILOTO = "restaurantes:whatsapp_agent";
const PROPUESTA_COPILOTO = "bcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrst";
const TEXTO_ORGS_COPILOTO = "Hay 6 organizaciones, 5 activas.";
const BLOQUE_ORGS_COPILOTO = {
  tool: "organizaciones",
  title: "Organizaciones y personal",
  columns: [{ key: "organizacion", label: "Organización", kind: "text" }, { key: "vertical", label: "Vertical", kind: "text" }],
  rows: [{ organizacion: "Taqueria El Faro", vertical: "restaurantes" }, { organizacion: "Hotel Brisa", vertical: "hoteles" }],
  truncated: false,
};
const FUENTE_ORGS_COPILOTO = { tool: "organizaciones", source: "Organizaciones de la plataforma", scopeLabel: "Toda la plataforma" };
const TEXTO_PROPUESTA_COPILOTO = "Preparé la propuesta; confírmala en la tarjeta.";
const RESUMEN_PROPUESTA_COPILOTO = `Apagar el agente ${AGENTE_COPILOTO}: deja de llamar al modelo de IA en toda la plataforma hasta que alguien lo encienda. Se revierte desde Interruptores o desde el Copiloto.`;
const BLOQUE_PROPUESTA_COPILOTO = {
  tool: "proponer_accion",
  title: "Proponer una acción",
  columns: [{ key: "propuesta", label: "Propuesta", kind: "text" }],
  rows: [{ propuesta: PROPUESTA_COPILOTO, clase: "interruptor", tipo: "apagar_agente", objetivo: AGENTE_COPILOTO, resumen: RESUMEN_PROPUESTA_COPILOTO, vence: "2026-09-30T18:05:00.000Z", agente: AGENTE_COPILOTO }],
  truncated: false,
};
const convsCopiloto = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<ConvCopilotoMock[]>("sa.copiloto.conversaciones", () => []);

// Organizaciones / Clientes y Ficha 360 (SA-L-20 / SA-07): misma forma que apps/api/src/routes/superadmin-organizaciones-ficha.ts. Solo existe en la
// API simulada de e2e; en produccion sale de las funciones core.get_orgs_metricas_for_superadmin / get_org_ficha_for_superadmin.
const campoOrg = <T,>(valor: T) => ({ valor, razon: null });
const sinDatoOrg = (razon: string) => ({ valor: null, razon });
const razonSinFuenteOps = "Sin fuente: despachos no guarda un registro de operaciones (la conciliación bancaria no se persiste).";

function filasResumenOrg() {
  return organizaciones().map((o, i) => {
    const despachos = o.vertical === "despachos";
    return {
      id: o.id, nombre: o.name, slug: o.slug, vertical: o.vertical, estado: o.status, creadaEn: o.createdAt, staff: o.staffCount,
      plan: i % 2 === 0 ? campoOrg({ id: `plan-${o.vertical}`, nombre: `Plan ${o.vertical}` }) : sinDatoOrg("Sin plan asignado: no hay ingreso esperado contra el cual calcular el margen."),
      operaciones30d: despachos ? sinDatoOrg(razonSinFuenteOps) : campoOrg(40 + i * 7),
      costoIa30dUsd: campoOrg(Math.round((12 - i * 1.7) * 100) / 100),
      onboarding: despachos ? campoOrg({ hechos: 1, total: 4, noMedibles: 1 }) : campoOrg({ hechos: Math.min(6, 2 + i), total: 6, noMedibles: 0 }),
    };
  });
}

function fichaOrg(id: string) {
  const o = organizaciones().find((x) => x.id === id);
  if (!o) return null;
  const despachos = o.vertical === "despachos";
  return {
    disponible: true, mensaje: null, mes: "2026-09", ventanaDias: 30,
    organizacion: { id: o.id, nombre: o.name, slug: o.slug, vertical: o.vertical, estado: o.status, creadaEn: o.createdAt },
    uso: { operaciones30d: despachos ? sinDatoOrg(razonSinFuenteOps) : campoOrg(52), conversaciones30d: campoOrg(130), minutosVoz30d: campoOrg(8.5) },
    costo: { llm30dUsd: campoOrg(9.8), eventos30dUsd: campoOrg(1.2), costoPorEventoUsd: campoOrg(0.4) },
    membresias: { porRol: [{ rol: "owner / staff", cantidad: 1 }, { rol: "member / staff", cantidad: 3 }], ultimosAccesos: campoOrg([{ rol: "member", ultimoAcceso: "2026-09-30T16:00:00.000Z" }]) },
    errores: {
      outboxMuerto: campoOrg(0),
      denegaciones30d: { valor: 0, razon: null, ultimas: [] },
      crons: sinDatoOrg("Sin fuente por organización: los crons se miden para toda la plataforma (ver Salud operativa)."),
    },
    facturacion: { plan: { id: `plan-${o.vertical}`, nombre: `Plan ${o.vertical}` }, cobro: { estado: "activa", periodoHasta: "2026-10-30T00:00:00.000Z", asientos: 3 }, contrato: { contractId: "contrato-1", version: 1 } },
    onboarding: [
      { paso: "staff_invitado", titulo: "Staff invitado", estado: "hecho", razon: null, razonTexto: null },
      despachos
        ? { paso: "primera_operacion", titulo: "Primera operación real", estado: "no_se_pudo_medir", razon: "sin_fuente", razonTexto: "Sin fuente: despachos no guarda un registro de operaciones (la conciliación bancaria no se persiste)." }
        : { paso: "primera_operacion", titulo: "Primera operación real", estado: "hecho", razon: null, razonTexto: null },
      { paso: "plan_asignado", titulo: "Plan asignado", estado: "pendiente", razon: null, razonTexto: null },
    ],
  };
}

// Consumo de IA (SA-L-22) y Ejecutivo / Board (SA-L-24): misma forma que apps/api/src/routes/superadmin-llm-usage.ts (gasto-api/*) y
// superadmin-cfo.ts (cfo/dashboard). Solo existen en la API simulada de e2e.
const RANGO_GASTO = { from: "2026-09-01", to: HOY_CONSOLA };
function consumoIa() {
  const cero = { costMicroUsd: 0, callCount: 0, fallbackCallCount: 0 };
  return {
    hoy: HOY_CONSOLA,
    desde: "2026-09-01",
    disponible: true,
    roles: [
      { role: "restaurantes:data_chat", grupo: "restaurantes", hoy: { costMicroUsd: 4200, callCount: 12, fallbackCallCount: 3 }, ventana: { costMicroUsd: 61000, callCount: 150, fallbackCallCount: 30 }, techoTurnosDia: 400, maxTurnosOrganizacionHoy: 12, pctTecho: 3 },
      { role: "restaurantes:whatsapp_agent", grupo: "restaurantes", hoy: { costMicroUsd: 1900, callCount: 8, fallbackCallCount: 0 }, ventana: { costMicroUsd: 72000, callCount: 610, fallbackCallCount: 4 }, techoTurnosDia: null, maxTurnosOrganizacionHoy: 8, pctTecho: null },
      { role: "hoteles:whatsapp_agent", grupo: "hoteles", hoy: cero, ventana: { costMicroUsd: 31000, callCount: 300, fallbackCallCount: 1 }, techoTurnosDia: null, maxTurnosOrganizacionHoy: 0, pctTecho: null },
    ],
    insights: [
      { codigo: "rol_con_fallbacks", severidad: "atencion", titulo: "El rol restaurantes:data_chat cae a su modelo de respaldo 20 % de las veces", detalle: "30 de 150 llamadas usaron respaldo en la ventana (umbral 10 %).", role: "restaurantes:data_chat" },
      { codigo: "rol_sin_techo", severidad: "info", titulo: "El rol restaurantes:whatsapp_agent no tiene techo diario", detalle: "610 llamadas y US$0.0720 en la ventana sin un tope de turnos por día; solo lo acotan el presupuesto del gateway y el tope mensual.", role: "restaurantes:whatsapp_agent" },
    ],
  };
}

function gastoApiOrganizaciones() {
  return VERTICALES.map((v, i) => {
    const org = orgDe(v);
    return { organizationId: org.id, organizationName: org.nombre, organizationSlug: org.slug, vertical: v, tokensIn: 1200 * (i + 1), tokensOut: 400 * (i + 1), costMicroUsd: 1_500_000 * (i + 1), callCount: 40 * (i + 1), monthlyCapMicroUsd: 100_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 1_500_000 * (i + 1), pctTopeUsado: 1.5 * (i + 1) };
  });
}

function dashboardCfo() {
  return {
    disponible: true,
    mes: "2026-09",
    tipoCambio: null,
    supuestos: ["El MRR suma solo organizaciones con plan y precio conocidos."],
    dashboard: {
      mes: "2026-09",
      ingresos: { mrrMxn: 48_900, arrMxn: 586_800, clientesConIngreso: 4, clientesSinPrecio: 2, porVertical: VERTICALES.map((v) => ({ vertical: v, mrrMxn: v === "restaurantes" ? 12_000 : 0, clientes: v === "restaurantes" ? 1 : 0, sinPrecio: 0 })), topClientes: [], concentracionTopPct: null },
      nrr: { disponible: false, razon: "sin_foto_previa" },
      margen: { disponible: false, razon: "sin_tipo_de_cambio" },
      caja: { disponible: false, razon: "Todavía no hay una fuente de caja." },
      cobranza: { pagoPendiente: 0, mrrEnRiesgoMxn: null },
      alertas: [],
    },
  };
}

export const rutasSuperadmin: readonly Ruta[] = [
  { metodo: "GET", patron: "/superadmin/copiloto/estado", manejador: () => ({ disponible: true, permitido: true, motivo: null, rol: "superadmin", financierasDisponibles: true, stepUpRequerido: false, interruptor: { apagado: false, clave: null }, gastoMes: { usadoMicroUsd: 1000000, topeMicroUsd: 25000000, usoPct: 4, medidoEnBitacora: true }, acciones: { propone: true }, fijados: true, adjuntos: true, herramientas: [] }) },
  { metodo: "GET", patron: "/superadmin/copiloto/pins", manejador: () => ({ disponible: true, pins: [] }) },
  { metodo: "POST", patron: "/superadmin/copiloto/pins", manejador: () => conStatus(201, { id: "00000000-0000-4000-8000-0000000000f1" }) },
  {
    metodo: "POST",
    patron: "/superadmin/copiloto/adjuntos",
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { nombre?: string };
      return {
        status: "ok",
        text: `«${String(cuerpo.nombre ?? "archivo")}» tiene 2 filas de datos y 2 columnas (1 numérica, 1 de texto).`,
        blocks: [{ kind: "table", tool: "archivo_adjunto", title: "Perfil del archivo", columns: [{ key: "columna", label: "Columna", kind: "text" }, { key: "tipo", label: "Tipo", kind: "text" }], rows: [{ columna: "unidades", tipo: "numérica" }, { columna: "producto", tipo: "texto" }], truncated: false }],
        sources: [{ tool: "archivo_adjunto", source: "Archivo adjunto analizado en el servidor del Copiloto (no se guarda)", scopeLabel: "Solo este archivo" }],
        toolsUsed: ["archivo_adjunto"],
      };
    },
  },
  {
    metodo: "POST",
    patron: "/superadmin/copiloto",
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { question?: string; label?: string; conversationId?: string };
      const pregunta = String(cuerpo.question ?? cuerpo.label ?? "");
      const lista = convsCopiloto(p);
      let conv = lista.find((c) => c.id === cuerpo.conversationId);
      if (!conv) {
        conv = { id: `00000000-0000-4000-8000-${String(lista.length + 1).padStart(12, "0")}`, titulo: pregunta.slice(0, 60), actualizadaEn: new Date().toISOString(), mensajes: [] };
        lista.unshift(conv);
      }
      const propone = /apaga/i.test(pregunta);
      const tool = propone ? "proponer_accion" : "organizaciones";
      const texto = propone ? TEXTO_PROPUESTA_COPILOTO : TEXTO_ORGS_COPILOTO;
      const blocks = propone ? [BLOQUE_PROPUESTA_COPILOTO] : [BLOQUE_ORGS_COPILOTO];
      const sources = propone ? [] : [FUENTE_ORGS_COPILOTO];
      const seq = conv.mensajes.length + 2;
      conv.mensajes.push({ id: `m-${seq - 1}`, role: "user", text: pregunta, seq: seq - 1 });
      conv.mensajes.push({ id: `m-${seq}`, role: "assistant", text: texto, status: "ok", blocks, sources, seq });
      conv.actualizadaEn = new Date().toISOString();
      return ndjson([
        { t: "paso", fase: "inicio", herramienta: tool },
        { t: "paso", fase: "fin", herramienta: tool },
        { t: "fin", conversacionId: conv.id, seq, respuesta: { status: "ok", text: texto, blocks, sources, toolsUsed: [tool] } },
      ]);
    },
  },
  { metodo: "GET", patron: "/superadmin/copiloto/conversaciones", manejador: (p) => ({ disponible: true, conversaciones: convsCopiloto(p).map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn, mensajes: c.mensajes.length })) }) },
  { metodo: "GET", patron: "/superadmin/copiloto/conversaciones/:cid", manejador: (p) => convsCopiloto(p).find((c) => c.id === p.params["cid"]) ?? fallo(404, "Conversación no encontrada.") },
  {
    metodo: "PATCH",
    patron: "/superadmin/copiloto/conversaciones/:cid",
    manejador: (p) => {
      const c = convsCopiloto(p).find((x) => x.id === p.params["cid"]);
      if (!c) return fallo(404, "Conversación no encontrada.");
      c.titulo = String(((p.cuerpo ?? {}) as { titulo?: string }).titulo ?? c.titulo);
      return { id: c.id, titulo: c.titulo };
    },
  },
  {
    metodo: "DELETE",
    patron: "/superadmin/copiloto/conversaciones/:cid",
    manejador: (p) => {
      const lista = convsCopiloto(p);
      const i = lista.findIndex((x) => x.id === p.params["cid"]);
      if (i < 0) return fallo(404, "Conversación no encontrada.");
      lista.splice(i, 1);
      return conStatus(204, undefined);
    },
  },
  {
    metodo: "GET",
    patron: "/superadmin/copiloto/acciones/:propuesta",
    manejador: (p) => {
      const ejecutada = p.estado.obtener("sa.copiloto.accion.ejecutada", () => ({ valor: false }));
      return { propuesta: p.params["propuesta"], clase: "interruptor", tipo: "apagar_agente", resumen: RESUMEN_PROPUESTA_COPILOTO, estado: ejecutada.valor ? "ejecutada" : "pendiente", venceEn: "2026-09-30T18:05:00.000Z", agente: AGENTE_COPILOTO, bloquear: true };
    },
  },
  {
    metodo: "POST",
    patron: "/superadmin/copiloto/acciones/confirmar",
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { propuesta?: string; agente?: string; motivo?: string };
      if (cuerpo.propuesta !== PROPUESTA_COPILOTO || cuerpo.agente !== AGENTE_COPILOTO) return fallo(404, "No encontré esa propuesta.");
      if (String(cuerpo.motivo ?? "").trim().length < 20) return fallo(400, "motivo obligatorio (mínimo 20 caracteres).");
      const ejecutada = p.estado.obtener("sa.copiloto.accion.ejecutada", () => ({ valor: false }));
      if (ejecutada.valor) return fallo(409, "Esta propuesta ya se usó.");
      ejecutada.valor = true;
      return { estado: "ejecutada", interruptor: { scope: "agente", target: AGENTE_COPILOTO, bloqueado: true, motivo: cuerpo.motivo, actualizadoPor: "mock", actualizadoEnMs: 1 } };
    },
  },
  { metodo: "GET", patron: "/superadmin/impersonacion/activa", manejador: () => ({ available: true, session: null }) },
  // Parte diario (/superadmin/parte-diario): sin resumenes generados todavia; la pagina pinta su vacio honesto.
  { metodo: "GET", patron: "/superadmin/resumen", manejador: () => ({ disponible: true, resumenes: [] }) },
  { metodo: "GET", patron: "/superadmin/consola/resumen", manejador: () => resumenConsola() },
  { metodo: "GET", patron: "/superadmin/gasto-api/consumo-ia", manejador: () => consumoIa() },
  { metodo: "GET", patron: "/superadmin/gasto-api/resumen", manejador: () => ({ range: RANGO_GASTO, usage: { tokensIn: 21_000, tokensOut: 7_000, costMicroUsd: 31_500_000, callCount: 840, fallbackCallCount: 38 }, platformBudget: { monthlyCapMicroUsd: 1_000_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 31_500_000 } }) },
  { metodo: "GET", patron: "/superadmin/gasto-api/organizaciones", manejador: () => ({ range: RANGO_GASTO, organizaciones: gastoApiOrganizaciones() }) },
  { metodo: "GET", patron: "/superadmin/gasto-api/desglose", manejador: () => ({ range: RANGO_GASTO, desglose: [{ vertical: "restaurantes", providerId: "openrouter:deepseek", model: "deepseek/deepseek-v4.1-flash", tokensIn: 12_000, tokensOut: 4_000, costMicroUsd: 9_000_000, callCount: 500 }] }) },
  { metodo: "GET", patron: "/superadmin/gasto-api/por-rol", manejador: () => ({ range: RANGO_GASTO, disponible: true, filas: [] }) },
  { metodo: "GET", patron: "/superadmin/cfo/dashboard", manejador: () => dashboardCfo() },
  { metodo: "GET", patron: "/superadmin/consola/agentes-actividad", manejador: () => agentesConsola() },
  { metodo: "GET", patron: "/superadmin/organizations", manejador: () => ({ organizations: organizaciones() }) },
  { metodo: "GET", patron: "/superadmin/organizaciones/resumen", manejador: () => ({ disponible: true, mensaje: null, ventanaDias: 30, organizaciones: filasResumenOrg() }) },
  { metodo: "GET", patron: "/superadmin/organizaciones/margen", manejador: () => ({
      disponible: true, mes: "2026-09", mensaje: null,
      margenes: Object.fromEntries(organizaciones().map((o, i) => [o.id, i % 2 === 0 ? campoOrg({ mxn: 1498 - i * 100, pct: 93.7 - i, ingresoMxn: 1598 }) : sinDatoOrg("Sin plan asignado: no hay ingreso esperado contra el cual calcular el margen.")])),
    }) },
  { metodo: "GET", patron: "/superadmin/organizaciones/acciones", manejador: () => ({ disponible: true, acciones: [] }) },
  { metodo: "GET", patron: "/superadmin/organizaciones/:id/ficha", manejador: (p) => fichaOrg(String(p.params["id"])) ?? fallo(404, "Organización no encontrada.") },
  { metodo: "GET", patron: "/superadmin/prospectos", manejador: (p) => ({ prospectos: p.estado.obtener("sa.prospectos", () => structuredClone(PROSPECTOS)) }) },
  // Cerebro de ventas (SA-L-37/38/41/42/43): lista con ubicacion, scores y supresion, detalle y rastro de exportaciones (fixtures/cerebro.ts).
  ...rutasCerebro,
  { metodo: "GET", patron: "/superadmin/cerebro/taxonomia", manejador: () => ({
      disponible: true,
      verticales: ["restaurantes"],
      versiones: [{
        vertical: "restaurantes", version: 1, vigente: true, estadoValidacion: "propuesta", planNombre: null,
        precio: { estado: "por_definir", texto: "Precio por definir" },
        subtipos: [{ clave: "taqueria", nombre: "Taquería" }],
        rangosTamano: { unidad: "empleados", rangos: [{ clave: "1_5", etiqueta: "1 a 5" }] },
        senales: [{ tipo: "sin_menu_en_linea", nombre: "Sin menú en línea", dimension: "ajuste", puntos: 30, comoConseguirla: "Revisar su sitio web." }],
        icp: { descripcion: "Restaurantes independientes.", subtiposObjetivo: ["taqueria"], tamanosObjetivo: ["1_5"] },
        objeciones: [{ objecion: "Ya uso WhatsApp", respuesta: "Se integra con el que ya tienes." }],
        mensajesBase: [{ canal: "correo", variante: "A", texto: "Hola, platiquemos de tus pedidos." }],
      }],
    }) },
  { metodo: "POST", patron: "/superadmin/prospectos", manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as Partial<Prospecto>;
      if (!cuerpo.empresa) return fallo(400, "La empresa es requerida");
      const lista = p.estado.obtener("sa.prospectos", () => structuredClone(PROSPECTOS));
      const nuevo: Prospecto = { id: `prs-${lista.length + 1}`, empresa: cuerpo.empresa, vertical: cuerpo.vertical ?? "restaurantes", ciudad: cuerpo.ciudad ?? null, contactoNombre: cuerpo.contactoNombre ?? null, telefono: cuerpo.telefono ?? null, correo: cuerpo.correo ?? null, estado: "nuevo", fuente: cuerpo.fuente ?? null, notas: cuerpo.notas ?? null, createdAt: "2026-09-30T16:00:00.000Z", updatedAt: "2026-09-30T16:00:00.000Z" };
      lista.push(nuevo);
      return { prospecto: nuevo };
    } },
  { metodo: "GET", patron: "/superadmin/agentes", manejador: (p) => {
      const sw = p.estado.obtener("sa.interruptores", () => [] as Array<Record<string, unknown>>);
      return {
        disponible: true,
        generadoEn: "2026-09-30T18:00:00.000Z",
        hoy: HOY_CONSOLA,
        interruptoresDisponible: true,
        agentes: AGENTES_PANEL.map((a) => {
          const fila = sw.find((x) => x.scope === "agente" && x.target === a.id);
          return { ...a, interruptor: fila ? { bloqueado: fila.bloqueado === true, motivo: fila.motivo ?? null, actualizadoEnMs: fila.actualizadoEnMs ?? null } : { bloqueado: false, motivo: null, actualizadoEnMs: null } };
        }),
        notas: [],
      };
    } },
  { metodo: "GET", patron: "/superadmin/agentes/corridas", manejador: () => ({ disponible: true, corridas: CORRIDAS_AGENTES }) },
  { metodo: "GET", patron: "/superadmin/agentes/:ficha", manejador: (p) => {
      const ficha = p.params["ficha"] ?? "";
      return ["extractor", "conciliacion", "whatsapp"].includes(ficha) ? fichaAgente(ficha) : fallo(404, "Ficha de agente no encontrada.");
    } },
  { metodo: "GET", patron: "/superadmin/model-ops", manejador: () => modelOps() },
  { metodo: "GET", patron: "/superadmin/interruptores", manejador: (p) => ({
      disponible: true,
      catalogo: { globales: ["llm", "crons"], agentes: ["restaurantes-whatsapp", "citas-whatsapp"], crons: ["recordatorios-citas", "sync-ical-rentas"] },
      interruptores: p.estado.obtener("sa.interruptores", () => [] as unknown[]),
    }) },
  { metodo: "PUT", patron: "/superadmin/interruptores", manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { scope?: string; target?: string; bloqueado?: boolean; motivo?: string };
      if (!c.scope || !c.target || (c.motivo ?? "").length < 20) return fallo(400, "Datos invalidos");
      const lista = p.estado.obtener("sa.interruptores", () => [] as Array<Record<string, unknown>>);
      const i = lista.findIndex((x) => x.scope === c.scope && x.target === c.target);
      const fila = { scope: c.scope, target: c.target, bloqueado: c.bloqueado === true, motivo: c.motivo, actualizadoPor: "superadmin@example.test", actualizadoEnMs: Date.now() };
      if (i >= 0) lista[i] = fila;
      else lista.push(fila);
      return { ok: true };
    } },
];
