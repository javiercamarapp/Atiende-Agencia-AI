// Fixtures del PANEL de restaurantes para el recorrido completo (qa-e2e-restaurantes): las lecturas que el humo no cubria
// (onboarding, config, conversaciones, turnos, voz, privacidad, promociones, auditoria, WhatsApp) y las ESCRITURAS reales de
// cada control (pedidos, productos, promociones, staff, config...) con estado por escenario: un POST/PATCH se refleja en el
// GET siguiente. La forma de cada respuesta copia los tipos de apps/web/src/verticals/restaurantes/lib/*-client.ts.
// Solo existe en la API simulada de e2e: jamas se usa contra el backend ni la base reales.
import { conStatus, fallo } from "../respuestas.ts";
import { propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";
import { ORDENES_SEMILLA, ENTREGAS_SEMILLA, PROGRAMADOS_SEMILLA } from "./restaurantes.ts";

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

export const CATEGORIAS_SEMILLA = [
  { id: "cat-1", name: "Tacos", slug: "tacos", displayOrder: 1 },
  { id: "cat-2", name: "Bebidas", slug: "bebidas", displayOrder: 2 },
];

export const PRODUCTOS_SEMILLA = [
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
  // R-33: fetchOnboarding exige `gate` (fuente unica de la puerta); sin pedidos y con 1 obligatorio pendiente el servidor real lo calcula igual.
  gate: { bloquea: false, obligatoriosPendientes: 1, operaConPedidos: true },
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
function gateActual(p: { estado: { obtener<T2>(k: string, s: () => T2): T2 } }): typeof CHECKLIST.gate {
  return { ...CHECKLIST.gate, bloquea: p.estado.obtener<boolean[]>("rest.gate.bloqueo", () => []).length > 0 };
}
function lista<T>(p: { estado: { obtener<T2>(k: string, s: () => T2): T2 } }, clave: string, semilla: readonly T[]): T[] {
  return p.estado.obtener<T[]>(clave, () => structuredClone([...semilla]));
}

function sucursal(p: { estado: { obtener<T>(k: string, s: () => T): T } }) {
  return p.estado.obtener("rest.sucursal", () => ({ propertyId: PROP.id, name: PROP.nombre, slug: "centro", status: "active" as "active" | "inactive", phone: "+529995550100" as string | null, address: "Calle 60 #400, Centro, Merida" as string | null, lat: 20.9674 as number | null, lng: -89.6237 as number | null }));
}

// ---------- Avisos y cierres: forma de apps/web/src/verticals/restaurantes/lib/{avisos,cierres}-client.ts ----------
const EVENTOS_AVISO_MOCK = [
  { tipo: "restaurantes.pedido.nuevo", etiqueta: "Pedido nuevo", descripcion: "Entra un pedido por WhatsApp o voz.", sonidoAplica: true },
  { tipo: "restaurantes.handoff.solicitado", etiqueta: "Cliente pide a una persona", descripcion: "El agente deriva una conversación a atención humana.", sonidoAplica: false },
  { tipo: "restaurantes.pedido.entrega_tardia", etiqueta: "Entrega tardía", descripcion: "Un pedido pasó de su hora prometida y sigue sin entregarse.", sonidoAplica: false },
];
const EQUIPO_AVISOS = [
  { userId: "restaurantes-owner", fullName: "Owner restaurantes", email: "owner.restaurantes@example.test", verticalRole: "owner" },
  { userId: "restaurantes-admin", fullName: "Admin restaurantes", email: "admin.restaurantes@example.test", verticalRole: "admin" },
  { userId: "restaurantes-staff", fullName: "Staff restaurantes", email: "staff.restaurantes@example.test", verticalRole: "staff" },
];
type PrefAviso = { tipo: string; enabled: boolean; sonido: boolean };
const efectivasAviso = (): PrefAviso[] => EVENTOS_AVISO_MOCK.map((e) => ({ tipo: e.tipo, enabled: true, sonido: true }));
function avisosPrefs(p: { estado: { obtener<T>(k: string, s: () => T): T } }): Record<string, PrefAviso[]> {
  return p.estado.obtener<Record<string, PrefAviso[]>>("rest.avisos.prefs", () => ({}));
}
const diaRelativo = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
function lunesDeSemanaPasada(): string {
  const d = new Date(Date.now() - 7 * 86_400_000);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function cierreMock(tipo: "dia" | "semana", inicio: string, n: number) {
  const fin = tipo === "dia" ? inicio : new Date(Date.parse(`${inicio}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  const k = tipo === "dia" ? 1 : 7;
  return {
    id: `cierre-${n}`, tipo, fechaInicio: inicio, fechaFin: fin, zonaHoraria: "America/Merida", generadoPor: "staff" as const, generadoAt: new Date().toISOString(),
    pedidos: 12 * k, ventasCentavos: 184_500 * k, ticketPromedioCentavos: 15_375, conProblema: 1, cancelados: 1, canceladosCentavos: 9_500, noRecogidos: 0, cancelacionPct: 8,
    porCanal: [{ canal: "whatsapp" as const, pedidos: 8 * k, ventasCentavos: 120_000 * k, cancelados: 1 }, { canal: "web" as const, pedidos: 4 * k, ventasCentavos: 64_500 * k, cancelados: 0 }],
    tiempos: { entregados: 10 * k, promedioMin: 32, medianaMin: 30, p90Min: 48 },
    comparativo: { fechaInicio: inicio, fechaFin: fin, pedidos: 10 * k, ventasCentavos: 150_000 * k, variacionPedidosPct: 20, variacionVentasPct: 23 },
    porDia: tipo === "semana" ? Array.from({ length: 7 }, (_, i) => ({ fecha: new Date(Date.parse(`${inicio}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), pedidos: 12, ventasCentavos: 184_500 })) : null,
  };
}
function cierresGenerados(p: { estado: { obtener<T>(k: string, s: () => T): T } }): ReturnType<typeof cierreMock>[] {
  return p.estado.obtener("rest.cierres", () => [cierreMock("dia", diaRelativo(-3), 0)]);
}


