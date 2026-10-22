// API simulada del encargado (Cola, Nuevo pedido, Viajes). Archivo del paquete B (`PLAN-PANEL-OPERADOR §6`), registrado en el indice.
// Toda respuesta pasa por `conContrato(esquema..., cuerpo)` de `./operacion-comun.ts` para que el mock no se desvie del contrato;
// las rutas que aun no tienen pantalla (captura, viajes) responden 404 `mock_sin_fixture` hasta su PR.
//
// Estado en memoria por escenario (`p.estado`): un PATCH/POST de la cola se refleja en el GET siguiente, como en el servidor real.
// Solo datos sinteticos (nombres y folios de ejemplo); nada de clientes reales.
import { esquemaColaSalida, esquemaListoSalida, esquemaRespuestaClientePorTelefono, esquemaRespuestaCotizar, esquemaRespuestaCrearPedido, esquemaCrearPedidoOperador, esquemaCotizarPedidoOperador } from "../../../../../packages/domain-restaurantes/src/operacion/contratos.ts";
import type { CrearPedidoOperadorEntrada } from "../../../../../packages/domain-restaurantes/src/operacion/contratos.ts";
import type { AccionDisponible, ColaSalida, TarjetaPedido } from "../../../../../packages/domain-restaurantes/src/operacion/contratos.ts";
import type { Peticion, Ruta } from "../tipos.ts";
import { conContrato, errorApi } from "./operacion-comun.ts";
import { rutasRestaurantesPanel } from "./restaurantes-panel.ts";

const BASE = "/v1/restaurantes/:id/admin";
const CLAVE = "operacion.cola";
const MIN = 60_000;

/** Pedido guardado en el escenario: la tarjeta sin los campos que dependen del reloj (minutos, semaforo, acciones). */
type PedidoMock = Omit<TarjetaPedido, "minutos" | "semaforo" | "accionesDisponibles">;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function semilla(): PedidoMock[] {
  const ahora = Date.now();
  const base = { aceptadoEn: null, listoAt: null, salioAt: null, repartidorId: null, sinAviso: false };
  return [
    { ...base, id: uuid(150), numero: 150, estado: "pending", canal: "domicilio", origen: "whatsapp", clienteNombre: "Ana R.", resumenItems: "4 taquitos al pastor, 1 horchata", total: 708, creadoEn: new Date(ahora - 6 * MIN).toISOString() },
    { ...base, id: uuid(151), numero: 151, estado: "pending", canal: "recoger", origen: "llamada", clienteNombre: "Luis M.", resumenItems: "2 tortas de cochinita", total: 190, creadoEn: new Date(ahora - 1 * MIN).toISOString(), sinAviso: true },
    { ...base, id: uuid(149), numero: 149, estado: "preparando", canal: "recoger", origen: "mostrador", clienteNombre: "Marta P.", resumenItems: "6 tacos de cochinita", total: 330, creadoEn: new Date(ahora - 12 * MIN).toISOString(), aceptadoEn: new Date(ahora - 10 * MIN).toISOString() },
    { ...base, id: uuid(146), numero: 146, estado: "preparando", canal: "domicilio", origen: "voice", clienteNombre: "Raúl C.", resumenItems: "3 órdenes de pastor", total: 520, creadoEn: new Date(ahora - 30 * MIN).toISOString(), aceptadoEn: new Date(ahora - 28 * MIN).toISOString(), listoAt: new Date(ahora - 4 * MIN).toISOString() },
    { ...base, id: uuid(141), numero: 141, estado: "en_camino", canal: "domicilio", origen: "whatsapp", clienteNombre: "Marta P.", resumenItems: "2 órdenes de pastor", total: 360, creadoEn: new Date(ahora - 120 * MIN).toISOString(), aceptadoEn: new Date(ahora - 115 * MIN).toISOString(), salioAt: new Date(ahora - 104 * MIN).toISOString(), repartidorId: uuid(900) },
  ];
}

function pedidos(p: Peticion): PedidoMock[] {
  return p.estado.obtener<PedidoMock[]>(CLAVE, semilla);
}

function acciones(m: PedidoMock): AccionDisponible[] {
  if (m.estado === "pending") return ["aceptar", "cancelar"];
  if (m.estado === "preparando" && m.canal === "recoger") return ["listo", "cancelar"];
  if (m.estado === "preparando") return m.listoAt ? ["salio", "cancelar"] : ["listo", "cancelar"];
  if (m.estado === "listo_para_recoger") return ["entregar", "cancelar"];
  if (m.estado === "en_camino") return ["entregar", "marcar_problema"];
  return [];
}

