// H-29 -- configuracion del canal WhatsApp y del agente de voz: integracion HTTP real sobre el espejo en memoria. RLS/GRANT por columna
// (el secreto no es legible por el cliente) los cubre scripts/verify-hoteles-hk-canal contra Postgres real.
import { describe, expect, it } from "vitest";
import { InMemoryMensajeriaConfigRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";

async function setup(opts?: { migrated?: boolean }) {
  const ctx = await buildHotelesTestContext(buildApp);
  const repo = new InMemoryMensajeriaConfigRepository(opts);
  const app = buildApp({ ...ctx.deps, hotelesMensajeriaConfigRepo: () => repo });
  const base = `/hoteles/${ctx.propertyId}/mensajeria`;
  const call = (method: string, path: string, token: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let raw: string | undefined;
    if (body !== undefined) {
      raw = JSON.stringify(body);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(new TextEncoder().encode(raw).byteLength);
    }
    return app.request(`${base}${path}`, { method, headers, ...(raw !== undefined ? { body: raw } : {}) });
  };
  return { ctx, repo, call };
}

describe("estado", () => {
  it("owner/gm ven el estado; el resto, 403", async () => {
    const s = await setup();
    expect(await (await s.call("GET", "", s.ctx.staff.owner.token)).json()).toEqual({
      whatsapp: { configurado: false, phoneNumberId: null, habilitado: false, actualizadoEn: null },
      voz: { configurado: false, habilitado: false, secretoConfigurado: false, actualizadoEn: null },
    });
    for (const t of [s.ctx.staff.frontdesk.token, s.ctx.staff.housekeeping.token, s.ctx.staff.reservations.token, s.ctx.staff.accountant.token]) {
      expect((await s.call("GET", "", t)).status).toBe(403);
    }
  });
});

describe("canal de WhatsApp", () => {
  it("guarda el numero, valida el formato (400) y responde 409 si otra propiedad ya lo tiene", async () => {
    const s = await setup();
    const ok = await s.call("PUT", "/whatsapp", s.ctx.staff.gm.token, { phoneNumberId: "109876543210", habilitado: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ configurado: true, phoneNumberId: "109876543210", habilitado: true });
    expect((await s.call("PUT", "/whatsapp", s.ctx.staff.gm.token, { phoneNumberId: "+52 55 1234", habilitado: true })).status).toBe(400);
    expect((await s.call("PUT", "/whatsapp", s.ctx.staff.gm.token, { phoneNumberId: "12345", habilitado: true, accessToken: "EAAB" })).status).toBe(400); // nada de tokens
    await s.repo.saveWhatsAppChannel("otra-propiedad", { phoneNumberId: "55555", enabled: true }, "u");
    expect((await s.call("PUT", "/whatsapp", s.ctx.staff.owner.token, { phoneNumberId: "55555", habilitado: true })).status).toBe(409);
  });
  it("frontdesk y fnb no editan (403); sin 039 responde 503", async () => {
    const s = await setup();
    for (const t of [s.ctx.staff.frontdesk.token, s.ctx.staff.fnb.token]) expect((await s.call("PUT", "/whatsapp", t, { phoneNumberId: "12345", habilitado: true })).status).toBe(403);
    const old = await setup({ migrated: false });
    expect((await old.call("PUT", "/whatsapp", old.ctx.staff.owner.token, { phoneNumberId: "12345", habilitado: true })).status).toBe(503);
    expect((await old.call("GET", "", old.ctx.staff.owner.token)).status).toBe(200);
  });
});

describe("agente de voz: el secreto es write-only", () => {
  it("rotar devuelve el secreto UNA vez (no-store) y ninguna lectura posterior lo contiene", async () => {
    const s = await setup();
    const rot = await s.call("POST", "/voz/rotar-secreto", s.ctx.staff.owner.token, {});
    expect(rot.status).toBe(200);
    expect(rot.headers.get("cache-control")).toBe("no-store");
    const body = (await rot.json()) as { secreto: string; secretoConfigurado: boolean; habilitado: boolean };
    expect(body.secreto).toMatch(/^[0-9a-f]{64}$/);
    expect(body).toMatchObject({ secretoConfigurado: true, habilitado: false });
    expect(s.repo.storedSecret(s.ctx.propertyId)).toBe(body.secreto);

    const read = JSON.stringify(await (await s.call("GET", "", s.ctx.staff.owner.token)).json());
    expect(read).not.toContain(body.secreto);
    expect(read).not.toContain("secreto\"");
    // una segunda rotacion produce otro secreto y conserva el estado habilitado
    await s.call("PUT", "/voz", s.ctx.staff.owner.token, { habilitado: true });
    const again = (await (await s.call("POST", "/voz/rotar-secreto", s.ctx.staff.gm.token, {})).json()) as { secreto: string; habilitado: boolean };
    expect(again.secreto).not.toBe(body.secreto);
    expect(again.habilitado).toBe(true);
  });
  it("encender la voz sin secreto es 409; roles sin acceso 403; habilitado debe ser booleano", async () => {
    const s = await setup();
    expect((await s.call("PUT", "/voz", s.ctx.staff.owner.token, { habilitado: true })).status).toBe(409);
    expect((await s.call("PUT", "/voz", s.ctx.staff.owner.token, { habilitado: "si" })).status).toBe(400);
    for (const t of [s.ctx.staff.frontdesk.token, s.ctx.staff.housekeeping.token]) {
      expect((await s.call("POST", "/voz/rotar-secreto", t, {})).status).toBe(403);
      expect((await s.call("PUT", "/voz", t, { habilitado: true })).status).toBe(403);
    }
  });
  it("sin 039 la rotacion responde 503 y no entrega ningun secreto", async () => {
    const s = await setup({ migrated: false });
    const res = await s.call("POST", "/voz/rotar-secreto", s.ctx.staff.owner.token, {});
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/[0-9a-f]{64}/);
  });
});
