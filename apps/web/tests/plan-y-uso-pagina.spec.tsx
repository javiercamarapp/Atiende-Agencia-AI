// @vitest-environment jsdom
// Pagina "Plan y uso" y banner de plan con un servidor falso: datos reales, boton del portal DESHABILITADO con su explicacion cuando
// el servidor dice que no esta disponible (nunca un boton que no hace nada), apertura real del portal, errores y vacio honestos.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BannerPlan } from "../src/components/BannerPlan.tsx";
import { PlanYUsoPagina } from "../src/components/PlanYUsoPagina.tsx";
import { planHrefDe } from "../src/components/VerticalShellConectado.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | null = null;
let doc: Record<string, unknown> | { status: number };
let portalRespuesta: { status: number; cuerpo: unknown } = { status: 200, cuerpo: { url: "https://billing.stripe.com/p/session/x" } };
let llamadas: Array<{ metodo: string; url: string }> = [];

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

const BASE = {
  disponible: true,
  periodo: "2026-10-01",
  zonaHoraria: "America/Merida",
  mensajes: { usado: 801, limite: 1000, accion: "pausar", excedente: 0, proactivosOmitidos: 2 },
  plan: { id: "p1", nombre: "Plan Estandar" },
  prueba: { activa: true, terminaEn: "2026-11-10T18:00:00.000Z", diasRestantes: 7 },
  portal: { disponible: true, motivo: null, explicacion: null },
};

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto));

