// Fixtures de restaurantes (Taqueria El Faro). Forma de cada respuesta = tipos de apps/web/src/verticals/restaurantes/lib.
// Rutas por `:id` = propertyId (la lista de sucursales cuelga del slug de la organizacion).
import { fallo } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("restaurantes");
const ORG = orgDe("restaurantes");
const B = "/v1/restaurantes/:id/admin";

const ORDENES = [
  { id: "ord-1001", propertyId: PROP.id, branch: PROP.nombre, customerId: "cli-1", customerName: "Marisol Pech", customerPhone: "+529995550101", customerAddress: "Calle 60 #412, Centro", total: 286, status: "pending", items: [{ id: "p-1", name: "Tacos al pastor (orden)", price: 95, quantity: 2 }, { id: "p-2", name: "Horchata", price: 48, quantity: 2 }], source: "whatsapp", notes: null, paymentMethod: "efectivo", createdAt: "2026-09-30T18:20:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, canal: "domicilio", propina: 20, horaRecogida: null },
  { id: "ord-1002", propertyId: PROP.id, branch: PROP.nombre, customerId: "cli-2", customerName: "Jorge Canul", customerPhone: "+529995550102", customerAddress: null, total: 190, status: "preparando", items: [{ id: "p-3", name: "Cochinita pibil (torta)", price: 95, quantity: 2 }], source: "web", notes: "Sin cebolla", paymentMethod: "tarjeta", createdAt: "2026-09-30T18:05:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, canal: "recoger", propina: null, horaRecogida: "2026-09-30T19:00:00.000Z" },
  { id: "ord-0999", propertyId: PROP.id, branch: PROP.nombre, customerId: "cli-1", customerName: "Marisol Pech", customerPhone: "+529995550101", customerAddress: "Calle 60 #412, Centro", total: 143, status: "completado", items: [{ id: "p-1", name: "Tacos al pastor (orden)", price: 95, quantity: 1 }, { id: "p-2", name: "Horchata", price: 48, quantity: 1 }], source: "voice", notes: null, paymentMethod: "efectivo", createdAt: "2026-09-29T20:10:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, canal: "domicilio", propina: null, horaRecogida: null },
];

const MIEMBROS = [
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

export const rutasRestaurantes: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/restaurantes/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre, slug: "centro" }] }) },
  { metodo: "GET", patron: `${B}/kpis/sales`, manejador: () => kpisVentas },
  { metodo: "GET", patron: `${B}/kpis/sales/trend`, manejador: () => ({ buckets: ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"].map((label, i) => ({ label, revenue: 2100 + i * 310, orders: 11 + i })) }) },
  { metodo: "GET", patron: `${B}/kpis/channels`, manejador: () => canales },
  { metodo: "GET", patron: `${B}/kpis/customers`, manejador: () => clientesKpis },

  { metodo: "GET", patron: `${B}/orders`, manejador: (p) => {
      const estado = p.query.get("status");
      const orders = ORDENES.filter((o) => (estado ? o.status === estado : true));
      return { orders, nextCursor: null };
    } },
  { metodo: "GET", patron: `${B}/scheduled-orders`, manejador: () => ({ disponible: true, orders: [], promovidos: [], serverNow: "2026-09-30T19:00:00.000Z" }) },

  { metodo: "GET", patron: `${B}/categories`, manejador: () => ({ categories: [{ id: "cat-1", name: "Tacos", slug: "tacos", displayOrder: 1 }, { id: "cat-2", name: "Bebidas", slug: "bebidas", displayOrder: 2 }] }) },
  { metodo: "GET", patron: `${B}/products`, manejador: () => ({ products: [
      { id: "p-1", categoryId: "cat-1", categoryName: "Tacos", name: "Tacos al pastor (orden)", description: "Cinco tacos con pina y cilantro", price: 95, imageUrl: null, isPopular: true, isAvailable: true, displayOrder: 1, searchKeywords: ["pastor"], branch: { propertyId: PROP.id, productId: "p-1", price: 95, isAvailable: true } },
      { id: "p-2", categoryId: "cat-2", categoryName: "Bebidas", name: "Horchata", description: null, price: 48, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 2, searchKeywords: [], branch: { propertyId: PROP.id, productId: "p-2", price: 48, isAvailable: true } },
    ] }) },
  { metodo: "GET", patron: `${B}/customers`, manejador: () => ({ customers: [{ id: "cli-1", name: "Marisol Pech", phone: "+529995550101", orderCount: 9 }, { id: "cli-2", name: "Jorge Canul", phone: "+529995550102", orderCount: 3 }], nextCursor: null }) },
  { metodo: "GET", patron: `${B}/sucursales`, manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre, slug: "centro", status: "active", phone: "+529995550100", address: "Calle 60 #400, Centro, Merida", lat: 20.9674, lng: -89.6237 }] }) },

  // Staff: gestion solo owner/admin (el servidor es la autoridad; la SPA solo oculta controles).
  { metodo: "GET", patron: `${B}/staff/repartidores`, manejador: () => ({ repartidores: [{ id: "usr-2", email: "ramon.uc@example.test", fullName: "Ramon Uc" }] }) },
  { metodo: "GET", patron: `${B}/staff/invitaciones`, roles: ["owner", "admin"], manejador: () => ({ invitations: [] }) },
  { metodo: "GET", patron: `${B}/staff/miembros`, roles: ["owner", "admin"], manejador: (p) => ({ miembros: p.estado.obtener("rest.miembros", () => structuredClone(MIEMBROS)) }) },
  { metodo: "DELETE", patron: `${B}/staff/miembros/:userId`, roles: ["owner", "admin"], manejador: (p) => {
      const miembros = p.estado.obtener("rest.miembros", () => structuredClone(MIEMBROS));
      const i = miembros.findIndex((m) => m.id === p.params.userId);
      if (i < 0) return fallo(404, "Ese miembro no existe");
      miembros.splice(i, 1);
      return { ok: true };
    } },
  { metodo: "PATCH", patron: `${B}/staff/miembros/:userId`, roles: ["owner", "admin"], manejador: (p) => {
      const miembros = p.estado.obtener("rest.miembros", () => structuredClone(MIEMBROS));
      const m = miembros.find((x) => x.id === p.params.userId);
      if (!m) return fallo(404, "Ese miembro no existe");
      m.verticalRole = String(((p.cuerpo ?? {}) as { verticalRole?: string }).verticalRole ?? m.verticalRole);
      return m;
    } },
];

export const restaurantes = { orgSlug: ORG.slug, propertyId: PROP.id };
