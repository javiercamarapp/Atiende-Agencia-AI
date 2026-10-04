// Fixtures del PANEL de restaurantes para el recorrido completo (qa-e2e-restaurantes): las lecturas que el humo no cubria
// (onboarding, config, conversaciones, turnos, voz, privacidad, promociones, auditoria, WhatsApp) y las ESCRITURAS reales de
// cada control (pedidos, productos, promociones, staff, config...) con estado por escenario: un POST/PATCH se refleja en el
// GET siguiente. La forma de cada respuesta copia los tipos de apps/web/src/verticals/restaurantes/lib/*-client.ts.
// Solo existe en la API simulada de e2e: jamas se usa contra el backend ni la base reales.
import { conStatus, fallo } from "../respuestas.ts";
import { propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";
import { ORDENES_SEMILLA, ENTREGAS_SEMILLA } from "./restaurantes.ts";

const PROP = propiedadDe("restaurantes");
const B = "/v1/restaurantes/:id/admin";

type Orden = (typeof ORDENES_SEMILLA)[number];
type Entrega = (typeof ENTREGAS_SEMILLA)[number];

/** Estados validos siguientes (mismo grafo que lib/orders-client.ts NEXT_STATUSES). */
const SIGUIENTES: Record<string, readonly string[]> = {
  programado: ["pending", "cancelado"],
  pending: ["preparando", "cancelado", "problema"],
  preparando: ["en_camino", "listo_para_recoger", "cancelado", "problema"],
  en_camino: ["entregado", "problema"],
  listo_para_recoger: ["entregado", "no_recogido", "cancelado", "problema"],
  no_recogido: ["preparando", "cancelado"],
  entregado: ["completado", "problema"],
  problema: ["preparando", "cancelado"],
  cancelado: [],
  completado: [],
};

const CATEGORIAS_SEMILLA = [
  { id: "cat-1", name: "Tacos", slug: "tacos", displayOrder: 1 },
  { id: "cat-2", name: "Bebidas", slug: "bebidas", displayOrder: 2 },
];

const PRODUCTOS_SEMILLA = [
  { id: "p-1", categoryId: "cat-1", categoryName: "Tacos", name: "Tacos al pastor (orden)", description: "Cinco tacos con pina y cilantro", price: 95, imageUrl: null, isPopular: true, isAvailable: true, displayOrder: 1, searchKeywords: ["pastor"], branch: { propertyId: PROP.id, productId: "p-1", price: 95, isAvailable: true } },
  { id: "p-2", categoryId: "cat-2", categoryName: "Bebidas", name: "Horchata", description: null, price: 48, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 2, searchKeywords: [], branch: { propertyId: PROP.id, productId: "p-2", price: 48, isAvailable: true } },
];

const PROMOCIONES_SEMILLA = [
  { id: "promo-1", code: "BIENVENIDA10", name: "Bienvenida 10%", description: "Descuento para clientes nuevos", type: "percentage", value: 10, minOrderTotal: 150, startsAt: null, endsAt: "2027-12-31T23:59:00.000Z", daysOfWeek: null, startTime: null, endTime: null, maxUses: 100, timesUsed: 12, isActive: true, channels: ["domicilio", "recoger"], productIds: null, autoApply: false, courtesyProductIds: null, courtesyQuantity: null, createdAt: "2026-09-01T15:00:00.000Z", updatedAt: "2026-09-01T15:00:00.000Z" },
];

const CHECKLIST = {
  items: [
    { id: "sucursales", titulo: "Sucursal con direccion y coordenadas", estado: "hecho", obligatorio: true, detalle: "1 de 1 sucursal lista.", faltantes: [], responsable: "dueno", pantalla: "sucursales" },
    { id: "menu", titulo: "Menu con al menos un producto disponible", estado: "hecho", obligatorio: true, detalle: "2 productos disponibles.", faltantes: [], responsable: "dueno", pantalla: "productos" },
    { id: "whatsapp", titulo: "Numero de WhatsApp Business conectado", estado: "pendiente", obligatorio: true, detalle: "Falta registrar el identificador del numero.", faltantes: ["Sucursal Centro"], responsable: "meta", pantalla: "configuracion" },
    { id: "pedidos", titulo: "Primer pedido recibido", estado: "externo", obligatorio: false, detalle: "Depende de que los clientes empiecen a pedir.", faltantes: [], responsable: "dueno", pantalla: "pedidos" },
  ],
  resumen: { hechos: 2, total: 4, obligatoriosPendientes: 1 },
  listoParaOperar: false,
};

const COBERTURA = { sinCobertura: false, turnosVigentes: [{ id: "turno-1", nombre: "Comida", inicia: "12:00", termina: "01:00" }], guardia: [{ userId: "usr-1", nombre: "Lucia Xool", turno: "Comida", orden: 1 }] };

const ZONAS_SEMILLA = [{ id: "zona-1", name: "Centro", lat: 20.9674, lng: -89.6237, createdAt: "2026-09-01T15:00:00.000Z" }];

const AGENTE_BASE = { perfil: "taqueria_pm", agentName: "Mari", businessName: "Taqueria El Faro", toneStyle: "calido_cercano", deliveryTimeText: "30 a 40 minutos", greetingText: null, salsasText: null, promosText: null, escalationReasonsOff: [] as string[], largeOrderText: null, replyDebounceSeconds: null, version: 3 };

const hoyIso = (): string => new Date().toISOString().slice(0, 10);

function dias(n: number): Array<{ fecha: string; conversaciones: number; conversacionesConPedido: number; conversionPct: number | null; handoffPct: number | null; pedidos: number; handoffs: number; pedidosOrg: number | null; costoLlmOrgCentavosMxn: number | null; costoLlmPorPedidoCentavosMxn: number | null }> {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { fecha: d, conversaciones: 8 + i, conversacionesConPedido: 5 + (i % 3), conversionPct: 62, handoffPct: 9, pedidos: 5 + (i % 3), handoffs: 1, pedidosOrg: 5 + (i % 3), costoLlmOrgCentavosMxn: 1200 + i * 10, costoLlmPorPedidoCentavosMxn: 210 };
  });
}

