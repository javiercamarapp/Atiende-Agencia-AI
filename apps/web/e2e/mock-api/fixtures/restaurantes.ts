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


// ---- Comandas al POS (captura asistida) y cartera de clientes: estado mutable por escenario --------------------------------------------------
// Solo existe en la API simulada de e2e. La comanda de ord-1001 empieza en "captura_manual" (el POS aun no esta conectado).
interface ComandaMock { id: string; propertyId: string; orderId: string; estado: string; intentos: number; maxIntentos: number; folio: string | null; ultimoError: string | null; notaCaptura: string | null; capturadoEn: string | null; creadoEn: string; totalPedido: number | null; comanda: unknown }
const comandasMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) =>
  p.estado.obtener<ComandaMock[]>("rest.comandas", () => [
    {
      id: "cmd-3001", propertyId: PROP.id, orderId: "ord-1001", estado: "captura_manual", intentos: 5, maxIntentos: 5, folio: null, ultimoError: "rechazada:producto_sin_codigo_pos", notaCaptura: null, capturadoEn: null,
      creadoEn: new Date(Date.now() - 12 * 60_000).toISOString(), totalPedido: 286,
      comanda: { sucursal: "T1", tipo: "domicilio", cliente: { nombre: "Marisol Pech", telefono: "9995550101" }, direccion: { texto: "Calle 60 #412, Centro" }, formaPago: "efectivo", items: [{ codigo: "TAQ-PASTOR", cantidad: 2, nombre: "Tacos al pastor (orden)", modificadores: [] }, { codigo: "BEB-HORCHATA", cantidad: 2, nombre: "Horchata", modificadores: [] }] },
    },
  ]);
const DIA_MS = 86_400_000;
interface ClienteMock { id: string; name: string | null; phone: string; orderCount: number; tier: string | null; lastOrderAt: string | null }
const clientesMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) =>
  p.estado.obtener<ClienteMock[]>("rest.clientes", () => [
    { id: "cli-1", name: "Marisol Pech", phone: "+529995550101", orderCount: 9, tier: "BLACK", lastOrderAt: new Date(Date.now() - 2 * DIA_MS).toISOString() },
    { id: "cli-2", name: "Jorge Canul", phone: "+529995550102", orderCount: 3, tier: "BLUE", lastOrderAt: new Date(Date.now() - 5 * DIA_MS).toISOString() },
  ]);
