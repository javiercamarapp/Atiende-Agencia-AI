// Fixtures del back office de plataforma (/superadmin/*). Solo la persona `plataforma-superadmin` ve estas rutas.
import { fallo } from "../respuestas.ts";
import { orgDe } from "../personas.ts";
import type { Ruta, Vertical } from "../tipos.ts";

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

export const rutasSuperadmin: readonly Ruta[] = [
  { metodo: "GET", patron: "/superadmin/consola/resumen", manejador: () => resumenConsola() },
  { metodo: "GET", patron: "/superadmin/consola/agentes-actividad", manejador: () => agentesConsola() },
  { metodo: "GET", patron: "/superadmin/organizations", manejador: () => ({ organizations: organizaciones() }) },
  { metodo: "GET", patron: "/superadmin/prospectos", manejador: (p) => ({ prospectos: p.estado.obtener("sa.prospectos", () => structuredClone(PROSPECTOS)) }) },
  { metodo: "POST", patron: "/superadmin/prospectos", manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as Partial<Prospecto>;
      if (!cuerpo.empresa) return fallo(400, "La empresa es requerida");
      const lista = p.estado.obtener("sa.prospectos", () => structuredClone(PROSPECTOS));
      const nuevo: Prospecto = { id: `prs-${lista.length + 1}`, empresa: cuerpo.empresa, vertical: cuerpo.vertical ?? "restaurantes", ciudad: cuerpo.ciudad ?? null, contactoNombre: cuerpo.contactoNombre ?? null, telefono: cuerpo.telefono ?? null, correo: cuerpo.correo ?? null, estado: "nuevo", fuente: cuerpo.fuente ?? null, notas: cuerpo.notas ?? null, createdAt: "2026-09-30T16:00:00.000Z", updatedAt: "2026-09-30T16:00:00.000Z" };
      lista.push(nuevo);
      return { prospecto: nuevo };
    } },
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
