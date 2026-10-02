// @vitest-environment jsdom
//
// H-30 -- paginas PUBLICAS de privacidad del huesped de hoteles: aviso + ARCO sin login (/hoteles/:orgSlug/aviso) y "mis datos" con
// enlace firmado (/hoteles/:orgSlug/mis-datos). `fetch` mockeado por ruta real contra apps/api/.../hoteles/privacidad-publica.ts.
// Cubre estados (cargando, no encontrado, base sin migrar, sin aviso publicado, varias propiedades), el flujo formulario -> codigo ->
// confirmada, el honeypot, el aviso honesto de correo sin configurar y que "mis datos" nunca pide ni muestra datos que no le tocan.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvisoPublicoPage } from "../src/verticals/hoteles/privacidad-publica/AvisoPublicoPage.tsx";
import { MisDatosPage, tokenDeFragmento } from "../src/verticals/hoteles/privacidad-publica/MisDatosPage.tsx";
import { PrivacidadPublicaError, crearClientePrivacidadPublica } from "../src/verticals/hoteles/privacidad-publica/cliente.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

const API = "https://api.test";
const AVISO = {
  version: "v3",
  textoSimplificado: "Usamos tus datos para identificarte y facturar.",
  urlIntegral: "https://hotel.example.com/aviso",
  finalidadesObligatorias: ["identificar al huesped"],
  finalidadesOpcionales: ["promociones"],
  publicadoEn: "2026-09-01T10:00:00.000Z",
};
const CENTRO = { propiedad: { slug: "centro", nombre: "Hotel Centro" }, aviso: AVISO };
const PLAYA = { propiedad: { slug: "playa", nombre: "Hotel Playa" }, aviso: null };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const texto = () => rendered!.container.textContent ?? "";
const q = <T extends Element>(sel: string) => rendered!.container.querySelector<T>(sel) as T;
const boton = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement;