/** Misma regla que el servidor (canonicalizeMexicanPhone): 10 digitos; +52 y 521 se aceptan; 11 digitos se rechaza. */
function telefonoMock(crudo: unknown): string | null {
  const d = String(crudo ?? "").replace(/\D/g, "");
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith("52")) return d.slice(2);
  if (d.length === 13 && d.startsWith("521")) return d.slice(3);
  return null;
}
type FilaImportMock = { telefono?: unknown; nombre?: unknown };
function prepararImportMock(filas: readonly FilaImportMock[]) {
  const validas: Array<{ phone: string; name: string | null }> = [];
  const errores: Array<{ renglon: number; motivo: string }> = [];
  filas.forEach((f, i) => {
    const phone = telefonoMock(f.telefono);
    if (phone === null) errores.push({ renglon: i + 1, motivo: "Telefono invalido: se esperan 10 digitos (se acepta +52 o 521 al inicio)." });
    else validas.push({ phone, name: String(f.nombre ?? "").trim() || null });
  });
  return { validas, errores };
}
const enmascarar = (tel: string) => `${"*".repeat(Math.max(0, tel.length - 4))}${tel.slice(-4)}`;

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
  // Lista en el estado del escenario: una prueba puede sembrar una segunda sucursal con `mock.agregarAEstado("rest.branches", ...)` y recargar.
  { metodo: "GET", patron: "/v1/restaurantes/:org/admin/branches", manejador: (p) => ({ branches: p.estado.obtener("rest.branches", () => [{ propertyId: PROP.id, name: PROP.nombre, slug: "centro" }]) }) },
  { metodo: "GET", patron: `${B}/kpis/sales`, manejador: () => kpisVentas },
  { metodo: "GET", patron: `${B}/kpis/sales/trend`, manejador: () => ({ buckets: ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"].map((label, i) => ({ label, revenue: 2100 + i * 310, orders: 11 + i })) }) },
  { metodo: "GET", patron: `${B}/kpis/channels`, manejador: () => canales },
  { metodo: "GET", patron: `${B}/kpis/customers`, manejador: () => clientesKpis },

  { metodo: "GET", patron: `${B}/scheduled-orders`, manejador: () => ({ disponible: true, orders: [], promovidos: [], serverNow: "2026-09-30T19:00:00.000Z" }) },

  { metodo: "GET", patron: `${B}/customers`, manejador: (p) => {
      const nivel = p.query.get("nivel");
      const frecuencia = p.query.get("frecuencia");
      const dias = Number(p.query.get("inactivoDias") ?? 0);
      const buscar = (p.query.get("search") ?? "").toLowerCase();
      const customers = clientesMock(p).filter((c) => {
        if (nivel && c.tier !== nivel) return false;
        if (frecuencia === "una_vez" && c.orderCount !== 1) return false;
        if (frecuencia === "recurrentes" && c.orderCount < 2) return false;
        if (dias > 0 && c.lastOrderAt !== null && Date.parse(c.lastOrderAt) >= Date.now() - dias * DIA_MS) return false;
        if (buscar && !`${c.name ?? ""} ${c.phone}`.toLowerCase().includes(buscar)) return false;
        return true;
      });
      return { customers, nextCursor: null, filtrosDisponibles: true };
    } },
  { metodo: "GET", patron: `${B}/customers/kpis`, manejador: (p) => {
      const todos = clientesMock(p);
      return { disponible: true, total: todos.length, recurrentes: todos.filter((c) => c.orderCount >= 2).length, ticketPromedio: 192.2, masFrecuente: { nombre: "Marisol Pech", telefonoEnmascarado: "********0101", pedidos: 9, diasDesdeUltimoPedido: 2 } };
    } },
  { metodo: "POST", patron: `${B}/customers/import/preview`, roles: ["owner", "admin", "staff"], manejador: (p) => {
      const { filas } = (p.cuerpo ?? {}) as { filas?: FilaImportMock[] };
      const { validas, errores } = prepararImportMock(filas ?? []);
      return { total: (filas ?? []).length, validos: validas.length, duplicadosEnArchivo: 0, totalErrores: errores.length, errores, muestra: validas.slice(0, 5).map((v) => ({ nombre: v.name, telefonoEnmascarado: enmascarar(v.phone), direccion: null, notas: null })) };
    } },
  { metodo: "POST", patron: `${B}/customers/import`, roles: ["owner", "admin", "staff"], manejador: (p) => {
      const { huella, filas } = (p.cuerpo ?? {}) as { huella?: string; filas?: FilaImportMock[] };
      const hechas = p.estado.obtener<Record<string, unknown>>("rest.importaciones", () => ({}));
      const clave = String(huella);
      if (hechas[clave]) return { resultado: { ...(hechas[clave] as object), yaImportado: true } };
      const { validas, errores } = prepararImportMock(filas ?? []);
      const clientes = clientesMock(p);
      let creados = 0;
      let sinCambios = 0;
      for (const v of validas) {
        if (clientes.some((c) => c.phone.endsWith(v.phone))) {
          sinCambios += 1;
          continue;
        }
        clientes.push({ id: `cli-imp-${clientes.length + 1}`, name: v.name, phone: v.phone, orderCount: 0, tier: null, lastOrderAt: null });
        creados += 1;
      }
      const resultado = { yaImportado: false, total: (filas ?? []).length, creados, actualizados: 0, sinCambios, rechazados: errores.length, errores };
      hechas[clave] = resultado;
      return { resultado };
    } },
  { metodo: "GET", patron: `${B}/softrestaurant/config`, manejador: () => ({ modo: "apagado", disponible: true, adaptador: { nombre: "no-configurado", esReal: false }, umbralCapturaManual: { porOmisionMin: 5, minimo: 1, maximo: 240, disponible: true, porSucursal: {} } }) },
  { metodo: "GET", patron: `${B}/softrestaurant/comandas`, manejador: (p) => {
      const estados = (p.query.get("estado") ?? "captura_manual,fallida,pendiente,enviada").split(",");
      const todas = comandasMock(p);
      const resumen: Record<string, number> = { pendiente: 0, enviada: 0, confirmada: 0, fallida: 0, captura_manual: 0, capturada_manual: 0 };
      for (const c of todas) resumen[c.estado] = (resumen[c.estado] ?? 0) + 1;
      return { disponible: true, comandas: todas.filter((c) => estados.includes(c.estado)), resumen, requierenAtencion: (resumen["captura_manual"] ?? 0) + (resumen["fallida"] ?? 0) };
    } },
  { metodo: "POST", patron: `${B}/softrestaurant/comandas/:comandaId/capturada`, roles: ["owner", "admin", "staff"], manejador: (p) => {
      const c = comandasMock(p).find((x) => x.id === p.params["comandaId"]);
      if (!c) return fallo(404, "Comanda no encontrada.");
      if (!["pendiente", "fallida", "captura_manual"].includes(c.estado)) return fallo(409, `La comanda esta en estado '${c.estado}' y ya no admite captura manual.`);
      c.estado = "capturada_manual";
      c.notaCaptura = String(((p.cuerpo ?? {}) as { nota?: string }).nota ?? "") || null;
      c.capturadoEn = new Date().toISOString();
      return { comanda: c };
    } },
  { metodo: "GET", patron: `${B}/softrestaurant/estados`, manejador: (p) => {
      const ids = new Set((p.query.get("orderIds") ?? "").split(",").filter(Boolean));
      const estados: Record<string, string> = {};
      for (const c of comandasMock(p)) if (ids.has(c.orderId)) estados[c.orderId] = c.estado;
      return { disponible: true, estados };
    } },
  { metodo: "PUT", patron: `${B}/softrestaurant/umbral-captura-manual`, roles: ["owner", "admin"], manejador: (p) => ({ branchId: (p.cuerpo as { branchId?: string } | undefined)?.branchId, minutos: (p.cuerpo as { minutos?: number } | undefined)?.minutos }) },

  // Staff: gestion solo owner/admin (el servidor es la autoridad; la SPA solo oculta controles).
  { metodo: "GET", patron: `${B}/staff/repartidores`, manejador: () => ({ repartidores: [{ id: "usr-2", email: "ramon.uc@example.test", fullName: "Ramon Uc" }] }) },
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

  // Ajustes del agente (owner/admin): PUT completo con la misma validacion del servidor (lista permitida; temperatura solo si el modelo la admite).
  { metodo: "GET", patron: `${B}/agente/ajustes`, roles: ["owner", "admin"], manejador: (p) => {
      const g = p.estado.obtener<{ ajustes: AjustesMock; configurados: boolean }>("rest.ajustes-agente", () => ({ ajustes: { ...AJUSTES_POR_OMISION }, configurados: false }));
      return vistaAjustes(g.ajustes, g.configurados);
    } },
  { metodo: "PUT", patron: `${B}/agente/ajustes`, roles: ["owner", "admin"], manejador: (p) => {
      const c = (p.cuerpo ?? {}) as Partial<AjustesMock>;
      for (const k of Object.keys(AJUSTES_POR_OMISION)) if (!(k in c)) return fallo(400, `${k}: campo requerido (los ajustes se guardan completos para no borrar por omision lo que un cliente desactualizado no conoce).`);
      const lista = MODELOS_AJUSTES.map((m) => m.id);
      if (c.whatsappModelo !== null && !lista.includes(String(c.whatsappModelo))) return fallo(400, "whatsappModelo: no esta en la lista de modelos permitidos.");
      const efectivo = MODELOS_AJUSTES.find((m) => m.id === (c.whatsappModelo ?? "openai/gpt-6-luna"));
      if (c.whatsappTemperatura !== null && efectivo && !efectivo.aceptaTemperatura) return fallo(400, `whatsappTemperatura: ${efectivo.etiqueta} no admite temperatura; elige otro modelo o deja la temperatura en automatica.`);
      const nuevos = { ...AJUSTES_POR_OMISION, ...c } as AjustesMock;
      p.estado.guardar("rest.ajustes-agente", { ajustes: nuevos, configurados: true });
      return vistaAjustes(nuevos, true);
    } },
  { metodo: "GET", patron: `${B}/agente/conocimiento`, roles: ["owner", "admin"], manejador: () => CONOCIMIENTO_MOCK },
  { metodo: "GET", patron: `${B}/voz/config`, roles: ["owner", "admin"], manejador: (p) => p.estado.obtener("rest.voz-config", () => ({ ...VOZ_CONFIG_MOCK })) },
  { metodo: "PUT", patron: `${B}/voz/config`, roles: ["owner", "admin"], manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { habilitado?: boolean; voiceId?: string; comportamiento?: string; mensajeInicial?: string };
      if (typeof c.voiceId !== "string" || c.voiceId === "") return fallo(400, "voiceId: campo requerido (1 a 64 caracteres).");
      const nueva = { ...VOZ_CONFIG_MOCK, habilitado: Boolean(c.habilitado), voiceId: c.voiceId, comportamiento: c.comportamiento ?? "", mensajeInicial: c.mensajeInicial ?? "" };
      p.estado.guardar("rest.voz-config", nueva);
      return nueva;
    } },

  // ---- Pruebas del agente (UNI-R4): el chat de WhatsApp de demostracion y la llamada de prueba. Solo existen en la API simulada de e2e; el
  // contrato es el del servidor real (agente-preview.ts y voz-admin.ts): respuesta {respuesta, escalado, pedidoSimulado} y pedido PRUEBA-xxxx. ----
  { metodo: "GET", patron: `${B}/whatsapp/kpi`, roles: ["owner", "admin"], manejador: () => ({
      disponible: true, zonaHoraria: "America/Merida", hoy: "2026-10-08", desde: "2026-09-25", hasta: "2026-10-08",
      resumen: { dias: 14, conversaciones: 74, conversacionesConPedido: 52, conversacionesConHandoff: 4, conversionPct: 70.3, handoffPct: 5.4, pedidos: 52, handoffs: 4, pedidosOrg: 52, orgEsDemo: false, costoLlmOrgCentavosMxn: 18400, costoLlmPorPedidoCentavosMxn: 354 },
      serie: [{ fecha: "2026-10-06", conversaciones: 11, conversacionesConPedido: 8, conversionPct: 72.7, handoffPct: 0, pedidos: 8, handoffs: 0, pedidosOrg: 8, costoLlmOrgCentavosMxn: 2800, costoLlmPorPedidoCentavosMxn: 350 }, { fecha: "2026-10-07", conversaciones: 13, conversacionesConPedido: 9, conversionPct: 69.2, handoffPct: 7.7, pedidos: 9, handoffs: 1, pedidosOrg: 9, costoLlmOrgCentavosMxn: 3200, costoLlmPorPedidoCentavosMxn: 355 }],
      entrega: { disponible: false, resumen: { dias: 14, enviados: 0, entregados: 0, leidos: 0, fallidos: 0, sinEstado: 0, entregaPct: null, lecturaPct: null, fallosPorMotivo: {} }, serie: [] },
    }) },
  { metodo: "POST", patron: `${B}/agente-whatsapp/preview/mensaje`, roles: ["owner", "admin", "staff"], manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { mensajes?: { rol: string; texto: string }[] };
      const ultimo = [...(c.mensajes ?? [])].reverse().find((m) => m.rol === "usuario")?.texto ?? "";
      if (/pedido|quiero|tacos/i.test(ultimo)) {
        return { respuesta: "Listo, le anoto 3 tacos al pastor y una horchata para recoger. Son $183.00. ¿Confirmo su pedido?", escalado: false, pedidoSimulado: { id: "PRUEBA-AB12", branch: PROP.nombre, total: 183, status: "simulado", payment_method: "efectivo", simulado: true, items: [{ name: "Tacos al pastor (orden)", quantity: 3, price: 45 }, { name: "Horchata", quantity: 1, price: 48 }] } };
      }
      return { respuesta: "Hola, bienvenido a Taquería El Faro. ¿En qué le puedo ayudar hoy?", escalado: false, pedidoSimulado: null };
    } },
  { metodo: "POST", patron: `${B}/voz/preview/sesion`, roles: ["owner", "admin"], manejador: () => ({ sesionId: "ses-prueba-1", proveedor: "gemini", modelo: "gemini-3.8-live", voiceId: "Kore", websocketUrl: "wss://gemini.e2e.test/live", tokenProveedor: "tok-efimero", tokenPreview: "tok-preview", expiraEn: "2099-01-01T00:00:00.000Z" }) },
  { metodo: "POST", patron: `${B}/voz/preview/:sesionId/herramienta`, roles: ["owner", "admin"], manejador: () => ({ resultado: { ok: true }, simulado: true }) },
];

