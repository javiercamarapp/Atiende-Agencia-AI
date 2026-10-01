// Dashboard ejecutivo CFO (SA-01/SA-05) y cron de alertas CFO (SA-36): rutas de punta a punta
// contra el repo en memoria (la autorizacion real en SQL se verifica en
// scripts/verify-superadmin-cfo/). SIN envio real: el despachador es un doble o recibe un fetch
// inyectado.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DistributedRateLimiter } from "@atiende/core-ratelimit";
import { InMemoryCfoRepository } from "@atiende/db";
import type { BillingSnapshotRow, CfoOrgRow, CfoRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { crearDespachadorAlertas } from "../src/alertas/despachador.ts";
import { crearLimitadorAlertas } from "../src/alertas/limite-horario.ts";
import type { AlertaSaliente, DespachadorAlertas } from "../src/alertas/tipos.ts";
import { alertaCfoASaliente } from "../src/routes/internal/superadmin-alertas-cfo.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

const T0 = new Date("2026-09-30T12:00:00.000Z").getTime();
const CRON = "/internal/superadmin/alertas-cfo";

function fila(id: string, parche: Partial<CfoOrgRow> = {}): CfoOrgRow {
  return {
    organizationId: id,
    organizationName: `Org ${id}`,
    organizationSlug: `org-${id}`,
    vertical: "restaurantes",
    orgStatus: "active",
    planId: "restaurantes-estandar",
    planNombre: "Restaurantes",
    precioBaseCentavos: 0,
    precioAsientoCentavos: 79900,
    asientosIncluidos: 1,
    billingStatus: null,
    billingSeats: null,
    sucursalesActivas: 3, // (3 - 1) x 799 = 1,598 MXN
    llmMicroUsd: 4_000_000, // 4 USD x 20 = 80 MXN
    vozMicroUsd: 0,
    whatsappMicroUsd: 0,
    telefoniaMicroUsd: 0,
    otrosMicroUsd: 0,
    eventosTotal: 0,
    eventosEstimados: 0,
    minutosVoz: 0,
    mensajes: 0,
    llmCapMicroUsd: 900_000_000,
    llmAlertPct: 80,
    billingPeriodEndMs: null,
    limites: [],
    mxnPorUsd: 20,
    fxFecha: "2026-09-01",
    fxFuente: "Banxico FIX",
    ...parche,
  };
}

const FILAS: CfoOrgRow[] = [
  fila("a"),
  fila("b", { vertical: "hoteles", planId: "hoteles-estandar", planNombre: "Hoteles", precioAsientoCentavos: 8900, asientosIncluidos: 5, sucursalesActivas: 15 }), // 890 MXN
  fila("c", { llmMicroUsd: 70_000_000, billingStatus: "pago_pendiente", billingPeriodEndMs: T0 - 9 * 86_400_000 }), // margen 12.4 % + cobranza vencida
  fila("d", { vertical: "rentas", planId: "rentas-estandar", planNombre: "Rentas", precioBaseCentavos: null, precioAsientoCentavos: null, asientosIncluidos: 0 }), // sin precio
  fila("e", { orgStatus: "trial" }),
];

async function setup(opciones: { repo?: CfoRepository | null; filas?: CfoOrgRow[]; snapshots?: BillingSnapshotRow[]; alertas?: DespachadorAlertas } = {}) {
  const s = await seguridadSetup();
  const cfo = new InMemoryCfoRepository();
  cfo.seedRows(opciones.filas ?? FILAS);
  cfo.seedSnapshots(opciones.snapshots ?? []);
  const repo = opciones.repo === undefined ? cfo : opciones.repo;
  const deps = { ...s.deps, ...(repo ? { cfoRepo: () => repo } : {}), ...(opciones.alertas ? { alertas: opciones.alertas } : {}) };
  const app = buildApp(deps);
  return {
    s,
    cfo,
    app,
    secret: deps.env.internalSecret,
    async superadmin() {
      const sa = await s.superadmin();
      cfo.seedSuperadmin(sa.id);
      return sa;
    },
  };
}

const get = (app: ReturnType<typeof buildApp>, path: string, token: string) => app.request(path, { headers: bearer(token) });
const cron = (t: Awaited<ReturnType<typeof setup>>) => t.app.request(CRON, { method: "POST", headers: { "x-atiende-internal-secret": t.secret } });

describe("GET /superadmin/cfo/dashboard -- gateo y validacion", () => {
  it("staff normal 403, sin token 401", async () => {
    const t = await setup();
    const st = await t.s.staff();
    expect((await get(t.app, "/superadmin/cfo/dashboard", st.token)).status).toBe(403);
    expect((await t.app.request("/superadmin/cfo/dashboard")).status).toBe(401);
  });

  it("valida mes y umbral (400)", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    expect((await get(t.app, "/superadmin/cfo/dashboard?mes=2026-13", sa.token)).status).toBe(400);
    expect((await get(t.app, "/superadmin/cfo/dashboard?mes=septiembre", sa.token)).status).toBe(400);
    expect((await get(t.app, "/superadmin/cfo/dashboard?umbralMargenPct=150", sa.token)).status).toBe(400);
  });
});

