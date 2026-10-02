// L-25 (REQ-040) -- gate final de la sala de guerra por HTTP real (Hono + auth + repositorios en memoria con la
// misma maquina de dominio que Postgres): ZIP alterado -> rojo, sin paquete / checklist en rojo -> no listo,
// holgura < 24 h visible + aviso in-app deduplicado, doble aprobacion 2/2 exigida, base sin migrar y cross-tenant.
import JSZip from "jszip";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { InMemorySalaGuerraRepository } from "@atiende/domain-licitaciones";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const GREEN_CHECKLIST_BODY = {
  files: [{ filename: "carta.pdf", extension: "pdf", sizeBytes: 1000 }],
  formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 20 },
  requiredSignatures: [],
  presentAnnexRefs: [],
};
const RED_CHECKLIST_BODY = { ...GREEN_CHECKLIST_BODY, files: [{ filename: "carta.exe", extension: "exe", sizeBytes: 1000 }] };
const RATE = (price: string) => [{ id: "r1", concept: "consultoria_hora", unitPrice: price, currency: "MXN" as const, approvalStatus: "aprobado" as const, validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }];

const enHoras = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function setup(opts: { cierre?: string | null } = {}) {
  const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: opts.cierre === undefined ? enHoras(72) : opts.cierre });
  const { deps: conAvisos, emisiones } = conEmisiones(ctx.deps);
  const app = buildApp({ ...conAvisos, licitacionesSalaGuerraRepo: () => new InMemorySalaGuerraRepository() });
  const url = (suffix: string) => `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/${suffix}`;
  expect((await app.request(url("proposal"), authedJson(ctx.staff.writer.token))).status).toBeLessThan(300);
  const gate = async (token = ctx.staff.viewer.token): Promise<Json> => {
    const res = await app.request(url("sala-guerra/gate"), authedJson(token));
    expect(res.status).toBe(200);
    return res.json();
  };
  return { ctx, app, url, emisiones, gate };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function prepararExpediente(s: Setup, checklistBody: unknown = GREEN_CHECKLIST_BODY) {
  s.ctx.repo.seedApprovedRates(s.ctx.organizationId, RATE("500.00"));
  const eco = await s.app.request(s.url("proposal/economic/generate"), authedJson(s.ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 10 }] }, { "idempotency-key": "econ-1" }));
  expect(eco.status).toBe(200);
  expect((await s.app.request(s.url("checklist/run"), authedJson(s.ctx.staff.writer.token, checklistBody, { "idempotency-key": "checklist-1" }))).status).toBe(200);
}
const aprobar = (s: Setup, token: string, stage: string) => s.app.request(s.url("expediente/approval"), authedJson(token, { stage }));
const ensamblar = (s: Setup, key = "asm-1") => s.app.request(s.url("package/assemble"), authedJson(s.ctx.staff.writer.token, {}, { "idempotency-key": key }));
/** Solo los avisos de ESTE gate (las aprobaciones de L-26 emiten los suyos). */
const avisosGate = (s: Setup) => s.emisiones.filter((e) => e.evento === "licitaciones.sala_guerra.paquete_no_listo");
const cond = (g: Json, id: string) => g.gate.condiciones.find((c: Json) => c.id === id);

async function expedienteListo(s: Setup) {
  await prepararExpediente(s);
  expect((await aprobar(s, s.ctx.staff.analyst.token, "tecnica_legal")).status).toBe(201);
  expect((await aprobar(s, s.ctx.staff.owner.token, "economica")).status).toBe(201);
  const asm = await ensamblar(s);
  expect(asm.status).toBe(200);
  expect(((await asm.json()) as Json).status).toBe("ready");
}

