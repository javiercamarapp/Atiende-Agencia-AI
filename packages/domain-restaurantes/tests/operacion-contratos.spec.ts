// Contratos del panel del operador (PLAN-PANEL-OPERADOR §2): los ejemplos del plan validan, y lo que el plan prohibe se rechaza.
import { describe, expect, it } from "vitest";
import {
  MAX_PEDIDOS_POR_VIAJE,
  RUTAS_OPERACION,
  esquemaColaSalida,
  esquemaCrearPedidoOperador,
  esquemaDespachoEntrada,
  esquemaDespachoSalida,
  esquemaEntregaChofer,
  esquemaEntregarEntrada,
  esquemaErrorOperacion,
  esquemaOperacionHoy,
  esquemaProblemaEntrada,
  esquemaRespuestaCrearPedido,
  esquemaViajesSalida,
} from "../src/operacion/index.ts";

const U1 = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
const U2 = "7a1d9e02-8c3b-4f55-a1b2-0d9e8f7a6b5c";
const AHORA = "2026-10-21T20:41:00.000Z";

const capturaValida = {
  propertyId: U1,
  canalCaptura: "llamada",
  canal: "domicilio",
  confirmarYa: true,
  cliente: { telefono: "+529990000000", nombre: "Cliente de prueba" },
  direccion: { texto: "Calle de prueba 1", colonia: "Centro" },
  indicacionesEntrega: "porton negro",
  items: [{ productId: U2, cantidad: 2, modificadores: ["tortilla_maiz"], nota: "sin cebolla" }],
  pago: { forma: "efectivo", pagaCon: 1000 },
  consentimientoWhatsapp: { otorgado: true, via: "verbal_llamada" },
};

describe("POST admin/orders", () => {
  it("el cuerpo de ejemplo del plan es valido", () => {
    expect(esquemaCrearPedidoOperador.validar(capturaValida).ok).toBe(true);
  });

  it("el consentimiento es obligatorio y explicito (sin valor por omision)", () => {
    const { consentimientoWhatsapp: _omitido, ...sin } = capturaValida;
    const r = esquemaCrearPedidoOperador.validar(sin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.map((e) => e.campo)).toContain("consentimientoWhatsapp");
    expect(esquemaCrearPedidoOperador.validar({ ...capturaValida, consentimientoWhatsapp: { via: "verbal_llamada" } }).ok).toBe(false);
    // Decir que NO es un valor valido: el pedido se crea sin aviso.
    expect(esquemaCrearPedidoOperador.validar({ ...capturaValida, consentimientoWhatsapp: { otorgado: false, via: "verbal_llamada" } }).ok).toBe(true);
  });

  it("rechaza telefono no internacional, cantidad 0, lista de productos vacia y canal desconocido", () => {
    expect(esquemaCrearPedidoOperador.validar({ ...capturaValida, cliente: { telefono: "9990000000", nombre: "X" } }).ok).toBe(false);
    expect(esquemaCrearPedidoOperador.validar({ ...capturaValida, items: [{ productId: U2, cantidad: 0 }] }).ok).toBe(false);
    expect(esquemaCrearPedidoOperador.validar({ ...capturaValida, items: [] }).ok).toBe(false);
    expect(esquemaCrearPedidoOperador.validar({ ...capturaValida, canalCaptura: "web" }).ok).toBe(false);
  });

  it("la respuesta de ejemplo del plan es valida y el aviso omitido lleva su motivo", () => {
    const respuesta = {
      pedido: { id: U1, numero: 145, estado: "preparando", total: 708, source: "admin", canalCaptura: "llamada", capturadoPor: U2 },
      cotizacion: { subtotal: 708, envio: 0, total: 708, tiempoEstimadoMin: [60, 65] },
      aviso: { estado: "omitido", plantilla: null, motivo: "sin_consentimiento" },
    };
    expect(esquemaRespuestaCrearPedido.validar(respuesta).ok).toBe(true);
    expect(esquemaRespuestaCrearPedido.validar({ ...respuesta, aviso: { estado: "omitido", plantilla: null, motivo: "inventado" } }).ok).toBe(false);
  });
});

describe("POST admin/orders/dispatch", () => {
  it("acepta de 1 a 6 pedidos y exige chofer y ETA", () => {
    const base = { pedidos: [U1], repartidorId: U2, etaMin: 35 };
    expect(esquemaDespachoEntrada.validar(base).ok).toBe(true);
    expect(esquemaDespachoEntrada.validar({ ...base, pedidos: Array.from({ length: MAX_PEDIDOS_POR_VIAJE }, () => U1) }).ok).toBe(true);
    expect(esquemaDespachoEntrada.validar({ ...base, pedidos: Array.from({ length: MAX_PEDIDOS_POR_VIAJE + 1 }, () => U1) }).ok).toBe(false);
    expect(esquemaDespachoEntrada.validar({ ...base, pedidos: [] }).ok).toBe(false);
    expect(esquemaDespachoEntrada.validar({ pedidos: [U1], etaMin: 35 }).ok).toBe(false);
    expect(esquemaDespachoEntrada.validar({ ...base, desdeEstado: "en_camino" }).ok).toBe(false);
  });

  it("la salida distingue despachado / ya_aplicado / reasignado y el aviso omitido con motivo", () => {
    const fila = { pedidoId: U1, resultado: "despachado", estado: "en_camino", salioAt: AHORA, repartidorId: U2, aviso: "encolado" };
    expect(esquemaDespachoSalida.validar({ resultados: [fila, { ...fila, resultado: "ya_aplicado", aviso: "ya_enviado" }, { ...fila, resultado: "reasignado", aviso: "omitido:sin_consentimiento" }] }).ok).toBe(true);
    expect(esquemaDespachoSalida.validar({ resultados: [{ ...fila, salioAt: null }] }).ok).toBe(true);
    expect(esquemaDespachoSalida.validar({ resultados: [{ ...fila, aviso: "enviado!" }] }).ok).toBe(false);
  });
});

