// @vitest-environment jsdom
//
// H-P3-04 -- <ConfiguracionPage /> de hoteles: render por rol (owner/gm escriben, accountant solo lee), guardar llama al endpoint con los valores
// convertidos, Descartar/Cerrar/Escape NUNCA escriben, y los errores del servidor quedan visibles (nunca un exito falso).
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfiguracionPage } from "../src/verticals/hoteles/pages/Configuracion.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}

const ctx = (role: string): HotelesShellContext => ({ apiBaseUrl: "http://api.local", token: "tok", propertyId: "prop-1", orgSlug: "hotel-demo", role, staffFullName: "Yo", staffEmail: "yo@hotel.mx" });
const montar = (role: string, tab = "impuestos") =>
  renderComponent(
    <MemoryRouter initialEntries={[`/hoteles/hotel-demo/configuracion?tab=${tab}`]}>
      <ConfiguracionPage {...ctx(role)} />
    </MemoryRouter>,
  );
const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;

const IMPUESTOS = { ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0, configurado: true, aviso: "La tasa del ISH depende del estado y del municipio: verifícala con tu contador antes de guardarla." };
const POLITICA = { freeUntilHours: 24, penaltyPct: 0.5, guestText: "Cancelación gratis hasta 24 h.", configurado: true };
const TIPOS = [{ roomTypeId: "rt-1", name: "Doble", maxOverbookRooms: 0, thresholdPct: 95 }];
const TARIFAS = {
  desde: "2026-12-01",
  hasta: "2026-12-30",
  truncado: false,
  tarifas: [
    { id: "r-1", roomTypeId: "rt-1", roomTypeName: "Doble", date: "2026-12-01", price: 1500, currency: "MXN", minStay: 1, closedToArrival: false, closedToDeparture: false, manualPriceAt: null },
    { id: "r-2", roomTypeId: "rt-1", roomTypeName: "Doble", date: "2026-12-02", price: 1800, currency: "MXN", minStay: 2, closedToArrival: false, closedToDeparture: false, manualPriceAt: "2026-11-01T10:00:00Z" },
  ],
};
const BITACORA = [{ id: "b-1", area: "impuestos", entityId: "prop-1", actorUserId: "u-1", valorAnterior: { ishRate: 0.03 }, valorNuevo: { ishRate: 0.04 }, createdAt: "2026-11-01T10:00:00Z" }];

function red(extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const llamadas: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const c = extra(url, init);
    if (c) return c;
    if (method === "GET") {
      if (url.endsWith("/configuracion/impuestos")) return json(IMPUESTOS);
      if (url.endsWith("/configuracion/politica-cancelacion")) return json(POLITICA);
      if (url.endsWith("/configuracion/sobreventa")) return json({ tipos: TIPOS });
      if (url.includes("/tarifas")) return json(TARIFAS);
      if (url.endsWith("/tipos-habitacion")) return json([{ id: "rt-1", nombre: "Doble", capacidadMaxima: 2 }]);
      if (url.includes("/configuracion/bitacora")) return json({ entradas: BITACORA });
    }
    throw new Error(`url inesperada: ${method} ${url}`);
  });
  return { fn, llamadas, mutaciones: () => llamadas.filter((l) => l.method !== "GET") };
}

