// Cliente de Plan y uso (GET /billing/uso, POST /billing/portal) y las reglas del banner de plan, sobre `fetch` inyectado.
import { describe, expect, it } from "vitest";
import { PlanUsoError, abrirPortalFacturacion, avisosDePlan, leerPlanUso } from "../src/lib/plan-uso-client.ts";
import type { PlanUso } from "../src/lib/plan-uso-client.ts";

function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });
}

const DOC = {
  disponible: true,
  periodo: "2026-10-01",
  zonaHoraria: "America/Merida",
  mensajes: { usado: 801, limite: 1000, accion: "pausar", excedente: 0, proactivosOmitidos: 2 },
  plan: { id: "p1", nombre: "Plan Estandar" },
  prueba: { activa: true, terminaEn: "2026-11-10T18:00:00.000Z", diasRestantes: 7 },
  portal: { disponible: false, motivo: "sin_llave_stripe", explicacion: "Falta STRIPE_SECRET_KEY" },
};

function uso(extra: Partial<PlanUso> = {}): PlanUso {
  return {
    periodo: "2026-10-01",
    zonaHoraria: "America/Merida",
    mensajes: { usado: 10, limite: 1000, accion: "avisar", excedente: 0, proactivosOmitidos: 0 },
    plan: null,
    prueba: { activa: false, terminaEn: null, diasRestantes: null },
    portal: { disponible: false, explicacion: null },
    ...extra,
  };
}

describe("leerPlanUso", () => {
  it("manda el token y mapea el documento", async () => {
    let visto: { url: string; auth: string | null } | null = null;
    const r = await leerPlanUso(async (url, init) => {
      visto = { url, auth: (init?.headers as Record<string, string>).authorization ?? null };
      return json(DOC);
    }, "https://api.test", "tok");
    expect(visto).toEqual({ url: "https://api.test/billing/uso", auth: "Bearer tok" });
    expect(r).toEqual({
      disponible: true,
      uso: {
        periodo: "2026-10-01",
        zonaHoraria: "America/Merida",
        mensajes: { usado: 801, limite: 1000, accion: "pausar", excedente: 0, proactivosOmitidos: 2 },
        plan: { id: "p1", nombre: "Plan Estandar" },
        prueba: { activa: true, terminaEn: "2026-11-10T18:00:00.000Z", diasRestantes: 7 },
        portal: { disponible: false, explicacion: "Falta STRIPE_SECRET_KEY" },
      },
    });
  });

  it("sin tope ni plan: limite y plan nulos (nunca un cero inventado)", async () => {
    const r = await leerPlanUso(async () => json({ ...DOC, mensajes: { usado: 5, limite: null, accion: null, excedente: 0, proactivosOmitidos: 0 }, plan: null }), "https://api.test", "tok");
    expect(r.disponible && r.uso.mensajes.limite).toBeNull();
    expect(r.disponible && r.uso.plan).toBeNull();
  });

  it("base sin migrar: disponible:false con el motivo del servidor", async () => {
    const r = await leerPlanUso(async () => json({ disponible: false, motivo: "falta aplicar la 0045" }), "https://api.test", "tok");
    expect(r).toEqual({ disponible: false, motivo: "falta aplicar la 0045" });
  });

  it("errores por estado con mensaje claro; red caida; respuesta invalida", async () => {
    await expect(leerPlanUso(async () => json({}, 401), "https://api.test", "t")).rejects.toMatchObject({ status: 401, message: expect.stringContaining("sesión expiró") });
    await expect(leerPlanUso(async () => json({}, 403), "https://api.test", "t")).rejects.toMatchObject({ status: 403 });
    await expect(leerPlanUso(async () => json({}, 500), "https://api.test", "t")).rejects.toBeInstanceOf(PlanUsoError);
    await expect(leerPlanUso(async () => { throw new TypeError("net"); }, "https://api.test", "t")).rejects.toMatchObject({ status: null });
    await expect(leerPlanUso(async () => json({ disponible: true }), "https://api.test", "t")).rejects.toMatchObject({ message: expect.stringContaining("no es válida") });
  });
});

