// Fixtures de despachos contables (Despacho Medina y Asociados). Forma = apps/web/src/verticals/despachos/lib/*-client.ts.
import { conStatus, fallo, ndjson } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";
import { consumirStepUp } from "./step-up.ts";

const PROP = propiedadDe("despachos");
const ORG = orgDe("despachos");
const D = "/despachos/:id";

interface Periodo {
  id: string;
  organizationId: string;
  propertyId: string;
  year: number;
  month: number;
  status: "open" | "closed" | "overdue";
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
}

interface Tarea {
  id: string;
  periodId: string;
  title: string;
  description: string;
  category: string;
  status: string;
  dependsOn: string[];
  dueDate: string | null;
  autoCheckQuery: string | null;
  required: boolean;
  completedAt: string | null;
  completedBy: string | null;
}

function periodosSemilla(): Periodo[] {
  return [{ id: "per-2026-09", organizationId: ORG.id, propertyId: PROP.id, year: 2026, month: 9, status: "open", openedAt: "2026-09-01T15:00:00.000Z", closedAt: null, closedBy: null }];
}

function tareasSemilla(): Tarea[] {
  const t = (id: string, title: string, category: string, status: string): Tarea => ({ id, periodId: "per-2026-09", title, description: `${title} del periodo`, category, status, dependsOn: [], dueDate: "2026-10-10", autoCheckQuery: null, required: true, completedAt: status === "done" ? "2026-09-28T15:00:00.000Z" : null, completedBy: null });
  return [t("tar-1", "Conciliar bancos de septiembre", "bank", "done"), t("tar-2", "Presentar declaracion mensual de IVA", "declaracion", "pending")];
}

function estadoDe(tareas: Tarea[]) {
  const done = tareas.filter((t) => t.status === "done").length;
  return { totalTasks: tareas.length, done, skipped: 0, pending: tareas.length - done, inProgress: 0, progressPercent: Math.round((done / tareas.length) * 100), blocked: [], overdue: [] };
}

// CHAT-11 -- Copiloto ("Pregunta a tus datos"): respuesta fija en el formato REAL del servidor (NDJSON paso/fin con conversacionId y
// seq; conversaciones guardadas por escenario). En el servidor real lo usan admin, contador, auditor y readonly; en e2e la persona "admin" es el unico rol con acceso.
// Solo existe en la API simulada de e2e.
interface ConversacionMock {
  id: string;
  titulo: string;
  actualizadaEn: string;
  mensajes: { id: string; role: "user" | "assistant"; text: string; status?: string; blocks?: unknown[]; sources?: unknown[]; seq: number }[];
}
const MOCK_ROLES_COPILOTO = ["admin"] as const;
const BLOQUE_CARTERA = {
  kind: "table",
  tool: "cartera_por_cliente",
  title: "Cartera por cliente",
  columns: [
    { key: "cliente", label: "Cliente", kind: "text" },
    { key: "cuentas", label: "Cuentas pendientes", kind: "integer" },
    { key: "pendiente", label: "Monto pendiente", kind: "mxn" },
    { key: "vencidas", label: "Cuentas vencidas", kind: "integer" },
    { key: "vencido", label: "Monto vencido", kind: "mxn" },
  ],
  rows: [
    { cliente: "Abarrotes del Sureste SA de CV", cuentas: 5, pendiente: 84000, vencido: 31000, vencidas: 2 },
    { cliente: "Comercial Peninsular SA de CV", cuentas: 3, pendiente: 36000, vencido: 14000, vencidas: 1 },
  ],
  chart: { kind: "bar", x: "cliente", y: "pendiente" },
  truncated: false,
};
const TEXTO_CARTERA = "Tus clientes te deben $120,000 MXN; $45,000 MXN ya están vencidos.";
const FUENTE_CARTERA = { tool: "cartera_por_cliente", source: "Cuentas por cobrar de CFDI en seguimiento de cobranza, sin pagar", periodLabel: "a hoy", scopeLabel: "todos tus clientes" };
const conversacionesMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<ConversacionMock[]>("desp.copiloto.conversaciones", () => []);

