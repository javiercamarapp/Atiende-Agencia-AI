// Rn-P3-20 / Rn-P3-21 -- el hilo de una conversación (GET .../conversaciones/:id/hilo) y las señales de escalamiento persistidas.
// Cubre: orden y origen de los mensajes con sus borradores, la señal que el generador detectó guardada en el borrador y devuelta en
// los listados, la lectura por rol (limpieza no lee lo que escribe el huésped) y el aislamiento por property (404 cross-tenant).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

interface BorradorBody {
  id: string;
  estado: string;
  mensajeEntranteId: string | null;
  necesitaEscalamiento: boolean;
  senales: string[];
}
interface HiloBody {
  conversacion: { id: string };
  mensajes: { id: string; direccion: string; origen: string; texto: string }[];
  borradores: BorradorBody[];
}

async function preparar() {
  const ctx = await buildRentasTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const token = ctx.staff.adminGestora.token;
  const conv = (await (await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/conversaciones`, authedJson(token, { canal: "airbnb", propiedadNombre: "Casa Sol" }))).json()) as { id: string };
  const mensaje = async (texto: string, origen?: string) => {
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/conversaciones/${conv.id}/mensajes`, authedJson(token, { texto, origen }));
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  const borrador = async (mensajeEntranteId: string) => {
    const res = await app.request(`/rentas/${ctx.propertyId}/conversaciones/${conv.id}/borradores`, authedJson(token, { mensajeEntranteId }));
    expect(res.status).toBe(201);
    return (await res.json()) as BorradorBody;
  };
  const hilo = (t: string, propertyId = ctx.propertyId, id = conv.id) => app.request(`/rentas/${propertyId}/conversaciones/${id}/hilo`, authedJson(t));
  return { ctx, app, token, conv, mensaje, borrador, hilo };
}

describe("GET /rentas/:propertyId/conversaciones/:id/hilo", () => {
  it("devuelve mensajes entrantes y salientes en orden con su origen, y cada borrador ligado al mensaje que responde", async () => {
    const { ctx, app, token, conv, mensaje, borrador, hilo } = await preparar();
    const m1 = await mensaje("¿Cuál es la clave del wifi?", "manual");
    const b1 = await borrador(m1.id);
    // Aprobar genera el mensaje saliente (origen simulador) en el mismo hilo.
    expect((await app.request(`/rentas/${ctx.propertyId}/borradores/${b1.id}/aprobar`, authedJson(token, {}))).status).toBe(200);
    const m2 = await mensaje("Gracias, ¿a qué hora es el check-in?");
    const b2 = await borrador(m2.id);

    const res = await hilo(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HiloBody;
    expect(body.conversacion.id).toBe(conv.id);
    expect(body.mensajes.map((m) => [m.direccion, m.origen])).toEqual([
      ["entrante", "manual"],
      ["saliente", "simulador"],
      ["entrante", "simulador"],
    ]);
    expect(body.mensajes[0]!.texto).toBe("¿Cuál es la clave del wifi?");
    const porMensaje = (id: string) => body.borradores.filter((b) => b.mensajeEntranteId === id).map((b) => b.id);
    expect(porMensaje(m1.id)).toEqual([b1.id]);
    expect(porMensaje(m2.id)).toEqual([b2.id]);
  });

  it("limpieza recibe 403 (no lee lo que escribe el huésped); contador y solo_calendario conservan la lectura", async () => {
    const { ctx, hilo } = await preparar();
    expect((await hilo(ctx.staff.limpieza.token)).status).toBe(403);
    expect((await hilo(ctx.staff.contador.token)).status).toBe(200);
    expect((await hilo(ctx.staff.operadorSoloCalendario.token)).status).toBe(200);
    expect((await hilo(ctx.staff.operadorAccesoTotal.token)).status).toBe(200);
  });

  it("limpieza recibe 403 también en las lecturas por unidad (conversaciones y mensajes) y en el listado de borradores", async () => {
    const { ctx, app, conv } = await preparar();
    const t = ctx.staff.limpieza.token;
    expect((await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/conversaciones`, authedJson(t))).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/conversaciones/${conv.id}/mensajes`, authedJson(t))).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/conversaciones/${conv.id}/borradores`, authedJson(t))).status).toBe(403);
  });

  it("una conversación de OTRA property da 404, aunque el id exista en la organización; y un id inexistente también", async () => {
    const { ctx, token, hilo } = await preparar();
    const otraPropiedad = randomUUID();
    ctx.engine.seedProperty({ id: otraPropiedad, organizationId: ctx.organizationId });
    const ajena = await ctx.rentasMensajeriaRepo.insertConversacion({ organizationId: ctx.organizationId, propertyId: otraPropiedad, unidadId: randomUUID(), canal: "vrbo", propiedadNombre: "Casa Ajena" });
    await ctx.rentasMensajeriaRepo.insertMensaje({ conversacionId: ajena.id, direccion: "entrante", origen: "manual", texto: "texto de otra property" });
    const res = await hilo(token, ctx.propertyId, ajena.id);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("texto de otra property");
    expect((await hilo(token, ctx.propertyId, randomUUID())).status).toBe(404);
  });

  it("sin sesión da 401", async () => {
    const { ctx, app, conv } = await preparar();
    expect((await app.request(`/rentas/${ctx.propertyId}/conversaciones/${conv.id}/hilo`)).status).toBe(401);
  });
});

describe("señales de escalamiento persistidas en el borrador", () => {
  it("una emergencia queda guardada (necesitaEscalamiento y senales) y el listado y el hilo la devuelven; una pregunta rutinaria no", async () => {
    const { ctx, app, token, conv, mensaje, borrador, hilo } = await preparar();
    const urgente = await mensaje("Es una emergencia: hay una fuga de gas y no puedo entrar");
    const rutina = await mensaje("¿Cuál es la clave del wifi?");
    const bUrgente = await borrador(urgente.id);
    const bRutina = await borrador(rutina.id);
    expect(bUrgente).toMatchObject({ necesitaEscalamiento: true });
    expect(bUrgente.senales).toContain("emergencia");
    expect(bRutina).toMatchObject({ necesitaEscalamiento: false, senales: [] });

    const lista = (await (await app.request(`/rentas/${ctx.propertyId}/conversaciones/${conv.id}/borradores`, authedJson(token))).json()) as { borradores: BorradorBody[] };
    expect(lista.borradores.find((b) => b.id === bUrgente.id)).toMatchObject({ necesitaEscalamiento: true, senales: expect.arrayContaining(["emergencia"]) });
    expect(lista.borradores.find((b) => b.id === bRutina.id)).toMatchObject({ necesitaEscalamiento: false, senales: [] });
    const body = (await (await hilo(token)).json()) as HiloBody;
    expect(body.borradores.find((b) => b.id === bUrgente.id)?.senales).toContain("emergencia");
  });
});
