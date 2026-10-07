// Fixtures de la API SIMULADA de e2e para el autopiloto de restaurantes (aprobaciones "Por aprobar"). Solo existen aqui: la API real
// (apps/api/.../restaurantes/autopiloto.ts) la prueban apps/api/tests y scripts/verify-restaurantes-autopiloto contra Postgres.
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("restaurantes");
void orgDe;
const B = "/v1/restaurantes/:id/admin/autopiloto";

interface SolicitudMock {
  id: string;
  propertyId: string;
  tipo: "pedido_grande" | "cancelacion" | "compensacion";
  estado: "pendiente" | "resuelta";
  orderId: string;
  detalle: Record<string, unknown>;
  decision: string | null;
  motivoResolucion: string | null;
  codigoDescuento: string | null;
  solicitadaAt: string;
  escaladaAt: string | null;
  resueltaAt: string | null;
  pedido: { numero: number; total: number; status: string; clienteNombre: string; canal: "domicilio" | "recoger"; renglones: { indice: number; nombre: string; cantidad: number }[] };
  decisionesPosibles: string[];
}

export const SOLICITUD_GRANDE_ID = "5a000000-0000-4000-8000-000000000001";

const semilla = (): SolicitudMock[] => [
  {
    id: SOLICITUD_GRANDE_ID,
    propertyId: PROP.id,
    tipo: "pedido_grande",
    estado: "pendiente",
    orderId: "ord-grande-1",
    detalle: { total: 4500 },
    decision: null,
    motivoResolucion: null,
    codigoDescuento: null,
    solicitadaAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    escaladaAt: null,
    resueltaAt: null,
    pedido: { numero: 2001, total: 4500, status: "por_aprobar", clienteNombre: "Evento Peniche", canal: "domicilio", renglones: [{ indice: 0, nombre: "Tacos al pastor (orden)", cantidad: 60 }] },
    decisionesPosibles: ["aprobar", "rechazar"],
  },
];

const CONFIG = {
  cancelacionAuto: false,
  aceptacionAuto: false,
  aprobacionMinutos: 10,
  handoffRegresoMinutos: 15,
  noRecogidoMinutos: 60,
  completadoHoras: 6,
  compensacionTopePct: 20,
  saturacionUmbral1: null,
  saturacionUmbral2: null,
  saturacionExtraMinutos: 15,
  configurada: false,
};

export const rutasRestaurantesAutopiloto: readonly Ruta[] = [
  {
    metodo: "GET",
    patron: `${B}/solicitudes`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      const estado = p.query.get("estado") ?? "pendiente";
      const todas = p.estado.obtener<SolicitudMock[]>("rest.autopiloto.solicitudes", semilla);
      return { disponible: true, solicitudes: todas.filter((s) => s.estado === estado) };
    },
  },
  {
    metodo: "POST",
    patron: `${B}/solicitudes/:sid/resolver`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      const todas = p.estado.obtener<SolicitudMock[]>("rest.autopiloto.solicitudes", semilla);
      const s = todas.find((x) => x.id === p.params.sid);
      const cuerpo = (p.cuerpo ?? {}) as { decision?: string; motivo?: string };
      if (!s) return { status: 404, cuerpo: { code: "not_found", message: "Solicitud no encontrada." } };
      if (s.estado === "resuelta") return { aplicado: false, tipo: s.tipo, decision: s.decision, estadoPedido: null, codigoDescuento: null, reposicionOrderId: null, efectos: [] };
      s.estado = "resuelta";
      s.decision = cuerpo.decision ?? null;
      s.motivoResolucion = cuerpo.motivo ?? null;
      s.resueltaAt = new Date().toISOString();
      return { aplicado: true, tipo: s.tipo, decision: s.decision, estadoPedido: cuerpo.decision === "aprobar" ? "pending" : "cancelado", codigoDescuento: null, reposicionOrderId: null, efectos: ["aviso_cliente"] };
    },
  },
  {
    metodo: "GET",
    patron: `${B}/config`,
    roles: ["owner", "admin", "staff"],
    manejador: () => ({ disponible: true, config: CONFIG, plantillas: [{ nombre: "pedido_aprobado", aprobada: false }], posReal: false }),
  },
  { metodo: "PUT", patron: `${B}/config`, roles: ["owner", "admin"], manejador: (p) => ({ ok: true, config: { ...(p.cuerpo as object), configurada: true } }) },
];
