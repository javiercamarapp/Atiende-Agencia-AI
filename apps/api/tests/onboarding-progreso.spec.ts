// ds3 «Guía»: GET/PUT /v1/onboarding/progreso contra el repo en memoria (mismas reglas que core.guardar_onboarding_progreso).
// La RLS y la funcion real se verifican contra Postgres en scripts/verify-onboarding-progreso/.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryOnboardingProgresoRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

const RUTA = "/v1/onboarding/progreso";

async function setup(opciones: { conRepo?: boolean } = {}) {
  const s = await seguridadSetup();
  const repo = new InMemoryOnboardingProgresoRepository();
  const deps = { ...s.deps, ...(opciones.conRepo === false ? {} : { onboardingProgresoRepo: () => repo }) };
  const app = buildApp(deps);
  const owner = await s.staff();
  const otro = await s.staff();
  repo.seedOrganizacion("taqueria", "restaurantes", [owner.id]);
  repo.seedOrganizacion("clinica", "citas", [otro.id]);
  const put = (token: string, cuerpo: unknown) =>
    app.request(RUTA, { method: "PUT", headers: bearer(token, { "content-type": "application/json" }), body: JSON.stringify(cuerpo) });
  const get = (token: string, q: string) => app.request(`${RUTA}?${q}`, { headers: bearer(token) });
  return { s, app, repo, owner, otro, put, get };
}

const PASO = { pista: "restaurantes.owner", org: "taqueria", modo: "corto", paso: "pedidos.que", visto: true, activo: true };

describe("GET/PUT /v1/onboarding/progreso", () => {
  it("sin token: 401", async () => {
    const { app } = await setup();
    expect((await app.request(`${RUTA}?pista=restaurantes.owner&org=taqueria`)).status).toBe(401);
  });

  it("guarda el paso de la persona y lo devuelve en el GET (se retoma en otro equipo)", async () => {
    const { owner, put, get } = await setup();
    const r = await put(owner.token, PASO);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ disponible: true });
    const g = await get(owner.token, "pista=restaurantes.owner&org=taqueria");
    const cuerpo = (await g.json()) as { disponible: boolean; progreso: Record<string, unknown> };
    expect(cuerpo.disponible).toBe(true);
    expect(cuerpo.progreso).toMatchObject({ modo: "corto", paso: "pedidos.que", visto: true, activo: true, terminado: false });
  });

  it("terminado es un hito: repetir el recorrido no lo borra", async () => {
    const { owner, put, get } = await setup();
    await put(owner.token, { ...PASO, paso: null, activo: false, terminado: true });
    await put(owner.token, { ...PASO, paso: "pedidos.ir" });
    const cuerpo = (await (await get(owner.token, "pista=restaurantes.owner&org=taqueria")).json()) as { progreso: { terminado: boolean } };
    expect(cuerpo.progreso.terminado).toBe(true);
  });

  it("otra persona no ve el progreso ajeno (la fila es por persona)", async () => {
    const { owner, otro, put, get } = await setup();
    await put(owner.token, PASO);
    const cuerpo = (await (await get(otro.token, "pista=restaurantes.owner&org=taqueria")).json()) as { progreso: unknown };
    expect(cuerpo.progreso).toBeNull();
  });

  it("cross-tenant: guardar en una organizacion de la que no es miembro es 403", async () => {
    const { otro, put } = await setup();
    expect((await put(otro.token, PASO)).status).toBe(403);
  });

  it("la pista debe ser de la vertical de la organizacion: 400", async () => {
    const { owner, put } = await setup();
    expect((await put(owner.token, { ...PASO, pista: "citas.owner" })).status).toBe(400);
  });

  it("formato cerrado: paso, pista, modo y banderas invalidos son 400 sin tocar la base", async () => {
    const { owner, put, get } = await setup();
    expect((await put(owner.token, { ...PASO, paso: "<script>" })).status).toBe(400);
    expect((await put(owner.token, { ...PASO, paso: "x".repeat(81) })).status).toBe(400);
    expect((await put(owner.token, { ...PASO, pista: "Restaurantes" })).status).toBe(400);
    expect((await put(owner.token, { ...PASO, modo: "largo" })).status).toBe(400);
    expect((await put(owner.token, { ...PASO, visto: "si" })).status).toBe(400);
    expect((await put(owner.token, [1, 2])).status).toBe(400);
    expect((await get(owner.token, "pista=superadmin&org=taqueria")).status).toBe(400);
    expect((await get(owner.token, "pista=restaurantes.owner")).status).toBe(400);
  });

  it("pista superadmin sin organizacion: solo un superadmin de plataforma", async () => {
    const { s, repo, owner, put } = await setup();
    expect((await put(owner.token, { pista: "superadmin", modo: "completo", paso: "organizaciones.que", visto: true })).status).toBe(403);
    const sa = await s.superadmin();
    repo.seedSuperadmin(sa.id);
    expect((await put(sa.token, { pista: "superadmin", modo: "completo", paso: "organizaciones.que", visto: true })).status).toBe(200);
  });

  it("base sin la migracion 0075: 200 con disponible:false (la guia sigue con el navegador), nunca 500", async () => {
    const { repo, owner, put, get } = await setup();
    repo.disponible = false;
    const r = await put(owner.token, PASO);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ disponible: false, actualizado: null });
    expect(await (await get(owner.token, "pista=restaurantes.owner&org=taqueria")).json()).toEqual({ disponible: false, progreso: null });
  });

  it("sin repo configurado: 200 con disponible:false", async () => {
    const { owner, put, get } = await setup({ conRepo: false });
    expect(await (await put(owner.token, PASO)).json()).toEqual({ disponible: false, actualizado: null });
    expect(await (await get(owner.token, "pista=restaurantes.owner&org=taqueria")).json()).toEqual({ disponible: false, progreso: null });
  });

  it("cuerpo de mas de 2 KB: rechazado", async () => {
    const { owner, put } = await setup();
    const r = await put(owner.token, { ...PASO, relleno: randomUUID().repeat(100) });
    expect(r.status).toBe(413);
  });
});
