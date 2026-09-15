// @vitest-environment jsdom
//
// Smoke tests reales de <RentasRegistroPage /> -- hallazgo de auditoría (rubro 9,
// MEDIO: "0 tests de componentes React en todo el repo"). Es el ÚNICO formulario de
// onboarding/registro self-serve que existe hoy en apps/web entre las 4 verticales
// nombradas por el hallazgo (rentas/despachos/licitaciones/citas): despachos,
// licitaciones y citas solo tienen Login.tsx (correo+contraseña, sin registro) -- ver
// el reporte final de esta ronda para el detalle de por qué no hay nada que probar
// ahí. Esta pantalla cierra un hallazgo de severidad CRÍTICA propio ("el onboarding
// self-serve de rentas está bloqueado en producción y ni siquiera tiene pantalla",
// ver el comentario de cabecera de Registro.tsx) -- vale la pena protegerla con algo
// más que los "*-client.spec.ts" que ya cubren `registrarTenant` en aislado.
//
// `registrarTenant` se mockea (nunca se toca red real): lo que se prueba aquí es que
// EL COMPONENTE arma el payload correcto a partir de lo que el usuario tipeó, y que
// reacciona correctamente a éxito/error -- no el contrato HTTP, que ya cubre
// apps/web/tests/rentas-onboarding-client.spec.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RentasRegistroPage } from "../src/verticals/rentas/pages/Registro.tsx";
import { OnboardingError } from "../src/verticals/rentas/lib/onboarding-client.ts";
import type { RegistroTenantInput, RegistroTenantResultado } from "../src/verticals/rentas/lib/onboarding-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

const registrarTenantMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, input: RegistroTenantInput) => Promise<RegistroTenantResultado>>();

vi.mock("../src/verticals/rentas/lib/onboarding-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/rentas/lib/onboarding-client.ts")>();
  return { ...actual, registrarTenant: (...args: Parameters<typeof registrarTenantMock>) => registrarTenantMock(...args) };
});

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  registrarTenantMock.mockReset();
});

function byId<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const el = root.querySelector(`#${id}`);
  if (!el) throw new Error(`No se encontró #${id}`);
  return el as T;
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <RentasRegistroPage apiBaseUrl="https://api.test" />
    </MemoryRouter>,
  );
}

function llenarFormularioMinimo(root: HTMLElement) {
  changeValue(byId(root, "organizacionNombre"), "Casas del Sol");
  changeValue(byId(root, "propiedadNombre"), "Edificio Marina");
  changeValue(byId(root, "adminNombreCompleto"), "Ana Torres");
  changeValue(byId(root, "adminCorreo"), "ana@example.com");
  changeValue(byId(root, "adminPassword"), "unaClaveDe10+");
  const unidadInput = root.querySelector('fieldset input[placeholder="Ej. Depa 101"]') as HTMLInputElement;
  changeValue(unidadInput, "Depa 101");
}

