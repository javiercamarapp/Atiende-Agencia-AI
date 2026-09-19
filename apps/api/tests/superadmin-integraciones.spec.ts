// GET /superadmin/integraciones — mismo criterio de autorización que
// superadmin.spec.ts (403 explícito para staff normal, 401 sin token). El caso
// feliz verifica la FORMA de la respuesta y, sobre todo, que nunca se filtre un
// valor: solo nombres de variable y booleanos.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

interface IntegracionRespuesta {
  id: string;
  nombre: string;
  configurada: boolean;
  faltantes: string[];
  habilita: string;
}

describe("GET /superadmin/integraciones", () => {
  it("un superadmin real ve la lista de integraciones, sin filtrar ningún valor de secreto", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;

    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);

    const app = buildApp(base.deps);
    const token = await signAccessToken(
      { sub: superadminId, org_id: "", vertical: "restaurantes", property_ids: null, email: "superadmin@example.com" },
      base.deps.env.jwtSecret,
      base.deps.env.accessTokenTtlSeconds,
    );

    const secretoDeMentira = "no-deberia-aparecer-en-la-respuesta";
    const previo = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = secretoDeMentira;
    try {
      const res = await app.request("/superadmin/integraciones", { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(secretoDeMentira);

      const body = JSON.parse(bodyText) as { integraciones: IntegracionRespuesta[] };
      expect(Array.isArray(body.integraciones)).toBe(true);
      expect(body.integraciones.length).toBeGreaterThan(0);

      const stripe = body.integraciones.find((i) => i.id === "stripe");
      expect(stripe).toBeDefined();
      expect(stripe!.configurada).toBe(false); // falta STRIPE_WEBHOOK_SECRET aunque SECRET_KEY sí esté
      expect(stripe!.faltantes).toContain("STRIPE_WEBHOOK_SECRET");
      expect(stripe!.faltantes).not.toContain("STRIPE_SECRET_KEY");

      for (const integracion of body.integraciones) {
        expect(typeof integracion.id).toBe("string");
        expect(typeof integracion.nombre).toBe("string");
        expect(typeof integracion.configurada).toBe("boolean");
        expect(typeof integracion.habilita).toBe("string");
        expect(Array.isArray(integracion.faltantes)).toBe(true);
        for (const faltante of integracion.faltantes) expect(typeof faltante).toBe("string");
      }
    } finally {
      if (previo === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previo;
    }
  });

  it("un staff normal (no superadmin) recibe 403 explícito, nunca la lista", async () => {
    const base = await buildTestDeps();
    const token = await signAccessToken(
      { sub: randomUUID(), org_id: base.organizationId, vertical: "restaurantes", property_ids: null, email: base.ownerEmail },
      base.deps.env.jwtSecret,
      base.deps.env.accessTokenTtlSeconds,
    );

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/integraciones", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("sin token -- 401, mismo criterio que cualquier otra ruta de superadmin", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/integraciones");
    expect(res.status).toBe(401);
  });
});