// Estado de las campanas de reactivacion (una configuracion lista y un borrador por aprobar con costo estimado).
function marketingConfig(p: { estado: { obtener<T>(k: string, s: () => T): T } }) {
  return p.estado.obtener("rest.marketing.config", () => ({ activo: true, tarifaCentavos: 80 as number | null, topeMensualCentavos: null as number | null, minimoSegmento: 10, plantillaNombre: "reactivacion_promo" as string | null, plantillaIdioma: "es_MX", hayPromocionVigente: true, plantillaAprobada: true, whatsappConectado: true, gastadoMesCentavos: 0, consentimientosVigentes: 40 }));
}
function marketingCampanas(p: { estado: { obtener<T>(k: string, s: () => T): T } }) {
  return p.estado.obtener("rest.marketing.campanas", () => [
    { id: "camp-e2e-1", segmento: "inactivo_30", estado: "borrador" as "borrador" | "aprobada" | "rechazada" | "expirada", conteo: 23, conteoControl: 2, costoEstimadoCentavos: 1840, promoNombre: "Vuelve con 10 por ciento", promoCodigo: "VUELVE10", creadaAt: "2026-09-30T14:00:00.000Z", decididaAt: null as string | null, encolados: null as number | null, enviados: 0, recompraTratados: 0, recompraControl: 0, ingresoTratados: 0, ventanaCerrada: false },
  ]);
}

