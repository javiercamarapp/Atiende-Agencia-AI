// @vitest-environment jsdom
//
// R-15 (migración 042) en la web: pestañas "Historial del día" y "Mi perfil" del repartidor y el diálogo de perfil de Staff (owner/admin).
// `fetch` inyectado por ruta real (lib/repartidor-perfil-client.ts). Cada caso afirma el EFECTO: qué llama al API (y con qué cuerpo), qué
// NO llama (validación), el estado honesto de base sin migrar, el efectivo a rendir y la alerta de licencia < 30 días.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorialDiaTab, MiPerfilTab } from "../src/verticals/restaurantes/components/RepartidorPestanas.tsx";
import { PerfilRepartidorDialogo } from "../src/verticals/restaurantes/components/PerfilRepartidorDialogo.tsx";
import { formABody, formDesdePerfil, validarPerfilForm, PERFIL_FORM_VACIO } from "../src/verticals/restaurantes/lib/repartidor-perfil-client.ts";
import type { PerfilRepartidor } from "../src/verticals/restaurantes/lib/repartidor-perfil-client.ts";
import { changeValue, click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
});

const API = "https://api.test";
const MI_PERFIL = `${API}/v1/restaurantes/prop-1/repartidor/perfil`;
const HISTORIAL = `${API}/v1/restaurantes/prop-1/repartidor/historial-dia`;
const GESTION = `${API}/v1/restaurantes/prop-1/admin/staff/rep-1/perfil-repartidor`;

function perfil(parcial: Partial<PerfilRepartidor> = {}): PerfilRepartidor {
  return {
    userId: "rep-1", vehiculoTipo: "moto", placas: "ABC-123", disponibilidad: "disponible", turno: "L-V 12:00-20:00", licenciaNumero: "LIC-9", licenciaVigencia: "2027-06-30",
    licenciaEstado: "vigente", licenciaDias: 270, emergenciaNombre: "Maria Perez", emergenciaTelefono: "5512345678", updatedAt: "2026-10-03T12:00:00.000Z", ...parcial,
  };
}

type Respuesta = { status: number; body?: unknown };
const res = (r: Respuesta) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} }) as unknown as Response;
function stub(rutas: Record<string, Respuesta | (() => Respuesta)>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const clave = `${init?.method ?? "GET"} ${url}`;
    const r = rutas[clave];
    if (!r) throw new Error(`fetch inesperado: ${clave}`);
    return res(typeof r === "function" ? r() : r);
  });
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
function campo(etiqueta: string): HTMLInputElement | HTMLSelectElement {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent?.startsWith(etiqueta));
  if (!label) throw new Error(`sin campo ${etiqueta}`);
  return document.getElementById(label.getAttribute("for")!) as HTMLInputElement | HTMLSelectElement;
}
const boton = (texto: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(texto)) as HTMLButtonElement | undefined;
const texto = () => document.body.textContent ?? "";

describe("validación y mapeo del formulario (puros)", () => {
  it("vacío es válido y se manda como null (disponibilidad por defecto)", () => {
    expect(validarPerfilForm(PERFIL_FORM_VACIO)).toEqual({});
    expect(formABody(PERFIL_FORM_VACIO)).toEqual({ vehiculoTipo: null, placas: null, disponibilidad: "disponible", turno: null, licenciaNumero: null, licenciaVigencia: null, emergenciaNombre: null, emergenciaTelefono: null });
  });
  it.each([
    [{ licenciaNumero: "L" }, "licenciaVigencia"],
    [{ licenciaVigencia: "2027-01-01" }, "licenciaNumero"],
    [{ emergenciaNombre: "A" }, "emergenciaTelefono"],
    [{ emergenciaTelefono: "5512345678" }, "emergenciaNombre"],
    [{ emergenciaNombre: "A", emergenciaTelefono: "123" }, "emergenciaTelefono"],
    [{ placas: "X".repeat(16) }, "placas"],
  ])("rechaza %j en el campo %s", (parcial, campoEsperado) => {
    expect(Object.keys(validarPerfilForm({ ...PERFIL_FORM_VACIO, ...parcial }))).toContain(campoEsperado);
  });
  it("acepta +52 y formatos con espacios; el servidor deja los 10 dígitos", () => {
    expect(validarPerfilForm({ ...PERFIL_FORM_VACIO, emergenciaNombre: "A", emergenciaTelefono: "+52 55 1234 5678" })).toEqual({});
  });
  it("formDesdePerfil / formABody ida y vuelta", () => {
    expect(formABody(formDesdePerfil(perfil()))).toMatchObject({ vehiculoTipo: "moto", placas: "ABC-123", licenciaVigencia: "2027-06-30", emergenciaTelefono: "5512345678" });
  });
});