describe("GET /superadmin/cfo/dashboard -- base sin migrar", () => {
  it("sin repo o con la migracion 0030 sin aplicar: disponible false con mensaje, nunca 500 ni cifras", async () => {
    for (const repo of [null, new InMemoryCfoRepository({ migrado: false })]) {
      const t = await setup({ repo });
      const sa = await t.superadmin();
      const res = await get(t.app, "/superadmin/cfo/dashboard?mes=2026-09", sa.token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disponible: boolean; mensaje: string; dashboard: unknown };
      expect(body.disponible).toBe(false);
      expect(body.mensaje).toMatch(/0030_superadmin_cfo_dashboard/);
      expect(body.dashboard).toBeNull();
    }
  });
});

describe("GET /superadmin/cfo/dashboard -- datos", () => {
  it("compone MRR/ARR por vertical, margen, cobranza, riesgos, caja sin datos y NRR sin foto previa", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/cfo/dashboard?mes=2026-09", sa.token);
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      disponible: boolean;
      organizaciones: number;
      tipoCambio: { mxnPorUsd: number; fuente: string };
      supuestos: string[];
      dashboard: {
        ingresos: { mrrMxn: number; arrMxn: number; clientesSinPrecio: number; porVertical: Array<{ vertical: string; mrrMxn: number; sinPrecio: number }> };
        margen: { disponible: boolean; clientesBajoUmbral: number; peores: Array<{ organizationId: string }> };
        cobranza: { pagoPendiente: number; mrrEnRiesgoMxn: number };
        caja: { disponible: boolean; razon: string };
        nrr: { disponible: boolean; razon: string };
        alertas: Array<{ codigo: string; organizaciones: Array<{ organizationId: string; dato: string }> }>;
      };
    };
    expect(b.disponible).toBe(true);
    expect(b.organizaciones).toBe(5);
    expect(b.tipoCambio).toMatchObject({ mxnPorUsd: 20, fuente: "Banxico FIX" });
    // a 1,598 + b 890 + c 1,598; d sin precio (no suma); e en prueba (no cuenta)
    expect(b.dashboard.ingresos.mrrMxn).toBe(4086);
    expect(b.dashboard.ingresos.arrMxn).toBe(49032);
    expect(b.dashboard.ingresos.clientesSinPrecio).toBe(1);
    expect(b.dashboard.ingresos.porVertical.find((v) => v.vertical === "rentas")).toMatchObject({ mrrMxn: 0, sinPrecio: 1 });
    expect(b.dashboard.margen).toMatchObject({ disponible: true, clientesBajoUmbral: 1 });
    expect(b.dashboard.margen.peores[0]!.organizationId).toBe("c");
    expect(b.dashboard.cobranza).toEqual({ pagoPendiente: 1, mrrEnRiesgoMxn: 1598 });
    expect(b.dashboard.caja.disponible).toBe(false);
    expect(b.dashboard.nrr).toEqual({ disponible: false, razon: "sin_foto_previa" });
    expect(b.dashboard.alertas.map((a) => a.codigo)).toEqual(["cliente_en_riesgo", "margen_bajo", "cobranza_vencida"]);
    expect(b.dashboard.alertas[2]!.organizaciones[0]!.dato).toBe("pago pendiente, periodo vencido hace 9 dias");
    expect(b.supuestos.some((x) => /Caja: no hay fuente/.test(x))).toBe(true);
  });

  it("sin tipo de cambio: margen no disponible (el ingreso si se muestra), y lo dice en los supuestos", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup({ filas: FILAS.map((f) => ({ ...f, mxnPorUsd: null, fxFecha: null, fxFuente: null })) });
    const sa = await t.superadmin();
    const b = (await (await get(t.app, "/superadmin/cfo/dashboard?mes=2026-09", sa.token)).json()) as { tipoCambio: unknown; supuestos: string[]; dashboard: { margen: unknown; ingresos: { mrrMxn: number } } };
    expect(b.tipoCambio).toBeNull();
    expect(b.dashboard.margen).toEqual({ disponible: false, razon: "sin_tipo_de_cambio" });
    expect(b.dashboard.ingresos.mrrMxn).toBe(4086);
    expect(b.supuestos.some((x) => /No hay tipo de cambio configurado/.test(x))).toBe(true);
  });

  it("con foto del mes anterior calcula NRR, expansion y churn contra el mes en curso en vivo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const previo = (organizationId: string, mrrCentavos: number | null): BillingSnapshotRow => ({ organizationId, mes: "2026-08-01", vertical: "restaurantes", orgStatus: "active", planId: null, billingStatus: null, mrrCentavos, mrrRazon: mrrCentavos === null ? "sin_plan" : null });
    // a: 1,000 -> 1,598 (expansion 598); b: 890 -> 890; z (ya no existe): 500 -> churn
    const t = await setup({ snapshots: [previo("a", 100_000), previo("b", 89_000), previo("z", 50_000)] });
    const sa = await t.superadmin();
    const b = (await (await get(t.app, "/superadmin/cfo/dashboard?mes=2026-09", sa.token)).json()) as { dashboard: { nrr: Record<string, unknown> } };
    expect(b.dashboard.nrr).toMatchObject({ disponible: true, mrrInicialMxn: 2390, expansionMxn: 598, churnMxn: 500, contraccionMxn: 0 });
    expect(b.dashboard.nrr.nrrPct).toBe(Math.round(((2390 + 598 - 500) / 2390) * 10_000) / 100);
  });

  it("un mes ya cerrado sin foto guardada: NRR no disponible (no se compara contra una foto vacia)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup({ snapshots: [{ organizationId: "a", mes: "2026-06-01", vertical: "restaurantes", orgStatus: "active", planId: null, billingStatus: null, mrrCentavos: 100_000, mrrRazon: null }] });
    const sa = await t.superadmin();
    const b = (await (await get(t.app, "/superadmin/cfo/dashboard?mes=2026-07", sa.token)).json()) as { dashboard: { nrr: unknown } };
    expect(b.dashboard.nrr).toEqual({ disponible: false, razon: "sin_foto_del_mes" });
  });

  it("el umbral es configurable por query", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    const b = (await (await get(t.app, "/superadmin/cfo/dashboard?mes=2026-09&umbralMargenPct=5", sa.token)).json()) as { umbralMargenPct: number; dashboard: { margen: { clientesBajoUmbral: number } } };
    expect(b.umbralMargenPct).toBe(5);
    expect(b.dashboard.margen.clientesBajoUmbral).toBe(0);
  });

  it("un superadmin que la base no reconoce recibe cero organizaciones (la autoridad real es SQL)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.s.superadmin(); // superadmin del shell, pero NO sembrado en el repo CFO
    const b = (await (await get(t.app, "/superadmin/cfo/dashboard?mes=2026-09", sa.token)).json()) as { organizaciones: number; dashboard: { ingresos: { mrrMxn: number } } };
    expect(b.organizaciones).toBe(0);
    expect(b.dashboard.ingresos.mrrMxn).toBe(0);
  });
});

