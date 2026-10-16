// @vitest-environment jsdom
// Seccion "Equipo" de la ficha de una organizacion (alta del equipo inicial por superadmin). Efectos observables con la API simulada por ruta:
// lista de miembros e invitaciones (correo enmascarado), invitar con motivo, segundo owner, reenviar y revocar con confirmacion, Cancelar sin
// llamadas, errores en linea, vacio, base sin migrar y error de carga con reintento.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EquipoOrganizacion } from "../src/superadmin/components/EquipoOrganizacion.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const ORG = "11111111-1111-4111-8111-111111111111";
const SUC_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUC_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASE = `https://api.test/superadmin/organizaciones/${ORG}/invitaciones`;
const MOTIVO = "Alta del dueño de la organización para el arranque en producción.";

const SUCURSALES = [{ id: SUC_1, nombre: "Sucursal Centro", estado: "active" }, { id: SUC_2, nombre: "Sucursal Norte", estado: "active" }];
const VACIO = { disponible: true, mensaje: null, miembros: [], invitaciones: [], sucursales: SUCURSALES };
const CON_EQUIPO = {
  disponible: true,
  mensaje: null,
  miembros: [{ userId: "u1", correo: "d***@lostaquitos.mx", rol: "owner", platformRole: "owner", propertyIds: null, altaEn: "2026-10-01T16:00:00.000Z" }],
  invitaciones: [
    { id: "i1", correo: "g***@lostaquitos.mx", rol: "staff", platformRole: "member", propertyIds: [SUC_1], creadaEn: "2026-10-02T16:00:00.000Z", venceEn: "2026-10-09T16:00:00.000Z", vencida: false },
    { id: "i2", correo: "v***@lostaquitos.mx", rol: "admin", platformRole: "admin", propertyIds: null, creadaEn: "2026-09-20T16:00:00.000Z", venceEn: "2026-09-27T16:00:00.000Z", vencida: true },
  ],
  sucursales: SUCURSALES,
};
const RESULTADO = { invitacion: { id: "i9", correo: "d***@lostaquitos.mx", verticalRole: "owner", venceEn: "2026-10-11T16:00:00.000Z" }, inviteToken: "tok-secreto", acceptUrl: "https://app.test/aceptar-invitacion?token=tok-secreto", correoEncolado: true };

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this; } }) as unknown as Response;
async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

