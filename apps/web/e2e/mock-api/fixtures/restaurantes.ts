// Fixtures de restaurantes (Taqueria El Faro). Forma de cada respuesta = tipos de apps/web/src/verticals/restaurantes/lib.
// Rutas por `:id` = propertyId (la lista de sucursales cuelga del slug de la organizacion).
import { conStatus, fallo, ndjson } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("restaurantes");
const ORG = orgDe("restaurantes");
const B = "/v1/restaurantes/:id/admin";

export const ORDENES_SEMILLA = [
  { id: "ord-1001", propertyId: PROP.id, branch: PROP.nombre, customerId: "cli-1", customerName: "Marisol Pech", customerPhone: "+529995550101", customerAddress: "Calle 60 #412, Centro", total: 286, status: "pending", items: [{ id: "p-1", name: "Tacos al pastor (orden)", price: 95, quantity: 2 }, { id: "p-2", name: "Horchata", price: 48, quantity: 2 }], source: "whatsapp", notes: null, paymentMethod: "efectivo", createdAt: "2026-09-30T18:20:00.000Z", assignedRepartidorId: null as string | null, estimatedDeliveryAt: null as string | null, incidentNote: null as string | null, canal: "domicilio", propina: 20, horaRecogida: null },
  { id: "ord-1002", propertyId: PROP.id, branch: PROP.nombre, customerId: "cli-2", customerName: "Jorge Canul", customerPhone: "+529995550102", customerAddress: null, total: 190, status: "preparando", items: [{ id: "p-3", name: "Cochinita pibil (torta)", price: 95, quantity: 2 }], source: "web", notes: "Sin cebolla", paymentMethod: "tarjeta", createdAt: "2026-09-30T18:05:00.000Z", assignedRepartidorId: null as string | null, estimatedDeliveryAt: null as string | null, incidentNote: null as string | null, canal: "recoger", propina: null, horaRecogida: "2026-09-30T19:00:00.000Z" },
  { id: "ord-0999", propertyId: PROP.id, branch: PROP.nombre, customerId: "cli-1", customerName: "Marisol Pech", customerPhone: "+529995550101", customerAddress: "Calle 60 #412, Centro", total: 143, status: "completado", items: [{ id: "p-1", name: "Tacos al pastor (orden)", price: 95, quantity: 1 }, { id: "p-2", name: "Horchata", price: 48, quantity: 1 }], source: "voice", notes: null, paymentMethod: "efectivo", createdAt: "2026-09-29T20:10:00.000Z", assignedRepartidorId: null as string | null, estimatedDeliveryAt: null as string | null, incidentNote: null as string | null, canal: "domicilio", propina: null, horaRecogida: null },
];

// Entregas asignadas al repartidor (GET/PATCH repartidor/orders). Forma = RepartidorOrder de lib/repartidor-client.ts.
export const ENTREGAS_SEMILLA = [
  { id: "ent-2001", propertyId: PROP.id, branch: PROP.nombre, customerName: "Marisol Pech", customerPhone: "+529995550101", customerAddress: "Calle 60 #412, Centro", total: 286, status: "preparando", items: [{ id: "p-1", name: "Tacos al pastor (orden)", price: 95, quantity: 2 }, { id: "p-2", name: "Horchata", price: 48, quantity: 2 }], notes: null, paymentMethod: "efectivo", estimatedDeliveryAt: null as string | null, incidentNote: null as string | null, createdAt: "2026-09-30T18:20:00.000Z" },
  { id: "ent-2002", propertyId: PROP.id, branch: PROP.nombre, customerName: "Jorge Canul", customerPhone: "+529995550102", customerAddress: "Calle 45 #210, Garcia Gineres", total: 190, status: "en_camino", items: [{ id: "p-3", name: "Cochinita pibil (torta)", price: 95, quantity: 2 }], notes: "Sin cebolla", paymentMethod: "tarjeta", estimatedDeliveryAt: null as string | null, incidentNote: null as string | null, createdAt: "2026-09-30T18:05:00.000Z" },
  { id: "ent-1998", propertyId: PROP.id, branch: PROP.nombre, customerName: "Lucia Xool", customerPhone: "+529995550103", customerAddress: "Calle 21 #88, Itzimna", total: 143, status: "entregado", items: [{ id: "p-1", name: "Tacos al pastor (orden)", price: 95, quantity: 1 }, { id: "p-2", name: "Horchata", price: 48, quantity: 1 }], notes: null, paymentMethod: "efectivo", estimatedDeliveryAt: null as string | null, incidentNote: null as string | null, createdAt: "2026-09-29T20:10:00.000Z" },
];

