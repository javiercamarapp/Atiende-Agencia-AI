// QA-PM-R6 A13: el pedido no se confirma si el ultimo mensaje del cliente rechaza el resumen. Corpus etiquetado (positivos y negativos) + contrato de entrada.
import { describe, expect, it } from "vitest";
import { rechazaElResumen } from "../src/agent-tools/order-flow.ts";

describe("rechazaElResumen", () => {
  it.each([
    "No, así no. En el flyer dice $10 cada taco, cóbrame $10 por los 3, porfa.",
    "así no",
    "No es correcto, son 4 tacos",
    "no está bien, cambia la tortilla",
    "Eso está mal",
    "no, corrige la hora",
    "No lo quiero así",
  ])("rechaza: %s", (t) => expect(rechazaElResumen(t)).toBe(true));
  it.each([
    "Sí, confirmo",
    "no",
    "No, nada más",
    "no, así está bien",
    "no, está bien así",
    "No, gracias, es todo",
    "sí, así está bien",
    "Está bien",
    "ok, dale",
    "así no, mejor sí confirmo",
    "quiero 3 tacos",
    "no tengo cambio",
    "ya no hay nada mal con el pedido, sí",
  ])("no rechaza: %s", (t) => expect(rechazaElResumen(t)).toBe(false));
  it.each([0, "", "   ", null, undefined, false, [], {}, 5].map((v) => [v]))("contrato: %j -> false sin lanzar", (v) => expect(rechazaElResumen(v)).toBe(false));
});
