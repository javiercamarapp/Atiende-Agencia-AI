// Revision independiente de #713 (REVISION-SEGURIDAD-PARIDAD-OPERACION.md, seccion Operacion): p1-3-comentario-redactado.
import { describe, expect, it } from "vitest";
import { redactarComentarioEncuesta } from "../src/ciclo-pedido/reglas.ts";
import { conEncuestaEnviada, min, responder } from "./support/ciclo-encuesta.ts";

describe("P1-3: el comentario se redacta como la conversacion", () => {
  it("tarjetas, telefonos, correos y direcciones salen enmascarados", () => {
    const r = redactarComentarioEncuesta("Pague con la tarjeta 4111 1111 1111 1111, llamenme al 999 123 4567 o a juan@correo.com, vivo en Calle 60 #123 por 21 y 23");
    expect(r).not.toMatch(/4111/);
    expect(r).not.toMatch(/999 123 4567/);
    expect(r).not.toContain("juan@correo.com");
    expect(r).not.toMatch(/Calle 60/);
    expect(r).toContain("[");
  });
  it("lo que se guarda en la fila es el texto redactado", async () => {
    const e = await conEncuestaEnviada();
    await responder(e, "5", min(1));
    await responder(e, "Mi tarjeta es 4111 1111 1111 1111, llamen al 9991234567", min(2));
    const c = e.ciclo.filasEncuesta()[0]!.comentario!;
    expect(c).not.toMatch(/4111|9991234567/);
  });
});