const totalesVoz = (d: number) => ({ dias: d, llamadas: 14 * d, llamadasCerradas: 13 * d, duracionPromedioS: 96, pedidosVoz: 9 * d, escaladas: d, abandonadas: d, tasaResolucionPct: 70, tasaHandoffPct: 8, tasaAbandonoPct: 8, erroresProveedor: 0, erroresTwilio: 0, erroresOtros: 0, tasaErrorPct: 0, toolCalls: 40 * d, toolP95PeorDiaMs: 820, costoVozMicroUsd: 1_800_000 * d, costoTelefoniaMicroUsd: 400_000 * d, costoCentavosMxn: 4200 * d, costoCompleto: true, costoPorLlamadaCentavosMxn: 300, costoLlmOrgCentavosMxn: 900 * d });

function ordenes(p: { estado: { obtener<T>(k: string, s: () => T): T } }): Orden[] {
  return p.estado.obtener<Orden[]>("rest.ordenes", () => structuredClone(ORDENES_SEMILLA));
}
function entregas(p: { estado: { obtener<T>(k: string, s: () => T): T } }): Entrega[] {
  return p.estado.obtener<Entrega[]>("rest.entregas", () => structuredClone(ENTREGAS_SEMILLA));
}
function lista<T>(p: { estado: { obtener<T2>(k: string, s: () => T2): T2 } }, clave: string, semilla: readonly T[]): T[] {
  return p.estado.obtener<T[]>(clave, () => structuredClone([...semilla]));
}

function sucursal(p: { estado: { obtener<T>(k: string, s: () => T): T } }) {
  return p.estado.obtener("rest.sucursal", () => ({ propertyId: PROP.id, name: PROP.nombre, slug: "centro", status: "active" as "active" | "inactive", phone: "+529995550100" as string | null, address: "Calle 60 #400, Centro, Merida" as string | null, lat: 20.9674 as number | null, lng: -89.6237 as number | null }));
}

