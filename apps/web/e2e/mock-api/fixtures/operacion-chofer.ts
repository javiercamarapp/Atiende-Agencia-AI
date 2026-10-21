// API simulada del chofer (paquete C1 del PLAN-PANEL-OPERADOR §2.3). Toda respuesta pasa por `conContrato`, asi que si el contrato cambia y este
// mock no, el e2e falla en vez de ocultar el desajuste.
//
// COMPUERTA: por omision estas rutas responden `no_implementado` como el servidor real mientras el paquete A1 no se despliegue, pero con 404 y no 501:
// el vigilante de e2e trata todo 5xx como fallo y los recorridos existentes del repartidor (vista anterior, `repartidor/orders`) deben seguir intactos.
// La SPA reconoce el codigo `no_implementado` (y tambien el 501 real: ver `esFuncionNoDisponible`). Una prueba del panel nuevo la abre con
// `mock.agregarAEstado("op.chofer.habilitado", true)` (la lista nace con la primera peticion, por eso la prueba recarga la pagina despues).
import { esquemaDeshacerEntregaSalida, esquemaEntregarSalida, esquemaEntregasChoferSalida, esquemaHoyChoferSalida, esquemaLlamarSalida, esquemaProblemaSalida } from "../../../../../packages/domain-restaurantes/src/operacion/contratos.ts";
import type { EntregaChofer } from "../../../../../packages/domain-restaurantes/src/operacion/contratos.ts";
import type { Peticion, Ruta } from "../tipos.ts";
import { MENSAJE_NO_IMPLEMENTADO } from "../../../../../packages/domain-restaurantes/src/operacion/contratos.ts";
import { conContrato, errorApi, RUTAS_OPERACION } from "./operacion-comun.ts";

const respuestaNoImplementada = () => errorApi(404, "no_implementado", MENSAJE_NO_IMPLEMENTADO);

const ID_ANA = "00000000-0000-4000-8000-0000000c0145";
const ID_LUIS = "00000000-0000-4000-8000-0000000c0146";
/** Telefono ficticio (rango de pruebas): solo sale por `llamar`, nunca por la lista. */
const TELEFONO_FICTICIO = "+529995550145";

interface EntregaMock extends Omit<EntregaChofer, "puedeDeshacerHasta"> {
  puedeDeshacerHasta: string | null;
  entregadoEn: number | null;
  llamadas: number;
}

function semilla(): EntregaMock[] {
  const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  return [
    {
      id: ID_ANA, numero: 145, estado: "en_camino", clienteNombre: "Ana R.", direccion: { texto: "Calle 60 #320", colonia: "Centro" }, indicaciones: "Portón negro, tocar timbre",
      total: 708, pago: { forma: "efectivo", pagaCon: 1000 }, resumenItems: "4 taquitos al pastor, 2 horchatas", totalPiezas: 6, salioAt: hace(22), etaAt: null, minutos: 22, semaforo: "verde",
      puedeDeshacerHasta: null, entregadoEn: null, llamadas: 0,
    },
    {
      id: ID_LUIS, numero: 146, estado: "en_camino", clienteNombre: "Luis M.", direccion: { texto: "Calle 21 #88", colonia: "Itzimná" }, indicaciones: null,
      total: 520, pago: { forma: "tarjeta", pagaCon: null }, resumenItems: "3 tortas de cochinita", totalPiezas: 3, salioAt: hace(50), etaAt: null, minutos: 50, semaforo: "amarillo",
      puedeDeshacerHasta: null, entregadoEn: null, llamadas: 0,
    },
  ];
}

const habilitado = (p: Peticion) => p.estado.obtener<unknown[]>("op.chofer.habilitado", () => []).length > 0;
const entregas = (p: Peticion) => p.estado.obtener<EntregaMock[]>("op.chofer.entregas", semilla);
const publica = ({ entregadoEn: _a, llamadas: _b, ...e }: EntregaMock): EntregaChofer => e;

