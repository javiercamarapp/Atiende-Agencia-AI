// @vitest-environment jsdom
//
// Rn-23 / Rn-40 -- <PreciosPage />: lista lo configurado, edita (FormDialog -> PATCH), borra con
// confirmacion de dos pasos (Cancelar o Escape NO llama al servidor), error de carga, estado vacio,
// "no disponible aun" (503) y roles sin escritura (sin botones de edicion).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreciosPage } from "../src/verticals/rentas/pages/Precios.tsx";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "s@example.com", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const montar = (rol: string) => renderComponent(<PreciosPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);
const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;

const CONFIG = {
  unidadId: "u1",
  tarifaBaseVigente: { id: "tb1", precioNocheCentavos: 150000, moneda: "MXN", vigenteDesde: "2026-01-01" },
  historialTarifaBase: [{ id: "tb1", precioNocheCentavos: 150000, moneda: "MXN", vigenteDesde: "2026-01-01" }],
  temporadas: [{ id: "te1", nombre: "Verano", rango: { inicio: "2027-07-01", fin: "2027-08-31" }, precioNocheCentavos: 220000, moneda: "MXN" }],
  descuentosDuracion: [{ id: "de1", nochesMinimas: 7, porcentajeDescuentoBasisPoints: 1000, fuente: "politica semanal" }],
  reglasMinStay: [{ id: "ms1", rango: { inicio: "2027-12-20", fin: "2028-01-05" }, diaSemanaCheckIn: null, nochesMinimas: 5 }],
  reglasCanal: [{ id: "rc1", canalCodigo: "airbnb", markupBasisPoints: 1500, activo: true }],
};
const VACIA = { unidadId: "u1", tarifaBaseVigente: null, historialTarifaBase: [], temporadas: [], descuentosDuracion: [], reglasMinStay: [], reglasCanal: [] };

function red(opciones: { config?: unknown; falla?: boolean; sinUnidades?: boolean; escritura?: (url: string, init: RequestInit) => Response | undefined } = {}) {
  const llamadas: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/rentas/prop-1/unidades")) return json({ unidades: opciones.sinUnidades ? [] : [{ id: "u1", nombre: "Suite 1" }] });
    if (url.endsWith("/configuracion-precios")) return opciones.falla ? json({ message: "Servidor caído" }, false, 500) : json(opciones.config ?? CONFIG);
    if (method !== "GET") {
      const r = opciones.escritura?.(url, init!);
      if (r) return r;
      return json({ id: "x" });
    }
    throw new Error(`url inesperada: ${method} ${url}`);
  });
  return { fn, mutaciones: () => llamadas.filter((l) => l.method !== "GET"), llamadas };
}

