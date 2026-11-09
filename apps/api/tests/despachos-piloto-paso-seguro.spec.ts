import { describe, expect, it } from "vitest";
import { PilotoEntradaInvalidaError } from "@atiende/domain-despachos";
import { AbortAwareFakeSession } from "../../../packages/domain-despachos/tests/support/aborting-fake-session.ts";
import { pasoSeguro } from "../src/routes/verticals/despachos/piloto-comun.ts";

describe("pasoSeguro", () => {
  it("un error de Postgres se reporta como codigo generico, sin el texto crudo", async () => {
    const s = new AbortAwareFakeSession([]);
    const r = await pasoSeguro(s, "x", async () => {
      throw Object.assign(new Error('new row violates check constraint "periodo_cierre_forzado_coherente"'), { code: "23514" });
    });
    expect(r).toEqual({ ok: false, error: "error_interno" });
  });
  it("un error de dominio del piloto conserva su mensaje para el usuario", async () => {
    const s = new AbortAwareFakeSession([]);
    const r = await pasoSeguro(s, "x", async () => {
      throw new PilotoEntradaInvalidaError("Captura la ficha del cliente");
    });
    expect(r).toEqual({ ok: false, error: "Captura la ficha del cliente" });
  });
});