describe("cron /internal/superadmin/alertas-cfo", () => {
  it("sin el secreto interno: 401", async () => {
    const t = await setup();
    expect((await t.app.request(CRON, { method: "POST" })).status).toBe(401);
    expect((await t.app.request(CRON, { method: "POST", headers: { "x-atiende-internal-secret": "otro" } })).status).toBe(401);
  });

  it("toma la foto y avisa UNA vez por regla, con tipo estable por regla y sin datos sensibles", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const notificar = vi.fn(async (_a: AlertaSaliente) => ({ resultados: [] }));
    const t = await setup({ alertas: { notificar } });
    const res = await cron(t);
    expect(res.status).toBe(200);
    const b = (await res.json()) as { ok: boolean; mes: string; fotoFilas: number; notificadas: number; alertas: Array<{ codigo: string }> };
    expect(b).toMatchObject({ ok: true, mes: "2026-09", fotoFilas: 5, notificadas: 3 });
    expect(t.cfo.snapshotLlamadas).toBe(1);
    expect(notificar.mock.calls.map((c) => [c[0].tipo, c[0].severidad])).toEqual([
      ["cfo:cliente_en_riesgo", "critica"],
      ["cfo:margen_bajo", "alta"],
      ["cfo:cobranza_vencida", "alta"],
    ]);
    const margen = notificar.mock.calls[1]![0];
    expect(margen.titulo).toBe("Clientes con margen bajo el 30 %: 1");
    expect(margen.detalle).toBe("Org c (margen 12.4 % (umbral 30 %))");
    expect(margen.href).toBe("/superadmin/cfo");
  });

  it("sin alertas que dar (todo sano) no notifica nada pero si toma la foto", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const notificar = vi.fn(async (_a: AlertaSaliente) => ({ resultados: [] }));
    const t = await setup({ filas: [fila("a"), fila("b")], alertas: { notificar } });
    const b = (await (await cron(t)).json()) as { ok: boolean; notificadas: number };
    expect(b).toMatchObject({ ok: true, notificadas: 0 });
    expect(notificar).not.toHaveBeenCalled();
    expect(t.cfo.snapshotLlamadas).toBe(1);
  });

  it("base sin migrar: 200 ok:false migracion_pendiente, sin avisos y sin 500", async () => {
    const notificar = vi.fn(async (_a: AlertaSaliente) => ({ resultados: [] }));
    for (const repo of [null, new InMemoryCfoRepository({ migrado: false })]) {
      const t = await setup({ repo, alertas: { notificar } });
      const res = await cron(t);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, motivo: "migracion_pendiente" });
    }
    expect(notificar).not.toHaveBeenCalled();
  });

  it("un despachador que lanza no tumba el cron", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const notificar = vi.fn().mockRejectedValue(new Error("canal roto"));
    const t = await setup({ alertas: { notificar } });
    const res = await cron(t);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean; notificadas: number })).toMatchObject({ ok: true, notificadas: 0 });
  });

  it("sin despachador configurado evalua y reporta sin enviar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const b = (await (await cron(t)).json()) as { ok: boolean; notificadas: number; alertas: unknown[] };
    expect(b.ok).toBe(true);
    expect(b.notificadas).toBe(0);
    expect(b.alertas).toHaveLength(3);
  });
});