// ---- Ajustes del agente (migración 055) y conocimiento automatico. Solo existe en la API simulada de e2e: reproduce el contrato de
// apps/api/src/routes/verticals/restaurantes/ajustes-agente.ts (PUT completo, lista permitida, temperatura solo donde el modelo la admite). ----
const MODELOS_AJUSTES = [
  { id: "openai/gpt-6-luna", etiqueta: "GPT-6 Luna", nivel: "economico", descripcion: "El predeterminado de la plataforma: rapido y barato; sigue bien las reglas.", aceptaTemperatura: false, predeterminado: true, costoWhatsappMicroUsdPorMensaje: 800, costoVozMicroUsdPorMinuto: 1850, precioVerificadoEn: "2026-10-01" },
  { id: "deepseek/deepseek-v4.1-flash", etiqueta: "DeepSeek V4.1 Flash", nivel: "economico", descripcion: "Economico, servido solo desde proveedores de EE.UU. con retencion cero.", aceptaTemperatura: true, predeterminado: false, costoWhatsappMicroUsdPorMensaje: 1440, costoVozMicroUsdPorMinuto: 2640, precioVerificadoEn: "2026-10-02" },
  { id: "google/gemini-2.5-flash-lite", etiqueta: "Gemini 2.5 Flash-Lite", nivel: "economico", descripcion: "El mas barato; respuestas cortas y directas.", aceptaTemperatura: true, predeterminado: false, costoWhatsappMicroUsdPorMensaje: 760, costoVozMicroUsdPorMinuto: 1400, precioVerificadoEn: "2026-10-02" },
  { id: "anthropic/claude-sonnet-5.5", etiqueta: "Claude Sonnet 5.5", nivel: "premium", descripcion: "El de mayor calidad y el mas caro; solo si el volumen es bajo.", aceptaTemperatura: false, predeterminado: false, costoWhatsappMicroUsdPorMensaje: 16000, costoVozMicroUsdPorMinuto: 29000, precioVerificadoEn: "2026-10-01" },
];
const AJUSTES_POR_OMISION = { whatsappModelo: null as string | null, whatsappTemperatura: null as number | null, vozModeloCascada: null as string | null, vozTemperatura: null as number | null, vozRitmo: "normal", vozEstilo: "neutro", vozFondoActivo: false, vozFondoVolumen: 8 };
type AjustesMock = typeof AJUSTES_POR_OMISION;

