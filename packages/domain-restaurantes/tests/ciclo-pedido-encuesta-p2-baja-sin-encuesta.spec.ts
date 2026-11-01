// Revision independiente de #713 (REVISION-SEGURIDAD-PARIDAD-OPERACION.md, seccion Operacion): p2-baja-sin-encuesta.
import { describe, expect, it } from "vitest";
import { InMemoryCicloPedidoRepository } from "../src/ciclo-pedido/in-memory-repository.ts";
import { procesarMensajeDeEncuesta } from "../src/ciclo-pedido/servicio.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { HASH, PHONE, T0 } from "./support/ciclo-encuesta.ts";

describe("P2: BAJA sin encuesta abierta", () => {
  it("'BAJA' registra la baja aunque no haya encuesta (y 'no gracias' no)", async () => {
    const fixture = buildRestaurantFixture();
    const ciclo = new InMemoryCicloPedidoRepository(fixture.repo);
    const deps = { repo: fixture.repo, ciclo };
    expect(await procesarMensajeDeEncuesta(deps, { organizationId: fixture.organizationId, phone: PHONE, body: "no gracias", ahora: T0 })).toBeNull();
    const r = await procesarMensajeDeEncuesta(deps, { organizationId: fixture.organizationId, phone: PHONE, body: "BAJA", ahora: T0 });
    expect(r?.tipo).toBe("baja");
    expect(ciclo.hayBaja(fixture.organizationId, HASH)).toBe(true);
  });
  it("'baja' dentro de una frase normal ('dar de baja mi pedido') no es la baja de encuestas", async () => {
    const fixture = buildRestaurantFixture();
    const ciclo = new InMemoryCicloPedidoRepository(fixture.repo);
    const deps = { repo: fixture.repo, ciclo };
    expect(await procesarMensajeDeEncuesta(deps, { organizationId: fixture.organizationId, phone: PHONE, body: "quiero dar de baja mi pedido", ahora: T0 })).toBeNull();
    expect(ciclo.hayBaja(fixture.organizationId, HASH)).toBe(false);
  });
  it("'stop' sin encuesta abierta NO es baja (podria ser parte de otra conversacion); 'no quiero mas encuestas' si", async () => {
    const fixture = buildRestaurantFixture();
    const ciclo = new InMemoryCicloPedidoRepository(fixture.repo);
    const deps = { repo: fixture.repo, ciclo };
    expect(await procesarMensajeDeEncuesta(deps, { organizationId: fixture.organizationId, phone: PHONE, body: "stop", ahora: T0 })).toBeNull();
    expect((await procesarMensajeDeEncuesta(deps, { organizationId: fixture.organizationId, phone: PHONE, body: "no quiero más encuestas", ahora: T0 }))?.tipo).toBe("baja");
  });
});