function montarAviso(propiedades: unknown[], entrada = "/hoteles/demo/aviso") {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[entrada]}>
      <Routes>
        <Route path="/hoteles/:orgSlug/aviso" element={<AvisoPublicoPage apiBaseUrl={API} orgSlug="demo" />} />
      </Routes>
    </MemoryRouter>,
  );
  return propiedades;
}
function stubAviso(respuesta: unknown, status = 200, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const otro = extra(url, init);
    if (otro) return otro;
    if ((init?.method ?? "GET") === "GET" && url.startsWith(`${API}/v1/hoteles/demo/privacidad`)) return json(respuesta, status);
    throw new Error(`fetch inesperado: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("AvisoPublicoPage", () => {
  it("muestra el aviso vigente sin login: version, finalidades, aviso integral y el enlace copiable; avisa que no genera QR", async () => {
    stubAviso({ disponible: true, hotel: { nombre: "Hotel Demo" }, propiedades: [CENTRO] });
    montarAviso([CENTRO]);
    await esperar();
    expect(texto()).toContain("Aviso de privacidad");
    expect(texto()).toContain("Hotel Demo");
    expect(texto()).toContain("Usamos tus datos para identificarte y facturar.");
    expect(texto()).toContain("Versión v3");
    expect(texto()).toContain("identificar al huesped");
    expect(texto()).toContain("promociones");
    expect(q<HTMLAnchorElement>('a[href="https://hotel.example.com/aviso"]').rel).toContain("noopener");
    expect(q<HTMLInputElement>('input[aria-label="Enlace del aviso"]').value).toMatch(/\/hoteles\/demo\/aviso$/);
    expect(texto()).toContain("aún no genera códigos QR");
    expect(fetchMock.mock.calls[0]![1]?.headers).toBeUndefined(); // sin Authorization: es publico
  });
  it("la propiedad sin aviso publicado se dice honestamente", async () => {
    stubAviso({ disponible: true, hotel: { nombre: "Hotel Demo" }, propiedades: [PLAYA] });
    montarAviso([PLAYA]);
    await esperar();
    expect(texto()).toContain("aún no publica su aviso de privacidad en línea");
  });
  it("con varias propiedades y sin ?property pide elegir; ?property filtra la consulta", async () => {
    stubAviso({ disponible: true, hotel: { nombre: "Hotel Demo" }, propiedades: [CENTRO, PLAYA] });
    montarAviso([CENTRO, PLAYA]);
    await esperar();
    expect(texto()).toContain("Elige la propiedad");
    expect(q<HTMLAnchorElement>('a[href="/hoteles/demo/aviso?property=centro"]')).toBeTruthy();
    rendered!.unmount();
    stubAviso({ disponible: true, hotel: { nombre: "Hotel Demo" }, propiedades: [CENTRO] });
    montarAviso([CENTRO], "/hoteles/demo/aviso?property=centro");
    await esperar();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${API}/v1/hoteles/demo/privacidad?property=centro`);
  });
  it("base sin la migracion: 'No disponible aún'; hotel inexistente: mensaje; error de red: reintentar", async () => {
    stubAviso({ disponible: false, motivo: "La privacidad publica aun no esta disponible en esta base: falta aplicar la migracion 042." });
    montarAviso([]);
    await esperar();
    expect(texto()).toContain("No disponible aún");
    expect(texto()).toContain("migracion 042");
    rendered!.unmount();
    stubAviso({ message: "Hotel no encontrado." }, 404);
    montarAviso([]);
    await esperar();
    expect(texto()).toContain("No encontramos ese hotel");
    rendered!.unmount();
    stubAviso({ message: "boom" }, 500);
    montarAviso([]);
    await esperar();
    expect(texto()).toContain("boom");
    expect(boton("Reintentar")).toBeTruthy();
  });

  it("flujo completo: formulario -> codigo -> solicitud confirmada con folio; el correo sin configurar se avisa", async () => {
    stubAviso({ disponible: true, hotel: { nombre: "Hotel Demo" }, propiedades: [CENTRO] }, 200, (url, init) => {
      if (init?.method === "POST" && url.endsWith("/solicitud")) return json({ ok: true, referencia: "00000000-0000-4000-8000-000000000001", mensaje: "Si el correo es valido, te enviamos un codigo.", venceEnMinutos: 15, envioDeCorreo: "pendiente_de_configuracion" }, 202);
      if (init?.method === "POST" && url.endsWith("/solicitud/verificar")) return json({ ok: true, folio: "ARCO-20261002-ABC123", mensaje: "Solicitud confirmada." });
      return undefined;
    });
    montarAviso([CENTRO]);
    await esperar();
    changeValue(q<HTMLInputElement>("#arco-pub-nombre"), "Ana Torres");
    changeValue(q<HTMLInputElement>("#arco-pub-correo"), "ana@example.com");
    changeValue(q<HTMLSelectElement>("#arco-pub-derecho"), "cancelacion");
    await submitForm(q<HTMLFormElement>('form[aria-label="Solicitud de derechos ARCO"]'));
    await esperar();
    const alta = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/solicitud"))!;
    expect(JSON.parse(String(alta[1].body))).toEqual({ derecho: "cancelacion", nombre: "Ana Torres", correo: "ana@example.com" });
    expect(texto()).toContain("El envío de correo aún no está activo");
    changeValue(q<HTMLInputElement>("#arco-pub-codigo"), "12ab34cd56");
    expect(q<HTMLInputElement>("#arco-pub-codigo").value).toBe("123456");
    await submitForm(q<HTMLFormElement>('form[aria-label="Confirmar solicitud con código"]'));
    await esperar();
    const ver = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/solicitud/verificar"))!;
    expect(JSON.parse(String(ver[1].body))).toEqual({ referencia: "00000000-0000-4000-8000-000000000001", codigo: "123456" });
    expect(texto()).toContain("Solicitud confirmada · ARCO-20261002-ABC123");
  });
  it("un codigo rechazado muestra el mensaje del servidor y deja reintentar; el honeypot viaja solo si un robot lo llena", async () => {
    stubAviso({ disponible: true, hotel: { nombre: "Hotel Demo" }, propiedades: [CENTRO] }, 200, (url, init) => {
      if (init?.method === "POST" && url.endsWith("/solicitud")) return json({ ok: true, referencia: "00000000-0000-4000-8000-000000000002", mensaje: "Te enviamos un codigo.", venceEnMinutos: 15, envioDeCorreo: "habilitado" }, 202);
      if (init?.method === "POST" && url.endsWith("/solicitud/verificar")) return json({ ok: false, message: "El codigo no es valido o ya vencio." }, 422);
      return undefined;
    });
    montarAviso([CENTRO]);
    await esperar();
    expect(q<HTMLInputElement>('input[name="sitioWeb"]').tabIndex).toBe(-1);
    changeValue(q<HTMLInputElement>("#arco-pub-nombre"), "Ana Torres");
    changeValue(q<HTMLInputElement>("#arco-pub-correo"), "ana@example.com");
    changeValue(q<HTMLInputElement>('input[name="sitioWeb"]'), "http://spam.example");
    await submitForm(q<HTMLFormElement>('form[aria-label="Solicitud de derechos ARCO"]'));
    await esperar();
    expect(JSON.parse(String(fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/solicitud"))![1].body)).sitioWeb).toBe("http://spam.example");
    expect(texto()).not.toContain("El envío de correo aún no está activo");
    changeValue(q<HTMLInputElement>("#arco-pub-codigo"), "000000");
    await submitForm(q<HTMLFormElement>('form[aria-label="Confirmar solicitud con código"]'));
    await esperar();
    expect(q<HTMLElement>('[role="alert"]').textContent).toContain("El codigo no es valido o ya vencio.");
    expect(q<HTMLInputElement>("#arco-pub-codigo")).toBeTruthy();
    click(boton("Empezar de nuevo"));
    expect(q<HTMLInputElement>("#arco-pub-nombre")).toBeTruthy();
  });
});

describe("MisDatosPage", () => {
  function montarMisDatos(hash: string) {
    window.history.pushState({}, "", `/hoteles/demo/mis-datos${hash}`);
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/hoteles/demo/mis-datos"]}>
        <Routes>
          <Route path="/hoteles/:orgSlug/mis-datos" element={<MisDatosPage apiBaseUrl={API} orgSlug="demo" />} />
        </Routes>
      </MemoryRouter>,
    );
  }
  it("lee el token del fragmento, lo manda por POST (nunca en la URL) y muestra solo perfil, estancias, consentimientos e identidad (estado)", async () => {
    fetchMock = vi.fn(async () =>
      json({
        folio: "ARCO-1",
        perfil: { nombre: "Ana Torres", correo: "ana@example.com", telefono: "5511112222" },
        estancias: [{ reservaId: "r1", entrada: "2026-03-01", salida: "2026-03-03", estado: "confirmada", tipoHabitacion: "Doble" }],
        consentimientos: [{ id: "k1", versionAviso: "v1", canal: "mostrador", consentidoEn: "2026-03-01T10:00:00Z", revocadoEn: null }],
        identidad: [{ id: "i1", tipoDocumento: "pasaporte", estado: "activo", conservarHasta: "2099-01-01" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    montarMisDatos("#token=m1.abc.def");
    await esperar();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${API}/v1/hoteles/demo/privacidad/mis-datos`);
    expect(String(url)).not.toContain("m1.abc.def");
    expect(JSON.parse(String(init.body))).toEqual({ token: "m1.abc.def" });
    expect(texto()).toContain("Ana Torres");
    expect(texto()).toContain("Doble");
    expect(texto()).toContain("pasaporte");
    expect(texto()).toContain("el documento de identidad nunca se muestra aquí");
    expect(texto()).not.toMatch(/notas|conversaci/i);
  });
  it("sin token en el fragmento no consulta la red; token invalido o vencido (404) = mismo aviso; error de red se muestra", async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    montarMisDatos("");
    await esperar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(texto()).toContain("No encontramos tus datos");
    rendered!.unmount();
    fetchMock = vi.fn(async () => json({ message: "El enlace no es valido o ya vencio." }, 404));
    vi.stubGlobal("fetch", fetchMock);
    montarMisDatos("#token=m1.x.y");
    await esperar();
    expect(texto()).toContain("No encontramos tus datos");
    rendered!.unmount();
    fetchMock = vi.fn(async () => json({ message: "falla temporal" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    montarMisDatos("#token=m1.x.y");
    await esperar();
    expect(texto()).toContain("falla temporal");
  });
  it("tokenDeFragmento decodifica y tolera otros parametros", () => {
    expect(tokenDeFragmento("#token=m1.a%2Bb.c")).toBe("m1.a+b.c");
    expect(tokenDeFragmento("#x=1&token=abc")).toBe("abc");
    expect(tokenDeFragmento("")).toBe("");
  });
});

describe("cliente de privacidad publica", () => {
  it("el 429 tiene un mensaje propio y un error del servidor conserva su mensaje real", async () => {
    const f = vi.fn(async () => json({ message: "Demasiadas solicitudes." }, 429));
    const c = crearClientePrivacidadPublica(f as unknown as typeof fetch, API, "demo");
    await expect(c.solicitar({ derecho: "acceso", nombre: "Ana", correo: "a@b.co" })).rejects.toMatchObject({ status: 429, message: expect.stringContaining("Espera un minuto") });
    const g = vi.fn(async () => json({ message: "correo: debe ser un correo valido." }, 400));
    await expect(crearClientePrivacidadPublica(g as unknown as typeof fetch, API, "demo").solicitar({ derecho: "acceso", nombre: "Ana", correo: "x" })).rejects.toBeInstanceOf(PrivacidadPublicaError);
  });
  it("codifica el slug del hotel en la URL", async () => {
    const f = vi.fn(async (_url: string) => json({ disponible: true, hotel: { nombre: null }, propiedades: [] }));
    await crearClientePrivacidadPublica(f as unknown as typeof fetch, API, "hotel demo/x").aviso();
    expect(String(f.mock.calls[0]![0])).toBe(`${API}/v1/hoteles/hotel%20demo%2Fx/privacidad`);
  });
});