describe("alertas CFO por el despachador real (fetch inyectado, sin envio)", () => {
  function despachador(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
    return crearDespachadorAlertas(
      { correo: null, webhook: { url: "https://hooks.example.com/cfo", secreto: null }, sentry: null, limitePorHora: 1 },
      { fetchImpl, limitador: crearLimitadorAlertas({ limitePorHora: 1, limiter: new DistributedRateLimiter({ redisUrl: "", redisToken: "" }) }), ahora: () => new Date(T0) },
    );
  }

  it("redacta correos y secretos del nombre/dato y aplica el piso por hora (la segunda corrida de la hora no vuelve a enviar)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const enviados: string[] = [];
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      enviados.push(String(init.body));
      return new Response("{}", { status: 200 });
    });
    const filas = [fila("c", { organizationName: "Cafe de cliente@correo.com", llmMicroUsd: 70_000_000 })];
    const t = await setup({ filas, alertas: despachador(f) });
    expect((await cron(t)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    expect(enviados[0]).not.toMatch(/cliente@correo\.com/);
    expect(enviados[0]).toMatch(/cfo:margen_bajo/);
    // segunda corrida en la misma hora: el piso la suprime
    await cron(t);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("alertaCfoASaliente", () => {
  it("limita el detalle a 8 organizaciones y cuenta el resto; el tipo no lleva ids de organizacion", () => {
    const organizaciones = Array.from({ length: 11 }, (_, i) => ({ organizationId: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, nombre: `Org ${i}`, dato: "margen 10.0 %" }));
    const s = alertaCfoASaliente({ codigo: "margen_bajo", severidad: "alta", titulo: "Clientes con margen bajo el 30 %", organizaciones }, "2026-09");
    expect(s.tipo).toBe("cfo:margen_bajo");
    expect(s.titulo).toBe("Clientes con margen bajo el 30 %: 11");
    expect(s.detalle.endsWith("; y 3 más")).toBe(true);
    expect(s.detalle.split("; ").length).toBe(9);
    expect(JSON.stringify(s)).not.toMatch(/00000000-0000-4000/);
  });
});