describe("<HistorialDiaTab />", () => {
  const datos = {
    fecha: "2026-10-03", zonaHoraria: "America/Mexico_City",
    entregas: [
      { id: "o1", customerName: "Marisol Pech", total: 150, paymentMethod: "efectivo", status: "entregado", deliveredAt: "2026-10-03T17:00:00.000Z" },
      { id: "o2", customerName: "Luis Uc", total: 90.5, paymentMethod: null, status: "entregado", deliveredAt: "2026-10-03T18:00:00.000Z" },
    ],
    totales: { pedidos: 2, totalCentavos: 24050, efectivoCentavos: 15000, efectivoPedidos: 1, tarjetaCentavos: 0, sinMetodoPedidos: 1 },
  };

  it("muestra las entregas, el efectivo a rendir con su base y avisa de los pedidos sin método (no los suma)", async () => {
    const f = stub({ [`GET ${HISTORIAL}`]: { status: 200, body: datos } });
    rendered = renderComponent(<HistorialDiaTab apiBaseUrl={API} token="tok" propertyId="prop-1" fetchImpl={f as unknown as typeof fetch} />);
    await settle();
    const t = texto();
    expect(t).toContain("Marisol Pech");
    expect(t).toContain("Luis Uc");
    expect(t).toContain("Efectivo a rendir");
    expect(t).toContain("$150.00 MXN");
    expect(t).toContain("1 pedido pagado en efectivo");
    expect(t).toContain("Hay pedidos sin método de pago registrado");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("sin entregas: vacío honesto y efectivo en cero (no inventa cifras)", async () => {
    const f = stub({ [`GET ${HISTORIAL}`]: { status: 200, body: { ...datos, entregas: [], totales: { pedidos: 0, totalCentavos: 0, efectivoCentavos: 0, efectivoPedidos: 0, tarjetaCentavos: 0, sinMetodoPedidos: 0 } } } });
    rendered = renderComponent(<HistorialDiaTab apiBaseUrl={API} token="tok" propertyId="prop-1" fetchImpl={f as unknown as typeof fetch} />);
    await settle();
    expect(texto()).toContain("Todavía no has entregado ningún pedido hoy.");
    expect(texto()).toContain("Ningún pedido pagado en efectivo");
    expect(texto()).not.toContain("Hay pedidos sin método");
  });

  it("error del API: mensaje con reintento que vuelve a llamar", async () => {
    let n = 0;
    const f = stub({ [`GET ${HISTORIAL}`]: () => (++n === 1 ? { status: 500, body: { message: "boom" } } : { status: 200, body: datos }) });
    rendered = renderComponent(<HistorialDiaTab apiBaseUrl={API} token="tok" propertyId="prop-1" fetchImpl={f as unknown as typeof fetch} />);
    await settle();
    expect(texto()).toContain("boom");
    click(boton("Reintentar")!);
    await settle();
    expect(texto()).toContain("Marisol Pech");
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("<MiPerfilTab />", () => {
  const pintar = async (f: ReturnType<typeof stub>) => {
    rendered = renderComponent(<MiPerfilTab apiBaseUrl={API} token="tok" propertyId="prop-1" fetchImpl={f as unknown as typeof fetch} />);
    await settle();
  };

  it("carga el perfil propio en el formulario; licencia vigente = sin alerta", async () => {
    await pintar(stub({ [`GET ${MI_PERFIL}`]: { status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: perfil() } } }));
    expect(campo("Placas").value).toBe("ABC-123");
    expect(campo("Número de licencia").value).toBe("LIC-9");
    expect(texto()).not.toContain("vence pronto");
    expect(texto()).not.toContain("está vencida");
  });

  it("licencia a menos de 30 días: alerta de aviso con los días; vencida: alerta de peligro", async () => {
    await pintar(stub({ [`GET ${MI_PERFIL}`]: { status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: perfil({ licenciaEstado: "por_vencer", licenciaDias: 12 }) } } }));
    expect(texto()).toContain("Tu licencia vence pronto");
    expect(texto()).toContain("Vence en 12 días.");
    rendered?.unmount();
    await pintar(stub({ [`GET ${MI_PERFIL}`]: { status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: perfil({ licenciaEstado: "vencida", licenciaDias: -3 }) } } }));
    expect(texto()).toContain("Tu licencia está vencida");
    expect(texto()).toContain("Venció hace 3 días.");
  });

  it("guardar: llama PUT con el cuerpo real, refleja lo devuelto por el servidor y avisa", async () => {
    const put = vi.fn(() => ({ status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: perfil({ placas: "XYZ-9", emergenciaTelefono: "5599998888" }) } }));
    const f = stub({ [`GET ${MI_PERFIL}`]: { status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: perfil() } }, [`PUT ${MI_PERFIL}`]: put });
    await pintar(f);
    changeValue(campo("Placas") as HTMLInputElement, "XYZ-9");
    changeValue(campo("Teléfono del contacto") as HTMLInputElement, "55 9999 8888");
    await act(async () => {
      click(boton("Guardar perfil")!);
    });
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
    const llamada = f.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse((llamada[1] as RequestInit).body as string)).toMatchObject({ placas: "XYZ-9", emergenciaTelefono: "55 9999 8888", licenciaNumero: "LIC-9" });
    expect(campo("Placas").value).toBe("XYZ-9");
    expect(campo("Teléfono del contacto").value).toBe("5599998888");
  });

  it("validación local: licencia sin vigencia NO llama al API y marca el campo", async () => {
    const f = stub({ [`GET ${MI_PERFIL}`]: { status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: null } } });
    await pintar(f);
    changeValue(campo("Número de licencia") as HTMLInputElement, "L-1");
    await act(async () => {
      click(boton("Guardar perfil")!);
    });
    await settle();
    expect(texto()).toContain("Indica hasta cuándo es válida la licencia.");
    expect(f.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toHaveLength(0);
  });

  it("error del servidor al guardar se muestra y el formulario conserva lo escrito", async () => {
    const f = stub({ [`GET ${MI_PERFIL}`]: { status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: null } }, [`PUT ${MI_PERFIL}`]: { status: 503, body: { message: "sin migración" } } });
    await pintar(f);
    changeValue(campo("Placas") as HTMLInputElement, "ZZZ");
    await act(async () => {
      click(boton("Guardar perfil")!);
    });
    await settle();
    expect(texto()).toContain("sin migración");
    expect(campo("Placas").value).toBe("ZZZ");
  });

  it("base SIN migrar (disponible=false): estado honesto, sin formulario ni botón de guardar", async () => {
    await pintar(stub({ [`GET ${MI_PERFIL}`]: { status: 200, body: { disponible: false, hoy: "2026-10-03", perfil: null } } }));
    expect(texto()).toContain("No disponible aún: requiere la actualización de base de datos");
    expect(boton("Guardar perfil")).toBeUndefined();
  });
});

