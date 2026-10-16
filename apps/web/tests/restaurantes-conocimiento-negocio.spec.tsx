// @vitest-environment jsdom
//
// <ConocimientoNegocio />: lista real de la API (publicadas y borradores), crear/editar/apagar/aprobar/borrar con los cuerpos exactos del
// contrato, estados honestos (cargando, error con reintento, vacio, base sin migrar) y la misma seccion montada en el editor del agente de
// WhatsApp. `fetch` mockeado por ruta real (lib/conocimiento-client.ts).
import { act } from "react";
import { afterEach, describe, expect, it, vi, beforeAll } from "vitest";
import { ConocimientoNegocio } from "../src/verticals/restaurantes/components/ConocimientoNegocio.tsx";
import { AgenteWhatsappSeccion } from "../src/verticals/restaurantes/pages/AgenteWhatsappSeccion.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, etiquetaMostrada, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const BASE = "https://api.test/v1/restaurantes/prop-1/admin";
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const GENERAL = { id: "k1", sucursalId: null, reemplazaId: null, titulo: "Estacionamiento", texto: "Hay estacionamiento gratuito para clientes.", tipo: "faq", prioridad: 50, vigenteDesde: null, vigenteHasta: null, activo: true, estado: "publicado", origen: "manual", version: 1, actualizadoEn: "2026-10-04T12:00:00Z" };
const AVISO = { ...GENERAL, id: "k2", sucursalId: "prop-1", titulo: "Cierre", texto: "Hoy cerramos a las 10.", tipo: "aviso_temporal", vigenteDesde: "2026-10-06", vigenteHasta: "2026-10-06" };
const BORRADOR = { ...GENERAL, id: "k3", titulo: "Reservas", texto: "No tomamos reservaciones.", tipo: "politica", estado: "borrador", origen: "importado" };

