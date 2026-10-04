// D-13: notificacion in-app `despachos.cfdi.lote_importado` -- una por lote con CFDI/REP nuevos, sin PII (solo contadores), clave unica por lote,
// enlace a la lista de CFDI; nada si todo fue duplicado o rechazado; una emision que falla no cambia el 200 de la carga.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { cfdiXml, cfdiXmlConDtd } from "./fixtures/cfdi-xml.ts";
import { conEmisiones } from "./support/emisiones.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function enviar(deps: typeof ctx.deps, archivos: { nombre: string; datos: string }[]) {
  const fd = new FormData();
  for (const a of archivos) fd.append("archivos", new File([a.datos], a.nombre, { type: "application/xml" }));
  return buildApp(deps).request(`/despachos/${ctx.propertyId}/cfdi/importar-lote`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}` }, body: fd });
}

describe("despachos.cfdi.lote_importado", () => {
  it("emite UNA por lote con los contadores del lote, enlace a /cfdi y clave propia; sin PII en el cuerpo", async () => {
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const res = await enviar(deps, [
      { nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) },
      { nombre: "b.xml", datos: cfdiXml({ uuid: U(2) }) },
      { nombre: "copia.xml", datos: cfdiXml({ uuid: U(1) }) },
      { nombre: "dtd.xml", datos: cfdiXmlConDtd(U(3)) },
    ]);
    expect(res.status).toBe(200);
    const lote = ((await res.json()) as { loteId: string }).loteId;
    const e = emisiones.filter((x) => x.evento === "despachos.cfdi.lote_importado");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      categoria: "fiscal",
      severidad: "info",
      cuerpo: expect.stringMatching(/^Ingeridos: \d+; en revisión: \d+; duplicados: 1; rechazados: 1\.$/),
      enlace: "/despachos/{orgSlug}/cfdi",
      dedupeKey: `despachos.cfdi.lote_importado:${lote}`,
      roles: ["contador"],
    });
    const [, ingeridos, enRevision] = /Ingeridos: (\d+); en revisión: (\d+)/.exec(e[0]!.cuerpo!)!;
    expect(Number(ingeridos) + Number(enRevision)).toBe(2);
    expect(JSON.stringify(e[0])).not.toMatch(/EMISOR DE PRUEBA|CON950820K12|EKU9003173C9/);
  });

  it("no emite si todo fue duplicado o rechazado", async () => {
    await enviar(ctx.deps, [{ nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) }]);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await enviar(deps, [{ nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) }, { nombre: "dtd.xml", datos: cfdiXmlConDtd(U(2)) }]);
    expect(emisiones.filter((x) => x.evento === "despachos.cfdi.lote_importado")).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar) no cambia el 200 ni lo ingerido", async () => {
    const { deps } = conEmisiones(ctx.deps, {
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const res = await enviar(deps, [{ nombre: "a.xml", datos: cfdiXml({ uuid: U(1) }) }]);
    expect(res.status).toBe(200);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(1);
  });
});