export const MIEMBROS_SEMILLA = [
  { id: "usr-owner", email: "owner.restaurantes@example.test", fullName: "Owner restaurantes", verticalRole: "owner", propertyIds: null },
  { id: "usr-1", email: "lucia.xool@example.test", fullName: "Lucia Xool", verticalRole: "staff", propertyIds: null },
  { id: "usr-2", email: "ramon.uc@example.test", fullName: "Ramon Uc", verticalRole: "repartidor", propertyIds: null },
];

const kpisVentas = { revenue: 18450, orders: 96, customers: 61, averageOrder: 192.2, revenueChangePct: 8.4, ordersChangePct: 5.1, customersChangePct: 2.3, avgOrderChangePct: 3.2, periodLabel: "Ultimos 7 dias" };
const canales = {
  totalOrders: 96,
  totalRevenue: 18450,
  voice: { orders: 21, completed: 19, cancelled: 2, revenue: 3900 },
  whatsapp: { orders: 52, completed: 50, cancelled: 2, revenue: 10100 },
  whatsappConversations: { total: 74, withOrder: 52, averageMessages: 7.5 },
  aiAdoptionPct: 76,
  aiRevenuePct: 82,
  estimatedHoursSaved: 31,
  periodo: { acotado: true, etiqueta: "Últimos 30 días" },
};
const clientesKpis = {
  totalCustomers: 61,
  averageOrderValue: 192.2,
  recurringCustomerPct: 41,
  topCustomer: { name: "Marisol Pech", phone: "+529995550101", orderCount: 9 },
  avgDaysSinceLastOrder: 6,
  tierDistribution: { metric: "frecuencia", BLACK: 2, PLATINUM: 5, GOLD: 11, BLUE: 30, withoutTier: 13 },
};

// CHAT-08 -- Copiloto ("Pregunta a tus datos"): respuesta fija en el formato REAL del servidor (NDJSON paso/fin con
// conversacionId y seq; conversaciones guardadas por escenario). Solo existe en la API simulada de e2e.
interface ConversacionMock {
  id: string;
  titulo: string;
  actualizadaEn: string;
  mensajes: { id: string; role: "user" | "assistant"; text: string; status?: string; blocks?: unknown[]; sources?: unknown[]; seq: number }[];
}
const MOCK_ROLES_COPILOTO = ["owner", "admin", "staff"] as const;
const BLOQUE_VENTAS = {
  kind: "table",
  tool: "ventas_por_dia",
  title: "Ventas por día",
  columns: [
    { key: "dia", label: "Día", kind: "text" },
    { key: "ventas", label: "Ventas", kind: "mxn" },
    { key: "pedidos", label: "Pedidos", kind: "integer" },
  ],
  rows: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((dia, i) => ({ dia, ventas: 2100 + i * 310, pedidos: 11 + i })),
  chart: { kind: "bar", x: "dia", y: "ventas" },
  truncated: false,
};
const TEXTO_VENTAS = "En los últimos 7 días vendiste $18,450 MXN en 96 pedidos.";
const FUENTE_VENTAS = { tool: "ventas_por_dia", source: "Pedidos completados", periodLabel: "últimos 7 días", scopeLabel: "todas tus sucursales" };
const conversacionesMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<ConversacionMock[]>("rest.copiloto.conversaciones", () => []);

