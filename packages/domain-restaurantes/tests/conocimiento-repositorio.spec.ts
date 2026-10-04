// Almacen en memoria (mismo contrato que Postgres) y compatibilidad con la base SIN migrar (053): AbortAwareFakeSession reproduce el
// estado abortado de la transaccion unica del request; cada caso verifica el vacio honesto / 503 y que la MISMA sesion sigue viva.
import { describe, expect, it } from "vitest";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const ACTOR = "00000000-0000-4000-8000-0000000000c1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const sinTabla = (tabla: string) => pgError("42P01", `relation "restaurantes.${tabla}" does not exist`);

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("conocimiento: base SIN migrar (42P01) con la transaccion unica del request", () => {
  it("la lista del panel degrada a 'no disponible aun' y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.conocimiento_negocio/i, respond: () => sinTabla("conocimiento_negocio") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).listarConocimiento(ORG)).toEqual({ disponible: false, entradas: [] });
    await sesionSigueViva(session);
  });

  it("la lectura del agente degrada a [] (el turno sigue sin conocimiento) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.conocimiento_negocio/i, respond: () => sinTabla("conocimiento_negocio") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).listarConocimientoPublicado(ORG, PROP)).toEqual([]);
    await sesionSigueViva(session);
  });

  it("crear / editar / borrar lanzan RestaurantesConfigUnavailableError (503 honesto), nunca una escritura a medias", async () => {
    for (const patron of [/insert into restaurantes\.conocimiento_negocio/i, /update restaurantes\.conocimiento_negocio/i, /delete from restaurantes\.conocimiento_negocio/i]) {
      const session = new AbortAwareFakeSession([{ match: patron, respond: () => sinTabla("conocimiento_negocio") }, SIGUIENTE]);
      const repo = new PostgresRestaurantesRepository(session);
      const op = patron.source.startsWith("insert")
        ? repo.crearConocimiento(ORG, ACTOR, { titulo: "t", texto: "x", tipo: "faq" })
        : patron.source.startsWith("update")
          ? repo.actualizarConocimiento(ORG, ACTOR, "id", { texto: "y" })
          : repo.borrarConocimiento(ORG, "id");
      await expect(op).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
      await sesionSigueViva(session);
    }
  });

  it("el interruptor: sin la tabla el agente de WhatsApp sigue ENCENDIDO (como hasta hoy) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.whatsapp_sucursal_control/i, respond: () => sinTabla("whatsapp_sucursal_control") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).findAgenteWhatsappActivo(PROP)).toBe(true);
    await sesionSigueViva(session);
  });

  it("el interruptor: la lista del panel degrada a 'no disponible' y apagar lanza el 503 honesto", async () => {
    const lista = new AbortAwareFakeSession([{ match: /from restaurantes\.whatsapp_sucursal_control/i, respond: () => sinTabla("whatsapp_sucursal_control") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(lista).listarAgentesWhatsappApagados(ORG)).toEqual({ disponible: false, propertyIdsApagados: [] });
    await sesionSigueViva(lista);
    const escritura = new AbortAwareFakeSession([{ match: /insert into restaurantes\.whatsapp_sucursal_control/i, respond: () => sinTabla("whatsapp_sucursal_control") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(escritura).fijarAgenteWhatsappActivo(ORG, PROP, ACTOR, false)).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(escritura);
  });

  it("un error que NO es de base sin migrar se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.whatsapp_sucursal_control/i, respond: () => pgError("23505", "otra cosa") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).findAgenteWhatsappActivo(PROP)).rejects.toMatchObject({ code: "23505" });
  });

  it("con la tabla presente lee el interruptor: fila apagada = false, sin fila = true", async () => {
    const apagada = new AbortAwareFakeSession([{ match: /from restaurantes\.whatsapp_sucursal_control where property_id/i, respond: () => [{ agente_activo: false }] }]);
    expect(await new PostgresRestaurantesRepository(apagada).findAgenteWhatsappActivo(PROP)).toBe(false);
    const sinFila = new AbortAwareFakeSession([{ match: /from restaurantes\.whatsapp_sucursal_control where property_id/i, respond: () => [] }]);
    expect(await new PostgresRestaurantesRepository(sinFila).findAgenteWhatsappActivo(PROP)).toBe(true);
  });
});

describe("conocimiento: almacen en memoria (mismo contrato que Postgres)", () => {
  async function repoConSucursales() {
    const repo = new InMemoryRestaurantesRepository();
    repo.seedBranch({ propertyId: "p1", organizationId: "org-a", name: "Uno", slug: "uno", status: "active", phone: null, address: null, lat: null, lng: null });
    repo.seedBranch({ propertyId: "p9", organizationId: "org-b", name: "Ajena", slug: "ajena", status: "active", phone: null, address: null, lat: null, lng: null });
    return repo;
  }

  it("aisla por organizacion: otra organizacion no ve, edita ni borra", async () => {
    const repo = await repoConSucursales();
    const a = await repo.crearConocimiento("org-a", "u1", { titulo: "t", texto: "x", tipo: "faq" });
    expect((await repo.listarConocimiento("org-b")).entradas).toEqual([]);
    expect(await repo.actualizarConocimiento("org-b", "u2", a.id, { texto: "hack" })).toBeNull();
    expect(await repo.borrarConocimiento("org-b", a.id)).toBe(false);
    const editada = await repo.actualizarConocimiento("org-a", "u1", a.id, { texto: "nuevo", activo: false });
    expect(editada).toMatchObject({ texto: "nuevo", activo: false, version: 2 });
    expect(await repo.listarConocimientoPublicado("org-a", null)).toEqual([]);
  });

  it("los borradores no llegan al agente hasta publicarse", async () => {
    const repo = await repoConSucursales();
    const borrador = await repo.crearConocimiento("org-a", "u1", { titulo: "t", texto: "x", tipo: "faq", estado: "borrador", origen: "importado" });
    expect(await repo.listarConocimientoPublicado("org-a", null)).toEqual([]);
    await repo.actualizarConocimiento("org-a", "u1", borrador.id, { estado: "publicado" });
    expect(await repo.listarConocimientoPublicado("org-a", null)).toHaveLength(1);
  });

  it("reemplaza_id solo hacia una entrada general de la misma organizacion y solo con sucursal", async () => {
    const repo = await repoConSucursales();
    const generalB = await repo.crearConocimiento("org-b", "u9", { titulo: "t", texto: "x", tipo: "faq" });
    await expect(repo.crearConocimiento("org-a", "u1", { propertyId: null, reemplazaId: generalB.id, titulo: "t", texto: "x", tipo: "faq" })).rejects.toThrow(/reemplaza_id/);
  });

  it("el interruptor se apaga y se enciende por sucursal; sin fila esta encendido", async () => {
    const repo = await repoConSucursales();
    expect(await repo.findAgenteWhatsappActivo("p-desconocida")).toBe(true);
    await repo.fijarAgenteWhatsappActivo("org-a", "p1", "u1", false);
    expect(await repo.findAgenteWhatsappActivo("p1")).toBe(false);
    expect(await repo.listarAgentesWhatsappApagados("org-a")).toEqual({ disponible: true, propertyIdsApagados: ["p1"] });
    expect((await repo.listarAgentesWhatsappApagados("org-b")).propertyIdsApagados).toEqual([]);
    // Una sucursal de otra organizacion no se puede apagar (mismo contrato que el with check de la policy).
    await expect(repo.fijarAgenteWhatsappActivo("org-a", "p9", "u1", false)).rejects.toThrow(/no pertenece/);
    await repo.fijarAgenteWhatsappActivo("org-a", "p1", "u1", true);
    expect(await repo.findAgenteWhatsappActivo("p1")).toBe(true);
  });
});
