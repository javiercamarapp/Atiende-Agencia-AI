import { describe, expect, it } from "vitest";
import { FORWARD_PERIOD_PARAMS, FORWARD_PERIOD_TOKENS, MIXED_PERIOD_PARAMS, MIXED_PERIOD_TOKENS, parseArgs, resolveMixedPeriod, propertyParam, resolveForwardPeriod, resolvePropertySelection, toJsonSchema, type VisibleProperty } from "../../src/data-chat/index.ts";

/** Martes 29-sep-2026 23:30 en Mérida = miércoles 30-sep 05:30 UTC. */
const NOW = new Date("2026-09-30T05:30:00.000Z");
const TZ = "America/Merida";

function ok(args: Record<string, string>, now = NOW, tz = TZ) {
  const r = resolveForwardPeriod(args, now, tz);
  if (!r.ok) throw new Error(`se esperaba ok: ${r.message}`);
  return r.period;
}

describe("resolveForwardPeriod — periodos hacia adelante en la zona del negocio", () => {
  it("'hoy' y 'mañana' usan la fecha de Mérida, no la de UTC", () => {
    expect(ok({ periodo: "hoy" })).toMatchObject({ fromDate: "2026-09-29", toDate: "2026-09-29" });
    const m = ok({ periodo: "manana" });
    expect(m).toMatchObject({ fromDate: "2026-09-30", toDate: "2026-09-30", label: "mañana (30 sep 2026)" });
    expect(m.start.toISOString()).toBe("2026-09-30T06:00:00.000Z");
    expect(m.end.toISOString()).toBe("2026-10-01T06:00:00.000Z");
  });

  it("próximos 7 y 30 días incluyen hoy", () => {
    expect(ok({ periodo: "proximos_7_dias" })).toMatchObject({ fromDate: "2026-09-29", toDate: "2026-10-05" });
    expect(ok({ periodo: "proximos_30_dias" })).toMatchObject({ fromDate: "2026-09-29", toDate: "2026-10-28" });
  });

  it("esta semana = lunes a domingo completa; semana próxima = la siguiente", () => {
    expect(ok({ periodo: "esta_semana" })).toMatchObject({ fromDate: "2026-09-28", toDate: "2026-10-04" });
    expect(ok({ periodo: "semana_proxima" })).toMatchObject({ fromDate: "2026-10-05", toDate: "2026-10-11" });
  });

  it("este mes llega hasta el último día (también en diciembre y febrero bisiesto)", () => {
    expect(ok({ periodo: "este_mes" })).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-30" });
    expect(ok({ periodo: "este_mes" }, new Date("2026-12-15T18:00:00Z"))).toMatchObject({ fromDate: "2026-12-01", toDate: "2026-12-31" });
    expect(ok({ periodo: "este_mes" }, new Date("2028-02-10T18:00:00Z"))).toMatchObject({ fromDate: "2028-02-01", toDate: "2028-02-29" });
  });

  it("fechas exactas: acepta futuro y pasado; rechaza inicio > fin, fechas irreales y más de 366 días", () => {
    expect(ok({ desde: "2026-12-20", hasta: "2026-12-31" })).toMatchObject({ fromDate: "2026-12-20", toDate: "2026-12-31" });
    expect(ok({ desde: "2026-09-01", hasta: "2026-09-02" })).toMatchObject({ fromDate: "2026-09-01" });
    expect(resolveForwardPeriod({ desde: "2026-10-05", hasta: "2026-10-01" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
    expect(resolveForwardPeriod({ desde: "2026-02-30", hasta: "2026-03-02" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
    expect(resolveForwardPeriod({ desde: "2026-01-01", hasta: "2027-01-02" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("periodo ambiguo o incompleto: pide aclaración (nunca adivina) y 'periodo' + fechas es inválido", () => {
    expect(resolveForwardPeriod({}, NOW, TZ)).toMatchObject({ ok: false, kind: "needs_clarification" });
    expect(resolveForwardPeriod({ desde: "2026-10-01" }, NOW, TZ)).toMatchObject({ ok: false, kind: "needs_clarification" });
    expect(resolveForwardPeriod({ periodo: "hoy", desde: "2026-10-01", hasta: "2026-10-02" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("zona inválida cae a la zona por defecto, no al reloj del proceso", () => {
    expect(ok({ periodo: "hoy" }, NOW, "Mars/Olympus")).toMatchObject({ fromDate: "2026-09-29" });
  });

  it("el esquema declara los mismos tokens y rechaza valores fuera del catálogo", () => {
    const schema = toJsonSchema(FORWARD_PERIOD_PARAMS) as { properties: { periodo: { enum: string[] } } };
    expect(schema.properties.periodo.enum).toEqual([...FORWARD_PERIOD_TOKENS]);
    expect(parseArgs(FORWARD_PERIOD_PARAMS, { periodo: "ayer" })).toMatchObject({ ok: false });
    expect(parseArgs(FORWARD_PERIOD_PARAMS, { periodo: "manana" })).toMatchObject({ ok: true });
  });
});

const NOUNS = { singular: "hotel", plural: "hoteles" } as const;
const VISIBLE: readonly VisibleProperty[] = [
  { propertyId: "p1", name: "Hotel Centro", slug: "Hotel Centro" },
  { propertyId: "p2", name: "Hotel Playa del Carmen", slug: "Hotel Playa del Carmen" },
];

describe("resolvePropertySelection — nombre de propiedad, solo entre las visibles", () => {
  it("sin nombre: todas (alcance null) o la lista asignada, con etiqueta", () => {
    expect(resolvePropertySelection(VISIBLE, null, undefined, NOUNS)).toEqual({ ok: true, propertyIds: null, label: "todos tus hoteles" });
    expect(resolvePropertySelection([VISIBLE[0]!], ["p1"], undefined, NOUNS)).toEqual({ ok: true, propertyIds: ["p1"], label: "hotel Hotel Centro" });
    expect(resolvePropertySelection(VISIBLE, ["p1", "p2"], "", NOUNS)).toEqual({ ok: true, propertyIds: ["p1", "p2"], label: "tus 2 hoteles asignados" });
  });

  it("ignora acentos y mayúsculas y acepta coincidencia parcial única", () => {
    expect(resolvePropertySelection(VISIBLE, null, "PLAYA", NOUNS)).toEqual({ ok: true, propertyIds: ["p2"], label: "hotel Hotel Playa del Carmen" });
    expect(resolvePropertySelection([{ propertyId: "x", name: "Mérida Norte", slug: "merida-norte" }], null, "merida", NOUNS)).toMatchObject({ ok: true, propertyIds: ["x"] });
  });

  it("un nombre fuera de lo visible responde igual que uno inexistente y no filtra otros nombres", () => {
    const r = resolvePropertySelection([VISIBLE[0]!], ["p1"], "Playa del Carmen", NOUNS);
    expect(r).toEqual({ ok: false, message: "No encontré ese hotel entre los que puedes consultar: Hotel Centro." });
    expect(resolvePropertySelection(VISIBLE, null, "inventado", NOUNS)).toMatchObject({ ok: false });
  });

  it("nombre ambiguo pide aclaración con las opciones; la coincidencia exacta gana", () => {
    const r = resolvePropertySelection(VISIBLE, null, "hotel", NOUNS);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain("Hotel Centro, Hotel Playa del Carmen");
    expect(resolvePropertySelection([...VISIBLE, { propertyId: "p3", name: "Hotel Centro Histórico", slug: "x" }], null, "Hotel Centro", NOUNS)).toMatchObject({ ok: true, propertyIds: ["p1"] });
  });

  it("concuerda en género con sustantivos femeninos (propiedades)", () => {
    const f = { singular: "propiedad", plural: "propiedades", feminine: true } as const;
    const props: VisibleProperty[] = [{ propertyId: "a", name: "Casas de Playa", slug: "playa" }, { propertyId: "b", name: "Casas del Centro", slug: "centro" }];
    expect(resolvePropertySelection(props, null, undefined, f)).toMatchObject({ label: "todas tus propiedades" });
    expect(resolvePropertySelection(props, ["a", "b"], undefined, f)).toMatchObject({ label: "tus 2 propiedades asignadas" });
    expect(resolvePropertySelection([props[0]!], ["a"], "Centro", f)).toEqual({ ok: false, message: "No encontré esa propiedad entre las que puedes consultar: Casas de Playa." });
    expect((resolvePropertySelection(props, null, "casas", f) as { message: string }).message).toContain("Hay varias propiedades");
  });

  it("propertyParam declara un texto corto (nunca un id) bajo el nombre pedido", () => {
    const spec = propertyParam("hotel", NOUNS);
    expect(Object.keys(spec)).toEqual(["hotel"]);
    expect(spec["hotel"]).toMatchObject({ type: "string", maxLength: 60, optional: true });
    expect(parseArgs(spec, { hotel: "x".repeat(61) })).toMatchObject({ ok: false });
    expect(parseArgs(spec, { hotel: " Centro " })).toEqual({ ok: true, value: { hotel: "Centro" } });
  });
});

describe("resolveMixedPeriod — pasado y futuro con semanas y meses completos", () => {
  const okMixed = (args: Record<string, string>) => {
    const r = resolveMixedPeriod(args, NOW, TZ);
    if (!r.ok) throw new Error(r.message);
    return r.period;
  };

  it("los tokens del pasado se resuelven como en resolvePeriod", () => {
    expect(okMixed({ periodo: "ayer" })).toMatchObject({ fromDate: "2026-09-28", toDate: "2026-09-28" });
    expect(okMixed({ periodo: "ultimos_7_dias" })).toMatchObject({ fromDate: "2026-09-23", toDate: "2026-09-29" });
    expect(okMixed({ periodo: "semana_pasada" })).toMatchObject({ fromDate: "2026-09-21", toDate: "2026-09-27" });
    expect(okMixed({ periodo: "mes_pasado" })).toMatchObject({ fromDate: "2026-08-01", toDate: "2026-08-31" });
  });

  it("'esta semana' y 'este mes' son COMPLETOS (incluyen lo ya reservado a futuro)", () => {
    expect(okMixed({ periodo: "esta_semana" })).toMatchObject({ fromDate: "2026-09-28", toDate: "2026-10-04" });
    expect(okMixed({ periodo: "este_mes" })).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-30" });
    expect(okMixed({ periodo: "proximos_30_dias" })).toMatchObject({ fromDate: "2026-09-29", toDate: "2026-10-28" });
  });

  it("fechas exactas pasadas o futuras; sin periodo pide aclaración; token desconocido es inválido", () => {
    expect(okMixed({ desde: "2026-01-01", hasta: "2026-01-31" })).toMatchObject({ fromDate: "2026-01-01" });
    expect(okMixed({ desde: "2026-11-01", hasta: "2026-11-30" })).toMatchObject({ toDate: "2026-11-30" });
    expect(resolveMixedPeriod({}, NOW, TZ)).toMatchObject({ ok: false, kind: "needs_clarification" });
    expect(resolveMixedPeriod({ periodo: "ultimo_siglo" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("el esquema declara los mismos tokens", () => {
    const schema = toJsonSchema(MIXED_PERIOD_PARAMS) as { properties: { periodo: { enum: string[] } } };
    expect(schema.properties.periodo.enum).toEqual([...MIXED_PERIOD_TOKENS]);
  });
});
