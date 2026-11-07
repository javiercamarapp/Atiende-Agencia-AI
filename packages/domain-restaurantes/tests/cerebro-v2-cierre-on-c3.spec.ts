// Regresiones de la maquina de cierre ON en C3 (c3-v2-base, sha b7d7a33): PED-18 (resumen mostrado ANTES de saber el pago, con la direccion a medias) y PED-05 (un «sí» claro
// rechazado porque entre el resumen y el «sí» el asistente solo pidio, sin cambiar nada, que confirmara el resumen anterior). Deterministas, sin LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { CIERRE_MAQUINA_ENV, decidirConfirmacion } from "../src/agent-tools/cierre-maquina.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

type Msg = { role: "user" | "assistant"; content: string };
const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
  vi.stubEnv(CIERRE_MAQUINA_ENV, "1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup(cerebroV2: boolean) {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }], propinaPolitica: "solo_tarjeta" });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  const hist: Msg[] = [{ role: "user", content: "dos cocas para recoger, soy Nora" }];
  const ctx = () => ({
    organizationId: f.organizationId,
    channel: "whatsapp" as const,
    phone: "9991234567",
    flow: { key: "k:wa", turn: "1", now: () => Date.now() },
    conversacionReciente: hist,
    ...(cerebroV2 ? { cerebroV2: true } : {}),
  });
  const quote = (extra: Record<string, unknown>) =>
    invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { branch_slug: "fco-montejo", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }], canal: "recoger", minutos_para_recoger: 30, ...extra });
  return { f, quote, snap: () => f.repo.readOrderFlow(f.organizationId, "k:wa") };
}

describe("PED-18 (ON): sin forma de pago la cotizacion NO trae el resumen para confirmar (cerebro v2)", () => {
  it("cotizar sin pago: sin resumen_canonico (el modelo pregunta el pago, el servidor no pega un resumen incompleto)", async () => {
    const s = setup(true);
    const q = (await s.quote({})) as { result: Record<string, unknown> };
    expect(q.result.resumen_canonico).toBeUndefined();
    expect(q.result.instruccion_resumen).toBeUndefined();
  });
  it("cotizar con pago: el resumen sale como siempre", async () => {
    const s = setup(true);
    const q = (await s.quote({ payment_method: "tarjeta" })) as { result: Record<string, unknown> };
    expect(String(q.result.resumen_canonico)).toContain("Pago: tarjeta");
  });
  it("sin cerebro v2 el comportamiento no cambia (el resumen sale aunque falte el pago)", async () => {
    const s = setup(false);
    const q = (await s.quote({})) as { result: Record<string, unknown> };
    expect(typeof q.result.resumen_canonico).toBe("string");
  });
});

describe("PED-05 (ON): «sí» al resumen tras un recordatorio del asistente que no cambia nada", () => {
  const RESUMEN = "Resumen de su pedido:\n• 1 × Pastor — 1 kg (maiz) — $900\n• 2 × Coca-Cola — $106\nEntrega: a domicilio\nPago: efectivo (paga con $1500)\nTotal a pagar: $1006\n\n¿Está correcto? Responda *sí* para confirmar su pedido o dígame qué desea cambiar.";
  const ctx = { quotedTotal: 1006, quotedPago: "efectivo", quotedEfectivoCon: 1500, quotedCanal: "domicilio" } as unknown as Parameters<typeof decidirConfirmacion>[0]["ctx"];
  const decidir = (historial: Msg[]) => decidirConfirmacion({ ctx, historial, turn: "9" });

  it("resumen -> cliente con una nota sin cambio -> asistente «responda sí al resumen anterior» -> «Sí» => confirma", () => {
    const d = decidir([
      { role: "assistant", content: RESUMEN },
      { role: "user", content: "Sí, está bien. Solo una cosa: son dos cocas normales, no me cobre de más. Lo demás correcto, confirme por favor." },
      { role: "assistant", content: "Gracias, Beatriz. Las 2 Coca-Cola normales son $106 en total y el pedido queda en $1,006. Para registrarlo, responda únicamente «sí» al resumen anterior o dígame qué desea cambiar." },
      { role: "user", content: "Sí" },
    ]);
    expect(d.ok).toBe(true);
  });

  it("si el asistente dice que CAMBIO algo (direccion actualizada) el «sí» NO confirma el resumen viejo (PED-14)", () => {
    const d = decidir([
      { role: "assistant", content: RESUMEN },
      { role: "user", content: "Sí, pero falta el edificio, es edificio Marina departamento 8." },
      { role: "assistant", content: "Gracias. Actualizo la dirección a edificio Marina, departamento 8. El resto queda igual: total $1,006. ¿Es correcto?" },
      { role: "user", content: "Sí" },
    ]);
    expect(d.ok).toBe(false);
  });

  it("si el recordatorio trae una cifra que no esta en el resumen, el «sí» NO confirma", () => {
    const d = decidir([
      { role: "assistant", content: RESUMEN },
      { role: "user", content: "Sí, está bien, confirme por favor." },
      { role: "assistant", content: "El total queda en $1,100. Responda «sí» para registrarlo." },
      { role: "user", content: "Sí" },
    ]);
    expect(d.ok).toBe(false);
  });
});
