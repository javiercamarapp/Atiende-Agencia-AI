// "Adjuntar archivo" del Copiloto por HTTP en una vertical (hoteles): la ruta `POST .../chat-datos/adjuntos` vive en la MISMA cadena de autorizacion que el chat
// (JWT -> membership -> rol de la vertical) y deja su fila en la bitacora del chat. El analisis en si (CSV/Excel/PDF) lo prueba data-chat-adjuntos-analisis.spec.ts y la
// ruta de plataforma, superadmin-copiloto.spec.ts. Las otras cinco verticales montan el mismo `mountAdjuntosRoutes` (comprobado abajo contra su fuente).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DataChatAnswer, DataChatAuditEntry } from "@atiende/agent-core/data-chat";
import { InMemoryCoreRepository, InMemoryTenancyEngine, hashPassword } from "@atiende/db";
import type { HotelesDataChatReader } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";

const CSV = ["producto,unidades,cliente", "Taco,10,Ana Pérez", "Torta,5,Luis"].join("\n");
const cuerpo = { nombre: "ventas.csv", contenidoBase64: Buffer.from(CSV, "utf8").toString("base64") };

async function harness() {
  const ctx = await buildHotelesTestContext(buildApp);
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const engine = ctx.deps.engine as InMemoryTenancyEngine;
  const otherOrg = randomUUID();
  coreRepo.addOrganization({ id: otherOrg, slug: "hotel-ajeno", name: "Hotel Ajeno", vertical: "hoteles" });
  engine.seedProperty({ id: randomUUID(), organizationId: otherOrg });
  const id = randomUUID();
  const password = "correcto-caballo-batería";
  coreRepo.addStaff({ id, email: "owner-ajeno@hotel-ajeno.mx", fullName: "Ajeno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: id, organizationId: otherOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });
  engine.seedMembership({ userId: id, organizationId: otherOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });
  const audit: DataChatAuditEntry[] = [];
  const reader = {} as HotelesDataChatReader;
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no se usa en hoteles");
    },
    hotelesReader: () => reader,
    audit: () => ({ record: async (e) => void audit.push(e) }),
    rateLimiter: { allow: async () => true },
    completion: undefined,
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner-ajeno@hotel-ajeno.mx", password }) });
  return { ctx, app, audit, otroOrg: ((await login.json()) as { token: string }).token };
}

describe("adjuntar archivo en una vertical (hoteles)", () => {
  it("el owner sube un CSV: perfil por columna, la columna de personas sin valores, y una fila de bitacora de la vertical sin el nombre del archivo", async () => {
    const h = await harness();
    const res = await h.app.request(`/hoteles/${h.ctx.propertyId}/chat-datos/adjuntos`, authedJson(h.ctx.staff.owner.token, cuerpo));
    expect(res.status).toBe(200);
    const r = (await res.json()) as DataChatAnswer;
    expect(r.status).toBe("ok");
    expect(r.blocks[0]?.rows.find((x) => x["columna"] === "unidades")).toMatchObject({ tipo: "numérica", suma: 15 });
    expect(r.blocks[0]?.rows.find((x) => x["columna"] === "cliente")).toMatchObject({ tipo: "personal", suma: null });
    expect(JSON.stringify(r)).not.toMatch(/Ana|Luis/);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ tool: "archivo_adjunto", vertical: "hoteles", organizationId: h.ctx.organizationId, outcome: "ok", rowCount: 2, params: { tipo: "csv" } });
    expect(JSON.stringify(h.audit)).not.toContain("ventas.csv");
  });

  it("sin token 401; recepcion (sin Copiloto) y el owner de OTRA organizacion 403; nada llega a la bitacora", async () => {
    const h = await harness();
    const ruta = `/hoteles/${h.ctx.propertyId}/chat-datos/adjuntos`;
    expect((await h.app.request(ruta, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) })).status).toBe(401);
    expect((await h.app.request(ruta, authedJson(h.ctx.staff.frontdesk.token, cuerpo))).status).toBe(403);
    expect((await h.app.request(ruta, authedJson(h.otroOrg, cuerpo))).status).toBe(403);
    expect(h.audit).toHaveLength(0);
  });

  it("las seis verticales montan la ruta con su propia lista de roles (restaurantes, hoteles/rentas/citas por el montaje comun, despachos y licitaciones)", () => {
    const fuente = (ruta: string): string => readFileSync(resolve(__dirname, "..", "src", ruta), "utf8");
    expect(fuente("data-chat/vertical-routes.ts")).toMatch(/mountAdjuntosRoutes\(app, deps, \{ base, vertical: cfg\.vertical, roles: cfg\.roles, role: cfg\.role \}\)/);
    for (const [archivo, vertical] of [
      ["routes/verticals/restaurantes/admin-data-chat.ts", "restaurantes"],
      ["routes/verticals/despachos/chat-datos.ts", "despachos"],
      ["routes/verticals/licitaciones/chat-datos.ts", "licitaciones"],
    ] as const) {
      expect(fuente(archivo), archivo).toMatch(new RegExp(`mountAdjuntosRoutes\\(app, deps, \\{ base, vertical: "${vertical}", roles: [A-Z_]+, role: [A-Z_]+ \\}\\)`));
    }
  });
});