export const rutasOperacionChofer: readonly Ruta[] = [
  { metodo: "GET", patron: RUTAS_OPERACION.entregasChofer.patron, manejador: (p) => {
      if (!habilitado(p)) return respuestaNoImplementada();
      const ahora = Date.now();
      // Activas, y lo recien entregado/problema mientras dure la ventana de 2 min (el servidor real las retira despues).
      const visibles = entregas(p).filter((e) => e.estado === "en_camino" || (e.entregadoEn !== null && ahora - e.entregadoEn < 120_000));
      return conContrato(esquemaEntregasChoferSalida, { entregas: visibles.map(publica), actualizadoEn: new Date(ahora).toISOString() });
    } },
  { metodo: "POST", patron: RUTAS_OPERACION.entregar.patron, manejador: (p) => {
      if (!habilitado(p)) return respuestaNoImplementada();
      const e = entregas(p).find((x) => x.id === p.params.orderId);
      if (!e) return errorApi(404, "not_found", "Ese pedido no existe o no es tuyo.");
      if (!p.cabeceras["idempotency-key"]) return errorApi(400, "validation_error", "Falta la cabecera Idempotency-Key.");
      if (e.estado === "entregado") return conContrato(esquemaEntregarSalida, { resultado: "ya_aplicado", entregadoAt: new Date(e.entregadoEn!).toISOString(), puedeDeshacerHasta: e.puedeDeshacerHasta ?? new Date(e.entregadoEn!).toISOString() });
      if (e.estado !== "en_camino") return errorApi(422, "no_activo", "Ese pedido ya no está en camino.");
      e.estado = "entregado";
      e.entregadoEn = Date.now();
      e.puedeDeshacerHasta = new Date(e.entregadoEn + 60_000).toISOString();
      return conContrato(esquemaEntregarSalida, { resultado: "entregado", entregadoAt: new Date(e.entregadoEn).toISOString(), puedeDeshacerHasta: e.puedeDeshacerHasta });
    } },
  { metodo: "POST", patron: RUTAS_OPERACION.deshacerEntrega.patron, manejador: (p) => {
      if (!habilitado(p)) return respuestaNoImplementada();
      const e = entregas(p).find((x) => x.id === p.params.orderId);
      if (!e) return errorApi(404, "not_found", "Ese pedido no existe o no es tuyo.");
      if (e.estado === "en_camino") return conContrato(esquemaDeshacerEntregaSalida, { resultado: "ya_aplicado", estado: "en_camino", avisoYaEnviado: false });
      if (e.estado !== "entregado" || e.entregadoEn === null || Date.now() - e.entregadoEn > 60_000) return errorApi(409, "fuera_de_ventana", "Ya pasó el tiempo para deshacer. Avisa al encargado.");
      e.estado = "en_camino";
      e.entregadoEn = null;
      e.puedeDeshacerHasta = null;
      return conContrato(esquemaDeshacerEntregaSalida, { resultado: "deshecho", estado: "en_camino", avisoYaEnviado: false });
    } },
  { metodo: "POST", patron: RUTAS_OPERACION.problema.patron, manejador: (p) => {
      if (!habilitado(p)) return respuestaNoImplementada();
      const e = entregas(p).find((x) => x.id === p.params.orderId);
      if (!e) return errorApi(404, "not_found", "Ese pedido no existe o no es tuyo.");
      const motivo = (p.cuerpo as { motivo?: string } | null)?.motivo;
      if (!motivo || !["no_contesto", "direccion", "rechazo", "otro"].includes(motivo)) return errorApi(400, "validation_error", "motivo: elige un motivo de la lista.");
      if (e.estado !== "en_camino") return errorApi(422, "no_activo", "Ese pedido ya no está en camino.");
      e.estado = "problema";
      e.entregadoEn = Date.now();
      return conContrato(esquemaProblemaSalida, { resultado: "problema", estado: "problema" });
    } },
  { metodo: "POST", patron: RUTAS_OPERACION.llamar.patron, manejador: (p) => {
      if (!habilitado(p)) return respuestaNoImplementada();
      const e = entregas(p).find((x) => x.id === p.params.orderId);
      if (!e) return errorApi(404, "not_found", "Ese pedido no existe o no es tuyo.");
      if (e.estado !== "en_camino") return errorApi(422, "no_activo", "Ese pedido ya no está en camino.");
      if (e.llamadas >= 5) return errorApi(429, "rate_limited", "Ya llamaste 5 veces a este cliente. Avisa al encargado.");
      e.llamadas += 1;
      return conContrato(esquemaLlamarSalida, { telefono: TELEFONO_FICTICIO });
    } },
  { metodo: "GET", patron: RUTAS_OPERACION.hoyChofer.patron, manejador: (p) => {
      if (!habilitado(p)) return respuestaNoImplementada();
      const todas = entregas(p);
      const hechas = todas.filter((e) => e.estado === "entregado").length;
      return conContrato(esquemaHoyChoferSalida, { entregasHoy: 4 + hechas, enCamino: todas.filter((e) => e.estado === "en_camino").length, efectivoPorEntregar: null });
    } },
];