describe("RentasRegistroPage", () => {
  it("renderiza los campos obligatorios del formulario, con exactamente una unidad al inicio y 'Quitar' deshabilitado", () => {
    rendered = renderPage();
    const root = rendered.container;
    expect(byId(root, "organizacionNombre")).toBeInstanceOf(HTMLInputElement);
    expect(byId(root, "propiedadNombre")).toBeInstanceOf(HTMLInputElement);
    expect(byId(root, "adminNombreCompleto")).toBeInstanceOf(HTMLInputElement);
    expect(byId(root, "adminCorreo")).toBeInstanceOf(HTMLInputElement);
    expect(byId(root, "adminPassword")).toBeInstanceOf(HTMLInputElement);
    const quitarButtons = [...root.querySelectorAll("button")].filter((b) => b.textContent === "Quitar");
    expect(quitarButtons).toHaveLength(1);
    expect(quitarButtons[0]!.disabled).toBe(true);
  });

  it("'Empresa gestora' revela el campo del propietario, y escribir un nombre ahí revela también el correo del propietario", () => {
    rendered = renderPage();
    const root = rendered.container;
    expect(root.querySelector("#primerOwnerNombre")).toBeNull();
    changeValue(byId(root, "tipoOrganizacion"), "empresa_gestora");
    expect(root.querySelector("#primerOwnerNombre")).not.toBeNull();
    expect(root.querySelector("#primerOwnerEmail")).toBeNull();
    changeValue(byId(root, "primerOwnerNombre"), "Dueño Real");
    expect(root.querySelector("#primerOwnerEmail")).not.toBeNull();
  });

  it("agregar una unidad habilita 'Quitar' en ambas filas; quitar una la deja en 1 fila con 'Quitar' deshabilitado otra vez", () => {
    rendered = renderPage();
    const root = rendered.container;
    click([...root.querySelectorAll("button")].find((b) => b.textContent === "+ Agregar otra unidad")!);
    let quitarButtons = [...root.querySelectorAll("button")].filter((b) => b.textContent === "Quitar");
    expect(quitarButtons).toHaveLength(2);
    expect(quitarButtons.every((b) => !b.disabled)).toBe(true);

    click(quitarButtons[0]!);
    quitarButtons = [...root.querySelectorAll("button")].filter((b) => b.textContent === "Quitar");
    expect(quitarButtons).toHaveLength(1);
    expect(quitarButtons[0]!.disabled).toBe(true);
  });

  it("al enviar, arma el payload real (fetchImpl, apiBaseUrl, e input tal como lo tipeó el usuario) y llama a registrarTenant una sola vez", async () => {
    registrarTenantMock.mockResolvedValue({ organizationId: "org-1", propertyId: "prop-1", staffId: "staff-1", slug: "casas-del-sol", unidadIds: ["u-1"], requiereVerificacionCorreo: true });
    rendered = renderPage();
    const root = rendered.container;
    llenarFormularioMinimo(root);
    const form = root.querySelector("form")!;
    await submitForm(form);

    expect(registrarTenantMock).toHaveBeenCalledTimes(1);
    const [, apiBaseUrl, input] = registrarTenantMock.mock.calls[0]!;
    expect(apiBaseUrl).toBe("https://api.test");
    expect(input).toMatchObject({
      organizacionNombre: "Casas del Sol",
      tipoOrganizacion: "anfitrion",
      propiedadNombre: "Edificio Marina",
      adminNombreCompleto: "Ana Torres",
      adminCorreo: "ana@example.com",
      adminPassword: "unaClaveDe10+",
      unidades: [{ nombre: "Depa 101" }],
      // 'anfitrion' -> el componente NUNCA manda datos de propietario, aunque
      // los campos de owner existan en el estado interno.
      primerOwnerNombre: undefined,
      primerOwnerEmail: undefined,
    });
  });

  it("mientras la promesa de registrarTenant sigue pendiente, el botón de submit queda deshabilitado y dice 'Creando cuenta…'", async () => {
    let resolvePromise!: (v: RegistroTenantResultado) => void;
    registrarTenantMock.mockReturnValue(new Promise((resolve) => { resolvePromise = resolve; }));
    rendered = renderPage();
    const root = rendered.container;
    llenarFormularioMinimo(root);
    await submitForm(root.querySelector("form")!);

    const submitButton = [...root.querySelectorAll('button[type="submit"]')][0] as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(submitButton.textContent).toBe("Creando cuenta…");

    const { act } = await import("react");
    await act(async () => {
      resolvePromise({ organizationId: "org-1", propertyId: "prop-1", staffId: "staff-1", slug: "s", unidadIds: ["u-1"], requiereVerificacionCorreo: true });
      await flushMicrotasks();
    });
  });

  it("en éxito, cambia a la pantalla 'Tu cuenta se creó' con el nombre de la organización/propiedad y el conteo real de unidades", async () => {
    registrarTenantMock.mockResolvedValue({ organizationId: "org-1", propertyId: "prop-1", staffId: "staff-1", slug: "s", unidadIds: ["u-1", "u-2"], requiereVerificacionCorreo: true });
    rendered = renderPage();
    const root = rendered.container;
    llenarFormularioMinimo(root);
    await submitForm(root.querySelector("form")!);

    expect(root.textContent).toContain("Tu cuenta se creó");
    expect(root.textContent).toContain("Casas del Sol");
    expect(root.textContent).toContain("Edificio Marina");
    expect(root.textContent).toContain("2");
    expect(root.textContent).toContain("unidades");
    // Honestidad del mensaje post-registro (ver comentario de cabecera del
    // componente): NUNCA promete un correo de verificación que no se manda.
    expect(root.textContent).toContain("ana@example.com");
  });

  it("en error, muestra el mensaje real de OnboardingError en role=alert y reactiva el botón de submit (nunca se queda atorado en 'Creando cuenta…')", async () => {
    registrarTenantMock.mockRejectedValue(new OnboardingError("Ya existe una cuenta con ese correo."));
    rendered = renderPage();
    const root = rendered.container;
    llenarFormularioMinimo(root);
    await submitForm(root.querySelector("form")!);

    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Ya existe una cuenta con ese correo.");
    const submitButton = [...root.querySelectorAll('button[type="submit"]')][0] as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
    expect(submitButton.textContent).toBe("Crear mi cuenta");
    // Sigue en el formulario, NO saltó a la pantalla de éxito.
    expect(root.textContent).not.toContain("Tu cuenta se creó");
  });
});