export const rutasRestaurantes: readonly Ruta[] = [
  { metodo: "GET", patron: `${B}/chat-datos/pins`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ disponible: true, pins: [] }) },
  { metodo: "GET", patron: `${B}/chat-datos/estado`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }) },
  {
    metodo: "POST",
    patron: `${B}/chat-datos`,
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
      conv.mensajes.push({ id: `m-${seq}`, role: "assistant", text: TEXTO_VENTAS, status: "ok", blocks: [BLOQUE_VENTAS], sources: [FUENTE_VENTAS], seq });
      conv.actualizadaEn = new Date().toISOString();
      return ndjson([
        { t: "paso", fase: "inicio", herramienta: "ventas_por_dia" },
        { t: "paso", fase: "fin", herramienta: "ventas_por_dia" },
        { t: "fin", conversacionId: conv.id, seq, respuesta: { status: "ok", text: TEXTO_VENTAS, blocks: [BLOQUE_VENTAS], sources: [FUENTE_VENTAS], toolsUsed: ["ventas_por_dia"] } },
      ]);
    },
  },
  { metodo: "GET", patron: `${B}/chat-datos/conversaciones`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => ({ disponible: true, conversaciones: conversacionesMock(p).map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn, mensajes: c.mensajes.length })) }) },
  { metodo: "GET", patron: `${B}/chat-datos/conversaciones/:cid`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => conversacionesMock(p).find((c) => c.id === p.params["cid"]) ?? fallo(404, "Conversación no encontrada.") },
  {
    metodo: "PATCH",
    patron: `${B}/chat-datos/conversaciones/:cid`,
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
    patron: `${B}/chat-datos/conversaciones/:cid`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const lista = conversacionesMock(p);
      const i = lista.findIndex((x) => x.id === p.params["cid"]);
      if (i < 0) return fallo(404, "Conversación no encontrada.");
      lista.splice(i, 1);
      return conStatus(204, undefined);
    },
  },
  { metodo: "GET", patron: "/v1/restaurantes/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre, slug: "centro" }] }) },
  { metodo: "GET", patron: `${B}/kpis/sales`, manejador: () => kpisVentas },
  { metodo: "GET", patron: `${B}/kpis/sales/trend`, manejador: () => ({ buckets: ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"].map((label, i) => ({ label, revenue: 2100 + i * 310, orders: 11 + i })) }) },
  { metodo: "GET", patron: `${B}/kpis/channels`, manejador: () => canales },
  { metodo: "GET", patron: `${B}/kpis/customers`, manejador: () => clientesKpis },

  { metodo: "GET", patron: `${B}/scheduled-orders`, manejador: () => ({ disponible: true, orders: [], promovidos: [], serverNow: "2026-09-30T19:00:00.000Z" }) },

  { metodo: "GET", patron: `${B}/customers`, manejador: () => ({ customers: [{ id: "cli-1", name: "Marisol Pech", phone: "+529995550101", orderCount: 9 }, { id: "cli-2", name: "Jorge Canul", phone: "+529995550102", orderCount: 3 }], nextCursor: null }) },
  { metodo: "GET", patron: `${B}/sucursales`, manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre, slug: "centro", status: "active", phone: "+529995550100", address: "Calle 60 #400, Centro, Merida", lat: 20.9674, lng: -89.6237 }] }) },

  // Staff: gestion solo owner/admin (el servidor es la autoridad; la SPA solo oculta controles).
  { metodo: "GET", patron: `${B}/staff/repartidores`, manejador: () => ({ repartidores: [{ id: "usr-2", email: "ramon.uc@example.test", fullName: "Ramon Uc" }] }) },
  { metodo: "GET", patron: `${B}/staff/invitaciones`, roles: ["owner", "admin"], manejador: () => ({ invitations: [] }) },
  { metodo: "GET", patron: `${B}/staff/miembros`, roles: ["owner", "admin"], manejador: (p) => ({ miembros: p.estado.obtener("rest.miembros", () => structuredClone(MIEMBROS_SEMILLA)) }) },
  { metodo: "DELETE", patron: `${B}/staff/miembros/:userId`, roles: ["owner", "admin"], manejador: (p) => {
      const miembros = p.estado.obtener("rest.miembros", () => structuredClone(MIEMBROS_SEMILLA));
      const i = miembros.findIndex((m) => m.id === p.params.userId);
      if (i < 0) return fallo(404, "Ese miembro no existe");
      miembros.splice(i, 1);
      return { ok: true };
    } },
  { metodo: "PATCH", patron: `${B}/staff/miembros/:userId`, roles: ["owner", "admin"], manejador: (p) => {
      const miembros = p.estado.obtener("rest.miembros", () => structuredClone(MIEMBROS_SEMILLA));
      const m = miembros.find((x) => x.id === p.params.userId);
      if (!m) return fallo(404, "Ese miembro no existe");
      m.verticalRole = String(((p.cuerpo ?? {}) as { verticalRole?: string }).verticalRole ?? m.verticalRole);
      return m;
    } },
  { metodo: "GET", patron: "/v1/restaurantes/:id/repartidor/orders", manejador: (p) => ({ orders: p.estado.obtener("rest.entregas", () => structuredClone(ENTREGAS_SEMILLA)) }) },
  { metodo: "PATCH", patron: "/v1/restaurantes/:id/repartidor/orders/:orderId/status", manejador: (p) => {
      const entregas = p.estado.obtener("rest.entregas", () => structuredClone(ENTREGAS_SEMILLA));
      const e = entregas.find((x) => x.id === p.params.orderId);
      if (!e) return fallo(404, "Ese pedido no existe");
      const cuerpo = (p.cuerpo ?? {}) as { status?: string; incidentNote?: string };
      if (!cuerpo.status) return fallo(400, "Estado requerido");
      if (cuerpo.status === "problema" && !cuerpo.incidentNote?.trim()) return fallo(400, "La nota de incidencia es obligatoria");
      e.status = cuerpo.status;
      if (cuerpo.incidentNote) e.incidentNote = cuerpo.incidentNote;
      // Mismo pedido visto desde el panel del owner (GET admin/orders): el cambio del repartidor se refleja alli.
      const orden = p.estado.obtener("rest.ordenes", () => structuredClone(ORDENES_SEMILLA)).find((o) => o.id === e.id);
      if (orden) {
        orden.status = cuerpo.status;
        if (cuerpo.incidentNote) orden.incidentNote = cuerpo.incidentNote;
      }
      return { order: e };
    } },
];

export const restaurantes = { orgSlug: ORG.slug, propertyId: PROP.id };