function vistaAjustes(a: AjustesMock, configurados: boolean) {
  return {
    disponible: true,
    configurados,
    actualizadoEn: configurados ? "2026-10-04T10:00:00.000Z" : null,
    ajustes: a,
    modelos: MODELOS_AJUSTES,
    supuestosCosto: { whatsappMensaje: { tokensEntrada: 6000, tokensSalida: 400 }, vozCascadaMinuto: { tokensEntrada: 12000, tokensSalida: 500 }, nota: "Estimacion con precios de lista y un uso tipico; el costo real lo reporta OpenRouter por llamada. No es una factura." },
    temperatura: { min: 0, max: 1, paso: 0.1 },
    habla: { ritmos: ["pausado", "normal", "agil"], estilos: ["neutro", "calido", "sobrio", "animado"], nota: "Gemini Live no tiene un control numerico de velocidad ni de estabilidad: el ritmo y el estilo se piden al modelo por instruccion. La temperatura si es un parametro real." },
    fondo: { volumenMax: 20, porOmision: "apagado" },
    escaleraVoz: { principal: "gemini-3.8-live", respaldo: "cascada por OpenRouter" },
    aplicaEn: {
      whatsappModeloYTemperatura: "ahora",
      vozTemperaturaYHabla: "vista previa ahora; llamadas reales cuando se despliegue el servicio de llamadas",
      vozModeloCascada: "llamadas reales cuando se despliegue el servicio de llamadas (la cascada solo atiende llamadas)",
      vozFondo: "llamadas reales cuando se despliegue el servicio de llamadas (la mezcla ya esta probada en aislado)",
    },
    clonacionDeVoz: { disponible: false, motivo: "No disponible con el proveedor actual: Gemini Live solo ofrece las 30 voces del catalogo y no clona voces.", decision: "Clonar una voz exigiria contratar un proveedor de voz aparte (decision de Javier: costo, consentimiento de la persona clonada y una llave nueva)." },
    documentosOmitidos: [
      { tipo: "ventas", motivo: "El agente que atiende al cliente no necesita cifras de ventas para tomar un pedido; las preguntas de ventas del dueno las responde el Copiloto con datos en vivo." },
      { tipo: "personal", motivo: "El personal es informacion de personas (nombres, turnos, contacto): no es conocimiento del agente." },
    ],
  };
}

