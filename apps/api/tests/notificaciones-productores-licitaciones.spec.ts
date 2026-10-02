// Productor `licitaciones.convocatoria.nueva`: la ingesta automatica avisa (una por organizacion por dia, solo el conteo) cuando creo
// registros nuevos; sin registros nuevos no emite, y una emision que falla (base sin 0039) no cambia el barrido ni la respuesta.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const HEADER = "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,descripcion_contrato,contract_type,work_category_id,tipo_contratacion,tipo_expediente,importe,moneda,fecha_inicio,fecha_fin,project_code,ff_fecha_inicio,ff_fecha_fin";
const csv = (rows: string[]) => `${[HEADER, ...rows].join("\n")}\n`;

afterEach(() => vi.unstubAllGlobals());

async function setup(opciones: { alEmitir?: () => number } = {}) {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const { deps, emisiones } = conEmisiones(ctx.deps, opciones);
  const cron = () => buildApp(deps).request("/internal/licitaciones/discover-tenders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
  return { ctx, emisiones, cron };
}

describe("licitaciones.convocatoria.nueva", () => {
  it("emite UNA por organizacion con el conteo de registros nuevos, a analistas, con clave organizacion + dia y sin titulos", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv(["CTR-1,EXP-1,Prov,Contrato secreto de prueba,,,,,,1000,MXN,2020-01-01,2020-06-01,,,"]), { status: 200 })));
    const s = await setup();
    expect((await s.cron()).status).toBe(200);
    const mias = s.emisiones.filter((e) => e.organizationId === s.ctx.organizationId);
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({ evento: "licitaciones.convocatoria.nueva", categoria: "operacion", severidad: "info", cuerpo: "Registros nuevos: 1.", enlace: "/licitaciones/{orgSlug}/convocatorias", roles: ["analyst"] });
    expect(mias[0]!.dedupeKey).toBe(`licitaciones.convocatoria.nueva:${s.ctx.organizationId}:${new Date().toISOString().slice(0, 10)}`);
    expect(JSON.stringify(mias[0])).not.toContain("secreto");
  });

  it("sin registros nuevos no emite", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv([]), { status: 200 })));
    const s = await setup();
    expect((await s.cron()).status).toBe(200);
    expect(s.emisiones.filter((e) => e.evento === "licitaciones.convocatoria.nueva")).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar) deja la respuesta del barrido intacta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(csv(["CTR-2,EXP-2,Prov,Otro contrato,,,,,,1000,MXN,2020-01-01,2020-06-01,,,"]), { status: 200 })));
    const s = await setup({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const res = await s.cron();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { corridas: { organization_id: string; fuentes: { source: string; creados: number }[] }[] };
    expect(body.corridas.find((c) => c.organization_id === s.ctx.organizationId)!.fuentes.find((f) => f.source === "compras_mx_historico")!.creados).toBe(1);
  });
});
