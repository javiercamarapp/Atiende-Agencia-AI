// Soporte de las pruebas de la revision de #713 (encuesta): una encuesta ya enviada contra los adaptadores en memoria.
import { randomUUID } from "node:crypto";
import { InMemoryCicloPedidoRepository } from "../../src/ciclo-pedido/in-memory-repository.ts";
import { barrerEncuestas, procesarMensajeDeEncuesta } from "../../src/ciclo-pedido/servicio.ts";
import { normalizePhone } from "../../src/phone.ts";
import { actorHash } from "../../src/rate-limit.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

export const T0 = new Date("2026-10-20T18:00:00.000Z");
export const min = (n: number): Date => new Date(T0.getTime() + n * 60_000);
export const TEL = "9991230001";
export const PHONE = "+5219991230001";
export const HASH = actorHash(normalizePhone(TEL));

export async function conEncuestaEnviada() {
  const fixture = buildRestaurantFixture();
  fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PNID");
  const ciclo = new InMemoryCicloPedidoRepository(fixture.repo);
  ciclo.ahora = () => T0;
  await ciclo.guardarConfigEncuesta(fixture.organizationId, "prop", { habilitada: true });
  ciclo.sembrarEntrega({
    orderId: randomUUID(), organizationId: fixture.organizationId, propertyId: "prop", customerPhone: TEL, deliveredAt: new Date(T0.getTime() - 150 * 60_000),
    zonaHoraria: "America/Merida", phoneHash: HASH, ultimoEntranteAt: new Date(T0.getTime() - 4 * 3_600_000),
  });
  const deps = { repo: fixture.repo, ciclo };
  await barrerEncuestas(deps, T0);
  return { fixture, ciclo, deps, org: fixture.organizationId };
}
export const responder = (e: Awaited<ReturnType<typeof conEncuestaEnviada>>, body: string, ahora: Date) => procesarMensajeDeEncuesta(e.deps, { organizationId: e.org, phone: PHONE, body, ahora });