function semaforoMock(m: PedidoMock, minutos: number): "verde" | "amarillo" | "rojo" {
  const prometido = m.canal === "domicilio" ? 65 : 35;
  if (m.estado === "en_camino") return minutos >= 90 ? "rojo" : "amarillo";
  return minutos > prometido ? "rojo" : minutos >= prometido * 0.7 ? "amarillo" : "verde";
}

function tarjeta(m: PedidoMock): TarjetaPedido {
  const desde = m.estado === "en_camino" && m.salioAt ? m.salioAt : m.creadoEn;
  const minutos = Math.max(0, Math.floor((Date.now() - Date.parse(desde)) / MIN));
  return { ...m, minutos, semaforo: semaforoMock(m, minutos), accionesDisponibles: acciones(m) };
}

function cola(p: Peticion): ColaSalida {
  const lista = pedidos(p).filter((m) => ["pending", "preparando", "listo_para_recoger", "en_camino"].includes(m.estado));
  const conteos: Record<string, number> = {};
  for (const m of lista) conteos[m.estado] = (conteos[m.estado] ?? 0) + 1;
  return { pedidos: lista.map(tarjeta), conteos, actualizadoEn: new Date().toISOString() };
}

function buscar(p: Peticion): PedidoMock | undefined {
  return pedidos(p).find((m) => m.id === p.params["orderId"]);
}

const rutaPatchEstadoEscritorio = rutasRestaurantesPanel.find((r) => r.metodo === "PATCH" && r.patron.endsWith("/orders/:orderId/status"))!;


// ---- Captura por personal (B2) ----

const PRECIO_UNITARIO = 95; // el mock no conoce el menu: cada pieza vale lo mismo; el contrato solo exige que el total venga del servidor
const ENVIO = 30;
/** Una colonia fuera de cobertura para probar el aviso rojo. */
const COLONIA_SIN_COBERTURA = "Zona sin reparto";

function cotizar(entrada: { canal: string; items: Array<{ cantidad: number }>; direccion?: { colonia?: string | null } | null }) {
  const subtotal = entrada.items.reduce((s, i) => s + i.cantidad * PRECIO_UNITARIO, 0);
  const envio = entrada.canal === "domicilio" ? ENVIO : 0;
  const dentro = !(entrada.canal === "domicilio" && entrada.direccion?.colonia === COLONIA_SIN_COBERTURA);
  return { cotizacion: { subtotal, envio, total: subtotal + envio, tiempoEstimadoMin: entrada.canal === "domicilio" ? [60, 65] : [25, 35] }, cobertura: { dentro } };
}