describe("<PerfilRepartidorDialogo /> (Staff, owner/admin)", () => {
  const confirmarSi = vi.fn(async () => true);
  const pintar = async (f: ReturnType<typeof stub>, confirmar = confirmarSi) => {
    const cambios = vi.fn();
    rendered = renderComponent(
      <PerfilRepartidorDialogo open onOpenChange={cambios} repartidor={{ id: "rep-1", fullName: "Ramon Uc" }} apiBaseUrl={API} token="tok" propertyId="prop-1" confirmar={confirmar} fetchImpl={f as unknown as typeof fetch} />,
    );
    await settle();
    return cambios;
  };

  it("abre, carga el perfil de ESE repartidor y muestra la alerta de licencia ajena", async () => {
    await pintar(stub({ [`GET ${GESTION}`]: { status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: perfil({ licenciaEstado: "por_vencer", licenciaDias: 5 }) } } }));
    expect(texto()).toContain("Perfil de Ramon Uc");
    expect(campo("Número de licencia").value).toBe("LIC-9");
    expect(texto()).toContain("La licencia vence pronto");
    expect(texto()).toContain("Vence en 5 días.");
  });

  it("guardar llama PUT a la ruta de gestión de ese usuario", async () => {
    const put = vi.fn(() => ({ status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: perfil({ turno: "Fines de semana" }) } }));
    const f = stub({ [`GET ${GESTION}`]: { status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: perfil() } }, [`PUT ${GESTION}`]: put });
    await pintar(f);
    changeValue(campo("Turno") as HTMLInputElement, "Fines de semana");
    await act(async () => {
      click(boton("Guardar perfil")!);
    });
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
    expect(campo("Turno").value).toBe("Fines de semana");
  });

  it("suprimir pide confirmación: cancelar NO llama al API; confirmar llama DELETE y cierra", async () => {
    const del = vi.fn(() => ({ status: 200, body: { ok: true, borrado: true } }));
    const f = stub({ [`GET ${GESTION}`]: { status: 200, body: { disponible: true, hoy: "2026-10-03", perfil: perfil() } }, [`DELETE ${GESTION}`]: del });
    const no = vi.fn(async () => false);
    await pintar(f, no);
    await act(async () => {
      click(boton("Suprimir perfil")!);
    });
    await settle();
    expect(no).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    rendered?.unmount();
    document.body.innerHTML = "";
    const cambios = await pintar(f, confirmarSi);
    await act(async () => {
      click(boton("Suprimir perfil")!);
    });
    await settle();
    expect(del).toHaveBeenCalledTimes(1);
    expect(cambios).toHaveBeenCalledWith(false);
  });

  it("base SIN migrar: estado honesto y solo el botón Cerrar (sin guardar ni suprimir)", async () => {
    await pintar(stub({ [`GET ${GESTION}`]: { status: 200, body: { disponible: false, hoy: "2026-10-03", perfil: null } } }));
    expect(texto()).toContain("No disponible aún");
    expect(boton("Guardar perfil")).toBeUndefined();
    expect(boton("Suprimir perfil")).toBeUndefined();
    expect(boton("Cerrar")).toBeDefined();
  });
});
