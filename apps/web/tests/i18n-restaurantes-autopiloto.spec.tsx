// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes: autopiloto (aprobaciones, programados), historial, comandas al POS, conversaciones, callbacks y avisos.
// En espanol el DOM es identico con y sin IdiomaProvider; en ingles las pantallas salen en ingles natural sin claves crudas, y los
// datos (nombres, productos) quedan tal cual. Las etiquetas de los lib/ siguen al idioma activo.
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { AprobacionesPanel } from "../src/verticals/restaurantes/pages/AprobacionesPanel.tsx";
import { ProgramadosPanel } from "../src/verticals/restaurantes/pages/ProgramadosPanel.tsx";
import type { SolicitudesRespuesta } from "../src/verticals/restaurantes/lib/autopiloto-client.ts";
import { MOTIVO_CANCELACION_ETIQUETAS, SOLICITUD_TIPO_ETIQUETAS, etiquetaActor, mensajeResultadoSolicitud } from "../src/verticals/restaurantes/lib/autopiloto-client.ts";
import { CALLBACK_RESULTADO_LABEL, ESTADO_LABEL, SLA_LABEL, textoEscalacion, textoMotivoCallback } from "../src/verticals/restaurantes/lib/conversaciones-client.ts";
import { antiguedadTexto } from "../src/verticals/restaurantes/lib/pos-comandas-client.ts";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

beforeAll(() => cargarIdioma("en"));

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  fijarIdiomaActivo("es");
  delete document.documentElement.dataset.diseno;
});

const AHORA = Date.parse("2026-10-02T18:00:00Z");

const DATOS: SolicitudesRespuesta = {
  disponible: true,
  solicitudes: [
    {
      id: "s-1",
      propertyId: "prop-1",
      tipo: "compensacion",
      estado: "pendiente",
      orderId: "ord-1",
      detalle: { subtipo: "faltante" },
      decision: null,
      motivoResolucion: null,
      codigoDescuento: null,
      solicitadaAt: new Date(AHORA - 12 * 60_000).toISOString(),
      escaladaAt: new Date(AHORA - 2 * 60_000).toISOString(),
      resueltaAt: null,
      pedido: { numero: 88, total: 450, status: "listo_para_recoger", clienteNombre: "Rosa Díaz", canal: "recoger", renglones: [{ indice: 0, nombre: "Tacos al pastor", cantidad: 2 }] },
      decisionesPosibles: ["sin_compensacion", "reponer_producto", "descuento_proximo"],
    },
  ],
} as unknown as SolicitudesRespuesta;

const PROGRAMADO = {
  id: "ord-p1",
  propertyId: "prop-1",
  branch: "Centro",
  customerId: "c-1",
  customerName: "Luis Mena",
  customerPhone: "5511112222",
  customerAddress: "Calle 5",
  total: 320,
  status: "programado",
  items: [],
  source: "whatsapp",
  notes: null,
  paymentMethod: "efectivo",
  createdAt: "2026-10-02T15:00:00.000Z",
  assignedRepartidorId: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
  canal: "domicilio",
  propina: null,
  horaRecogida: null,
  programadoPara: "2026-10-02T21:00:00.000Z",
  orderNumber: 12,
} as unknown as OrderSummary;

const pantallas = (): ReadonlyArray<readonly [string, ReactElement]> => [
  ["aprobaciones", <AprobacionesPanel key="a" datos={DATOS} ahoraMs={AHORA} apiBaseUrl="https://api.test" token="t" propertyId="prop-1" topeDescuentoPct={20} onResuelta={async () => undefined} />],
  ["programados", <ProgramadosPanel key="p" orders={[PROGRAMADO]} disponible ahoraMs={AHORA} changingId={null} onAbrir={() => undefined} onAdelantar={() => undefined} onCancelar={() => undefined} />],
];

function html(el: ReactElement): string {
  rendered = renderComponent(el);
  const h = rendered.container.innerHTML;
  rendered.unmount();
  rendered = undefined;
  return h;
}

