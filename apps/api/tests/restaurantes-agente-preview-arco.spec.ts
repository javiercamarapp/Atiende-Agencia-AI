// «Probar agente» usa el MISMO atajo ARCO que el webhook real (antes el preview se saltaba el atajo y el dueño no podia ver como responde el agente a una solicitud de
// derechos). Sobre un repositorio en memoria: la prueba no registra solicitudes reales con el telefono ficticio.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LlmGateway } from "@atiende/agent-core";
import { InMemoryPrivacidadRepository } from "@atiende/domain-restaurantes";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function construir(opciones: { conLlm?: boolean; clasificador?: import("@atiende/domain-restaurantes").ClasificadorArco } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const turnos: string[] = [];
  const privacidad = new InMemoryPrivacidadRepository();
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage(entrada) {
      turnos.push(entrada.messages.at(-1)!.content);
      return { reply: "Hola, soy el asistente (prueba).", orderId: null, propertyId: entrada.propertyId ?? null };
    },
  };
  const deps: AppDeps = { ...ctx.deps, ...(opciones.conLlm === false ? {} : { llmGateway: {} as LlmGateway }), turnHandler, privacidadRepo: () => privacidad, ...(opciones.clasificador ? { arcoClassifier: opciones.clasificador } : {}) };
  const app = buildApp(deps);
  const enviar = (mensajes: Array<{ rol: "usuario" | "agente"; texto: string }>) =>
    app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/agente-whatsapp/preview/mensaje`, authedJson(ctx.staff.owner.token, { sesionId: randomUUID(), mensajes }));
  return { ctx, enviar, turnos, privacidad };
}

describe("«Probar agente»: atajo ARCO compartido con produccion", () => {
  it("una solicitud de derechos recibe la respuesta ARCO REAL, sin pasar por el modelo y sin registrar nada en la base", async () => {
    const t = await construir();
    const res = await t.enviar([{ rol: "usuario", texto: "borren mis datos" }]);
    expect(res.status).toBe(200);
    const cuerpo = (await res.json()) as Json;
    expect(cuerpo.respuesta).toContain("CONFIRMO");
    expect(t.turnos).toEqual([]);
    expect(t.privacidad.requests).toHaveLength(0);
  });

  it("el atajo no necesita proveedor LLM (como en produccion, una solicitud de derechos no depende del modelo)", async () => {
    const t = await construir({ conLlm: false });
    const res = await t.enviar([{ rol: "usuario", texto: "quiero ejercer mis derechos ARCO" }]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).respuesta).toContain("Elija una opción");
  });

  it("el menu y su eleccion funcionan dentro del historial de la prueba", async () => {
    const t = await construir();
    const menu = ((await (await t.enviar([{ rol: "usuario", texto: "derechos ARCO" }])).json()) as Json).respuesta as string;
    const res = await t.enviar([
      { rol: "usuario", texto: "derechos ARCO" },
      { rol: "agente", texto: menu },
      { rol: "usuario", texto: "Cancelación" },
    ]);
    expect(((await res.json()) as Json).respuesta).toContain("cancelación");
  });

  it("senal debil: contesta el agente y se agrega la oferta de derechos", async () => {
    const t = await construir();
    const cuerpo = (await (await t.enviar([{ rol: "usuario", texto: "no me llamen" }])).json()) as Json;
    expect(t.turnos).toEqual(["no me llamen"]);
    expect(cuerpo.respuesta).toContain("Hola, soy el asistente (prueba).");
    expect(cuerpo.respuesta).toContain("Por si se refería a sus datos personales");
  });

  it("el clasificador tambien corre en el preview (mismo camino que produccion) y no registra nada en la base", async () => {
    const t = await construir({ clasificador: { clasificar: async () => ({ intencion: "revocacion_contacto", confianza: 0.95, derechoMasProbable: "oposicion" }) } });
    const cuerpo = (await (await t.enviar([{ rol: "usuario", texto: "oiga ya no quiero que me anden buscando" }])).json()) as Json;
    expect(cuerpo.respuesta).toContain("CONFIRMO");
    expect(cuerpo.respuesta).toContain("oposición");
    expect(t.turnos).toEqual([]);
    expect(t.privacidad.requests).toHaveLength(0);
  });

  it("un mensaje normal sigue al agente tal cual", async () => {
    const t = await construir();
    const cuerpo = (await (await t.enviar([{ rol: "usuario", texto: "quiero 2 tacos de pastor" }])).json()) as Json;
    expect(t.turnos).toEqual(["quiero 2 tacos de pastor"]);
    expect(cuerpo.respuesta).toBe("Hola, soy el asistente (prueba).");
  });
});