describe("GET .../sala-guerra/gate (L-25)", () => {
  it("expediente completo (checklist verde, 2/2, paquete ready, ZIP intacto, 72 h): listo, todo en verde, sin alerta", async () => {
    const s = await setup();
    await expedienteListo(s);
    const g = await s.gate();
    expect(g.gate.veredicto).toBe("listo");
    expect(g.gate.condiciones.map((c: Json) => [c.id, c.color])).toEqual([["aprobaciones", "verde"], ["checklist", "verde"], ["paquete", "verde"], ["zip_manifiesto", "verde"], ["holgura", "verde"]]);
    expect(g.gate.motivos).toEqual([]);
    expect(g.alerta).toBe("no_aplica");
    expect(g.gate.cuentaRegresiva.estado).toBe("abierto");
    expect(avisosGate(s)).toEqual([]);
  });

  it("ZIP alterado (el manifiesto guardado ya no coincide con los bytes) -> gate rojo con 'el ZIP no coincide con el manifiesto'", async () => {
    const s = await setup();
    await expedienteListo(s);
    const proposalId = (await s.gate()).proposalId as string;
    const stored = (await s.ctx.repo.findLatestManifest(s.ctx.organizationId, proposalId))!;
    const zip = await JSZip.loadAsync(await s.ctx.repo.readManifestZip(stored.storageRef));
    const doc = ((stored.manifest as Json).documents as Json[]).find((d) => d.present && d.sha256)!;
    const nombre = doc.filename as string;
    expect(zip.file(nombre)).not.toBeNull();
    zip.file(nombre, "CONTENIDO ALTERADO DESPUES DE ENSAMBLAR");
    const ref = await s.ctx.repo.writeManifestZip(s.ctx.organizationId, proposalId, await zip.generateAsync({ type: "uint8array" }));
    await s.ctx.repo.saveManifest(s.ctx.organizationId, proposalId, { status: stored.status, manifest: stored.manifest, checklistSnapshot: stored.checklistSnapshot, storageRef: ref, inputsHash: stored.inputsHash, correlationId: null, generatedBy: s.ctx.staff.writer.id });
    const g = await s.gate();
    expect(g.gate.veredicto).toBe("no_listo");
    expect(cond(g, "zip_manifiesto").color).toBe("rojo");
    expect(g.gate.motivos.join(" ")).toContain("El ZIP no coincide con el manifiesto");
    expect(cond(g, "zip_manifiesto").enlace).toBe("paquete");
  });

  it("sin propuesta/paquete -> no listo (aprobaciones, checklist, paquete y ZIP en rojo)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: enHoras(72) });
    const app = buildApp({ ...ctx.deps, licitacionesSalaGuerraRepo: () => new InMemorySalaGuerraRepository() });
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/sala-guerra/gate`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const g = (await res.json()) as Json;
    expect(g.proposalId).toBeNull();
    expect(g.gate.listo).toBe(false);
    for (const id of ["aprobaciones", "checklist", "paquete", "zip_manifiesto"]) expect(cond(g, id).color).toBe("rojo");
  });

  it("checklist con rojos -> no listo y el enlace lleva al checklist", async () => {
    const s = await setup();
    await prepararExpediente(s, RED_CHECKLIST_BODY);
    const g = await s.gate();
    expect(cond(g, "checklist")).toMatchObject({ color: "rojo", enlace: "checklist" });
    expect(g.gate.listo).toBe(false);
  });

  it("falta la 2/2 -> rojo y nombra la aprobacion economica; con la 1/2 y sin paquete tampoco hay listo", async () => {
    const s = await setup();
    await prepararExpediente(s);
    await aprobar(s, s.ctx.staff.analyst.token, "tecnica_legal");
    const g = await s.gate();
    expect(cond(g, "aprobaciones")).toMatchObject({ color: "rojo", enlace: "aprobaciones" });
    expect(cond(g, "aprobaciones").motivo).toContain("aprobación económica (2/2)");
    expect(g.gate.listo).toBe(false);
  });

  it("cambiar un insumo despues de ensamblar invalida el 2/2: el paquete deja de estar vigente y el gate lo dice", async () => {
    const s = await setup();
    await expedienteListo(s);
    s.ctx.repo.seedApprovedRates(s.ctx.organizationId, RATE("999.00"));
    const g = await s.gate();
    expect(cond(g, "aprobaciones").color).toBe("rojo");
    expect(cond(g, "paquete").color).toBe("rojo");
    expect(g.gate.listo).toBe(false);
  });

  it("holgura < 24 h: visible en ambar con el tiempo restante; todo en verde sigue 'listo' y NO avisa", async () => {
    const s = await setup({ cierre: enHoras(5) });
    await expedienteListo(s);
    const g = await s.gate();
    expect(cond(g, "holgura").color).toBe("ambar");
    expect(cond(g, "holgura").motivo).toMatch(/Quedan 4 h \d+ min: menos de 24 h de holgura/);
    expect(g.gate.listo).toBe(true);
    expect(g.gate.holguraHoras).toBeLessThan(5);
    expect(g.alerta).toBe("no_aplica");
    expect(avisosGate(s)).toEqual([]);
  });

  it("a menos de 24 h con el paquete NO listo: emite el aviso in-app (catalogo, enlace real, sin PII, dedupe por convocatoria)", async () => {
    const s = await setup({ cierre: enHoras(5) });
    const g = await s.gate();
    expect(g.gate.alerta24h).toBe(true);
    expect(g.alerta).toBe("emitida");
    expect(avisosGate(s)).toHaveLength(1);
    expect(s.emisiones[0]).toMatchObject({ evento: "licitaciones.sala_guerra.paquete_no_listo", categoria: "cierres", severidad: "critica", enlace: "/licitaciones/{orgSlug}/convocatorias" });
    expect(s.emisiones[0]!.dedupeKey).toBe(`licitaciones.sala_guerra.paquete_no_listo:${s.ctx.tenderId}`);
    expect(JSON.stringify(s.emisiones[0])).not.toContain("@");
    expect(JSON.stringify(s.emisiones[0])).not.toContain("Licitación pública de prueba");
  });

  it("con mas de 24 h de holgura y el paquete NO listo: sin aviso; ya vencido: rojo y sin aviso; sin fecha: ambar", async () => {
    const lejos = await setup({ cierre: enHoras(72) });
    expect((await lejos.gate()).alerta).toBe("no_aplica");
    expect(avisosGate(lejos)).toEqual([]);
    const vencido = await setup({ cierre: enHoras(-2) });
    const gv = await vencido.gate();
    expect(cond(gv, "holgura").color).toBe("rojo");
    expect(gv.gate.cuentaRegresiva.estado).toBe("vencido");
    expect(gv.alerta).toBe("no_aplica");
    const sinFecha = await setup({ cierre: null });
    const gs = await sinFecha.gate();
    expect(cond(gs, "holgura").color).toBe("ambar");
    expect(gs.gate.cuentaRegresiva.estado).toBe("sin_fecha");
  });

  it("presentacion ya declarada: el gate se sigue mostrando pero no vuelve a alertar", async () => {
    const s = await setup({ cierre: enHoras(5) });
    await expedienteListo(s);
    const decl = await s.app.request(s.url("submission/declare"), authedJson(s.ctx.staff.writer.token, { submittedAt: new Date().toISOString() }, { "idempotency-key": "decl-1" }));
    expect(decl.status).toBe(201);
    const g = await s.gate();
    expect(g.presentado).toBe(true);
    expect(avisosGate(s)).toEqual([]);
  });

  it("COMPATIBILIDAD base sin migracion 033: la aprobacion unica se muestra en ambar declarado (no rompe, no finge 2/2)", async () => {
    const s = await setup();
    await prepararExpediente(s);
    s.ctx.repo.setExpedienteStageMode("legacy");
    expect((await s.app.request(s.url("expediente/approval"), authedJson(s.ctx.staff.owner.token, {}))).status).toBe(201);
    const g = await s.gate();
    expect(cond(g, "aprobaciones").color).toBe("ambar");
    expect(cond(g, "aprobaciones").motivo).toContain("migración 033");
  });

  it("cualquier miembro lee (viewer), sin sesion 401, y otra organizacion no accede (403/404)", async () => {
    const s = await setup();
    expect((await s.app.request(s.url("sala-guerra/gate"), authedJson(s.ctx.staff.viewer.token))).status).toBe(200);
    expect((await s.app.request(s.url("sala-guerra/gate"))).status).toBe(401);
    const otra = await setup();
    const res = await s.app.request(s.url("sala-guerra/gate"), authedJson(otra.ctx.staff.owner.token));
    expect([403, 404]).toContain(res.status);
  });

  it("sin ids ni correos de personas en la respuesta", async () => {
    const s = await setup();
    await expedienteListo(s);
    const crudo = JSON.stringify(await s.gate());
    for (const p of [s.ctx.staff.analyst, s.ctx.staff.owner, s.ctx.staff.writer]) {
      expect(crudo).not.toContain(p.id);
      expect(crudo).not.toContain(p.email);
    }
  });

  it("COMPATIBILIDAD storage_ref legacy: si la lectura del ZIP falla con 22P02 dentro de la transaccion compartida, SAVEPOINT la recupera, el gate marca 'ilegible' y el aviso/COMMIT siguen (no 500, no 25P02)", async () => {
    const base = await setup({ cierre: enHoras(10) });
    await expedienteListo(base);
    const ctx = base.ctx;
    let abortada = false;
    let savepoints = 0;
    let rollbacksToSavepoint = 0;
    let consultasTrasRecuperar = 0;
    const envolver = (session: TenantDbSession): TenantDbSession => ({
      exec: async (sql) => {
        if (/^\s*savepoint/i.test(sql)) savepoints += 1;
        if (/^\s*rollback to savepoint/i.test(sql)) {
          abortada = false;
          rollbacksToSavepoint += 1;
          return;
        }
        if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        return session.exec(sql);
      },
      query: async <T>(sql: string, params?: unknown[]) => {
        if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        if (/marcador_post_lectura/.test(sql)) {
          if (rollbacksToSavepoint > 0) consultasTrasRecuperar += 1;
          return { rows: [] as T[] };
        }
        return session.query<T>(sql, params);
      },
    });
    const engine: TenancyEngine = { withAppSession: (claims, fn) => ctx.deps.engine.withAppSession(claims, (session) => fn(envolver(session))) };
    const { deps: conAvisos, emisiones } = conEmisiones({ ...ctx.deps, engine });
    const app = buildApp({
      ...conAvisos,
      licitacionesSalaGuerraRepo: () => new InMemorySalaGuerraRepository(),
      licitacionesRepo: (db) => {
        const real = ctx.deps.licitacionesRepo(db);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "readManifestZip") {
              return async () => {
                abortada = true;
                throw Object.assign(new Error('invalid input syntax for type uuid: "/var/data/legacy.zip"'), { code: "22P02" });
              };
            }
            if (prop === "findSubmission") return async (...args: [string, string]) => (await db.query("select 1 as marcador_post_lectura"), target.findSubmission(...args));
            const v = Reflect.get(target, prop, receiver);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
    });
    const res = await app.request(base.url("sala-guerra/gate"), authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const g = (await res.json()) as Json;
    expect(savepoints).toBeGreaterThan(0);
    expect(rollbacksToSavepoint).toBeGreaterThan(0);
    expect(cond(g, "zip_manifiesto").color).toBe("rojo");
    expect(g.gate.listo).toBe(false);
    expect(g.alerta).not.toBe("error");
    expect(emisiones.filter((e) => e.evento === "licitaciones.sala_guerra.paquete_no_listo").length).toBe(1);
  });
});