describe("autopiloto ES/EN", () => {
  for (const [nombre, el] of pantallas()) {
    it(`${nombre}: en espanol el DOM es identico con y sin IdiomaProvider`, () => {
      expect(html(<IdiomaProvider idiomaInicial="es">{el}</IdiomaProvider>)).toBe(html(el));
    });
  }

  it("aprobaciones en ingles: acciones y estados traducidos, datos tal cual", () => {
    document.documentElement.dataset.diseno = "ds3";
    rendered = renderComponent(<IdiomaProvider idiomaInicial="en">{pantallas()[0]![1]}</IdiomaProvider>);
    const texto = rendered.container.textContent ?? "";
    for (const en of ["Complaint: compensation", "Pickup", "Waiting for 12 min", "owner already notified", "Missing item", "order ready for pickup", "No compensation", "Replace item", "Discount on next order", "Order #88"]) {
      expect(texto, en).toContain(en);
    }
    for (const es of ["Sin compensación", "Espera hace", "Reponer producto", "Recoger"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("Rosa Díaz");
    expect(texto).toContain("Tacos al pastor");
    expect(rendered.container.innerHTML).not.toMatch(/\brestaurantes\.[a-z]+\.[A-Za-z0-9.]+/);
  });

  it("programados en ingles", () => {
    document.documentElement.dataset.diseno = "ds3";
    rendered = renderComponent(<IdiomaProvider idiomaInicial="en">{pantallas()[1]![1]}</IdiomaProvider>);
    const texto = rendered.container.textContent ?? "";
    for (const en of ["Moved to Received automatically 30 min before their time", "Send to kitchen now", "Cancel order", "goes to the kitchen at", "Delivery", "Scheduled"]) expect(texto, en).toContain(en);
    expect(texto).not.toContain("Enviar a cocina ahora");
  });
});

describe("etiquetas de lib/ (idioma activo)", () => {
  it("en espanol, los textos de siempre", () => {
    expect(MOTIVO_CANCELACION_ETIQUETAS.cliente_desistio).toBe("El cliente desistió");
    expect(SOLICITUD_TIPO_ETIQUETAS.cancelacion).toBe("Cancelación pedida por el cliente");
    expect(etiquetaActor("staff:1")).toBe("Equipo");
    expect(mensajeResultadoSolicitud({ decision: "aprobar" }, { aplicado: true, decision: "aprobar", motivo: null, estadoPedido: null, codigoDescuento: "ABC" } as never).texto).toBe(
      "Listo. Código de descuento enviado al cliente: ABC.",
    );
    expect(ESTADO_LABEL.pendiente).toBe("Esperando a una persona");
    expect(Object.keys(CALLBACK_RESULTADO_LABEL)).toEqual(["contactado", "no_contesto", "buzon", "numero_invalido", "reprogramar"]);
    expect(SLA_LABEL.vencido).toBe("Vencido");
    expect(textoEscalacion({ nivel: 2, minutosEspera: 9, sinCobertura: false, avisarAdministracion: true, destinatarios: [] })).toBe("9 min sin respuesta: avisar a administración");
    expect(textoMotivoCallback("escalada:queja_grave")).toBe("Escalada: queja grave");
    expect(antiguedadTexto("2026-10-02T15:30:00Z", AHORA)).toBe("hace 2 h 30 min");
  });

  it("en ingles siguen al idioma activo", () => {
    fijarIdiomaActivo("en");
    expect(MOTIVO_CANCELACION_ETIQUETAS.fuera_de_zona).toBe("Outside delivery area");
    expect(etiquetaActor("agente")).toBe("Agent");
    expect(ESTADO_LABEL.tomada).toBe("With a person");
    expect(CALLBACK_RESULTADO_LABEL.buzon).toBe("Voicemail");
    expect(textoEscalacion({ nivel: 0, minutosEspera: 0, sinCobertura: true, avisarAdministracion: true, destinatarios: [] })).toBe("No one on duty: notify management");
    expect(antiguedadTexto("2026-10-02T17:55:00Z", AHORA)).toBe("5 min ago");
  });
});