export const rutasDespachos: readonly Ruta[] = [
  { metodo: "GET", patron: `${D}/chat-datos/pins`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ disponible: true, pins: [] }) },
  { metodo: "GET", patron: `${D}/chat-datos/estado`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }) },
  {
    metodo: "POST",
    patron: `${D}/chat-datos`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { question?: string; label?: string; conversationId?: string };
      const pregunta = String(cuerpo.question ?? cuerpo.label ?? "");
      const lista = conversacionesMock(p);
      let conv = lista.find((c) => c.id === cuerpo.conversationId);
      if (!conv) {
        conv = { id: `00000000-0000-4000-8000-${String(lista.length + 1).padStart(12, "0")}`, titulo: pregunta.slice(0, 60), actualizadaEn: new Date().toISOString(), mensajes: [] };
        lista.unshift(conv);
      }
      const seq = conv.mensajes.length + 2;
      conv.mensajes.push({ id: `m-${seq - 1}`, role: "user", text: pregunta, seq: seq - 1 });
      conv.mensajes.push({ id: `m-${seq}`, role: "assistant", text: TEXTO_CARTERA, status: "ok", blocks: [BLOQUE_CARTERA], sources: [FUENTE_CARTERA], seq });
      conv.actualizadaEn = new Date().toISOString();
      return ndjson([
        { t: "paso", fase: "inicio", herramienta: "cartera_por_cliente" },
        { t: "paso", fase: "fin", herramienta: "cartera_por_cliente" },
        { t: "fin", conversacionId: conv.id, seq, respuesta: { status: "ok", text: TEXTO_CARTERA, blocks: [BLOQUE_CARTERA], sources: [FUENTE_CARTERA], toolsUsed: ["cartera_por_cliente"] } },
      ]);
    },
  },
  { metodo: "GET", patron: `${D}/chat-datos/conversaciones`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => ({ disponible: true, conversaciones: conversacionesMock(p).map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn, mensajes: c.mensajes.length })) }) },
  { metodo: "GET", patron: `${D}/chat-datos/conversaciones/:cid`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => conversacionesMock(p).find((c) => c.id === p.params["cid"]) ?? fallo(404, "Conversación no encontrada.") },
  {
    metodo: "PATCH",
    patron: `${D}/chat-datos/conversaciones/:cid`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const c = conversacionesMock(p).find((x) => x.id === p.params["cid"]);
      if (!c) return fallo(404, "Conversación no encontrada.");
      c.titulo = String(((p.cuerpo ?? {}) as { titulo?: string }).titulo ?? c.titulo);
      return { id: c.id, titulo: c.titulo };
    },
  },
  {
    metodo: "DELETE",
    patron: `${D}/chat-datos/conversaciones/:cid`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const lista = conversacionesMock(p);
      const i = lista.findIndex((x) => x.id === p.params["cid"]);
      if (i < 0) return fallo(404, "Conversación no encontrada.");
      lista.splice(i, 1);
      return conStatus(204, undefined);
    },
  },
  // UNI-RES-despachos: consolidado del Resumen (forma de `DashboardDespacho`). Solo existe en la API simulada de e2e.
  { metodo: "GET", patron: "/v1/despachos/:org/dashboard", manejador: () => {
      const cliente = {
        propertyId: PROP.id,
        nombre: PROP.nombre,
        hoy: "2026-09-30",
        fuentesNoDisponibles: [],
        cartera: { cuentasPendientes: 3, montoPendiente: 48200, cuentasVencidas: 1, montoVencido: 12800, cuentas90Mas: 0, monto90Mas: 0, porAntiguedad: { "0-30": { count: 2, monto: 35400 }, "31-60": { count: 1, monto: 12800 }, "61-90": { count: 0, monto: 0 }, "90+": { count: 0, monto: 0 } }, scorePromedio: 0.6, cuentasSinCorreo: 0, cuentasSinMonto: 0, cuentasCobradas: 2, montoCobrado: 21000, tasaCobranzaPct: 30.3 },
        cargaTrabajo: { revisionesPendientes: 1, revisionesAntiguas: 0, vencimientosAbiertos: 2, vencimientosVencidos: 0, vencimientosProximos: 1, tareasCierrePendientes: 1, tareasCierreVencidas: 0, totalPendientes: 4 },
        cierres: { periodosSinCerrar: 1, periodosVencidos: 0, mesAnterior: { year: 2026, month: 8, estado: "cerrado" }, periodoReciente: null },
        cfdiMes: { periodo: "2026-09", total: 12, invalidos: 0, requierenRevision: 1 },
        anomalias: [],
        nivelAtencion: "atencion",
      };
      return {
        organizacion: { slug: ORG.slug, nombre: ORG.nombre },
        totalClientesVisibles: 1,
        truncado: false,
        totalClientes: 1,
        clientesPorNivel: { critico: 0, atencion: 1, al_corriente: 0, sin_datos: 0 },
        cartera: { cuentasPendientes: 3, montoPendiente: 48200, montoVencido: 12800, monto90Mas: 0, montoCobrado: 21000, tasaCobranzaPct: 30.3, clientesConDato: 1 },
        cargaTrabajo: { revisionesPendientes: 1, vencimientosAbiertos: 2, vencimientosVencidos: 0, tareasCierrePendientes: 1, totalPendientes: 4 },
        cierres: { periodosSinCerrar: 1, periodosVencidos: 0, clientesMesAnteriorSinCerrar: 0 },
        anomaliasPorSeveridad: { alta: 0, media: 0, baja: 0 },
        fuentesNoDisponibles: [],
        ranking: [cliente],
      };
    } },
  { metodo: "GET", patron: "/v1/despachos/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre }] }) },
  { metodo: "GET", patron: `${D}/cierre-mensual/periodos`, manejador: (p) => ({ periodos: p.estado.obtener("desp.periodos", periodosSemilla) }) },
  { metodo: "GET", patron: `${D}/cierre-mensual/periodos/:pid`, manejador: (p) => {
      const periodo = p.estado.obtener("desp.periodos", periodosSemilla).find((x) => x.id === p.params.pid);
      if (!periodo) return fallo(404, "Ese periodo no existe");
      const tareas = p.estado.obtener("desp.tareas", tareasSemilla);
      return { periodo, tareas, estado: estadoDe(tareas) };
    } },
  { metodo: "POST", patron: `${D}/cierre-mensual/periodos/:pid/cerrar`, roles: ["admin"], manejador: (p) => {
      const periodo = p.estado.obtener("desp.periodos", periodosSemilla).find((x) => x.id === p.params.pid);
      if (!periodo) return fallo(404, "Ese periodo no existe");
      // D-30: el servidor real exige el segundo factor reciente (x-step-up-token) ademas del rol; el mock tambien.
      { const sinStepUp = consumirStepUp(p); if (sinStepUp) return fallo(403, sinStepUp); }
      const esperado = `${periodo.year}-${String(periodo.month).padStart(2, "0")}`;
      // El servidor real exige el mismo texto que la UI: aqui tambien, para que la prueba no pueda "saltarse" el candado.
      if (((p.cuerpo ?? {}) as { confirmacion?: string }).confirmacion !== esperado) return fallo(400, `Escribe exactamente ${esperado}`);
      periodo.status = "closed";
      periodo.closedAt = "2026-10-01T15:00:00.000Z";
      return periodo;
    } },
];

export const despachos = { orgSlug: ORG.slug, propertyId: PROP.id, periodoId: "per-2026-09" };