interface Llamada {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

function stub(llamadas: Llamada[], opciones: { lista?: () => Response; escritura?: (m: string, url: string, body: unknown) => Response } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      llamadas.push({ method, url, body });
      if (url === `${BASE}/sucursales`) return json({ branches: [{ propertyId: "prop-1", name: "Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: null, lng: null }] });
      if (url.startsWith(`${BASE}/conocimiento`)) {
        if (method === "GET") return opciones.lista ? opciones.lista() : json({ disponible: true, topeCaracteres: 6000, entradas: [GENERAL, AVISO, BORRADOR] });
        return opciones.escritura ? opciones.escritura(method, url, body) : json({ ok: true, ...GENERAL });
      }
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    }),
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

async function montar(canal: "voz" | "whatsapp" = "whatsapp") {
  rendered = renderComponent(<ConocimientoNegocio apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" canal={canal} />);
  await settle();
}

const boton = (texto: string) => [...rendered!.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(texto) || b.getAttribute("aria-label")?.includes(texto));
const fila = (id: string) => rendered!.container.querySelector(`[data-entrada="${id}"]`)!;
const botonEn = (el: Element, texto: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === texto || b.getAttribute("aria-label")?.startsWith(texto))!;
const pulsarYEsperar = async (el: Element) => {
  await act(async () => {
    click(el);
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
};

describe("<ConocimientoNegocio />", () => {
  it("lista publicadas y borradores por separado, con alcance, vigencia legible y el uso del tope", async () => {
    stub([]);
    await montar();
    expect(fila("k1").textContent).toContain("Toda la organización");
    expect(fila("k1").textContent).toContain("Activa");
    expect(fila("k2").textContent).toContain("Altabrisa");
    expect(fila("k2").textContent).toContain("Solo el 2026-10-06");
    const seccionBorradores = rendered!.container.querySelector('section[aria-label="Borradores por aprobar"]')!;
    expect(seccionBorradores.textContent).toContain("Nada de esto llega al agente hasta que usted lo apruebe");
    expect(seccionBorradores.querySelector('[data-entrada="k3"]')).not.toBeNull();
    expect(seccionBorradores.querySelector('[data-entrada="k1"]')).toBeNull();
    const uso = GENERAL.titulo.length + GENERAL.texto.length + AVISO.titulo.length + AVISO.texto.length;
    expect(rendered!.container.querySelector('[data-testid="conocimiento-uso"]')!.textContent).toContain(`En uso: ${uso} de 6,000`);
  });

  it("aprobar un borrador manda PATCH {estado:'publicado'} y recarga", async () => {
    const llamadas: Llamada[] = [];
    stub(llamadas);
    await montar();
    await pulsarYEsperar(botonEn(fila("k3"), "Aprobar"));
    expect(llamadas.find((c) => c.method === "PATCH")).toMatchObject({ url: `${BASE}/conocimiento/k3`, body: { estado: "publicado" } });
    expect(rendered!.container.textContent).toContain("Borrador aprobado");
    expect(llamadas.filter((c) => c.method === "GET" && c.url.endsWith("/conocimiento")).length).toBe(2);
  });

  it("apagar una entrada manda PATCH {activo:false}", async () => {
    const llamadas: Llamada[] = [];
    stub(llamadas);
    await montar();
    await pulsarYEsperar(botonEn(fila("k1"), "Apagar"));
    expect(llamadas.find((c) => c.method === "PATCH")).toMatchObject({ url: `${BASE}/conocimiento/k1`, body: { activo: false } });
  });

  it("eliminar pide confirmacion: Volver no borra; Eliminar manda DELETE", async () => {
    const llamadas: Llamada[] = [];
    stub(llamadas);
    await montar();
    await pulsarYEsperar(botonEn(fila("k1"), "Eliminar"));
    const dialogo = () => document.body.querySelector('[role="alertdialog"]')!;
    expect(dialogo().textContent).toContain("Estacionamiento");
    await pulsarYEsperar([...dialogo().querySelectorAll("button")].find((b) => b.textContent === "Volver")!);
    expect(llamadas.some((c) => c.method === "DELETE")).toBe(false);
    await pulsarYEsperar(botonEn(fila("k1"), "Eliminar"));
    await pulsarYEsperar([...dialogo().querySelectorAll("button")].find((b) => b.textContent === "Eliminar")!);
    expect(llamadas.find((c) => c.method === "DELETE")!.url).toBe(`${BASE}/conocimiento/k1`);
  });

  it("editar precarga el formulario, no deja cambiar el alcance y manda el PATCH con los campos del formulario", async () => {
    const llamadas: Llamada[] = [];
    stub(llamadas);
    await montar();
    await pulsarYEsperar(botonEn(fila("k2"), "Editar"));
    const form = rendered!.container.querySelector('section[aria-label="Editar entrada"]')!;
    expect(form.querySelector<HTMLElement>("[role='combobox'][disabled]")).not.toBeNull();
    changeValue(form.querySelector<HTMLTextAreaElement>("textarea")!, "Hoy cerramos a las 9.");
    await pulsarYEsperar(botonEn(form, "Guardar entrada"));
    expect(llamadas.find((c) => c.method === "PATCH")).toMatchObject({
      url: `${BASE}/conocimiento/k2`,
      body: { titulo: "Cierre", texto: "Hoy cerramos a las 9.", tipo: "aviso_temporal", prioridad: 50, vigenteDesde: "2026-10-06", vigenteHasta: "2026-10-06", reemplazaId: null },
    });
  });

  it("una entrada nueva de sucursal puede sustituir a una general (el selector solo aparece con sucursal elegida)", async () => {
    const llamadas: Llamada[] = [];
    stub(llamadas);
    await montar();
    click(boton("Agregar entrada")!);
    const form = () => rendered!.container.querySelector('section[aria-label="Nueva entrada"]')!;
    expect(form().textContent).not.toContain("Sustituye a una entrada general");
    const aplicaA = [...form().querySelectorAll("[role='combobox']")].find((s) => etiquetaMostrada(s).includes("Toda la organización"))!;
    elegirValor(aplicaA, "prop-1");
    expect(form().textContent).toContain("Sustituye a una entrada general");
    changeValue(form().querySelector<HTMLInputElement>('input[placeholder="Estacionamiento"]')!, "Estacionamiento");
    changeValue(form().querySelector<HTMLTextAreaElement>("textarea")!, "Hoy el estacionamiento está en obra.");
    const sustituye = [...form().querySelectorAll("[role='combobox']")].find((s) => etiquetaMostrada(s).includes("No sustituye ninguna"))!;
    elegirValor(sustituye, "k1");
    await pulsarYEsperar(botonEn(form(), "Guardar entrada"));
    expect(llamadas.find((c) => c.method === "POST")!.body).toMatchObject({ sucursalId: "prop-1", reemplazaId: "k1", tipo: "faq" });
  });

  it("valida en el cliente lo evidente (vacio, fechas invertidas) sin llamar a la API", async () => {
    const llamadas: Llamada[] = [];
    stub(llamadas);
    await montar();
    click(boton("Agregar entrada")!);
    const form = () => rendered!.container.querySelector('section[aria-label="Nueva entrada"]')!;
    await pulsarYEsperar(botonEn(form(), "Guardar entrada"));
    expect(rendered!.container.querySelector('[role="alert"]')!.textContent).toContain("no pueden quedar vacíos");
    changeValue(form().querySelector<HTMLInputElement>('input[placeholder="Estacionamiento"]')!, "x");
    changeValue(form().querySelector<HTMLTextAreaElement>("textarea")!, "y");
    const fechas = form().querySelectorAll<HTMLInputElement>('input[type="date"]');
    changeValue(fechas[0]!, "2026-10-10");
    changeValue(fechas[1]!, "2026-10-01");
    await pulsarYEsperar(botonEn(form(), "Guardar entrada"));
    expect(rendered!.container.querySelector('[role="alert"]')!.textContent).toContain("fecha final");
    expect(llamadas.some((c) => c.method === "POST")).toBe(false);
  });

  it("sin entradas: estado vacio con ejemplo; error de carga: mensaje real y Reintentar vuelve a pedir", async () => {
    stub([], { lista: () => json({ disponible: true, topeCaracteres: 6000, entradas: [] }) });
    await montar("voz");
    expect(rendered!.container.textContent).toContain("Sin conocimiento cargado");
    expect(rendered!.container.textContent).toContain("agente de voz");
    rendered!.unmount();

    let intento = 0;
    stub([], { lista: () => (++intento === 1 ? json({ message: "Falla del servidor" }, 500) : json({ disponible: true, topeCaracteres: 6000, entradas: [GENERAL] })) });
    await montar();
    expect(rendered!.container.textContent).toContain("No se pudo cargar");
    await pulsarYEsperar(boton("Reintentar")!);
    expect(rendered!.container.querySelector('[data-entrada="k1"]')).not.toBeNull();
  });

  it("el editor del agente de WhatsApp monta esta misma seccion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(`${BASE}/conocimiento`)) return json({ disponible: true, topeCaracteres: 6000, entradas: [GENERAL] });
        if (url === `${BASE}/sucursales`) return json({ branches: [] });
        return json({ message: "no disponible en este test" }, 404);
      }),
    );
    rendered = renderComponent(<AgenteWhatsappSeccion apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />);
    await settle();
    expect(rendered.container.querySelector('[data-testid="conocimiento-negocio"] [data-entrada="k1"]')).not.toBeNull();
  });
});