export const rutasRestaurantesPanel: readonly Ruta[] = [
  // ---------- Pedidos (estado compartido con el repartidor y el Historial) ----------
  {
    metodo: "GET",
    patron: `${B}/orders`,
    manejador: (p) => {
      const estado = p.query.get("status");
      return { orders: ordenes(p).filter((o) => (estado ? o.status === estado : true)), nextCursor: null };
    },
  },
  {
    metodo: "PATCH",
    patron: `${B}/orders/:orderId/status`,
    manejador: (p) => {
      const o = ordenes(p).find((x) => x.id === p.params["orderId"]);
      if (!o) return fallo(404, "Ese pedido no existe");
      const siguiente = String(((p.cuerpo ?? {}) as { status?: string }).status ?? "");
      if (!SIGUIENTES[o.status]?.includes(siguiente)) return fallo(409, `No se puede pasar de ${o.status} a ${siguiente}`);
      o.status = siguiente;
      const e = entregas(p).find((x) => x.id === o.id);
      if (e) e.status = siguiente;
      return { order: o };
    },
  },
  {
    metodo: "PATCH",
    patron: `${B}/orders/:orderId/assign-repartidor`,
    manejador: (p) => {
      const o = ordenes(p).find((x) => x.id === p.params["orderId"]);
      if (!o) return fallo(404, "Ese pedido no existe");
      const cuerpo = (p.cuerpo ?? {}) as { repartidorId?: string; estimatedDeliveryAt?: string | null };
      if (!cuerpo.repartidorId) return fallo(400, "Repartidor requerido");
      o.assignedRepartidorId = cuerpo.repartidorId;
      o.estimatedDeliveryAt = cuerpo.estimatedDeliveryAt ?? null;
      // El pedido aparece en "Mis entregas" del repartidor (mismo id).
      const lista = entregas(p);
      if (!lista.some((x) => x.id === o.id)) {
        lista.push({ id: o.id, propertyId: o.propertyId, branch: o.branch, customerName: o.customerName, customerPhone: o.customerPhone, customerAddress: o.customerAddress ?? "Calle 60 #412, Centro", total: o.total, status: o.status, items: o.items, notes: o.notes, paymentMethod: o.paymentMethod as "efectivo", estimatedDeliveryAt: o.estimatedDeliveryAt, incidentNote: null, createdAt: o.createdAt });
      }
      return { order: o };
    },
  },

  // ---------- Catalogo ----------
  { metodo: "GET", patron: `${B}/categories`, manejador: (p) => ({ categories: lista(p, "rest.categorias", CATEGORIAS_SEMILLA) }) },
  {
    metodo: "POST",
    patron: `${B}/categories`,
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { name?: string; slug?: string };
      if (!cuerpo.name?.trim()) return fallo(400, "El nombre es obligatorio");
      const cats = lista(p, "rest.categorias", CATEGORIAS_SEMILLA);
      const c = { id: `cat-${cats.length + 1}`, name: cuerpo.name.trim(), slug: cuerpo.slug ?? cuerpo.name.toLowerCase(), displayOrder: cats.length + 1 };
      cats.push(c);
      return conStatus(201, { category: c });
    },
  },
  { metodo: "GET", patron: `${B}/products`, manejador: (p) => ({ products: lista(p, "rest.productos", PRODUCTOS_SEMILLA) }) },
  {
    metodo: "POST",
    patron: `${B}/products`,
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { name?: string; price?: number; categoryId?: string | null; description?: string | null };
      if (!cuerpo.name?.trim() || typeof cuerpo.price !== "number") return fallo(400, "Nombre y precio son obligatorios");
      const prods = lista(p, "rest.productos", PRODUCTOS_SEMILLA);
      const cat = lista(p, "rest.categorias", CATEGORIAS_SEMILLA).find((c) => c.id === cuerpo.categoryId);
      const n = {
        id: `p-${prods.length + 1}`,
        categoryId: cuerpo.categoryId ?? null,
        categoryName: cat?.name ?? null,
        name: cuerpo.name.trim(),
        description: cuerpo.description ?? null,
        price: cuerpo.price,
        imageUrl: null,
        isPopular: false,
        isAvailable: true,
        displayOrder: prods.length + 1,
        searchKeywords: [] as string[],
        branch: { propertyId: PROP.id, productId: `p-${prods.length + 1}`, price: cuerpo.price, isAvailable: true },
      };
      prods.push(n as (typeof prods)[number]);
      return conStatus(201, { product: n });
    },
  },
  {
    metodo: "PATCH",
    patron: `${B}/products/:productId/branch-availability`,
    manejador: (p) => {
      const prod = lista(p, "rest.productos", PRODUCTOS_SEMILLA).find((x) => x.id === p.params["productId"]);
      if (!prod) return fallo(404, "Ese producto no existe");
      const cuerpo = (p.cuerpo ?? {}) as { price?: number; isAvailable?: boolean };
      if (cuerpo.price !== undefined) prod.branch = { ...prod.branch!, price: cuerpo.price };
      if (cuerpo.isAvailable !== undefined) prod.branch = { ...prod.branch!, isAvailable: cuerpo.isAvailable };
      return { branch: prod.branch };
    },
  },
  {
    metodo: "PATCH",
    patron: `${B}/products/:productId`,
    manejador: (p) => {
      const prod = lista(p, "rest.productos", PRODUCTOS_SEMILLA).find((x) => x.id === p.params["productId"]);
      if (!prod) return fallo(404, "Ese producto no existe");
      Object.assign(prod, p.cuerpo ?? {});
      return { product: prod };
    },
  },
  { metodo: "GET", patron: `${B}/config/no-domicilio`, manejador: (p) => p.estado.obtener("rest.nodomicilio", () => ({ productIds: [] as string[], categoryIds: [] as string[] })) },
  {
    metodo: "PUT",
    patron: `${B}/config/no-domicilio/:tipo/:itemId`,
    manejador: (p) => {
      const marcas = p.estado.obtener("rest.nodomicilio", () => ({ productIds: [] as string[], categoryIds: [] as string[] }));
      const clave = p.params["tipo"] === "categorias" ? "categoryIds" : "productIds";
      const id = String(p.params["itemId"]);
      const activo = Boolean(((p.cuerpo ?? {}) as { noDomicilio?: boolean }).noDomicilio);
      marcas[clave] = activo ? [...new Set([...marcas[clave], id])] : marcas[clave].filter((x) => x !== id);
      return { id, noDomicilio: activo };
    },
  },

  // ---------- Promociones ----------
  { metodo: "GET", patron: `${B}/promotions`, manejador: (p) => ({ promotions: lista(p, "rest.promos", PROMOCIONES_SEMILLA) }) },
  {
    metodo: "POST",
    patron: `${B}/promotions`,
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { code?: string; name?: string; type?: string; value?: number };
      if (!cuerpo.code || !cuerpo.name) return fallo(400, "Codigo y nombre son obligatorios");
      const promos = lista(p, "rest.promos", PROMOCIONES_SEMILLA);
      const nueva = { ...PROMOCIONES_SEMILLA[0]!, id: `promo-${promos.length + 1}`, timesUsed: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...cuerpo } as (typeof promos)[number];
      promos.push(nueva);
      return conStatus(201, { promotion: nueva });
    },
  },
  {
    metodo: "PATCH",
    patron: `${B}/promotions/:promoId`,
    manejador: (p) => {
      const promo = lista(p, "rest.promos", PROMOCIONES_SEMILLA).find((x) => x.id === p.params["promoId"]);
      if (!promo) return fallo(404, "Esa promocion no existe");
      Object.assign(promo, p.cuerpo ?? {});
      return { promotion: promo };
    },
  },

  // ---------- Clientes (ficha) ----------
  {
    metodo: "GET",
    patron: `${B}/customers/:customerId`,
    manejador: (p) => ({ customer: p.params["customerId"] === "cli-1" ? { isNew: false, name: "Marisol Pech", orderCount: 9, addresses: [{ address: "Calle 60 #412, Centro", label: "Casa", isDefault: true }], lastOrderItems: [{ name: "Tacos al pastor (orden)", quantity: 2 }], frequentItems: [{ name: "Horchata", quantity: 7 }], tier: "GOLD", agentNotes: ["Prefiere sin cebolla"] } : { isNew: true } }),
  },

  // ---------- Sucursales ----------
  { metodo: "GET", patron: `${B}/sucursales`, manejador: (p) => ({ branches: [sucursal(p)] }) },
  { metodo: "PATCH", patron: `${B}/sucursales/:branchId`, manejador: (p) => { Object.assign(sucursal(p), p.cuerpo ?? {}); return { branch: sucursal(p) }; } },
  { metodo: "GET", patron: `${B}/sucursales/:branchId`, manejador: (p) => ({ branch: sucursal(p) }) },
  { metodo: "GET", patron: `${B}/config/sucursales/:branchId/politica`, manejador: (p) => p.estado.obtener("rest.politica", () => ({ horario: [{ dias: [1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }], pedidoMinimoDomicilio: 120, pedidoMinimoRecoger: null, propinaPolitica: "solo_tarjeta" })) },
  { metodo: "PUT", patron: `${B}/config/sucursales/:branchId/politica`, manejador: (p) => { p.estado.guardar("rest.politica", p.cuerpo); return p.cuerpo; } },
  { metodo: "GET", patron: `${B}/config/sucursales/:branchId/zonas-reparto`, manejador: (p) => ({ zoneIds: p.estado.obtener("rest.zonasreparto", () => [] as string[]) }) },
  { metodo: "PUT", patron: `${B}/config/sucursales/:branchId/zonas-reparto`, manejador: (p) => { const z = ((p.cuerpo ?? {}) as { zoneIds?: string[] }).zoneIds ?? []; p.estado.guardar("rest.zonasreparto", z); return { zoneIds: z }; } },
  { metodo: "GET", patron: `${B}/config/sucursales/:branchId/whatsapp`, manejador: (p) => ({ phoneNumberId: p.estado.obtener<string | null>("rest.wa-sucursal", () => null) }) },
  { metodo: "PUT", patron: `${B}/config/sucursales/:branchId/whatsapp`, manejador: (p) => { const v = String(((p.cuerpo ?? {}) as { phoneNumberId?: string }).phoneNumberId ?? ""); p.estado.guardar("rest.wa-sucursal", v); return { phoneNumberId: v }; } },
  { metodo: "DELETE", patron: `${B}/config/sucursales/:branchId/whatsapp`, manejador: (p) => { p.estado.guardar("rest.wa-sucursal", null); return { ok: true }; } },
  { metodo: "GET", patron: `${B}/config/puentes`, manejador: (p) => ({ puentes: lista(p, "rest.puentes", []) }) },

  // ---------- Staff: invitaciones ----------
  { metodo: "GET", patron: `${B}/staff/invitaciones`, roles: ["owner", "admin"], manejador: (p) => ({ invitations: lista<Record<string, unknown>>(p, "rest.invitaciones", []) }) },
  {
    metodo: "POST",
    patron: `${B}/staff/invitaciones`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { email?: string; verticalRole?: string };
      if (!cuerpo.email?.includes("@")) return fallo(400, "Correo invalido");
      const invs = lista<Record<string, unknown>>(p, "rest.invitaciones", []);
      const inv = { id: `inv-${invs.length + 1}`, email: cuerpo.email, verticalRole: cuerpo.verticalRole ?? "staff", propertyIds: null, status: "pendiente", expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), createdAt: new Date().toISOString() };
      invs.push(inv);
      return conStatus(201, { ...inv, inviteToken: "token-de-prueba" });
    },
  },
  {
    metodo: "DELETE",
    patron: `${B}/staff/invitaciones/:inviteId`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const invs = lista<Record<string, unknown>>(p, "rest.invitaciones", []);
      const i = invs.findIndex((x) => x["id"] === p.params["inviteId"]);
      if (i < 0) return fallo(404, "Esa invitacion no existe");
      invs.splice(i, 1);
      return { ok: true };
    },
  },

  // ---------- Onboarding, auditoria, privacidad ----------
  { metodo: "GET", patron: `${B}/onboarding`, roles: ["owner", "admin"], manejador: () => CHECKLIST },
  {
    metodo: "GET",
    patron: `${B}/auditoria`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const tipo = p.query.get("tipo");
      const items = [
        { id: "aud-1", actorUserId: "usr-owner", action: "producto.precio_actualizado", entityType: "producto", entityId: "p-1", campo: "precio", antes: "90", despues: "95", creadoEn: "2026-09-30T17:00:00.000Z" },
        { id: "aud-2", actorUserId: "usr-owner", action: "staff.rol_actualizado", entityType: "staff", entityId: "usr-1", campo: "rol", antes: "repartidor", despues: "staff", creadoEn: "2026-09-29T17:00:00.000Z" },
      ].filter((x) => !tipo || x.entityType === tipo);
      return { disponible: true, total: items.length, nextOffset: null, items };
    },
  },
  {
    metodo: "GET",
    patron: `${B}/privacidad/configuracion`,
    roles: ["owner", "admin"],
    manejador: (p) => ({ configuracion: p.estado.obtener("rest.privacidad", () => ({ responsable: "Taqueria El Faro SA de CV", avisoUrl: "https://example.test/aviso", avisoVersion: "2026-09", retencionConversacionesDias: 365, retencionVozDias: 90, exigirConsentimientoGrabacion: true, configurada: true })) }),
  },
  {
    metodo: "PUT",
    patron: `${B}/privacidad/configuracion`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const nueva = { ...((p.cuerpo ?? {}) as object), configurada: true };
      p.estado.guardar("rest.privacidad", nueva);
      return { configuracion: nueva };
    },
  },
  {
    metodo: "GET",
    patron: `${B}/privacidad/solicitudes`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const items = p.estado.obtener("rest.arco", () => [{ id: "arco-1", folio: "ARCO-0001", telefono: "+529995550101", derecho: "acceso", estado: "recibida", plazo: "en_plazo", solicitadaEn: "2026-09-28T16:00:00.000Z", respuestaVenceEn: "2026-10-20T16:00:00.000Z", ejecucionVenceEn: null, notaResolucion: null, canal: "whatsapp", identidadVerificadaPor: "whatsapp_numero" }]);
      return { disponible: true, total: items.length, nextOffset: null, plazos: { respuestaDias: 20, ejecucionDias: 15 }, items };
    },
  },
  {
    metodo: "PATCH",
    patron: `${B}/privacidad/solicitudes/:requestId/estado`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const items = p.estado.obtener<Array<{ id: string; estado: string }>>("rest.arco", () => []);
      const it = items.find((x) => x.id === p.params["requestId"]);
      if (!it) return fallo(404, "Esa solicitud no existe");
      it.estado = String(((p.cuerpo ?? {}) as { estado?: string }).estado ?? it.estado);
      return { id: it.id, estado: it.estado };
    },
  },

  // ---------- Configuracion (WhatsApp, zona horaria, zonas) ----------
  { metodo: "GET", patron: `${B}/config/whatsapp`, roles: ["owner", "admin"], manejador: (p) => ({ phoneNumberId: p.estado.obtener<string | null>("rest.wa", () => null) }) },
  { metodo: "PUT", patron: `${B}/config/whatsapp`, roles: ["owner", "admin"], manejador: (p) => { const v = String(((p.cuerpo ?? {}) as { phoneNumberId?: string }).phoneNumberId ?? ""); p.estado.guardar("rest.wa", v); return { phoneNumberId: v }; } },
  { metodo: "GET", patron: `${B}/config/zona-horaria`, roles: ["owner", "admin"], manejador: (p) => ({ zonaHoraria: p.estado.obtener<string | null>("rest.tz", () => "America/Merida") }) },
  { metodo: "PATCH", patron: `${B}/config/zona-horaria`, roles: ["owner", "admin"], manejador: (p) => { const v = ((p.cuerpo ?? {}) as { zona_horaria?: string | null }).zona_horaria ?? null; p.estado.guardar("rest.tz", v); return { zonaHoraria: v }; } },
  { metodo: "GET", patron: `${B}/config/zonas`, roles: ["owner", "admin"], manejador: (p) => ({ zonas: lista(p, "rest.zonas", ZONAS_SEMILLA) }) },
  {
    metodo: "POST",
    patron: `${B}/config/zonas`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { name?: string; lat?: number; lng?: number };
      if (!cuerpo.name?.trim()) return fallo(400, "El nombre es obligatorio");
      const zonas = lista(p, "rest.zonas", ZONAS_SEMILLA);
      const z = { id: `zona-${zonas.length + 1}`, name: cuerpo.name.trim(), lat: cuerpo.lat ?? 0, lng: cuerpo.lng ?? 0, createdAt: new Date().toISOString() };
      zonas.push(z);
      return conStatus(201, z);
    },
  },
  {
    metodo: "DELETE",
    patron: `${B}/config/zonas/:zoneId`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const zonas = lista(p, "rest.zonas", ZONAS_SEMILLA);
      const i = zonas.findIndex((z) => z.id === p.params["zoneId"]);
      if (i < 0) return fallo(404, "Esa zona no existe");
      zonas.splice(i, 1);
      return { ok: true };
    },
  },

  // ---------- Agente de WhatsApp ----------
  { metodo: "GET", patron: `${B}/config/agente-whatsapp/opciones`, roles: ["owner", "admin"], manejador: () => ({ perfiles: [{ perfil: "generico", agentName: null, businessName: "Tu negocio", toneStyle: "calido_cercano", deliveryTimeText: "30 a 45 minutos" }, { perfil: "taqueria_pm", agentName: "Mari", businessName: "Taqueria", toneStyle: "formal_directo", deliveryTimeText: "30 a 40 minutos" }], tonos: ["calido_cercano", "formal_directo", "profesional_neutro", "divertido_desenfadado"], motivosDesactivables: ["pedido_grande", "zona_ambigua", "producto_agotado", "no_entiende"], limites: { agentName: 40, businessName: 80, deliveryTimeText: 120, greetingText: 400, salsasText: 400, promosText: 400, largeOrderText: 400 }, esperaRafagasMaxSegundos: 30 }) },
  { metodo: "GET", patron: `${B}/config/agente-whatsapp/historial`, roles: ["owner", "admin"], manejador: () => ({ entradas: [] }) },
  { metodo: "POST", patron: `${B}/config/agente-whatsapp/vista-previa`, roles: ["owner", "admin"], manejador: () => ({ prompt: "Eres Mari, la asistente de Taqueria El Faro.", promptVigente: "Eres Mari.", diferenciasCampos: [{ campo: "agentName", antes: "", despues: "Mari" }], diferenciasPrompt: [{ tipo: "igual", texto: "Eres" }, { tipo: "agregada", texto: "Mari, la asistente de Taqueria El Faro." }], version: 3 }) },
  { metodo: "POST", patron: `${B}/config/agente-whatsapp/restablecer`, roles: ["owner", "admin"], manejador: (p) => { p.estado.guardar("rest.agente", null); return { ...AGENTE_BASE, version: 4 }; } },
  { metodo: "PUT", patron: `${B}/config/agente-whatsapp`, roles: ["owner", "admin"], manejador: (p) => { const c = { ...AGENTE_BASE, ...((p.cuerpo ?? {}) as object), version: 4 }; p.estado.guardar("rest.agente", c); return c; } },
  { metodo: "GET", patron: `${B}/config/agente-whatsapp`, roles: ["owner", "admin"], manejador: (p) => ({ organizacion: p.estado.obtener("rest.agente", () => AGENTE_BASE), sucursal: null }) },
  { metodo: "GET", patron: `${B}/whatsapp/kpi`, roles: ["owner", "admin"], manejador: (p) => {
      const n = Number(p.query.get("dias") ?? "7");
      return { disponible: true, zonaHoraria: "America/Merida", hoy: hoyIso(), desde: new Date(Date.now() - (n - 1) * 86_400_000).toISOString().slice(0, 10), hasta: hoyIso(), resumen: { dias: n, conversaciones: 74, conversacionesConPedido: 52, conversacionesConHandoff: 7, conversionPct: 70, handoffPct: 9, pedidos: 52, handoffs: 7, pedidosOrg: 96, orgEsDemo: false, costoLlmOrgCentavosMxn: 8600, costoLlmPorPedidoCentavosMxn: 165 }, serie: dias(Math.min(n, 14)) };
    } },

  // ---------- Conversaciones, handoffs, callbacks, turnos ----------
  {
    metodo: "GET",
    patron: `${B}/conversaciones/:canal/:conversationId`,
    manejador: (p) => ({ canal: p.params["canal"], conversationId: p.params["conversationId"], transcripcionDisponible: true, mensajes: [{ rol: "cliente", texto: "Hola, quiero una orden de tacos", creadoEn: "2026-09-30T18:00:00.000Z" }, { rol: "agente", texto: "Con gusto, para cuando la necesita?", creadoEn: "2026-09-30T18:00:10.000Z" }], handoff: p.estado.obtener<{ estado: string } | null>("rest.handoff", () => ({ estado: "pendiente" })) ? { handoffId: "ho-1", estado: p.estado.obtener("rest.handoff-estado", () => "pendiente"), solicitadoPor: "agente", motivo: "El cliente pidio hablar con una persona", solicitadaEn: "2026-09-30T18:02:00.000Z", tomadaPor: null, tomadaPorNombre: null } : null, notas: p.estado.obtener("rest.handoff-notas", () => [] as unknown[]) }),
  },
  {
    metodo: "GET",
    patron: `${B}/conversaciones`,
    manejador: (p) => {
      const estado = p.estado.obtener("rest.handoff-estado", () => "pendiente");
      return { disponible: true, total: 1, nextOffset: null, cobertura: COBERTURA, items: [{ canal: "whatsapp", conversationId: "conv-1", telefono: "+529995550101", vistaPrevia: "Hola, quiero una orden de tacos", actividadEn: "2026-09-30T18:02:00.000Z", estado, handoffId: "ho-1", motivo: "El cliente pidio hablar con una persona", solicitadaEn: "2026-09-30T18:02:00.000Z", tomadaPor: null, tomadaPorNombre: null, resultadoVoz: null, escalacion: null }] };
    },
  },
  { metodo: "POST", patron: `${B}/conversaciones/:canal/:conversationId/tomar`, manejador: (p) => { p.estado.guardar("rest.handoff-estado", "tomada"); return { handoffId: "ho-1" }; } },
  { metodo: "POST", patron: `${B}/handoffs/:handoffId/devolver`, manejador: (p) => { p.estado.guardar("rest.handoff-estado", "devuelta"); return { estado: "devuelta", cambio: true }; } },
  { metodo: "POST", patron: `${B}/handoffs/:handoffId/cerrar`, manejador: (p) => { p.estado.guardar("rest.handoff-estado", "cerrada"); return { estado: "cerrada", cambio: true }; } },
  { metodo: "POST", patron: `${B}/handoffs/:handoffId/notas`, manejador: (p) => { const notas = p.estado.obtener("rest.handoff-notas", () => [] as unknown[]); const texto = String(((p.cuerpo ?? {}) as { texto?: string }).texto ?? ""); notas.push({ id: `nota-${notas.length + 1}`, autor: "Owner restaurantes", texto, creadoEn: new Date().toISOString() }); return { id: `nota-${notas.length}` }; } },
  { metodo: "POST", patron: `${B}/handoffs/:handoffId/responder`, manejador: () => ({ encolado: true }) },
  { metodo: "GET", patron: `${B}/callbacks`, manejador: () => ({ disponible: true, items: [] }) },
  { metodo: "GET", patron: `${B}/turnos`, manejador: (p) => ({ disponible: true, turnos: p.estado.obtener("rest.turnos", () => [{ id: "turno-1", nombre: "Comida", dias: [1, 2, 3, 4, 5, 6], inicia: "12:00", termina: "01:00", miembros: [{ userId: "usr-1", nombre: "Lucia Xool", orden: 1 }] }]), cobertura: COBERTURA }) },
  { metodo: "PUT", patron: `${B}/turnos`, manejador: (p) => { const t = ((p.cuerpo ?? {}) as { turnos?: unknown[] }).turnos ?? []; p.estado.guardar("rest.turnos", t); return { disponible: true }; } },

  // ---------- Agente de voz ----------
  { metodo: "GET", patron: `${B}/voz/config`, roles: ["owner", "admin"], manejador: (p) => p.estado.obtener("rest.voz", () => ({ disponible: true, configurada: true, habilitado: true, voiceId: "voz-1", comportamiento: "Atiende pedidos por telefono.", mensajeInicial: "Taqueria El Faro, en que le ayudo?" })) },
  { metodo: "PUT", patron: `${B}/voz/config`, roles: ["owner", "admin"], manejador: (p) => { const c = { disponible: true, configurada: true, ...((p.cuerpo ?? {}) as object) }; p.estado.guardar("rest.voz", c); return c; } },
  { metodo: "GET", patron: `${B}/voz/catalogo`, roles: ["owner", "admin"], manejador: () => ({ salud: { ok: true, detalle: "Servicio de voz operativo." } }) },
  { metodo: "GET", patron: `${B}/voz/conversaciones`, roles: ["owner", "admin"], manejador: () => ({ disponible: true, items: [{ id: "voz-conv-1", iniciadaEn: "2026-09-30T18:30:00.000Z", duracionS: 84, costoEstimadoMicroUsd: 120000, resultado: "pedido_creado" }] }) },
  { metodo: "GET", patron: `${B}/voz/conversaciones/:conversationId`, roles: ["owner", "admin"], manejador: () => ({ id: "voz-conv-1", iniciadaEn: "2026-09-30T18:30:00.000Z", duracionS: 84, costoEstimadoMicroUsd: 120000, resultado: "pedido_creado", turnos: [{ rol: "agente", texto: "Taqueria El Faro, en que le ayudo?", creadoEn: "2026-09-30T18:30:02.000Z" }, { rol: "usuario", texto: "Una orden de pastor", creadoEn: "2026-09-30T18:30:08.000Z" }] }) },
  { metodo: "GET", patron: `${B}/voz/kpi`, roles: ["owner", "admin"], manejador: () => ({ disponible: true, zonaHoraria: "America/Merida", hoy: hoyIso(), diaDeHoy: totalesVoz(1), mes: totalesVoz(30), serie: dias(7).map((d) => ({ fecha: d.fecha, llamadas: 14, pedidosVoz: 9, escaladas: 1, erroresProveedor: 0, toolP95Ms: 800, costoCentavosMxn: 4200 })) }) },
];