const CONOCIMIENTO_MOCK = {
  generadoEn: "2026-10-04T10:00:00.000Z",
  huella: "9f2c4a7be1d03a55",
  nota: "Estos documentos se generan al momento desde los datos de tu cuenta (sucursales, horarios, menu, colonias). No hay copia que se desactualice: al cambiar un dato, el documento cambia solo.",
  documentos: [
    { tipo: "sucursales_horarios", titulo: "Sucursales y horarios", contenido: `## ${PROP.nombre}\nDireccion: Calle 60 #400, Centro, Merida\nHorario: lunes a viernes de 12:00 a 22:00`, caracteres: 96, huella: "a1b2c3d4e5f6", vacio: false, motivoVacio: null, enPrompt: true },
    { tipo: "colonias_sucursal", titulo: "Colonia → sucursal más cercana", contenido: "", caracteres: 0, huella: "e3b0c442", vacio: true, motivoVacio: "No hay colonias conocidas configuradas.", enPrompt: false },
    { tipo: "faq", titulo: "Preguntas frecuentes", contenido: "P: ¿Dónde están?\nR: Calle 60 #400, Centro, Merida.", caracteres: 44, huella: "0f1e2d3c4b5a", vacio: false, motivoVacio: null, enPrompt: true },
    { tipo: "menu_precios", titulo: "Menú y precios", contenido: "- Tacos al pastor (orden): $95\n- Horchata: $48", caracteres: 41, huella: "5a4b3c2d1e0f", vacio: false, motivoVacio: null, enPrompt: true },
  ],
  prompt: { topeCaracteres: 6000, caracteresUsados: 310, omitidos: [] },
  alertasColonias: { umbralKm: 1, items: [], sinSucursal: 0 },
  documentosOmitidos: [
    { tipo: "ventas", motivo: "El agente que atiende al cliente no necesita cifras de ventas para tomar un pedido; las preguntas de ventas del dueno las responde el Copiloto con datos en vivo." },
    { tipo: "personal", motivo: "El personal es informacion de personas (nombres, turnos, contacto): no es conocimiento del agente." },
  ],
};

const VOZ_CONFIG_MOCK = { disponible: true, configurada: true, habilitado: false, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "Hola, le atiende el asistente virtual de Taqueria El Faro." };


export const restaurantes = { orgSlug: ORG.slug, propertyId: PROP.id };