describe("abrirPortalFacturacion", () => {
  it("POST /billing/portal y devuelve la URL https de Stripe", async () => {
    let metodo: string | undefined;
    const url = await abrirPortalFacturacion(async (_u, init) => {
      metodo = init?.method;
      return json({ url: "https://billing.stripe.com/p/session/x" });
    }, "https://api.test", "tok");
    expect(metodo).toBe("POST");
    expect(url).toBe("https://billing.stripe.com/p/session/x");
  });

  it("un 503 muestra el motivo honesto del servidor; una URL que no es https se rechaza", async () => {
    const err = await abrirPortalFacturacion(async () => json({ code: "service_unavailable", message: "Falta STRIPE_SECRET_KEY" }, 503), "https://api.test", "t").catch((e: PlanUsoError) => e);
    expect((err as PlanUsoError).status).toBe(503);
    expect((err as PlanUsoError).message).toBe("Falta STRIPE_SECRET_KEY");
    await expect(abrirPortalFacturacion(async () => json({ url: "javascript:alert(1)" }), "https://api.test", "t")).rejects.toMatchObject({ message: expect.stringContaining("no es válida") });
  });
});

describe("avisosDePlan (banner)", () => {
  it("sin nada que avisar: ningun banner", () => {
    expect(avisosDePlan(uso())).toEqual([]);
  });

  it("fin de prueba a 7 dias o menos avisa; a 1 dia o hoy es rojo; a 8 dias no", () => {
    const con = (d: number) => avisosDePlan(uso({ prueba: { activa: true, terminaEn: null, diasRestantes: d } }));
    expect(con(8)).toEqual([]);
    expect(con(7)[0]).toMatchObject({ tono: "warning", titulo: "Su prueba termina en 7 días" });
    expect(con(3)[0]).toMatchObject({ tono: "warning" });
    expect(con(1)[0]).toMatchObject({ tono: "danger", titulo: "Su prueba termina en 1 día" });
    expect(con(0)[0]).toMatchObject({ tono: "danger", titulo: "Su prueba termina hoy" });
    expect(avisosDePlan(uso({ prueba: { activa: true, terminaEn: null, diasRestantes: -2 } }))).toEqual([]);
    expect(avisosDePlan(uso({ prueba: { activa: false, terminaEn: null, diasRestantes: 3 } }))).toEqual([]);
  });

  it("80 por ciento: 800 de 1000 aun no avisa (es exactamente 80), 801 si; 1001 avisa del tope superado; sin tope nada", () => {
    const con = (usado: number, limite: number | null) => avisosDePlan(uso({ mensajes: { usado, limite, accion: "avisar", excedente: Math.max(0, usado - (limite ?? usado)), proactivosOmitidos: 0 } }));
    expect(con(800, 1000)).toEqual([]);
    expect(con(801, 1000)[0]).toMatchObject({ tono: "warning", titulo: "Va en el 80 por ciento del tope de mensajes de su plan", detalle: "Mensajes del mes: 801 de 1000." });
    expect(con(1000, 1000)[0]).toMatchObject({ tono: "warning" });
    expect(con(1001, 1000)[0]).toMatchObject({ tono: "danger", titulo: "Superó el tope de mensajes de su plan" });
    expect(con(5000, null)).toEqual([]);
    expect(con(5, 0)).toEqual([]);
  });

  it("la clave de cada aviso cambia con el mes y el umbral (cerrar el de octubre no esconde el de noviembre)", () => {
    const a = avisosDePlan(uso({ periodo: "2026-10-01", mensajes: { usado: 900, limite: 1000, accion: null, excedente: 0, proactivosOmitidos: 0 } }))[0]!;
    const b = avisosDePlan(uso({ periodo: "2026-11-01", mensajes: { usado: 900, limite: 1000, accion: null, excedente: 0, proactivosOmitidos: 0 } }))[0]!;
    expect(a.clave).not.toBe(b.clave);
  });
});