beforeEach(() => {
  llamadas = [];
  doc = BASE;
  portalRespuesta = { status: 200, cuerpo: { url: "https://billing.stripe.com/p/session/x" } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const metodo = init?.method ?? "GET";
      llamadas.push({ metodo, url });
      const u = new URL(url);
      if (u.pathname === "/billing/uso") return "status" in doc ? json({}, doc.status as number) : json(doc);
      if (u.pathname === "/billing/portal" && metodo === "POST") return json(portalRespuesta.cuerpo, portalRespuesta.status);
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

async function montarPagina() {
  rendered = renderComponent(
    <MemoryRouter>
      <PlanYUsoPagina apiBaseUrl="https://api.test" token="tok" />
    </MemoryRouter>,
  );
  await esperar();
}

describe("PlanYUsoPagina", () => {
  it("pinta consumo real: 801 de 1000, plan, accion del tope, omitidos, zona horaria y fin de prueba", async () => {
    await montarPagina();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("Mensajes de octubre de 2026");
    expect(t).toContain("801");
    expect(t).toContain("801 de 1,000");
    expect(t).toContain("Plan Estandar");
    expect(t).toContain("se omiten los avisos proactivos no críticos");
    expect(t).toContain("2 avisos proactivos omitidos");
    expect(t).toContain("America/Merida");
    expect(t).toContain("en 7 días");
    expect(rendered!.container.querySelector("progress")?.getAttribute("value")).toBe("80");
  });

  it("sin llave de Stripe el boton de facturacion esta DESHABILITADO y muestra la explicacion; no llama al portal", async () => {
    doc = { ...BASE, portal: { disponible: false, motivo: "sin_llave_stripe", explicacion: "El portal no está disponible: falta STRIPE_SECRET_KEY." } };
    await montarPagina();
    const b = boton("Administrar facturación") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(rendered!.container.textContent).toContain("falta STRIPE_SECRET_KEY");
    click(b);
    await esperar();
    expect(llamadas.filter((l) => l.url.endsWith("/billing/portal"))).toHaveLength(0);
  });

  it("con el portal disponible el boton llama a POST /billing/portal y redirige a la URL de Stripe", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    await montarPagina();
    const b = boton("Administrar facturación") as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    click(b);
    await esperar();
    expect(llamadas.some((l) => l.metodo === "POST" && l.url === "https://api.test/billing/portal")).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://billing.stripe.com/p/session/x");
  });

  it("si el portal falla muestra el error y deja el boton usable de nuevo", async () => {
    portalRespuesta = { status: 502, cuerpo: { code: "bad_gateway" } };
    await montarPagina();
    click(boton("Administrar facturación")!);
    await esperar();
    expect(rendered!.container.querySelector('[role="alert"]')?.textContent).toContain("servidor");
    expect((boton("Administrar facturación") as HTMLButtonElement).disabled).toBe(false);
  });

  it("sin plan ni tope: lo dice (sin cifras inventadas) y sin barra de avance", async () => {
    doc = { ...BASE, mensajes: { usado: 5, limite: null, accion: null, excedente: 0, proactivosOmitidos: 0 }, plan: null, prueba: { activa: false, terminaEn: null, diasRestantes: null } };
    await montarPagina();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("Sin plan asignado");
    expect(t).toContain("sin tope configurado");
    expect(t).toContain("Sin fecha de fin de prueba");
    expect(rendered!.container.querySelector("progress")).toBeNull();
  });

  it("tope superado: avisa el excedente y la accion del plan (cobrar)", async () => {
    doc = { ...BASE, mensajes: { usado: 1003, limite: 1000, accion: "cobrar", excedente: 3, proactivosOmitidos: 0 } };
    await montarPagina();
    expect(rendered!.container.textContent).toContain("3 mensajes por encima del tope");
    expect(rendered!.container.textContent).toContain("se registran como excedente a cobrar");
  });

  it("base sin migrar: estado 'Todavia no disponible' con el motivo; error del servidor: estado de error con reintento", async () => {
    doc = { disponible: false, motivo: "Falta aplicar la migracion 0045." };
    await montarPagina();
    expect(rendered!.container.textContent).toContain("Todavía no disponible");
    expect(rendered!.container.textContent).toContain("Falta aplicar la migracion 0045.");
    rendered!.unmount();
    doc = { status: 500 };
    await montarPagina();
    expect(rendered!.container.textContent).toContain("No se pudo cargar el plan");
    expect(boton("Reintentar")).toBeDefined();
  });
});

describe("BannerPlan", () => {
  async function montarBanner(ruta = "/hoteles/hotel-a/inicio") {
    rendered = renderComponent(
      <MemoryRouter initialEntries={[ruta]}>
        <BannerPlan apiBaseUrl="https://api.test" token="tok" planHref="/hoteles/hotel-a/plan" />
      </MemoryRouter>,
    );
    await esperar();
  }

  it("con 801 de 1000 y fin de prueba a 7 dias muestra los dos avisos con enlace a Plan y uso", async () => {
    await montarBanner();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("Va en el 80 por ciento del tope de mensajes de su plan");
    expect(t).toContain("Su prueba termina en 7 días");
    expect(rendered!.container.querySelector('a[href="/hoteles/hotel-a/plan"]')).not.toBeNull();
  });

  it("sin nada que avisar, con la base sin migrar o con un error NO muestra nada (nunca un aviso de adorno)", async () => {
    doc = { ...BASE, mensajes: { usado: 10, limite: 1000, accion: null, excedente: 0, proactivosOmitidos: 0 }, prueba: { activa: false, terminaEn: null, diasRestantes: null } };
    await montarBanner();
    expect(rendered!.container.querySelector('[data-testid="banner-plan"]')).toBeNull();
    rendered!.unmount();
    doc = { disponible: false, motivo: "x" };
    await montarBanner();
    expect(rendered!.container.querySelector('[data-testid="banner-plan"]')).toBeNull();
    rendered!.unmount();
    doc = { status: 500 };
    await montarBanner();
    expect(rendered!.container.querySelector('[data-testid="banner-plan"]')).toBeNull();
  });

  it("cerrar un aviso lo oculta por la sesion", async () => {
    await montarBanner();
    const cerrar = rendered!.container.querySelector('button[aria-label]');
    expect(cerrar).not.toBeNull();
    click(cerrar!);
    await esperar();
    expect((rendered!.container.textContent ?? "").split("Va en el 80").length - 1 + (rendered!.container.textContent ?? "").split("Su prueba termina").length - 1).toBe(1);
  });

  it("dentro de la propia pagina Plan y uso el banner sobra", async () => {
    await montarBanner("/hoteles/hotel-a/plan");
    expect(rendered!.container.querySelector('[data-testid="banner-plan"]')).toBeNull();
  });
});

describe("planHrefDe", () => {
  it("deriva la ruta de Plan y uso de la de notificaciones de la vertical", () => {
    expect(planHrefDe("/hoteles/hotel-a/notificaciones")).toBe("/hoteles/hotel-a/plan");
    expect(planHrefDe("/citas/mi-clinica/notificaciones/")).toBe("/citas/mi-clinica/plan");
  });
});
