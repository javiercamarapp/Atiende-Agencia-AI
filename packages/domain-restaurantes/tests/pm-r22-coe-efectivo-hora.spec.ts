// PM R22 (CLASIFICACION R21-M31): la hora de recogida cotizada sobrevive a una re-cotizacion sin plazo. Datos sinteticos.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";

afterEach(limpiarEntorno);
beforeEach(() => prepararEntorno(true));

describe("cotizar_pedido: la hora cotizada sobrevive a re-cotizar sin plazo", () => {
  it("segunda cotizacion sin minutos_para_recoger conserva la hora", async () => {
    const s = setup();
    s.cliente("paso en 40 minutos");
    await s.quote({ minutos_para_recoger: 40, efectivo_con: 500 });
    const hora1 = (await s.snap())?.context?.horaRecogida;
    expect(hora1).toBeTruthy();
    await s.quote({ efectivo_con: 800 });
    expect((await s.snap())?.context?.horaRecogida).toBe(hora1);
  });
});

describe("solicitar_agregado_pedido: pedido ya salido ofrece el minimo a domicilio (T7-072)", () => {
  it("con minimo configurado el mensaje lo dice", async () => {
    const { mensajeAgregadoYaSalio, MENSAJE_AGREGADO_PEDIDO_YA_SALIO } = await import("../src/agent-tools/registry.ts");
    const s = setup();
    s.f.repo.seedBranchPolicy(s.f.propertyId, { pedidoMinimoDomicilio: 200 });
    expect(await mensajeAgregadoYaSalio(s.f.repo, s.f.propertyId)).toContain("a domicilio el mínimo es de $200");
    expect(await mensajeAgregadoYaSalio(s.f.repo, null)).toBe(MENSAJE_AGREGADO_PEDIDO_YA_SALIO);
  });
});