describe("chofer", () => {
  const entrega = {
    id: U1,
    numero: 145,
    estado: "en_camino",
    clienteNombre: "Ana R.",
    direccion: { texto: "Calle de prueba 1", colonia: null },
    indicaciones: null,
    total: 708,
    pago: { forma: "efectivo", pagaCon: 1000 },
    resumenItems: "4 piezas",
    totalPiezas: 4,
    salioAt: AHORA,
    etaAt: null,
    minutos: 22,
    semaforo: "verde",
  };

  it("la entrega NO lleva telefono ni notas libres (las claves de mas se descartan, nunca se propagan)", () => {
    const r = esquemaEntregaChofer.validar({ ...entrega, telefono: "+529990000000", notes: "pin 1234" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.valor).not.toHaveProperty("telefono");
      expect(r.valor).not.toHaveProperty("notes");
    }
  });

  it("entregar: cobradoMonto opcional y no negativo; problema exige motivo de la lista cerrada", () => {
    expect(esquemaEntregarEntrada.validar({}).ok).toBe(true);
    expect(esquemaEntregarEntrada.validar({ cobradoMonto: 708, desdeEstado: "en_camino" }).ok).toBe(true);
    expect(esquemaEntregarEntrada.validar({ cobradoMonto: -1 }).ok).toBe(false);
    expect(esquemaProblemaEntrada.validar({ motivo: "no_contesto" }).ok).toBe(true);
    expect(esquemaProblemaEntrada.validar({ motivo: "se_me_acabo_la_gasolina" }).ok).toBe(false);
  });
});

describe("lecturas", () => {
  it("cola, viajes y hoy aceptan su forma vacia honesta", () => {
    expect(esquemaColaSalida.validar({ pedidos: [], conteos: {}, actualizadoEn: AHORA }).ok).toBe(true);
    expect(esquemaViajesSalida.validar({ porSalir: [], enCamino: [], recientes: [], repartidores: [], actualizadoEn: AHORA }).ok).toBe(true);
    const hoy = {
      corte: { desde: AHORA, hasta: AHORA },
      pedidos: { total: 0, porEstado: {} },
      ventas: 0,
      ticketPromedio: 0,
      puntuales: { pct: null, evaluados: 0, umbralMin: { domicilio: 65, recoger: 35 } },
      tiempos: { preparacionMinProm: null, entregaMinProm: null, entregaMinP90: null },
      cancelados: { total: 0, porMotivo: {} },
      porCanal: {},
      alertas: { sinAceptar: [], enCaminoMas90: [] },
      efectivoPorChofer: { disponible: false, choferes: [] },
      actualizadoEn: AHORA,
    };
    expect(esquemaOperacionHoy.validar(hoy).ok).toBe(true);
    expect(esquemaOperacionHoy.validar({ ...hoy, ventas: "16300" }).ok).toBe(false);
  });

  it("el error 501 honesto cabe en el esquema de error", () => {
    expect(esquemaErrorOperacion.validar({ code: "no_implementado", message: "No disponible aún" }).ok).toBe(true);
  });
});

describe("tarjeta de pedido: cobro", () => {
  it("el cobro es opcional (compatibilidad hacia atras) y valida forma y montos", () => {
    const tarjeta = { id: U1, numero: 1, estado: "preparando", canal: "domicilio", origen: "llamada", clienteNombre: "Ana", resumenItems: "2 piezas", total: 100, creadoEn: AHORA, aceptadoEn: null, listoAt: null, salioAt: null, minutos: 3, semaforo: "verde", repartidorId: null, sinAviso: false, accionesDisponibles: ["aceptar"] };
    const cola = (t: unknown) => esquemaColaSalida.validar({ pedidos: [t], conteos: {}, actualizadoEn: AHORA }).ok;
    expect(cola(tarjeta)).toBe(true);
    expect(cola({ ...tarjeta, pago: { forma: "efectivo", pagaCon: 200, totalACobrar: 100, cobrado: false } })).toBe(true);
    expect(cola({ ...tarjeta, pago: { forma: null, totalACobrar: 100, cobrado: false } })).toBe(true);
    expect(cola({ ...tarjeta, pago: { forma: "cheque", totalACobrar: 100, cobrado: false } })).toBe(false);
    expect(cola({ ...tarjeta, pago: { forma: "efectivo", totalACobrar: -1, cobrado: false } })).toBe(false);
  });
});

describe("rutas", () => {
  it("todas cuelgan de /v1/restaurantes/:propertyId y no hay dos iguales", () => {
    const claves = Object.values(RUTAS_OPERACION).map((r) => `${r.metodo} ${r.patron}`);
    expect(new Set(claves).size).toBe(claves.length);
    for (const r of Object.values(RUTAS_OPERACION)) expect(r.patron.startsWith("/v1/restaurantes/:propertyId/")).toBe(true);
  });
});
