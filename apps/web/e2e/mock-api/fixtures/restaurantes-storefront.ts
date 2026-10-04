// Storefront PUBLICO de restaurantes (/pedir/*) para el recorrido e2e: menu -> carrito -> cotizacion -> pedido -> rastreo.
// La forma de cada respuesta copia apps/web/src/verticals/restaurantes/storefront/storefront-client.ts. Son rutas publicas (sin
// sesion): el mock las atribuye al escenario "anon", asi que el estado de pedidos es compartido entre pruebas; por eso cada pedido
// lleva un token unico y las pruebas filtran el registro por el nombre unico del cliente. Solo existe en la API simulada de e2e.
import { fallo } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";
import { CATEGORIAS_SEMILLA, PRODUCTOS_SEMILLA } from "./restaurantes-panel.ts";

const S = "/v1/restaurantes/:id/storefront";
const ORG = orgDe("restaurantes");
const PROP = propiedadDe("restaurantes");

const SUCURSAL = {
  slug: "centro",
  name: PROP.nombre,
  address: "Calle 60 #400, Centro, Merida",
  phone: "+529995550100",
  abiertoAhora: true,
  cierraA: "01:00",
  proximaApertura: null,
  pedidoMinimoDomicilio: 120,
  pedidoMinimoRecoger: null,
  propinaPolitica: "solo_tarjeta",
  zonasReparto: ["Centro"],
};

interface PedidoPublico {
  token: string;
  status: string;
  total: number;
  canal: string;
  paymentMethod: string | null;
  createdAt: string;
  items: Array<{ name: string; quantity: number; tortilla: string | null }>;
}

interface ItemCuerpo { product_id: string; requested_quantity: number; tortilla?: string }
interface CuerpoPedido { items?: ItemCuerpo[]; canal?: string; payment_method?: string; customer_name?: string; customer_phone?: string; promo_code?: string; quote_hash?: string }

function renglones(items: readonly ItemCuerpo[]) {
  return items.flatMap((i) => {
    const p = PRODUCTOS_SEMILLA.find((x) => x.id === i.product_id);
    if (!p || !p.isAvailable) return [];
    return [{ product_id: p.id, name: p.name, price: p.price, quantity: i.requested_quantity, tortilla: (i.tortilla ?? null) as "maiz" | "harina" | "mixta" | null, line_total: p.price * i.requested_quantity }];
  });
}

export const rutasRestaurantesStorefront: readonly Ruta[] = [
  { metodo: "GET", patron: S, publica: true, manejador: () => ({ restaurante: { slug: ORG.slug, nombre: ORG.nombre }, sucursales: [SUCURSAL] }) },
  {
    metodo: "GET",
    patron: `${S}/:branchSlug/menu`,
    publica: true,
    manejador: (p) => {
      if (p.params["branchSlug"] !== SUCURSAL.slug) return fallo(404, "No encontramos esa sucursal.");
      const categorias = CATEGORIAS_SEMILLA.map((c) => ({
        id: c.id,
        name: c.name,
        items: PRODUCTOS_SEMILLA.filter((x) => x.categoryId === c.id).map((x) => ({ id: x.id, name: x.name, description: x.description, price: x.price, imageUrl: null, isPopular: x.isPopular, available: x.isAvailable, packSize: null, requiresAdultConfirmation: false, requiresTortilla: x.id === "p-1", noDomicilio: false })),
      }));
      return { sucursal: SUCURSAL, categorias };
    },
  },
  {
    metodo: "POST",
    patron: `${S}/:branchSlug/quote`,
    publica: true,
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as CuerpoPedido;
      const lines = renglones(c.items ?? []);
      if (lines.length === 0) return fallo(400, "Tu carrito esta vacio.");
      const total = lines.reduce((s, l) => s + l.line_total, 0);
      if (c.canal === "domicilio" && total < SUCURSAL.pedidoMinimoDomicilio) return fallo(409, `El pedido minimo a domicilio es de $${SUCURSAL.pedidoMinimoDomicilio}.`);
      const promo = c.canal === "recoger" && c.promo_code ? (c.promo_code.toUpperCase() === "BIENVENIDA10" ? { valida: true, codigo: "BIENVENIDA10", descuento: Math.round(total * 0.1), totalConDescuento: total - Math.round(total * 0.1), mensaje: null } : { valida: false, codigo: c.promo_code, descuento: 0, totalConDescuento: total, mensaje: "Ese codigo no existe o ya no esta vigente." }) : null;
      return { quote: { lines, total, contains_alcohol: false, abierto_ahora: true }, quote_hash: `h-${total}-${lines.length}`, promo };
    },
  },
  { metodo: "POST", patron: `${S}/:branchSlug/confirm`, publica: true, manejador: () => ({ confirmado: true }) },
  {
    metodo: "POST",
    patron: `${S}/:branchSlug/orders`,
    publica: true,
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as CuerpoPedido;
      const lines = renglones(c.items ?? []);
      if (lines.length === 0) return fallo(400, "Tu carrito esta vacio.");
      if (!c.customer_name?.trim() || !c.customer_phone?.trim()) return fallo(400, "Faltan tus datos de contacto.");
      const pedidos = p.estado.obtener<PedidoPublico[]>("rest.storefront.pedidos", () => []);
      const total = lines.reduce((s, l) => s + l.line_total, 0);
      const token = `trk-${Date.now().toString(36)}-${pedidos.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
      pedidos.push({ token, status: "pending", total, canal: c.canal ?? "recoger", paymentMethod: c.payment_method ?? null, createdAt: new Date().toISOString(), items: lines.map((l) => ({ name: l.name, quantity: l.quantity, tortilla: l.tortilla })) });
      return { rastreo_token: token, estado: "pending", total, canal: c.canal ?? "recoger", sucursal: SUCURSAL.name };
    },
  },
  {
    metodo: "GET",
    patron: `${S}/track/:token`,
    publica: true,
    manejador: (p) => {
      const pedido = p.estado.obtener<PedidoPublico[]>("rest.storefront.pedidos", () => []).find((x) => x.token === p.params["token"]);
      if (!pedido) return fallo(404, "No encontramos ese pedido.");
      return { disponible: true, pedido: { status: pedido.status, branch: SUCURSAL.name, total: pedido.total, paymentMethod: pedido.paymentMethod, canal: pedido.canal, createdAt: pedido.createdAt, items: pedido.items } };
    },
  },
];
