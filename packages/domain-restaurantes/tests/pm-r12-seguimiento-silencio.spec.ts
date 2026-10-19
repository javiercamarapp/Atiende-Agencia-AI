// PM Ronda 12, seguimiento de #593 (3 observaciones no bloqueantes del revisor independiente):
//  (a) «pedido en curso»: un pedido PROGRAMADO creado hace mas de 12 h (para hoy) sigue siendo un pedido en curso: una falla tecnica conserva el silencio.
//  (b) el acuse de toma pendiente considera las excepciones de horario por fecha (festivos / puentes); si no puede saber la hora con certeza, manda el
//      acuse fijo SIN hora (nunca una hora inventada).
//  (c) caida larga sin toma: un solo aviso `falla_sistema` por telefono cada 15 min, sin perder la alerta de racha (cada turno sigue contando como fallo).
import { FakeLlmProvider } from "@atiende/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrder } from "../src/orders.ts";
import { ACUSE_HANDOFF_PENDIENTE, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import type { Order, OrderStatus } from "../src/types.ts";
import { CLASE_FALLA_DEL_SISTEMA } from "../src/alertas-duenio/timeouts-agente.ts";
import { MARTES_14H, MIERCOLES_0230, TEL_CLIENTE, nuevoViaje, type Viaje } from "./qa-viaje/arnes-viaje.ts";
import { PHONE, buildRestaurantFixture, gatewayDe } from "./pm-r11-romper/arnes.ts";

const min = (n: number) => n * 60_000;
const dia = (n: number) => n * 24 * 60 * 60_000;
const avanza = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

function escalaPorModelo(v: Viaje, motivo: string): void {
  v.guion([
    { tools: [{ name: "escalar_a_humano", args: { customer_name: "Cliente", motivo, resumen: "El asistente no pudo con la solicitud." } }] },
    { texto: "Ya avisé al equipo." },
  ]);
}

/** Crea un pedido real del cliente y lo deja en `status`, creado hace `haceMs`. */
async function pedidoViejo(v: Viaje, status: OrderStatus, haceMs: number): Promise<void> {
  const o = await createOrder(v.world.repo, {
    organizationId: v.world.organizationId,
    branchSlug: "garcia-lavin",
    customerName: "Cliente Prueba",
    customerPhone: TEL_CLIENTE,
    canal: "recoger",
    paymentMethod: "efectivo",
    source: "whatsapp",
    items: [{ productId: v.producto("Bistec de Res — 1 kg"), requestedQuantity: 1 }],
  });
  const lista = (v.world.repo as unknown as { orders: Order[] }).orders;
  const i = lista.findIndex((x) => x.id === o.id);
  lista[i] = { ...lista[i]!, status, createdAt: new Date(Date.now() - haceMs).toISOString() };
}

describe("(a) pedido en curso: los programados cuentan sin importar cuando se crearon", () => {
  it.each(["falla_sistema", "no_puedo_resolver"])("%s con un pedido PROGRAMADO creado hace 3 dias: se conserva el silencio (toma abierta)", async (motivo) => {
    const v = await nuevoViaje();
    await pedidoViejo(v, "programado", dia(3));
    escalaPorModelo(v, motivo);
    const r = await v.escribe("¿ya está mi pedido de hoy?");
    expect(r.escalated).toBe(true);
    expect(v.conversaciones.handoffs).toHaveLength(1);
  });

  it("un pedido programado creado hace mas de 30 dias ya no es un pedido en curso (dato rancio)", async () => {
    const v = await nuevoViaje();
    await pedidoViejo(v, "programado", dia(40));
    escalaPorModelo(v, "falla_sistema");
    expect((await v.escribe("hola")).escalated).toBe(false);
    expect(v.conversaciones.handoffs).toHaveLength(0);
  });

  it("controles: un programado ENTREGADO, o un pedido que NO es programado creado hace 3 dias, no cuentan (se conserva la ventana de 12 h)", async () => {
    for (const status of ["entregado", "preparando"] as const) {
      const v = await nuevoViaje();
      await pedidoViejo(v, status, dia(3));
      escalaPorModelo(v, "falla_sistema");
      expect((await v.escribe("hola")).escalated, status).toBe(false);
    }
  });
});

async function escalado(v: Viaje): Promise<void> {
  expect((await v.escribe("quiero hablar con una persona")).escalated).toBe(true);
}

describe("(b) el acuse respeta las excepciones de horario por fecha", () => {
  it("festivo con cierre excepcional: NO da la apertura del horario regular (12:00); manda el acuse fijo sin hora", async () => {
    vi.setSystemTime(new Date(MIERCOLES_0230));
    const v = await nuevoViaje();
    await v.world.repo.createBranchHoursException(v.world.organizationId, { propertyId: v.t7, fechaDesde: "2026-10-14", fechaHasta: "2026-10-14", horario: [], motivo: "Festivo" });
    await escalado(v);
    avanza(min(2));
    const r = await v.escribe("¿ya salió?");
    expect(r.reply).toBe(ACUSE_HANDOFF_PENDIENTE);
    expect(r.reply).not.toMatch(/12:00|\d{1,2}:\d{2}/);
  });

  it("excepcion con otro horario hoy (15:00): el acuse da la apertura REAL de la excepcion", async () => {
    vi.setSystemTime(new Date(MIERCOLES_0230));
    const v = await nuevoViaje();
    await v.world.repo.createBranchHoursException(v.world.organizationId, { propertyId: v.t7, fechaDesde: "2026-10-14", fechaHasta: "2026-10-14", horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "15:00", cierra: "22:00" }], motivo: "Puente" });
    await escalado(v);
    avanza(min(2));
    const r = await v.escribe("¿ya salió?");
    expect(r.reply!.startsWith(ACUSE_HANDOFF_PENDIENTE)).toBe(true);
    expect(r.reply).toMatch(/15:00/);
    expect(r.reply).not.toMatch(/12:00/);
  });

  it("cerrado por una excepcion que ya paso hoy (08:00-10:00): no inventa la apertura de manana con las horas de la excepcion; acuse fijo", async () => {
    const v = await nuevoViaje();
    await v.world.repo.createBranchHoursException(v.world.organizationId, { propertyId: v.t7, fechaDesde: "2026-10-13", fechaHasta: "2026-10-13", horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "08:00", cierra: "10:00" }], motivo: "Evento" });
    await escalado(v);
    avanza(min(2));
    const r = await v.escribe("¿ya salió?");
    expect(r.reply).toBe(ACUSE_HANDOFF_PENDIENTE);
  });

  it("sin excepciones el comportamiento no cambia: cerrada a las 02:30, abre hoy a las 12:00", async () => {
    vi.setSystemTime(new Date(MIERCOLES_0230));
    const v = await nuevoViaje();
    await escalado(v);
    avanza(min(2));
    expect((await v.escribe("¿ya salió?")).reply).toMatch(/12:00/);
  });
});