const boton = (texto: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
const botonAria = (fragmento: string) => [...document.body.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.includes(fragmento)) as HTMLButtonElement | undefined;
const campo = (r: RenderedComponent, id: string) => r.container.querySelector(`#${id}`) as HTMLInputElement;

describe("ConfiguracionPage: impuestos", () => {
  it("owner: carga los valores como porcentaje y guardar manda PUT con razones (0.04) y los demas campos", async () => {
    const { fn, mutaciones } = red((url, init) => (init?.method === "PUT" ? json({ ...IMPUESTOS, ishRate: 0.04, dsaPerNight: 20 }) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("owner");
    await esperar();
    expect(campo(rendered, "imp-iva").value).toBe("16");
    expect(campo(rendered, "imp-ish").value).toBe("3");
    expect(rendered.container.textContent).toContain("contador");
    expect(boton("Guardar impuestos")?.disabled).toBe(true); // sin cambios no se puede guardar
    changeValue(campo(rendered, "imp-ish"), "4");
    changeValue(campo(rendered, "imp-dsa"), "20");
    expect(boton("Guardar impuestos")?.disabled).toBe(false);
    await submitForm(rendered.container.querySelector("form") as HTMLFormElement);
    await esperar();
    expect(mutaciones()).toEqual([expect.objectContaining({ method: "PUT", url: "http://api.local/hoteles/prop-1/configuracion/impuestos", body: { ivaRate: 0.16, ishRate: 0.04, discountThreshold: 500, dsaPerNight: 20 } })]);
  });

  it("Descartar cambios restaura el formulario y NO escribe", async () => {
    const { fn, mutaciones } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar("gm");
    await esperar();
    changeValue(campo(rendered, "imp-ish"), "9");
    await act(async () => click(boton("Descartar cambios")!));
    expect(campo(rendered, "imp-ish").value).toBe("3");
    expect(mutaciones()).toHaveLength(0);
  });

  it("un valor invalido (IVA 150 %) deshabilita Guardar", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("owner");
    await esperar();
    changeValue(campo(rendered, "imp-iva"), "150");
    expect(boton("Guardar impuestos")?.disabled).toBe(true);
  });

  it("si el servidor rechaza el guardado el mensaje real queda visible y el formulario conserva lo escrito", async () => {
    const { fn } = red((url, init) => (init?.method === "PUT" ? json({ message: "ishRate debe ser un número entre 0 y 1." }, false, 400) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("owner");
    await esperar();
    changeValue(campo(rendered, "imp-ish"), "4");
    await submitForm(rendered.container.querySelector("form") as HTMLFormElement);
    await esperar();
    expect(rendered.container.textContent).toContain("ishRate debe ser un número entre 0 y 1.");
    expect(campo(rendered, "imp-ish").value).toBe("4");
  });

  it("base sin configurar: avisa que se usan los valores por omision", async () => {
    vi.stubGlobal("fetch", red((url) => (url.endsWith("/configuracion/impuestos") ? json({ ...IMPUESTOS, configurado: false }) : undefined)).fn);
    rendered = montar("owner");
    await esperar();
    expect(rendered.container.textContent).toContain("Aún no guardas tus impuestos");
  });

  it("accountant: ve los valores pero sin Guardar, con campos deshabilitados, sin pestana Bitacora y sin PUT", async () => {
    const { fn, mutaciones } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar("accountant");
    await esperar();
    expect(campo(rendered, "imp-ish").disabled).toBe(true);
    expect(boton("Guardar impuestos")).toBeUndefined();
    expect(rendered.container.textContent).toContain("tu rol puede consultarlos");
    expect(rendered.container.textContent).not.toContain("Bitácora");
    expect(mutaciones()).toHaveLength(0);
  });

  it("un rol sin acceso (frontdesk) no pide nada y lo explica", async () => {
    const { fn } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar("frontdesk");
    await esperar();
    expect(rendered.container.textContent).toContain("reservada al propietario");
    expect(fn).not.toHaveBeenCalled();
  });

  it("error al cargar: muestra el error, nunca un formulario vacio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "boom" }, false, 500)));
    rendered = montar("owner");
    await esperar();
    expect(rendered.container.textContent).toContain("boom");
    expect(boton("Guardar impuestos")).toBeUndefined();
  });
});

describe("ConfiguracionPage: politica de cancelacion", () => {
  it("guardar manda horas, penalidad como razon y el texto", async () => {
    const { fn, mutaciones } = red((url, init) => (init?.method === "PUT" ? json({ ...POLITICA, freeUntilHours: 72, penaltyPct: 0.25 }) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("owner", "cancelacion");
    await esperar();
    const inputs = [...rendered.container.querySelectorAll("input")] as HTMLInputElement[];
    changeValue(inputs[0]!, "72");
    changeValue(inputs[1]!, "25");
    await submitForm(rendered.container.querySelector("form") as HTMLFormElement);
    await esperar();
    expect(mutaciones()).toEqual([expect.objectContaining({ method: "PUT", url: "http://api.local/hoteles/prop-1/configuracion/politica-cancelacion", body: { freeUntilHours: 72, penaltyPct: 0.25, guestText: "Cancelación gratis hasta 24 h." } })]);
  });

  it("horas fraccionarias o penalidad mayor a 100 deshabilitan Guardar; accountant no ve Guardar", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("owner", "cancelacion");
    await esperar();
    const inputs = [...rendered.container.querySelectorAll("input")] as HTMLInputElement[];
    changeValue(inputs[0]!, "1.5");
    expect(boton("Guardar política")?.disabled).toBe(true);
    changeValue(inputs[0]!, "10");
    changeValue(inputs[1]!, "120");
    expect(boton("Guardar política")?.disabled).toBe(true);
    rendered.unmount();
    rendered = montar("accountant", "cancelacion");
    await esperar();
    expect(boton("Guardar política")).toBeUndefined();
  });
});

describe("ConfiguracionPage: sobreventa", () => {
  it("lista los tipos; editar abre el dialogo y guardar manda PUT; Cerrar y Escape NO escriben", async () => {
    const { fn, mutaciones } = red((url, init) => (init?.method === "PUT" ? json({ ...TIPOS[0], maxOverbookRooms: 2, thresholdPct: 90 }) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("owner", "sobreventa");
    await esperar();
    expect(rendered.container.textContent).toContain("Sin sobreventa");

    await act(async () => click(botonAria("Editar la sobreventa de Doble")!));
    await esperar();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => click(botonAria("Cerrar")!));
    await esperar();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => click(botonAria("Editar la sobreventa de Doble")!));
    await esperar();
    keydown(document.body.querySelector('[role="dialog"]')!, "Escape");
    await esperar();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mutaciones()).toHaveLength(0);

    await act(async () => click(botonAria("Editar la sobreventa de Doble")!));
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    const inputs = [...dialogo.querySelectorAll("input")] as HTMLInputElement[];
    changeValue(inputs[0]!, "2");
    changeValue(inputs[1]!, "90");
    await submitForm(dialogo.querySelector("form") as HTMLFormElement);
    await esperar();
    expect(mutaciones()).toEqual([expect.objectContaining({ method: "PUT", url: "http://api.local/hoteles/prop-1/configuracion/sobreventa/rt-1", body: { maxOverbookRooms: 2, thresholdPct: 90 } })]);
  });

  it("accountant ve la tabla sin boton Editar", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("accountant", "sobreventa");
    await esperar();
    expect(rendered.container.textContent).toContain("Doble");
    expect(botonAria("Editar la sobreventa")).toBeUndefined();
  });
});

describe("ConfiguracionPage: tarifas", () => {
  it("lista las noches, marca el precio manual y editar manda PUT con precio y estancia minima", async () => {
    const { fn, mutaciones, llamadas } = red((url, init) => (init?.method === "PUT" ? json({ ...TARIFAS.tarifas[0], price: 1700, manualPriceAt: "2026-11-02T10:00:00Z" }) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("owner", "tarifas");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Precio manual");
    expect(texto).toContain("$1,500.00");
    expect(llamadas.some((l) => l.url.includes("/tarifas?") && l.url.includes("desde=") && l.url.includes("hasta="))).toBe(true);

    await act(async () => click(document.body.querySelector('[aria-label^="Editar el precio del"]') as HTMLButtonElement));
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    const inputs = [...dialogo.querySelectorAll("input")] as HTMLInputElement[];
    expect(inputs[0]!.value).toBe("1500");
    changeValue(inputs[0]!, "1700");
    await submitForm(dialogo.querySelector("form") as HTMLFormElement);
    await esperar();
    expect(mutaciones()).toEqual([expect.objectContaining({ method: "PUT", url: "http://api.local/hoteles/prop-1/tarifas/r-1", body: { precio: 1700, estanciaMinima: 1 } })]);
  });

  it("un precio negativo deshabilita Guardar y un 4xx del servidor se muestra sin cerrar el dialogo", async () => {
    const { fn, mutaciones } = red((url, init) => (init?.method === "PUT" ? json({ message: "precio debe ser un número mayor o igual a 0." }, false, 400) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("gm", "tarifas");
    await esperar();
    await act(async () => click(document.body.querySelector('[aria-label^="Editar el precio del"]') as HTMLButtonElement));
    await esperar();
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    const inputs = [...dialogo.querySelectorAll("input")] as HTMLInputElement[];
    changeValue(inputs[0]!, "-5");
    const guardar = [...dialogo.querySelectorAll("button")].find((b) => b.getAttribute("type") === "submit") as HTMLButtonElement;
    expect(guardar.disabled).toBe(true);
    changeValue(inputs[0]!, "100");
    await submitForm(dialogo.querySelector("form") as HTMLFormElement);
    await esperar();
    expect(document.body.textContent).toContain("precio debe ser un número mayor o igual a 0.");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mutaciones()).toHaveLength(1);
  });

  it("error al listar: muestra el error con reintento; rango vacio: mensaje honesto", async () => {
    vi.stubGlobal("fetch", red((url) => (url.includes("/tarifas") ? json({ ...TARIFAS, tarifas: [] }) : undefined)).fn);
    rendered = montar("owner", "tarifas");
    await esperar();
    expect(rendered.container.textContent).toContain("No hay tarifas en este rango");
  });
});

describe("ConfiguracionPage: bitacora", () => {
  it("owner la ve con valor anterior y nuevo", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("owner", "bitacora");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Impuestos");
    expect(texto).toContain("ishRate: 0.03");
    expect(texto).toContain("ishRate: 0.04");
  });

  it("accountant que fuerza ?tab=bitacora cae en Impuestos (no pide la bitacora)", async () => {
    const { fn, llamadas } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar("accountant", "bitacora");
    await esperar();
    expect(llamadas.some((l) => l.url.includes("/configuracion/bitacora"))).toBe(false);
    expect(campo(rendered, "imp-iva")).not.toBeNull();
  });
});
