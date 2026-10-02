// Fixtures de citas (Clinica Dental Mayab). Las respuestas del API de citas usan snake_case (ver lib/*-client.ts).
import { conStatus, fallo, ndjson } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("citas");
const ORG = orgDe("citas");
const P = "/v1/citas/properties/:id";
const C = "/citas/:id";

// CHAT-13 -- Copiloto ("Pregunta a tus datos"): respuesta fija en el formato REAL del servidor (NDJSON paso/fin con conversacionId y
// seq; conversaciones guardadas por escenario). Solo owner/admin lo usan en el servidor real (DATA_CHAT_ROLES); en e2e `roles` hace que
// staff reciba 403 igual que el servidor. Solo existe en la API simulada de e2e.
interface ConversacionMock {
  id: string;
  titulo: string;
  actualizadaEn: string;
  mensajes: { id: string; role: "user" | "assistant"; text: string; status?: string; blocks?: unknown[]; sources?: unknown[]; seq: number }[];
}
const MOCK_ROLES_COPILOTO = ["owner", "admin"] as const;
const BLOQUE_CITAS = {
  kind: "table",
  tool: "citas_por_dia",
  title: "Citas por día",
  columns: [
    { key: "periodo", label: "Día", kind: "text" },
    { key: "citas", label: "Citas", kind: "integer" },
    { key: "canceladas", label: "Canceladas", kind: "integer" },
  ],
  rows: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"].map((periodo, i) => ({ periodo, citas: 3 + i, canceladas: i % 2 })),
  chart: { kind: "bar", x: "periodo", y: "citas" },
  truncated: false,
};
const TEXTO_CITAS = "Esta semana tienes 24 citas (18 completadas, 4 por atender, 2 canceladas).";
const FUENTE_CITAS = { tool: "citas_por_dia", source: "Citas de la agenda", periodLabel: "esta semana (lunes a hoy)", scopeLabel: "todas tus sucursales" };
const conversacionesMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<ConversacionMock[]>("citas.copiloto.conversaciones", () => []);

const PROVEEDORES = [
  { id: "prv-1", property_id: PROP.id, display_name: "Dra. Paola Medina", role_label: "Odontologa", is_active: true },
  { id: "prv-2", property_id: PROP.id, display_name: "Dr. Luis Cetina", role_label: "Ortodoncista", is_active: true },
];
const SERVICIOS = [
  { id: "srv-1", name: "Limpieza dental", duration_minutes: 45, buffer_minutes_before: 0, buffer_minutes_after: 10, price_cents: 65000, is_active: true },
  { id: "srv-2", name: "Revision de ortodoncia", duration_minutes: 30, buffer_minutes_before: 0, buffer_minutes_after: 0, price_cents: 90000, is_active: true },
];
const CLIENTES = [
  { id: "cli-1", full_name: "Ana Lilia Pech", phone: "+529995550201", email: "ana.pech@example.test" },
  { id: "cli-2", full_name: "Mario Chan", phone: "+529995550202", email: null },
];

interface Cita {
  id: string;
  property_id: string;
  provider_id: string;
  service_id: string;
  customer_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  notes: string | null;
  provider_name: string;
  service_name: string;
  customer_name: string;
  customer_phone: string;
}

function citasSemilla(): Cita[] {
  // Relativas a "ahora" para caer siempre dentro de la semana que pide la agenda.
  const base = Date.now();
  const hora = 3_600_000;
  const mk = (id: string, delta: number, status: string, prv: number, srv: number, cli: number): Cita => ({
    id,
    property_id: PROP.id,
    provider_id: PROVEEDORES[prv]!.id,
    service_id: SERVICIOS[srv]!.id,
    customer_id: CLIENTES[cli]!.id,
    starts_at: new Date(base + delta * hora).toISOString(),
    ends_at: new Date(base + delta * hora + 45 * 60_000).toISOString(),
    status,
    source: "whatsapp",
    notes: null,
    provider_name: PROVEEDORES[prv]!.display_name,
    service_name: SERVICIOS[srv]!.name,
    customer_name: CLIENTES[cli]!.full_name,
    customer_phone: CLIENTES[cli]!.phone,
  });
  return [mk("apt-1", 1, "confirmed", 0, 0, 0), mk("apt-2", 3, "pending", 1, 1, 1)];
}

