// Fixtures de licitaciones (Constructora Peninsular). Forma = apps/web/src/verticals/licitaciones/lib/*-client.ts.
import { conStatus, fallo, ndjson } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("licitaciones");
const ORG = orgDe("licitaciones");
const L = "/licitaciones/:id";

const CONVOCATORIAS = [
  { id: "tnd-1", organizationId: ORG.id, title: "Rehabilitacion de la avenida Reforma, tramo norte", submissionDeadline: "2026-10-20T17:00:00.000Z", updatedAt: "2026-09-29T15:00:00.000Z", source: "compranet", externalId: "LA-931037999-E12-2026", contractingBody: "Secretaria de Obras Publicas de Yucatan", cpvCodes: ["45233120"], budgetAmount: 18500000, currency: "MXN", state: "Yucatan", procedureTypeRaw: "Licitacion publica nacional", status: "in_review" },
  { id: "tnd-2", organizationId: ORG.id, title: "Suministro de luminarias LED para alumbrado publico", submissionDeadline: "2026-10-27T17:00:00.000Z", updatedAt: "2026-09-30T15:00:00.000Z", source: "compranet", externalId: "LA-931037999-E15-2026", contractingBody: "Ayuntamiento de Merida", cpvCodes: ["34928500"], budgetAmount: 4200000, currency: "MXN", state: "Yucatan", procedureTypeRaw: "Invitacion a cuando menos tres personas", status: "discovered" },
];

interface AjustesWhatsapp {
  available: boolean;
  configured: boolean;
  contact: { phoneE164: string; status: string; notifyPlazos: boolean; notifyConvocatorias: boolean; notifyFallos: boolean; notifyDecisiones: boolean } | null;
  events: Array<{ id: string; event: string; detail: string | null; createdAt: string }>;
}

function ajustesSemilla(): AjustesWhatsapp {
  return {
    available: true,
    configured: true,
    contact: { phoneE164: "+529995550501", status: "activo", notifyPlazos: true, notifyConvocatorias: true, notifyFallos: true, notifyDecisiones: false },
    events: [{ id: "evt-1", event: "confirmado", detail: null, createdAt: "2026-09-25T16:00:00.000Z" }],
  };
}

// CHAT-12 -- Copiloto ("Pregunta a tus datos"): respuesta fija en el formato REAL del servidor (NDJSON paso/fin con conversacionId y
// seq; conversaciones guardadas por escenario). El servidor real deja pasar a todo rol de la vertical, asi que la API simulada no
// restringe por rol. Solo existe en la API simulada de e2e.
interface ConversacionMock {
  id: string;
  titulo: string;
  actualizadaEn: string;
  mensajes: { id: string; role: "user" | "assistant"; text: string; status?: string; blocks?: unknown[]; sources?: unknown[]; seq: number }[];
}
const BLOQUE_SEMAFORO = {
  kind: "table",
  tool: "plazos_semaforo",
  title: "Plazos y semáforo",
  columns: [
    { key: "semaforo", label: "Semáforo", kind: "text" },
    { key: "convocatorias", label: "Convocatorias", kind: "integer" },
  ],
  rows: [
    { semaforo: "Rojo", convocatorias: 1 },
    { semaforo: "Amarillo", convocatorias: 2 },
    { semaforo: "Verde", convocatorias: 4 },
  ],
  chart: { kind: "bar", x: "semaforo", y: "convocatorias" },
  truncated: false,
};
const TEXTO_SEMAFORO = "Tienes 7 convocatorias abiertas: 1 en rojo, 2 en amarillo y 4 en verde.";
const FUENTE_SEMAFORO = { tool: "plazos_semaforo", source: "Convocatorias de la organización con fecha límite vigente", periodLabel: "hoy", scopeLabel: "toda tu organización" };
const conversacionesMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<ConversacionMock[]>("licitaciones.copiloto.conversaciones", () => []);

const rutasCopiloto: readonly Ruta[] = [
  { metodo: "GET", patron: `${L}/chat-datos/estado`, manejador: () => ({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }) },
  {
    metodo: "POST",
    patron: `${L}/chat-datos`,
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
      conv.mensajes.push({ id: `m-${seq}`, role: "assistant", text: TEXTO_SEMAFORO, status: "ok", blocks: [BLOQUE_SEMAFORO], sources: [FUENTE_SEMAFORO], seq });
      conv.actualizadaEn = new Date().toISOString();
      return ndjson([
        { t: "paso", fase: "inicio", herramienta: "plazos_semaforo" },
        { t: "paso", fase: "fin", herramienta: "plazos_semaforo" },
        { t: "fin", conversacionId: conv.id, seq, respuesta: { status: "ok", text: TEXTO_SEMAFORO, blocks: [BLOQUE_SEMAFORO], sources: [FUENTE_SEMAFORO], toolsUsed: ["plazos_semaforo"] } },
      ]);
    },
  },
  { metodo: "GET", patron: `${L}/chat-datos/conversaciones`, manejador: (p) => ({ disponible: true, conversaciones: conversacionesMock(p).map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn, mensajes: c.mensajes.length })) }) },
  { metodo: "GET", patron: `${L}/chat-datos/conversaciones/:cid`, manejador: (p) => conversacionesMock(p).find((c) => c.id === p.params["cid"]) ?? fallo(404, "Conversación no encontrada.") },
  {
    metodo: "PATCH",
    patron: `${L}/chat-datos/conversaciones/:cid`,
    manejador: (p) => {
      const c = conversacionesMock(p).find((x) => x.id === p.params["cid"]);
      if (!c) return fallo(404, "Conversación no encontrada.");
      c.titulo = String(((p.cuerpo ?? {}) as { titulo?: string }).titulo ?? c.titulo);
      return { id: c.id, titulo: c.titulo };
    },
  },
  {
    metodo: "DELETE",
    patron: `${L}/chat-datos/conversaciones/:cid`,
    manejador: (p) => {
      const lista = conversacionesMock(p);
      const i = lista.findIndex((x) => x.id === p.params["cid"]);
      if (i < 0) return fallo(404, "Conversación no encontrada.");
      lista.splice(i, 1);
      return conStatus(204, undefined);
    },
  },
];

export const rutasLicitaciones: readonly Ruta[] = [
  ...rutasCopiloto,
  { metodo: "GET", patron: "/v1/licitaciones/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre }] }) },
  { metodo: "GET", patron: `${L}/tenders`, manejador: () => ({ tenders: CONVOCATORIAS }) },
  { metodo: "GET", patron: `${L}/whatsapp/settings`, manejador: (p) => p.estado.obtener("lic.whatsapp", ajustesSemilla) },
  { metodo: "POST", patron: `${L}/whatsapp/opt-out`, manejador: (p) => {
      const a = p.estado.obtener("lic.whatsapp", ajustesSemilla);
      const cambio = a.contact !== null && a.contact.status !== "baja";
      if (a.contact) a.contact.status = "baja";
      return { ok: true, changed: cambio };
    } },
];

export const licitaciones = { orgSlug: ORG.slug, propertyId: PROP.id };