const rutasCaptura: readonly Ruta[] = [
  {
    metodo: "POST",
    patron: `${BASE}/orders/cotizar`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      const v = esquemaCotizarPedidoOperador.validar(p.cuerpo);
      if (!v.ok) return errorApi(400, "validation_error", "Cuerpo de cotización inválido.");
      const r = cotizar(v.valor);
      if (!r.cobertura.dentro) return errorApi(422, "fuera_de_cobertura", "Esa dirección está fuera de la zona de reparto.");
      return conContrato(esquemaRespuestaCotizar, r);
    },
  },
  {
    // Cliente existente: SOLO el telefono sintetico de abajo; cualquier otro es cliente nuevo (404).
    metodo: "GET",
    patron: `${BASE}/customers/por-telefono`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      if (p.query.get("telefono") !== "+529995550100") return errorApi(404, "not_found", "Cliente no encontrado.");
      return conContrato(esquemaRespuestaClientePorTelefono, { cliente: { id: uuid(800), nombre: "Cliente Ejemplo", domicilios: [{ id: uuid(801), texto: "Calle Ficticia 123", colonia: "Centro" }], ultimoPedido: null, gustos: [] } });
    },
  },
  {
    metodo: "POST",
    patron: `${BASE}/orders`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      const v = esquemaCrearPedidoOperador.validar(p.cuerpo);
      if (!v.ok) return errorApi(400, "validation_error", "Cuerpo de captura inválido.");
      const entrada: CrearPedidoOperadorEntrada = v.valor;
      const llave = String(p.cabeceras["idempotency-key"] ?? "");
      if (!llave) return errorApi(400, "validation_error", "Falta Idempotency-Key.");
      const hechos = p.estado.obtener<Array<{ llave: string; huella: string; respuesta: unknown }>>("operacion.capturas", () => []);
      const huella = `${entrada.cliente.telefono}|${entrada.items.map((i) => `${i.productId}x${i.cantidad}`).join(",")}`;
      const repetido = hechos.find((h) => h.llave === llave);
      if (repetido) return conContrato(esquemaRespuestaCrearPedido, { ...(repetido.respuesta as object), yaAplicado: true }, 200);
      if (!entrada.forzarDuplicado && hechos.some((h) => h.huella === huella)) return errorApi(409, "pedido_duplicado_reciente", "Hay un pedido igual de hace menos de 10 minutos.");
      const r = cotizar(entrada);
      const lista = pedidos(p);
      const numero = Math.max(150, ...lista.map((m) => m.numero)) + 1;
      const preparando = entrada.confirmarYa ?? true;
      const ahora = new Date().toISOString();
      lista.push({
        id: uuid(numero), numero, estado: preparando ? "preparando" : "pending", canal: entrada.canal, origen: entrada.canalCaptura, clienteNombre: entrada.cliente.nombre,
        resumenItems: `${entrada.items.reduce((s, i) => s + i.cantidad, 0)} piezas`, total: r.cotizacion.total, creadoEn: ahora, aceptadoEn: preparando ? ahora : null,
        listoAt: null, salioAt: null, repartidorId: null, sinAviso: !entrada.consentimientoWhatsapp.otorgado,
      });
      const aviso = entrada.consentimientoWhatsapp.otorgado ? { estado: "encolado", plantilla: preparando ? "pedido_confirmado" : "pedido_recibido", motivo: null } : { estado: "omitido", plantilla: null, motivo: "sin_consentimiento" };
      const respuesta = {
        pedido: { id: uuid(numero), numero, estado: preparando ? "preparando" : "pending", total: r.cotizacion.total, source: "admin", canalCaptura: entrada.canalCaptura, capturadoPor: null },
        cotizacion: r.cotizacion,
        aviso,
      };
      hechos.push({ llave, huella, respuesta });
      return conContrato(esquemaRespuestaCrearPedido, respuesta, 201);
    },
  },
];

export const rutasOperacionEncargado: readonly Ruta[] = [
  ...rutasCaptura,
  {
    metodo: "GET",
    patron: `${BASE}/operacion/cola`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => conContrato(esquemaColaSalida, cola(p)),
  },
  {
    // Aceptar / entregar en mostrador: el PATCH de estado vigente. Idempotente: repetir devuelve `yaAplicado` sin cambiar nada.
    metodo: "PATCH",
    patron: `${BASE}/orders/:orderId/status`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      const m = buscar(p);
      // Un pedido que no es de la cola del panel lo atiende la fixture del panel de escritorio (Pedidos): esta ruta se registra antes y le cede el paso.
      if (!m) return rutaPatchEstadoEscritorio.manejador(p);
      const destino = String((p.cuerpo as { status?: unknown } | null)?.status ?? "");
      if (destino === "en_camino") return errorApi(422, "usar_despacho", "Para sacar un pedido a reparto usa Viajes.");
      if (m.estado === destino) return { yaAplicado: true };
      const valido = (m.estado === "pending" && destino === "preparando") || (m.estado === "listo_para_recoger" && destino === "entregado");
      if (!valido) return errorApi(409, "estado_cambio", `El pedido ya está en ${m.estado}.`);
      m.estado = destino as PedidoMock["estado"];
      if (destino === "preparando") m.aceptadoEn = new Date().toISOString();
      return { yaAplicado: false };
    },
  },
  {
    // Listo: domicilio solo marca `listoAt`; recoger pasa a `listo_para_recoger`.
    metodo: "POST",
    patron: `${BASE}/orders/:orderId/listo`,
    roles: ["owner", "admin", "staff"],
    manejador: (p) => {
      const m = buscar(p);
      if (!m) return errorApi(404, "not_found", "Pedido no encontrado.");
      if (m.estado !== "preparando") return errorApi(409, "estado_cambio", `El pedido ya está en ${m.estado}.`);
      const yaAplicado = m.listoAt !== null;
      if (!m.listoAt) m.listoAt = new Date().toISOString();
      if (m.canal === "recoger") m.estado = "listo_para_recoger";
      return conContrato(esquemaListoSalida, { yaAplicado, listoAt: m.listoAt }, 200);
    },
  },
];