const dialogoConfirmar = () => document.body.querySelector('[role="alertdialog"]');
const botonConfirmar = (texto: string) => [...dialogoConfirmar()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const botonPagina = (texto: string, indice = 0) => [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.trim() === texto)[indice] as HTMLButtonElement;
const dialogoFormulario = () => document.body.querySelector('[role="dialog"]');
const campo = (etiqueta: string) => {
  const label = [...dialogoFormulario()!.querySelectorAll("label")].find((l) => l.textContent?.includes(etiqueta))!;
  return dialogoFormulario()!.querySelector(`#${label.getAttribute("for")}`) as HTMLInputElement;
};

describe("PreciosPage -- lectura", () => {
  it("al abrir Precios un admin_gestora ve lo ya configurado (tarifa, temporada, descuento, min-stay, canal)", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("admin_gestora");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("$1,500.00");
    expect(t).toContain("Vigente");
    expect(t).toContain("Verano");
    expect(t).toContain("$2,200.00");
    expect(t).toContain("7 noches");
    expect(t).toContain("politica semanal");
    expect(t).toContain("2027-12-20 a 2028-01-05");
    expect(t).toContain("Airbnb");
    expect(t).not.toContain("MXN");
  });

  it("sin nada configurado: avisa que no hay tarifa base vigente y muestra los vacios", async () => {
    vi.stubGlobal("fetch", red({ config: VACIA }).fn);
    rendered = montar("admin_gestora");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Sin tarifa base vigente");
    expect(t).toContain("Sin temporadas");
    expect(t).toContain("Sin reglas de canal");
  });

  it("error al cargar la configuracion: mensaje y Reintentar vuelve a pedir", async () => {
    const r = red({ falla: true });
    vi.stubGlobal("fetch", r.fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Servidor caído");
    const antes = r.llamadas.filter((l) => l.url.endsWith("/configuracion-precios")).length;
    await act(async () => {
      click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar")) as HTMLButtonElement);
      await flushMicrotasks();
    });
    await esperar();
    expect(r.llamadas.filter((l) => l.url.endsWith("/configuracion-precios")).length).toBe(antes + 1);
  });

  it("propiedad sin unidades: estado de error honesto", async () => {
    vi.stubGlobal("fetch", red({ sinUnidades: true }).fn);
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Sin unidades");
  });
});

describe("PreciosPage -- roles", () => {
  it("un rol sin escritura NO ve botones de edicion ni la configuracion, solo el cotizador y un aviso", async () => {
    const r = red();
    vi.stubGlobal("fetch", r.fn);
    rendered = montar("contador");
    await esperar();
    const textos = [...rendered.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(textos).not.toContain("Editar");
    expect(textos).not.toContain("Borrar");
    expect(textos).not.toContain("Nueva temporada");
    expect(rendered.container.textContent).toContain("solo lectura");
    expect(r.llamadas.some((l) => l.url.endsWith("/configuracion-precios"))).toBe(false);
  });
});

describe("PreciosPage -- edicion", () => {
  it("editar una temporada abre el formulario precargado y hace PATCH con los valores convertidos a centavos; luego recarga", async () => {
    const r = red({ escritura: () => json({ id: "te1" }) });
    vi.stubGlobal("fetch", r.fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina("Editar", 0)); // primera tabla con acciones: temporadas
    await esperar();
    expect(dialogoFormulario()).not.toBeNull();
    expect(campo("Nombre").value).toBe("Verano");
    expect(campo("Precio por noche").value).toBe("2200.00");
    await act(async () => {
      changeValue(campo("Precio por noche"), "3000");
      await flushMicrotasks();
    });
    const antesGets = r.llamadas.filter((l) => l.url.endsWith("/configuracion-precios")).length;
    await act(async () => {
      click([...dialogoFormulario()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Guardar cambios")) as HTMLButtonElement);
      await flushMicrotasks();
    });
    await esperar();
    const patch = r.mutaciones();
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject({ method: "PATCH", url: "http://api.local/rentas/prop-1/unidades/u1/temporadas/te1" });
    expect(patch[0]!.body).toEqual({ nombre: "Verano", rango: { inicio: "2027-07-01", fin: "2027-08-31" }, precioNocheCentavos: 300000, moneda: "MXN" });
    expect(r.llamadas.filter((l) => l.url.endsWith("/configuracion-precios")).length).toBe(antesGets + 1);
    expect(rendered.container.textContent).toContain("Temporada actualizada.");
  });

  it("un error del servidor al guardar se muestra dentro del formulario y el formulario sigue abierto", async () => {
    const r = red({ escritura: () => json({ message: 'Se traslapa con "Invierno" (2027-08-15..2027-09-15).' }, false, 409) });
    vi.stubGlobal("fetch", r.fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina("Editar", 0));
    await esperar();
    await act(async () => {
      click([...dialogoFormulario()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Guardar cambios")) as HTMLButtonElement);
      await flushMicrotasks();
    });
    await esperar();
    expect(dialogoFormulario()!.textContent).toContain("Se traslapa");
  });

  it("validacion local: precio vacio no llega al servidor", async () => {
    const r = red();
    vi.stubGlobal("fetch", r.fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina("Editar", 0));
    await esperar();
    await act(async () => {
      changeValue(campo("Precio por noche"), "");
      await flushMicrotasks();
    });
    await act(async () => {
      click([...dialogoFormulario()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Guardar cambios")) as HTMLButtonElement);
      await flushMicrotasks();
    });
    expect(r.mutaciones()).toHaveLength(0);
    expect(dialogoFormulario()!.textContent).toContain("precio por noche válido");
  });

  it("Nueva temporada hace POST; Cambiar tarifa hace POST a tarifa-base", async () => {
    const r = red({ escritura: () => json({ id: "nuevo" }, true, 201) });
    vi.stubGlobal("fetch", r.fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina("Cambiar tarifa"));
    await esperar();
    await act(async () => {
      changeValue(campo("Precio por noche"), "1800");
      await flushMicrotasks();
    });
    await act(async () => {
      click([...dialogoFormulario()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Guardar tarifa")) as HTMLButtonElement);
      await flushMicrotasks();
    });
    await esperar();
    expect(r.mutaciones()[0]).toMatchObject({ method: "POST", url: "http://api.local/rentas/prop-1/unidades/u1/tarifa-base", body: { precioNocheCentavos: 180000, moneda: "MXN" } });
  });
});

describe("PreciosPage -- borrado", () => {
  it("Borrar pide confirmacion: Cancelar NO llama al servidor; Escape tampoco; Confirmar hace DELETE y recarga", async () => {
    const r = red({ escritura: () => json({ id: "te1", eliminada: true }) });
    vi.stubGlobal("fetch", r.fn);
    rendered = montar("admin_gestora");
    await esperar();

    click(botonPagina("Borrar", 0));
    await esperar();
    expect(dialogoConfirmar()).not.toBeNull();
    expect(dialogoConfirmar()!.textContent).toContain("Verano");
    expect(r.mutaciones()).toHaveLength(0);
    await act(async () => {
      click(botonConfirmar("Cancelar"));
      await flushMicrotasks();
    });
    await esperar();
    expect(r.mutaciones()).toHaveLength(0);

    click(botonPagina("Borrar", 0));
    await esperar();
    await act(async () => {
      keydown(dialogoConfirmar()!, "Escape");
      await flushMicrotasks();
    });
    await esperar();
    expect(r.mutaciones()).toHaveLength(0);

    click(botonPagina("Borrar", 0));
    await esperar();
    const antesGets = r.llamadas.filter((l) => l.url.endsWith("/configuracion-precios")).length;
    await act(async () => {
      click(botonConfirmar("Borrar"));
      await flushMicrotasks();
    });
    await esperar();
    expect(r.mutaciones()).toEqual([expect.objectContaining({ method: "DELETE", url: "http://api.local/rentas/prop-1/unidades/u1/temporadas/te1" })]);
    expect(r.llamadas.filter((l) => l.url.endsWith("/configuracion-precios")).length).toBe(antesGets + 1);
    expect(rendered.container.textContent).toContain("Temporada borrada.");
  });

  it("si el servidor responde 'no disponible aun' (503) al borrar, se muestra el aviso y nada se da por borrado", async () => {
    const r = red({ escritura: () => json({ message: "No disponible aún: la base de datos todavía no permite borrar temporadas (migración 030 pendiente)." }, false, 503) });
    vi.stubGlobal("fetch", r.fn);
    rendered = montar("admin_gestora");
    await esperar();
    click(botonPagina("Borrar", 0));
    await esperar();
    await act(async () => {
      click(botonConfirmar("Borrar"));
      await flushMicrotasks();
    });
    await esperar();
    expect(rendered.container.textContent).toContain("No disponible aún");
    expect(rendered.container.textContent).not.toContain("Temporada borrada.");
  });
});