describe("(c) caida larga sin toma: un solo aviso falla_sistema por telefono cada 15 min", () => {
  function fixtureCaido() {
    const f = buildRestaurantFixture();
    const caido = new FakeLlmProvider({
      id: "caido",
      script: () => {
        throw new Error("proveedor caido");
      },
    });
    const handler = createLlmWhatsAppTurnHandler(f.repo, gatewayDe([caido]), { defaultRole: "default", escalatedRole: "escalated" });
    const avisos: string[] = [];
    const original = f.repo.createCallbackRequest.bind(f.repo);
    f.repo.createCallbackRequest = async (input) => {
      avisos.push(`${input.customerPhone}|${input.reason ?? ""}`);
      return original(input);
    };
    const clases: (string | null)[] = [];
    const fin = f.repo.finishWhatsAppMessage.bind(f.repo);
    f.repo.finishWhatsAppMessage = (async (...a: Parameters<typeof fin>) => {
      if (a[3] === "processed") clases.push((a[4] as string | null) ?? null);
      return fin(...a);
    }) as typeof fin;
    let n = 0;
    const escribe = (phone = PHONE) => handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: `wamid.caida-${++n}`, phone, body: "hola, quiero unos tacos", phoneNumberId: "1" });
    return { f, avisos, clases, escribe };
  }

  it("tres mensajes seguidos del mismo cliente: UN aviso falla_sistema; cada turno sigue contando como fallo para la alerta de racha", async () => {
    const { avisos, clases, escribe } = fixtureCaido();
    for (let i = 0; i < 3; i++) {
      const r = await escribe();
      expect(r).toMatchObject({ ok: true });
      expect(r.reply).toBeTruthy();
      avanza(min(1));
    }
    expect(avisos.filter((a) => a.endsWith("escalada:falla_sistema"))).toHaveLength(1);
    expect(clases.filter((c) => c === CLASE_FALLA_DEL_SISTEMA)).toHaveLength(3);
  });

  it("pasados los 15 min vuelve a avisar; otro telefono tiene su propio aviso", async () => {
    const { avisos, escribe } = fixtureCaido();
    await escribe();
    avanza(min(16));
    await escribe();
    await escribe("+5219995550123");
    expect(avisos.filter((a) => a.endsWith("escalada:falla_sistema"))).toHaveLength(3);
  });
});