export const rutasRestaurantesPanel: readonly Ruta[] = [
  // ---------- Pedidos (estado compartido con el repartidor y el Historial) ----------
  {
    metodo: "GET",
    patron: `${B}/orders`,
    manejador: (p) => {
      const estado = p.query.get("status");
      // Con varias sucursales sembradas (qa-r2-botones) cada sucursal ve solo sus pedidos, como el servidor real con branchId/propertyId.
      const multisucursal = p.estado.obtener<unknown[]>("rest.branches", () => [{ propertyId: PROP.id, name: PROP.nombre, slug: "centro" }]).length > 1;
      return { orders: ordenes(p).filter((o) => (estado ? o.status === estado : true) && (!multisucursal || o.propertyId === p.params["id"])), nextCursor: null };
    },
  },
  {
    // Detalle de un pedido (pagina completa de Pedidos): tambien resuelve los programados.
    metodo: "GET",
    patron: `${B}/orders/:orderId`,
    manejador: (p) => {
      const o = ordenes(p).find((x) => x.id === p.params["orderId"]) ?? p.estado.obtener<Array<{ id: string }>>("rest.programados", () => structuredClone(PROGRAMADOS_SEMILLA)).find((x) => x.id === p.params["orderId"]);
      return o ? { order: o } : fallo(404, "Ese pedido no existe");
    },
  },
  {
    metodo: "PATCH",
    patron: `${B}/orders/:orderId/status`,
    manejador: (p) => {
      // Un programado que se adelanta a cocina (pending) pasa a la lista normal; uno cancelado sale de los programados.
      const programados = p.estado.obtener<Orden[]>("rest.programados", () => structuredClone(PROGRAMADOS_SEMILLA) as unknown as Orden[]);
      const iProg = programados.findIndex((x) => x.id === p.params["orderId"]);
      if (iProg >= 0) {
        const destino = String(((p.cuerpo ?? {}) as { status?: string }).status ?? "");
        const [prog] = programados.splice(iProg, 1);
        if (prog && destino === "pending") ordenes(p).push({ ...prog, status: "pending" } as unknown as Orden);
        return { order: { ...prog, status: destino } };
      }
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

  // ---------- Campanas de reactivacion (autopiloto 2): forma de lib/marketing-client.ts (contrato de admin-marketing.ts) ----------
  { metodo: "GET", patron: `${B}/marketing`, roles: ["owner", "admin"], manejador: (p) => ({ disponible: true, config: marketingConfig(p), campanas: marketingCampanas(p) }) },
  { metodo: "PUT", patron: `${B}/marketing/config`, roles: ["owner", "admin"], manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { activo?: boolean; tarifaCentavos?: number | null; topeMensualCentavos?: number | null; minimoSegmento?: number; plantillaNombre?: string | null };
      if (typeof c.activo !== "boolean") return fallo(400, "activo: se esperaba un booleano.");
      Object.assign(marketingConfig(p), { activo: c.activo, tarifaCentavos: c.tarifaCentavos ?? null, topeMensualCentavos: c.topeMensualCentavos ?? null, minimoSegmento: c.minimoSegmento ?? 10, plantillaNombre: c.plantillaNombre ?? null });
      return { disponible: true, config: marketingConfig(p) };
    } },
  { metodo: "POST", patron: `${B}/marketing/campanas/:campanaId/decidir`, roles: ["owner", "admin"], manejador: (p) => {
      const k = marketingCampanas(p).find((x) => x.id === p.params["campanaId"]);
      if (!k) return fallo(403, "Sin acceso a las campañas de esta organización.");
      const accion = (p.cuerpo as { accion?: string } | undefined)?.accion;
      if (accion !== "aprobar" && accion !== "rechazar") return fallo(400, 'accion: se esperaba "aprobar" o "rechazar".');
      if (k.estado !== "borrador") return fallo(409, "Esta campaña ya fue decidida o expiró; espera el siguiente borrador.");
      if (accion === "rechazar") {
        k.estado = "rechazada";
        return { estado: "rechazada", encolados: 0, control: 0 };
      }
      k.estado = "aprobada";
      k.encolados = k.conteo;
      k.decididaAt = new Date().toISOString();
      return { estado: "aprobada", encolados: k.conteo, control: k.conteoControl };
    } },

  // ---------- Repartidor sugerido (autopiloto 2): solo lectura, NO asigna ----------
  { metodo: "GET", patron: `${B}/repartidor-sugerido`, roles: ["owner", "admin", "staff"], manejador: (p) => {
      const ids = (p.query.get("orderIds") ?? "").split(",").filter((x) => x.length > 0);
      const sugerencias: Record<string, { repartidorId: string; nombre: string; enCamino: number }> = {};
      for (const o of ordenes(p)) {
        if (ids.includes(o.id) && o.status === "preparando" && o.canal !== "recoger" && !o.assignedRepartidorId) sugerencias[o.id] = { repartidorId: "usr-2", nombre: "Ramon Uc", enCamino: 0 };
      }
      return { sugerencias };
    } },

  // ---------- Clientes (ficha) ----------
  // Politica de reincidencia: va ANTES de `/customers/:customerId` (misma regla que el servidor real, que la registra primero).
  { metodo: "GET", patron: `${B}/customers/policy`, roles: ["owner", "admin"], manejador: (p) => ({ policy: p.estado.obtener("rest.politica-clientes", () => ({ umbralNoRecogidos: 2, ventanaDias: 90 })) }) },
  { metodo: "PUT", patron: `${B}/customers/policy`, roles: ["owner", "admin"], manejador: (p) => { p.estado.guardar("rest.politica-clientes", p.cuerpo); return { policy: p.cuerpo }; } },
  // Ficha completa del cliente (Cliente 360): la pantalla la pide primero; la ficha basica de abajo solo sirve de respaldo (503).
  {
    metodo: "GET",
    patron: `${B}/customers/:customerId/ficha`,
    manejador: (p) => {
      if (p.params["customerId"] !== "cli-1") return fallo(404, "Ese cliente no existe");
      return {
        ficha: {
          customer: { id: "cli-1", name: "Marisol Pech", phone: "+529995550101", orderCount: 9, lastOrderAt: "2026-10-02T19:30:00.000Z", createdAt: "2026-06-01T15:00:00.000Z", fechaNacimientoDia: null, fechaNacimientoMes: null, staffNotes: null },
          addresses: [{ id: "dom-1", address: "Calle 60 #412, Centro", label: "Casa", isDefault: true, accessNotes: null, mapsUrl: null, colonia: "Centro", branchSlug: null, lastUsedAt: "2026-10-02T19:30:00.000Z", timesUsed: 4 }],
          preferences: [],
          reliability: { noRecogidos90d: 0, pedidosFalsos: 0, umbral: 2, ventanaDias: 90 },
          tier: null,
          orders: [],
          whatsapp: { conversaciones: 0, ultimaActividad: null, mensajes: 0 },
          llamadas: [],
        },
      };
    },
  },
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
  { metodo: "GET", patron: `${B}/onboarding`, roles: ["owner", "admin"], manejador: (p) => ({ ...CHECKLIST, gate: gateActual(p) }) },
  {
    // R-33: la puerta del Resumen. Por defecto NO bloquea (para no desviar el recorrido); una prueba la enciende agregando un
    // elemento a `rest.gate.bloqueo` (mock.agregarAEstado) tras haber visitado el Resumen una vez, que es quien crea la lista.
    metodo: "GET",
    patron: `${B}/onboarding/gate`,
    roles: ["owner", "admin"],
    manejador: (p) => ({ ...gateActual(p), listoParaOperar: false }),
  },
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
  { metodo: "GET", patron: `${B}/callbacks`, manejador: (p) => ({ disponible: true, items: p.estado.obtener("rest.callbacks", () => [] as unknown[]) }) },
  { metodo: "GET", patron: `${B}/turnos`, manejador: (p) => ({ disponible: true, turnos: p.estado.obtener("rest.turnos", () => [{ id: "turno-1", nombre: "Comida", dias: [1, 2, 3, 4, 5, 6], inicia: "12:00", termina: "01:00", miembros: [{ userId: "usr-1", nombre: "Lucia Xool", orden: 1 }] }]), cobertura: COBERTURA }) },
  { metodo: "PUT", patron: `${B}/turnos`, manejador: (p) => { const t = ((p.cuerpo ?? {}) as { turnos?: unknown[] }).turnos ?? []; p.estado.guardar("rest.turnos", t); return { disponible: true }; } },


  // ---------- Conocimiento del negocio e interruptor del agente de WhatsApp (053; solo owner/admin como la API real) ----------
  // Replica del servidor lo que la SPA debe ver: el validador rechaza precios (`$` + numero) con el mismo mensaje y una entrada nueva nace publicada.
  { metodo: "GET", patron: `${B}/conocimiento`, roles: ["owner", "admin"], manejador: (p) => ({ disponible: true, topeCaracteres: 6000, entradas: p.estado.obtener("rest.conocimiento", () => [] as unknown[]) }) },
  { metodo: "POST", patron: `${B}/conocimiento`, roles: ["owner", "admin"], manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { titulo?: string; texto?: string; tipo?: string; sucursalId?: string | null; reemplazaId?: string | null; prioridad?: number; vigenteDesde?: string | null; vigenteHasta?: string | null };
      if (/\$\s*\d/.test(`${c.titulo ?? ""} ${c.texto ?? ""}`)) return fallo(400, "No incluya precios: el agente los toma siempre del menú real con la cotización, y un precio escrito aquí se quedaría desactualizado.");
      const lista = p.estado.obtener("rest.conocimiento", () => [] as unknown[]);
      const entrada = { id: `cono-${lista.length + 1}`, sucursalId: c.sucursalId ?? null, reemplazaId: c.reemplazaId ?? null, titulo: c.titulo ?? "", texto: c.texto ?? "", tipo: c.tipo ?? "faq", prioridad: c.prioridad ?? 50, vigenteDesde: c.vigenteDesde ?? null, vigenteHasta: c.vigenteHasta ?? null, activo: true, estado: "publicado", origen: "manual", version: 1, actualizadoEn: new Date().toISOString() };
      lista.push(entrada);
      return conStatus(201, entrada);
    } },
  { metodo: "PATCH", patron: `${B}/conocimiento/:entradaId`, roles: ["owner", "admin"], manejador: (p) => {
      const lista = p.estado.obtener("rest.conocimiento", () => [] as Record<string, unknown>[]);
      const e = lista.find((x) => x["id"] === p.params["entradaId"]);
      if (!e) return fallo(404, "Entrada de conocimiento no encontrada.");
      Object.assign(e, p.cuerpo ?? {}, { version: Number(e["version"]) + 1 });
      return e;
    } },
  { metodo: "DELETE", patron: `${B}/conocimiento/:entradaId`, roles: ["owner", "admin"], manejador: (p) => {
      const lista = p.estado.obtener("rest.conocimiento", () => [] as Record<string, unknown>[]);
      const i = lista.findIndex((x) => x["id"] === p.params["entradaId"]);
      if (i < 0) return fallo(404, "Entrada de conocimiento no encontrada.");
      lista.splice(i, 1);
      return { ok: true };
    } },
  { metodo: "GET", patron: `${B}/config/sucursales/:branchId/agente-whatsapp`, roles: ["owner", "admin"], manejador: (p) => ({ disponible: true, agenteActivo: p.estado.obtener("rest.agente-wa-activo", () => true) }) },
  { metodo: "PUT", patron: `${B}/config/sucursales/:branchId/agente-whatsapp`, roles: ["owner", "admin"], manejador: (p) => {
      const activo = ((p.cuerpo ?? {}) as { activo?: unknown }).activo;
      if (typeof activo !== "boolean") return fallo(400, "activo: se esperaba true o false.");
      p.estado.guardar("rest.agente-wa-activo", activo);
      return { disponible: true, agenteActivo: activo };
    } },

  // ---------- Agente de voz ----------
  { metodo: "GET", patron: `${B}/voz/config`, roles: ["owner", "admin"], manejador: (p) => p.estado.obtener("rest.voz", () => ({ disponible: true, configurada: true, habilitado: true, voiceId: "voz-1", comportamiento: "Atiende pedidos por telefono.", mensajeInicial: "Taqueria El Faro, en que le ayudo?", mensajeInicialInterrumpible: true })) },
  { metodo: "PUT", patron: `${B}/voz/config`, roles: ["owner", "admin"], manejador: (p) => { const c = { disponible: true, configurada: true, ...((p.cuerpo ?? {}) as object) }; p.estado.guardar("rest.voz", c); return c; } },
  { metodo: "GET", patron: `${B}/voz/catalogo`, roles: ["owner", "admin"], manejador: () => ({ salud: { ok: true, detalle: "Servicio de voz operativo." } }) },
  { metodo: "GET", patron: `${B}/voz/conversaciones`, roles: ["owner", "admin"], manejador: () => ({ disponible: true, items: [{ id: "voz-conv-1", iniciadaEn: "2026-09-30T18:30:00.000Z", duracionS: 84, costoEstimadoMicroUsd: 120000, resultado: "pedido_creado" }] }) },
  { metodo: "GET", patron: `${B}/voz/conversaciones/:conversationId`, roles: ["owner", "admin"], manejador: () => ({ id: "voz-conv-1", iniciadaEn: "2026-09-30T18:30:00.000Z", duracionS: 84, costoEstimadoMicroUsd: 120000, resultado: "pedido_creado", turnos: [{ rol: "agente", texto: "Taqueria El Faro, en que le ayudo?", creadoEn: "2026-09-30T18:30:02.000Z" }, { rol: "usuario", texto: "Una orden de pastor", creadoEn: "2026-09-30T18:30:08.000Z" }] }) },
  { metodo: "GET", patron: `${B}/voz/kpi`, roles: ["owner", "admin"], manejador: () => ({ disponible: true, zonaHoraria: "America/Merida", hoy: hoyIso(), diaDeHoy: totalesVoz(1), mes: totalesVoz(30), serie: dias(7).map((d) => ({ fecha: d.fecha, llamadas: 14, pedidosVoz: 9, escaladas: 1, erroresProveedor: 0, toolP95Ms: 800, costoCentavosMxn: 4200 })) }) },

  // ---------- Avisos del staff (R-16): lectura por rol, preferencias propias/del equipo y umbral de entrega tardia ----------
  { metodo: "GET", patron: `${B}/avisos`, roles: ["owner", "admin", "staff"], manejador: (p) => {
      const esAdmin = p.persona?.rol === "owner" || p.persona?.rol === "admin";
      const prefs = avisosPrefs(p);
      const base = { disponible: true, eventos: EVENTOS_AVISO_MOCK, mias: prefs[p.persona?.id ?? ""] ?? efectivasAviso(), umbralDefectoMin: 45 };
      if (!esAdmin) return { ...base, equipo: null, umbrales: null };
      return {
        ...base,
        equipo: EQUIPO_AVISOS.map((m) => ({ ...m, preferencias: prefs[m.userId] ?? efectivasAviso() })),
        umbrales: p.estado.obtener("rest.avisos.umbrales", () => [{ propertyId: PROP.id, nombre: PROP.nombre, entregaTardiaMin: null as number | null }]),
        umbralMin: 10,
        umbralMax: 240,
      };
    } },
  { metodo: "PUT", patron: `${B}/avisos/preferencias`, roles: ["owner", "admin", "staff"], manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { tipo?: string; enabled?: boolean; sonido?: boolean; userId?: string };
      if (!EVENTOS_AVISO_MOCK.some((e) => e.tipo === c.tipo)) return fallo(400, "tipo: aviso desconocido.");
      if (typeof c.enabled !== "boolean") return fallo(400, "enabled: debe ser verdadero o falso.");
      const yo = p.persona?.id ?? "";
      if (c.userId && c.userId !== yo && p.persona?.rol === "staff") return fallo(403, "No tienes permiso para esta acción.");
      const objetivo = c.userId && c.userId !== yo ? c.userId : yo;
      const prefs = avisosPrefs(p);
      const filas = prefs[objetivo] ?? (prefs[objetivo] = efectivasAviso());
      const fila = filas.find((f) => f.tipo === c.tipo)!;
      fila.enabled = c.enabled;
      if (typeof c.sonido === "boolean") fila.sonido = c.sonido;
      return { ok: true, tipo: c.tipo, enabled: fila.enabled, sonido: fila.sonido };
    } },
  { metodo: "PUT", patron: `${B}/avisos/umbral`, roles: ["owner", "admin"], manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { propertyId?: string; minutos?: unknown };
      if (typeof c.minutos !== "number" || !Number.isInteger(c.minutos)) return fallo(400, "minutos: debe ser un número entero.");
      if (c.minutos < 10 || c.minutos > 240) return fallo(400, "minutos: fuera del rango permitido (10 a 240).");
      const u = p.estado.obtener("rest.avisos.umbrales", () => [{ propertyId: PROP.id, nombre: PROP.nombre, entregaTardiaMin: null as number | null }]);
      const fila = u.find((x) => x.propertyId === c.propertyId);
      if (!fila) return fallo(404, "Sucursal no encontrada.");
      fila.entregaTardiaMin = c.minutos;
      return { ok: true, propertyId: c.propertyId, minutos: c.minutos };
    } },

  // ---------- Cierre del dia y resumen semanal (R-42, solo owner/admin): lo generado aparece en el GET siguiente ----------
  { metodo: "GET", patron: `${B}/cierres`, roles: ["owner", "admin"], manejador: (p) => {
      const tipo = p.query.get("tipo") === "semana" ? "semana" : "dia";
      const cierres = cierresGenerados(p).filter((c) => c.tipo === tipo);
      const pendientes = (tipo === "dia" ? [diaRelativo(-1), diaRelativo(-2)] : [lunesDeSemanaPasada()]).filter((f) => !cierres.some((c) => c.fechaInicio === f));
      return { disponible: true, tipo, zonaHoraria: "America/Merida", hoy: hoyIso(), cierres, pendientes };
    } },
  { metodo: "POST", patron: `${B}/cierres/generar`, roles: ["owner", "admin"], manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { tipo?: string; fecha?: string };
      if (c.tipo !== "dia" && c.tipo !== "semana") return fallo(400, "tipo debe ser «dia» o «semana».");
      if (typeof c.fecha !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.fecha)) return fallo(400, "fecha debe ser YYYY-MM-DD.");
      if (c.fecha >= hoyIso()) return fallo(400, "Solo se cierra un periodo que ya terminó en la zona horaria de la sucursal.");
      const lista = cierresGenerados(p);
      const previo = lista.find((x) => x.tipo === c.tipo && x.fechaInicio === c.fecha);
      if (previo) return { estado: "existente", cierre: previo };
      const nuevo = cierreMock(c.tipo, c.fecha, lista.length + 1);
      lista.unshift(nuevo);
      return conStatus(201, { estado: "creado", cierre: nuevo });
    } },
];