type Manejador = (url: string, init?: RequestInit) => Response | undefined;
function stub(get: () => Response, mutaciones: Manejador = () => undefined) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const m = mutaciones(url, init);
    if (m) return m;
    if (url === BASE && (!init?.method || init.method === "GET")) return get();
    throw new Error(`fetch inesperado: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const render = () => renderComponent(<EquipoOrganizacion apiBaseUrl="https://api.test" token="tok" organizacionId={ORG} />);
const mutaciones = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method && (c[1] as RequestInit).method !== "GET");
const boton = (raiz: ParentNode, texto: string) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.includes(texto))!;
const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement;
const confirm = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("EquipoOrganizacion", () => {
  it("lista miembros e invitaciones pendientes con correo enmascarado, sucursales y vencimiento; sin tokens", async () => {
    stub(() => json(CON_EQUIPO));
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    for (const s of ["Equipo", "Miembros · 1", "d***@lostaquitos.mx", "Todas las sucursales", "Invitaciones pendientes · 2", "g***@lostaquitos.mx", "Sucursal Centro", "Vencida"]) expect(t).toContain(s);
    expect(t).not.toContain("tok");
    expect(rendered.container.querySelectorAll('[data-invitacion]')).toHaveLength(2);
    expect(boton(rendered.container, "Invitar")).toBeDefined();
  });

  it("organizacion sin miembros: estado vacio honesto con la accion de invitar al primer dueño", async () => {
    stub(() => json(VACIO));
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("Sin miembros todavía");
    expect(rendered.container.textContent).toContain("No hay invitaciones pendientes.");
    expect(boton(rendered.container, "Invitar")).toBeDefined();
  });

  it("Invitar: Cancelar no llama al servidor; motivo corto y correo invalido muestran error en linea sin POST", async () => {
    stub(() => json(VACIO));
    rendered = render();
    await esperar();
    click(boton(rendered.container, "Invitar"));
    await esperar();
    expect(dialogo()).toBeTruthy();
    click(boton(dialogo(), "Cancelar"));
    await esperar();
    expect(mutaciones()).toHaveLength(0);

    click(boton(rendered.container, "Invitar"));
    await esperar();
    await submitForm(dialogo().querySelector("form")!);
    expect(dialogo().querySelector('[role="alert"]')?.textContent).toContain("correo válido");
    changeValue(dialogo().querySelector("#equipo-email") as HTMLInputElement, "dueno@lostaquitos.mx");
    changeValue(dialogo().querySelector("#equipo-motivo") as HTMLTextAreaElement, "corto");
    await submitForm(dialogo().querySelector("form")!);
    expect(dialogo().querySelector('[role="alert"]')?.textContent).toContain("motivo");
    expect(mutaciones()).toHaveLength(0);
  });

  it("Invitar con datos validos: POST real con rol, sucursales y motivo; muestra el enlace una sola vez y recarga la lista", async () => {
    let n = 0;
    stub(
      () => json(++n === 1 ? VACIO : CON_EQUIPO),
      (url, init) => (url === BASE && init?.method === "POST" ? json(RESULTADO, 201) : undefined),
    );
    rendered = render();
    await esperar();
    click(boton(rendered.container, "Invitar"));
    await esperar();
    const d = dialogo();
    changeValue(d.querySelector("#equipo-email") as HTMLInputElement, " dueno@lostaquitos.mx ");
    changeValue(d.querySelector("#equipo-rol") as HTMLSelectElement, "staff");
    const casillas = [...d.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(casillas).toHaveLength(2);
    click(casillas[0]!);
    changeValue(d.querySelector("#equipo-motivo") as HTMLTextAreaElement, MOTIVO);
    await submitForm(d.querySelector("form")!);
    await esperar();

    const post = mutaciones()[0]!;
    expect(post[0]).toBe(BASE);
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ email: "dueno@lostaquitos.mx", verticalRole: "staff", propertyIds: [SUC_1], motivo: MOTIVO });
    const aviso = rendered.container.querySelector('[data-testid="enlace-activacion"]')!;
    expect((aviso.querySelector("input") as HTMLInputElement).value).toBe(RESULTADO.acceptUrl);
    expect(aviso.textContent).toContain("una sola vez");
    expect(aviso.textContent).toContain("encolado");
    expect(rendered.container.textContent).toContain("Miembros · 1");
    click(boton(aviso, "Listo"));
    expect(rendered.container.querySelector('[data-testid="enlace-activacion"]')).toBeNull();
  });

  it("sin sucursales marcadas no se manda propertyIds (acceso a todas)", async () => {
    stub(() => json(VACIO), (url, init) => (url === BASE && init?.method === "POST" ? json(RESULTADO, 201) : undefined));
    rendered = render();
    await esperar();
    click(boton(rendered.container, "Invitar"));
    await esperar();
    const d = dialogo();
    changeValue(d.querySelector("#equipo-email") as HTMLInputElement, "dueno@lostaquitos.mx");
    changeValue(d.querySelector("#equipo-motivo") as HTMLTextAreaElement, MOTIVO);
    await submitForm(d.querySelector("form")!);
    await esperar();
    expect(JSON.parse(String((mutaciones()[0]![1] as RequestInit).body))).toEqual({ email: "dueno@lostaquitos.mx", verticalRole: "owner", motivo: MOTIVO });
  });

  it("segundo owner: con owner existente exige confirmar antes de enviar; con la casilla manda confirmarSegundoOwner", async () => {
    stub(() => json(CON_EQUIPO), (url, init) => (url === BASE && init?.method === "POST" ? json(RESULTADO, 201) : undefined));
    rendered = render();
    await esperar();
    click(boton(rendered.container, "Invitar"));
    await esperar();
    const d = dialogo();
    changeValue(d.querySelector("#equipo-email") as HTMLInputElement, "otro@lostaquitos.mx");
    changeValue(d.querySelector("#equipo-motivo") as HTMLTextAreaElement, MOTIVO);
    expect(d.textContent).toContain("Confirmo invitar a un segundo owner");
    await submitForm(d.querySelector("form")!);
    expect(d.querySelector('[role="alert"]')?.textContent).toContain("segundo owner");
    expect(mutaciones()).toHaveLength(0);
    const casilla = [...d.querySelectorAll('input[type="checkbox"]')].find((c) => c.closest("label")?.textContent?.includes("segundo owner")) as HTMLInputElement;
    click(casilla);
    await submitForm(d.querySelector("form")!);
    await esperar();
    expect(JSON.parse(String((mutaciones()[0]![1] as RequestInit).body))).toMatchObject({ confirmarSegundoOwner: true, verticalRole: "owner" });
  });

  it("un rechazo del servidor (409 correo ya miembro) se muestra en linea y el formulario sigue abierto", async () => {
    stub(() => json(VACIO), (url, init) => (url === BASE && init?.method === "POST" ? json({ code: "conflict", message: "ese correo ya es miembro de la organizacion" }, 409) : undefined));
    rendered = render();
    await esperar();
    click(boton(rendered.container, "Invitar"));
    await esperar();
    const d = dialogo();
    changeValue(d.querySelector("#equipo-email") as HTMLInputElement, "ya@lostaquitos.mx");
    changeValue(d.querySelector("#equipo-motivo") as HTMLTextAreaElement, MOTIVO);
    await submitForm(d.querySelector("form")!);
    await esperar();
    expect(dialogo().querySelector('[role="alert"]')?.textContent).toContain("ya es miembro");
    expect(rendered.container.querySelector('[data-testid="enlace-activacion"]')).toBeNull();
  });

  it("el servidor pide confirmar segundo owner (409 segundo_owner_requiere_confirmacion): aparece la casilla", async () => {
    stub(() => json(VACIO), (url, init) => (url === BASE && init?.method === "POST" ? json({ code: "segundo_owner_requiere_confirmacion", message: "La organización ya tiene un owner: confirma." }, 409) : undefined));
    rendered = render();
    await esperar();
    click(boton(rendered.container, "Invitar"));
    await esperar();
    const d = dialogo();
    expect(d.textContent).not.toContain("segundo owner");
    changeValue(d.querySelector("#equipo-email") as HTMLInputElement, "otro@lostaquitos.mx");
    changeValue(d.querySelector("#equipo-motivo") as HTMLTextAreaElement, MOTIVO);
    await submitForm(d.querySelector("form")!);
    await esperar();
    expect(dialogo().textContent).toContain("Confirmo invitar a un segundo owner");
  });

  it("Reenviar: Cancelar no llama; con motivo hace POST .../reenviar y muestra el enlace nuevo", async () => {
    stub(() => json(CON_EQUIPO), (url, init) => (url === `${BASE}/i1/reenviar` && init?.method === "POST" ? json(RESULTADO) : undefined));
    rendered = render();
    await esperar();
    click(boton(rendered.container.querySelector('[data-invitacion="i1"]')!, "Reenviar"));
    await esperar();
    click(boton(confirm(), "Cancelar"));
    await esperar();
    expect(mutaciones()).toHaveLength(0);

    click(boton(rendered.container.querySelector('[data-invitacion="i1"]')!, "Reenviar"));
    await esperar();
    const enviar = () => click([...confirm().querySelectorAll("button")].find((b) => b.textContent === "Reenviar")!);
    enviar();
    await esperar();
    expect(mutaciones()).toHaveLength(0); // sin motivo no sale
    changeValue(confirm().querySelector("textarea")!, MOTIVO);
    enviar();
    await esperar();
    expect(mutaciones()).toHaveLength(1);
    expect(JSON.parse(String((mutaciones()[0]![1] as RequestInit).body))).toEqual({ motivo: MOTIVO });
    expect(rendered.container.querySelector('[data-testid="enlace-activacion"]')).not.toBeNull();
  });

  it("Revocar: pide motivo y hace DELETE de esa invitacion; Cancelar no llama", async () => {
    stub(() => json(CON_EQUIPO), (url, init) => (url === `${BASE}/i2` && init?.method === "DELETE" ? json({ ok: true, id: "i2" }) : undefined));
    rendered = render();
    await esperar();
    click(boton(rendered.container.querySelector('[data-invitacion="i2"]')!, "Revocar"));
    await esperar();
    click(boton(confirm(), "Cancelar"));
    await esperar();
    expect(mutaciones()).toHaveLength(0);

    click(boton(rendered.container.querySelector('[data-invitacion="i2"]')!, "Revocar"));
    await esperar();
    changeValue(confirm().querySelector("textarea")!, MOTIVO);
    click([...confirm().querySelectorAll("button")].find((b) => b.textContent === "Revocar")!);
    await esperar();
    expect(mutaciones()).toHaveLength(1);
    expect((mutaciones()[0]![1] as RequestInit).method).toBe("DELETE");
    expect(JSON.parse(String((mutaciones()[0]![1] as RequestInit).body))).toEqual({ motivo: MOTIVO });
  });

  it("base sin la migracion: aviso honesto, sin boton Invitar", async () => {
    stub(() => json({ disponible: false, mensaje: "El alta de equipo todavía no está disponible en este despliegue (falta aplicar la migración 0053_superadmin_alta_equipo).", miembros: [], invitaciones: [], sucursales: [] }));
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("falta aplicar la migración 0053");
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Invitar"))).toBe(false);
  });

  it("error de carga: estado de error con Reintentar que vuelve a pedir", async () => {
    let n = 0;
    stub(() => (++n === 1 ? json({ message: "x" }, 500) : json(CON_EQUIPO)));
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar el equipo");
    click(boton(rendered.container, "Reintentar"));
    await esperar();
    expect(rendered.container.textContent).toContain("Miembros · 1");
  });
});
