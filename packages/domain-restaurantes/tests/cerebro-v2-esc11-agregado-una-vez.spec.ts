// C3 ESC-11 (cerebro v2, Luna): el cliente pide agregar una Coca a su pedido ya registrado. El agente contesto CINCO veces seguidas la frase fija de agregados
// («Lo paso ahorita a la sucursal; ... Le confirmo en un momento.»), tambien cuando el cliente solo preguntaba si ya habian avisado o daba las gracias («Ya van varias
// veces con lo mismo»). Ademas, cada nueva llamada a solicitar_agregado_pedido con lo mismo se FUSIONA en la solicitud abierta sumando cantidades (fusionarRenglones):
// repetir la llamada convierte una Coca en varias. Con la bandera, las politicas v2 mandan pedir el agregado UNA vez (con la variante ya resuelta) y, despues, contestar
// que ya se aviso sin volver a llamar la herramienta ni repetir la frase completa. Sin la bandera el prompt no lleva estas politicas (se anexan solo con cerebro_v2).
import { describe, expect, it } from "vitest";
import { PM_POLICY_RULES_V2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { fusionarRenglones } from "../src/agregados/fusion.ts";

describe("ESC-11 agregado a un pedido ya creado: una sola solicitud y sin repetir la frase", () => {
  const regla = PM_POLICY_RULES_V2.split("\n").find((l) => /solicitar_agregado_pedido/.test(l) && /una sola vez/i.test(l)) ?? "";

  it("la politica v2 manda llamar solicitar_agregado_pedido UNA sola vez por lo que agrega, con la variante ya resuelta", () => {
    expect(regla).not.toBe("");
    expect(regla).toMatch(/variante/i);
  });

  it("si el cliente solo pregunta si ya avisaron, agradece o insiste: no vuelve a llamar la herramienta (sumaria otra vez lo mismo) ni repite la frase completa", () => {
    expect(regla).toMatch(/no la vuelva a llamar/i);
    expect(regla).toMatch(/sumar/i);
    expect(regla).toMatch(/ya le avis[eé] a la sucursal/i);
    expect(regla).toMatch(/no repita/i);
  });

  it("la razon de la regla: la fusion de la solicitud abierta SUMA cantidades (una Coca pedida dos veces queda en dos)", () => {
    const coca = { id: "coca", name: "Coca-Cola", price: 45, quantity: 1 };
    expect(fusionarRenglones([coca], [coca])).toEqual([{ ...coca, quantity: 2 }]);
  });
});
