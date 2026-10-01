// @vitest-environment jsdom
//
// D-21 -- pantalla de la cartera de clientes (jsdom): lista con/sin ficha, aviso de base sin migrar, alta con validacion
// en el cliente y error del servidor visible, edicion con RFC bloqueado, acciones ocultas por rol, y el alta del primer
// cliente cuando el despacho no tiene ninguno.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AltaPrimerCliente, CarteraPage } from "../src/verticals/despachos/pages/Cartera.tsx";
import type { CarteraRespuesta } from "../src/verticals/despachos/lib/cartera-client.ts";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const FICHA = { propertyId: "p1", rfc: "ABC010101AB1", tipoPersona: "moral", razonSocial: "Abarrotes SA de CV", regimenesFiscales: [{ clave: "601", nombre: "General de Ley Personas Morales" }], cpFiscal: "06600", periodicidad: "mensual", responsableId: null, creadoEn: "2026-09-01", actualizadoEn: "2026-09-01" } as const;
const LISTA: CarteraRespuesta = { estado: "disponible", puedeDarDeAlta: true, clientes: [{ propertyId: "p1", nombre: "Abarrotes del Norte", ficha: FICHA }, { propertyId: "p2", nombre: "Taller Sin Ficha", ficha: null }] };

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Staff", staffEmail: "s@example.com" });

interface Llamada {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}
let llamadas: Llamada[];
let rendered: RenderedComponent | undefined;

function stubFetch(lista: CarteraRespuesta, respuestaEscritura: () => Response = () => new Response(JSON.stringify({ propertyId: "p9", nombre: "x" }), { status: 201 })) {
  llamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/admin/cartera") && method === "GET") return new Response(JSON.stringify(lista), { status: 200 });
      if (url.endsWith("/admin/staff/miembros")) return new Response(JSON.stringify({ miembros: [{ id: "00000000-0000-0000-0000-000000000009", email: "ana@despacho.mx", fullName: "Ana Contadora", verticalRole: "contador", propertyIds: null }] }), { status: 200 });
      return respuestaEscritura();
    }),
  );
}

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function montar(role: string): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter>
      <CarteraPage {...CTX(role)} />
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return r;
}

const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const campo = (id: string) => document.getElementById(id) as HTMLInputElement;

describe("CarteraPage", () => {
  it("lista los clientes: con ficha (RFC, tipo de persona, regimen, CP) y sin ficha senalado", async () => {
    stubFetch(LISTA);
    rendered = await montar("admin");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Cartera de clientes");
    expect(texto).toContain("ABC010101AB1");
    expect(texto).toContain("Persona moral");
    expect(texto).toContain("601 General de Ley Personas Morales");
    expect(texto).toContain("06600");
    expect(texto).toContain("Taller Sin Ficha");
    expect(texto).toContain("Sin ficha");
    expect(texto).toContain("1 de 2 clientes sin ficha fiscal");
    expect(texto).toContain("Completar ficha");
    expect(texto).toContain("Editar ficha");
  });

  it("auditor/readonly ven la cartera pero ninguna accion de escritura", async () => {
    stubFetch({ ...LISTA, puedeDarDeAlta: false });
    rendered = await montar("auditor");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Abarrotes del Norte");
    expect(texto).not.toContain("Nuevo cliente");
    expect(texto).not.toContain("Editar ficha");
    expect(texto).not.toContain("Completar ficha");
    // ni siquiera pide la lista de staff (solo la entrega el servidor al administrador)
    expect(llamadas.some((l) => l.url.endsWith("/admin/staff/miembros"))).toBe(false);
  });

  it("base sin migrar: aviso honesto y sin acciones de escritura (no se ofrece guardar lo que fallaria)", async () => {
    stubFetch({ estado: "no_disponible", puedeDarDeAlta: true, clientes: [{ propertyId: "p1", nombre: "Abarrotes del Norte", ficha: null }] });
    rendered = await montar("admin");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("aún no está habilitada en esta base");
    expect(texto).not.toContain("Nuevo cliente");
    expect(texto).not.toContain("Completar ficha");
  });

  it("alta: validacion en el cliente (nada se envia) y luego envio con el cuerpo normalizado y recarga", async () => {
    stubFetch(LISTA);
    rendered = await montar("admin");
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Nuevo cliente"))!);
    expect(dialogo()).not.toBeNull();

    // Formulario vacio: errores visibles y ningun POST.
    await submitForm(document.getElementById("form-cartera") as HTMLFormElement);
    expect(dialogo()!.textContent).toContain("El nombre del cliente es obligatorio.");
    expect(dialogo()!.textContent).toContain("El RFC es obligatorio.");
    expect(dialogo()!.textContent).toContain("Elige al menos un régimen fiscal.");
    expect(llamadas.some((l) => l.method === "POST")).toBe(false);

    changeValue(campo("form-cartera-nombre"), "Cliente Nuevo");
    changeValue(campo("form-cartera-rfc"), "nnn010101nn1");
    changeValue(campo("form-cartera-razon"), "Nuevo SA de CV");
    changeValue(campo("form-cartera-cp"), "64000");
    click([...dialogo()!.querySelectorAll('input[type="checkbox"]')].find((c) => c.closest("label")?.textContent?.startsWith("601"))!);
    expect(dialogo()!.textContent).toContain("Persona moral");

    await submitForm(document.getElementById("form-cartera") as HTMLFormElement);
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const post = llamadas.find((l) => l.method === "POST")!;
    expect(post.url).toBe("https://api.test/v1/despachos/demo/admin/cartera");
    expect(post.body).toEqual({ nombre: "Cliente Nuevo", rfc: "NNN010101NN1", razonSocial: "Nuevo SA de CV", regimenesFiscales: ["601"], cpFiscal: "64000", periodicidad: "mensual" });
    expect(dialogo()).toBeNull();
    expect(rendered.container.textContent).toContain("Cliente «Cliente Nuevo» dado de alta.");
    expect(llamadas.filter((l) => l.method === "GET" && l.url.endsWith("/admin/cartera")).length).toBeGreaterThanOrEqual(2);
  });

  it("alta: el error del servidor (409 RFC duplicado) se muestra y el dialogo sigue abierto", async () => {
    stubFetch(LISTA, () => new Response(JSON.stringify({ error: "conflict", message: "Ya existe un cliente con ese RFC en tu despacho." }), { status: 409 }));
    rendered = await montar("contador");
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Nuevo cliente"))!);
    changeValue(campo("form-cartera-nombre"), "Dup");
    changeValue(campo("form-cartera-rfc"), "ABC010101AB1");
    changeValue(campo("form-cartera-razon"), "Dup SA");
    changeValue(campo("form-cartera-cp"), "64000");
    click([...dialogo()!.querySelectorAll('input[type="checkbox"]')].find((c) => c.closest("label")?.textContent?.startsWith("601"))!);
    await submitForm(document.getElementById("form-cartera") as HTMLFormElement);
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("Ya existe un cliente con ese RFC en tu despacho.");
  });

  it("edicion: el RFC de una ficha existente queda bloqueado y el PUT no manda nombre", async () => {
    stubFetch(LISTA, () => new Response(JSON.stringify({ ficha: FICHA }), { status: 200 }));
    rendered = await montar("admin");
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Editar ficha"))!);
    expect(campo("form-cartera-rfc").disabled).toBe(true);
    expect(campo("form-cartera-rfc").value).toBe("ABC010101AB1");
    expect(document.getElementById("form-cartera-nombre")).toBeNull();
    changeValue(campo("form-cartera-cp"), "11000");
    await submitForm(document.getElementById("form-cartera") as HTMLFormElement);
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const put = llamadas.find((l) => l.method === "PUT")!;
    expect(put.url).toBe("https://api.test/despachos/p1/cartera/ficha");
    expect(put.body).toMatchObject({ rfc: "ABC010101AB1", cpFiscal: "11000" });
    expect(put.body).not.toHaveProperty("nombre");
  });

  it("completar ficha de un cliente sin ficha deja el RFC editable", async () => {
    stubFetch(LISTA);
    rendered = await montar("admin");
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Completar ficha"))!);
    expect(campo("form-cartera-rfc").disabled).toBe(false);
    expect(campo("form-cartera-rfc").value).toBe("");
  });
});

