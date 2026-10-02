// Fixtures de hoteles (Hotel Casa Azul). Forma = apps/web/src/verticals/hoteles/lib/*-client.ts.
import { conStatus, fallo, ndjson } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("hoteles");
const ORG = orgDe("hoteles");
const H = "/hoteles/:id";

function ticketsSemilla() {
  const ahora = Date.now();
  return [
    { id: "tkt-1", habitacion: "204", resenaId: null, departamento: "housekeeping", prioridad: "media", estado: "abierto", canal: "recepcion", mensaje: "Faltan toallas en la habitacion 204", slaMinutos: 60, slaVenceEn: new Date(ahora + 40 * 60_000).toISOString(), estadoSla: "en_tiempo", minutosParaVencer: 40, asignadoA: null, escaladoEn: null, escaladoARoles: [], notaResolucion: null, creadoEn: new Date(ahora - 20 * 60_000).toISOString() },
    { id: "tkt-2", habitacion: "112", resenaId: null, departamento: "maintenance", prioridad: "alta", estado: "en_progreso", canal: "huesped", mensaje: "El aire acondicionado de la 112 no enfria", slaMinutos: 120, slaVenceEn: new Date(ahora + 15 * 60_000).toISOString(), estadoSla: "por_vencer", minutosParaVencer: 15, asignadoA: "Equipo de mantenimiento", escaladoEn: null, escaladoARoles: [], notaResolucion: null, creadoEn: new Date(ahora - 105 * 60_000).toISOString() },
  ];
}

type Ticket = ReturnType<typeof ticketsSemilla>[number];

const ESTADO_POR_ACCION: Record<string, string> = { iniciar: "en_progreso", cerrar: "cerrado", cancelar: "cancelado", escalar: "escalado" };

// CHAT-09 -- Copiloto ("Pregunta a tus datos"): respuesta fija en el formato REAL del servidor (NDJSON paso/fin con conversacionId y
// seq; conversaciones guardadas por escenario). Solo owner/gm lo usan en el servidor real; en e2e la persona "owner" es el unico rol con acceso.
// Solo existe en la API simulada de e2e.
interface ConversacionMock {
  id: string;
  titulo: string;
  actualizadaEn: string;
  mensajes: { id: string; role: "user" | "assistant"; text: string; status?: string; blocks?: unknown[]; sources?: unknown[]; seq: number }[];
}
const MOCK_ROLES_COPILOTO = ["owner"] as const;
const BLOQUE_OCUPACION = {
  kind: "table",
  tool: "ocupacion_adr_revpar",
  title: "Ocupación, ADR y RevPAR",
  columns: [
    { key: "periodo", label: "Día", kind: "text" },
    { key: "ocupacion", label: "Ocupación", kind: "percent" },
    { key: "adr", label: "ADR", kind: "mxn" },
  ],
  rows: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((periodo, i) => ({ periodo, ocupacion: 58 + i * 5, adr: 1450 + i * 40 })),
  chart: { kind: "line", x: "periodo", y: "ocupacion" },
  truncated: false,
};
const TEXTO_OCUPACION = "Esta semana tu ocupación fue 73% (255 de 350 noches); ADR $1,570 MXN.";
const FUENTE_OCUPACION = { tool: "ocupacion_adr_revpar", source: "Cargos de hospedaje del folio e inventario por día", periodLabel: "esta semana (lunes a hoy)", scopeLabel: "todos tus hoteles" };
const conversacionesMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<ConversacionMock[]>("hoteles.copiloto.conversaciones", () => []);

export const rutasHoteles: readonly Ruta[] = [
  { metodo: "GET", patron: `${H}/chat-datos/estado`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }) },
  {
    metodo: "POST",
    patron: `${H}/chat-datos`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { question?: string; conversationId?: string };
      const pregunta = String(cuerpo.question ?? "");
      const lista = conversacionesMock(p);
      let conv = lista.find((c) => c.id === cuerpo.conversationId);
      if (!conv) {
        conv = { id: `00000000-0000-4000-8000-${String(lista.length + 1).padStart(12, "0")}`, titulo: pregunta.slice(0, 60), actualizadaEn: new Date().toISOString(), mensajes: [] };
        lista.unshift(conv);
      }
      const seq = conv.mensajes.length + 2;
      conv.mensajes.push({ id: `m-${seq - 1}`, role: "user", text: pregunta, seq: seq - 1 });
      conv.mensajes.push({ id: `m-${seq}`, role: "assistant", text: TEXTO_OCUPACION, status: "ok", blocks: [BLOQUE_OCUPACION], sources: [FUENTE_OCUPACION], seq });
      conv.actualizadaEn = new Date().toISOString();
      return ndjson([
        { t: "paso", fase: "inicio", herramienta: "ocupacion_adr_revpar" },
        { t: "paso", fase: "fin", herramienta: "ocupacion_adr_revpar" },
        { t: "fin", conversacionId: conv.id, seq, respuesta: { status: "ok", text: TEXTO_OCUPACION, blocks: [BLOQUE_OCUPACION], sources: [FUENTE_OCUPACION], toolsUsed: ["ocupacion_adr_revpar"] } },
      ]);
    },
  },
  { metodo: "GET", patron: `${H}/chat-datos/conversaciones`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => ({ disponible: true, conversaciones: conversacionesMock(p).map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn, mensajes: c.mensajes.length })) }) },
  { metodo: "GET", patron: `${H}/chat-datos/conversaciones/:cid`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => conversacionesMock(p).find((c) => c.id === p.params["cid"]) ?? fallo(404, "Conversación no encontrada.") },
  {
    metodo: "PATCH",
    patron: `${H}/chat-datos/conversaciones/:cid`,
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
    patron: `${H}/chat-datos/conversaciones/:cid`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const lista = conversacionesMock(p);
      const i = lista.findIndex((x) => x.id === p.params["cid"]);
      if (i < 0) return fallo(404, "Conversación no encontrada.");
      lista.splice(i, 1);
      return conStatus(204, undefined);
    },
  },
  { metodo: "GET", patron: "/v1/hoteles/:org/admin/propiedades", manejador: () => ({ propiedades: [{ propertyId: PROP.id, nombre: PROP.nombre }] }) },
  // Rutas especificas antes que `:tid` (el router toma la primera que coincide).
  { metodo: "GET", patron: `${H}/tickets/resenas-pendientes`, manejador: () => ({ disponible: true, resenas: [] }) },
  { metodo: "GET", patron: `${H}/tickets/sla`, manejador: () => ({ disponible: true, efectiva: [{ departamento: "housekeeping", prioridad: "media", minutos: 60, configurada: false }] }) },
  { metodo: "GET", patron: `${H}/tickets`, manejador: (p) => {
      const todos = p.estado.obtener<Ticket[]>("hoteles.tickets", ticketsSemilla);
      const activos = p.query.get("activos") === "1";
      return { disponible: true, ahora: new Date().toISOString(), tickets: activos ? todos.filter((t) => t.estado !== "cerrado" && t.estado !== "cancelado") : todos };
    } },
  { metodo: "POST", patron: `${H}/tickets/:tid/:accion`, manejador: (p) => {
      const t = p.estado.obtener<Ticket[]>("hoteles.tickets", ticketsSemilla).find((x) => x.id === p.params.tid);
      const estado = ESTADO_POR_ACCION[p.params.accion ?? ""];
      if (!t || !estado) return fallo(404, "Ticket o accion desconocidos");
      t.estado = estado;
      return t;
    } },
];

export const hoteles = { orgSlug: ORG.slug, propertyId: PROP.id };