const conteo = (pending: number, confirmed: number) => ({ pending, confirmed, completed: 0, cancelled: 0, no_show: 0 });

// C-19 -- API PUBLICA de la pagina de reservas (sin sesion): catalogo, disponibilidad y el POST publico de la cita. Mismo formato que
// apps/api/src/routes/verticals/citas/publico.ts. Los horarios son siempre 10:00/10:30/11:00 hora de Merida (UTC-6) del dia pedido;
// un horario ya reservado devuelve 409 igual que el servidor y deja de ofrecerse. Estas rutas no llevan sesion, asi que caen en el
// escenario compartido "anon": el estado de horarios tomados se aisla POR SLUG (cada prueba usa `${orgSlug}--<sufijo unico>`). El slug
// "sin-agenda" es un negocio que aun no esta listo y cualquier otro slug responde 404 uniforme.
const SLUG_NO_LISTO = "sin-agenda";
const HORAS_PUBLICAS: Readonly<Record<string, readonly string[]>> = { "prv-1": ["16:00", "16:30"], "prv-2": ["16:30", "17:00"] };
function negocioPublico(org: string): "listo" | "no-listo" | null {
  return org === ORG.slug || org.startsWith(`${ORG.slug}--`) ? "listo" : org === SLUG_NO_LISTO ? "no-listo" : null;
}
function slotsPublicos(fecha: string, proveedores: readonly string[], tomados: readonly string[]) {
  const unicos = new Map<string, { starts_at: string; ends_at: string; provider_id: string }>();
  for (const prv of proveedores) {
    for (const hora of HORAS_PUBLICAS[prv] ?? []) {
      const ini = new Date(`${fecha}T${hora}:00.000Z`);
      const startsAt = ini.toISOString();
      if (tomados.includes(startsAt) || unicos.has(startsAt)) continue;
      unicos.set(startsAt, { starts_at: startsAt, ends_at: new Date(ini.getTime() + 30 * 60_000).toISOString(), provider_id: prv });
    }
  }
  return [...unicos.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

export const rutasCitas: readonly Ruta[] = [
  {
    metodo: "GET",
    patron: "/v1/citas/:org/publico/catalogo",
    publica: true,
    manejador: (p) => {
      const negocio = negocioPublico(p.params["org"]!);
      if (!negocio) return fallo(404, "Negocio no encontrado.");
      if (negocio === "no-listo") return { lista: false, faltan: ["horario"] };
      return {
        lista: true,
        negocio: { nombre: ORG.nombre, zona_horaria: "America/Merida" },
        servicios: SERVICIOS.map((s) => ({ id: s.id, nombre: s.name, duracion_minutos: s.duration_minutes, precio_centavos: s.price_cents })),
        profesionales: PROVEEDORES.map((v) => ({ id: v.id, nombre: v.display_name, servicio_ids: SERVICIOS.map((s) => s.id) })),
      };
    },
  },
  {
    metodo: "POST",
    patron: "/v1/citas/:org/publico/disponibilidad",
    publica: true,
    manejador: (p) => {
      const negocio = negocioPublico(p.params["org"]!);
      if (!negocio) return fallo(404, "Negocio no encontrado.");
      if (negocio === "no-listo") return { lista: false, faltan: ["horario"] };
      const c = (p.cuerpo ?? {}) as { provider_id?: string; date?: string };
      if (!c.date || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) return fallo(400, "date debe tener formato YYYY-MM-DD válido");
      const tomados = p.estado.obtener<string[]>(`citas.reserva.tomados:${p.params["org"]}`, () => []);
      return { lista: true, zona_horaria: "America/Merida", slots: slotsPublicos(c.date, c.provider_id ? [c.provider_id] : PROVEEDORES.map((v) => v.id), tomados) };
    },
  },
  {
    metodo: "POST",
    patron: "/v1/citas/:org/appointments",
    publica: true,
    manejador: (p) => {
      if (!negocioPublico(p.params["org"]!)) return fallo(404, "Negocio no encontrado.");
      const c = (p.cuerpo ?? {}) as { starts_at?: string; provider_id?: string; service_id?: string; customer_name?: string };
      if (!c.starts_at || !c.provider_id || !c.service_id || !c.customer_name) return fallo(400, "Payload inválido");
      const tomados = p.estado.obtener<string[]>(`citas.reserva.tomados:${p.params["org"]}`, () => []);
      if (tomados.includes(c.starts_at)) return fallo(409, "El horario ya no está disponible.");
      tomados.push(c.starts_at);
      const fin = new Date(new Date(c.starts_at).getTime() + 30 * 60_000).toISOString();
      return conStatus(201, { appointment: { id: `apt-web-${tomados.length}`, starts_at: c.starts_at, ends_at: fin, status: "pending", source: "web" } });
    },
  },
  { metodo: "GET", patron: `${C}/chat-datos/estado`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }) },
  {
    metodo: "POST",
    patron: `${C}/chat-datos`,
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
      conv.mensajes.push({ id: `m-${seq}`, role: "assistant", text: TEXTO_CITAS, status: "ok", blocks: [BLOQUE_CITAS], sources: [FUENTE_CITAS], seq });
      conv.actualizadaEn = new Date().toISOString();
      return ndjson([
        { t: "paso", fase: "inicio", herramienta: "citas_por_dia" },
        { t: "paso", fase: "fin", herramienta: "citas_por_dia" },
        { t: "fin", conversacionId: conv.id, seq, respuesta: { status: "ok", text: TEXTO_CITAS, blocks: [BLOQUE_CITAS], sources: [FUENTE_CITAS], toolsUsed: ["citas_por_dia"] } },
      ]);
    },
  },
  { metodo: "GET", patron: `${C}/chat-datos/conversaciones`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => ({ disponible: true, conversaciones: conversacionesMock(p).map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn, mensajes: c.mensajes.length })) }) },
  { metodo: "GET", patron: `${C}/chat-datos/conversaciones/:cid`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => conversacionesMock(p).find((c) => c.id === p.params["cid"]) ?? fallo(404, "Conversación no encontrada.") },
  {
    metodo: "PATCH",
    patron: `${C}/chat-datos/conversaciones/:cid`,
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
    patron: `${C}/chat-datos/conversaciones/:cid`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const lista = conversacionesMock(p);
      const i = lista.findIndex((x) => x.id === p.params["cid"]);
      if (i < 0) return fallo(404, "Conversación no encontrada.");
      lista.splice(i, 1);
      return conStatus(204, undefined);
    },
  },
  { metodo: "GET", patron: "/v1/citas/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre }] }) },
  { metodo: "GET", patron: `${P}/resumen`, manejador: () => ({
      timezone: "America/Merida",
      generated_at: new Date().toISOString(),
      today: { date: new Date().toISOString().slice(0, 10), total: 2, by_status: conteo(1, 1) },
      week: { from_date: new Date().toISOString().slice(0, 10), to_date: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10), total: 9, by_status: conteo(3, 6) },
      pending_to_confirm: 3,
      no_shows_last_30_days: 1,
      new_customers_last_30_days: 12,
    }) },
  { metodo: "GET", patron: `${P}/providers`, manejador: () => ({ providers: PROVEEDORES }) },
  { metodo: "GET", patron: `${P}/services`, manejador: () => ({ services: SERVICIOS }) },
  { metodo: "GET", patron: `${P}/customers`, manejador: () => ({ customers: CLIENTES, total: CLIENTES.length, next_offset: null }) },
  { metodo: "GET", patron: `${P}/appointments`, manejador: (p) => ({ appointments: p.estado.obtener("citas.lista", citasSemilla) }) },
  { metodo: "POST", patron: `${P}/appointments/:aptId/cancel`, manejador: (p) => {
      const cita = p.estado.obtener("citas.lista", citasSemilla).find((c) => c.id === p.params.aptId);
      if (!cita) return fallo(404, "Esa cita no existe");
      cita.status = "cancelled";
      return { appointment: cita };
    } },
  { metodo: "GET", patron: `${P}/waitlist`, manejador: () => ({ waitlist: [] }) },
];

export const citas = { orgSlug: ORG.slug, propertyId: PROP.id, slugNoListo: SLUG_NO_LISTO };