describe("AltaPrimerCliente (despacho sin ningun cliente)", () => {
  it("da de alta el primer cliente y avisa para recargar los contribuyentes", async () => {
    stubFetch(LISTA);
    const onCreado = vi.fn();
    rendered = renderComponent(<AltaPrimerCliente apiBaseUrl="https://api.test" token="tok" orgSlug="demo" onCreado={onCreado} />);
    expect(rendered.container.textContent).toContain("Da de alta tu primer cliente");
    changeValue(campo("form-primer-cliente-nombre"), "Primero");
    changeValue(campo("form-primer-cliente-rfc"), "PPP010101PP1");
    changeValue(campo("form-primer-cliente-razon"), "Primero SA");
    changeValue(campo("form-primer-cliente-cp"), "01000");
    click([...rendered.container.querySelectorAll('input[type="checkbox"]')].find((c) => c.closest("label")?.textContent?.startsWith("601"))!);
    await submitForm(document.getElementById("form-primer-cliente") as HTMLFormElement);
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(llamadas.find((l) => l.method === "POST")?.url).toBe("https://api.test/v1/despachos/demo/admin/cartera");
    expect(onCreado).toHaveBeenCalledTimes(1);
  });

  it("si el servidor rechaza, muestra el error y NO avisa", async () => {
    stubFetch(LISTA, () => new Response(JSON.stringify({ error: "forbidden", message: "Dar de alta clientes requiere acceso a toda la organización." }), { status: 403 }));
    const onCreado = vi.fn();
    rendered = renderComponent(<AltaPrimerCliente apiBaseUrl="https://api.test" token="tok" orgSlug="demo" onCreado={onCreado} />);
    changeValue(campo("form-primer-cliente-nombre"), "Primero");
    changeValue(campo("form-primer-cliente-rfc"), "PPP010101PP1");
    changeValue(campo("form-primer-cliente-razon"), "Primero SA");
    changeValue(campo("form-primer-cliente-cp"), "01000");
    click([...rendered.container.querySelectorAll('input[type="checkbox"]')].find((c) => c.closest("label")?.textContent?.startsWith("601"))!);
    await submitForm(document.getElementById("form-primer-cliente") as HTMLFormElement);
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain("requiere acceso a toda la organización");
    expect(onCreado).not.toHaveBeenCalled();
  });
});
