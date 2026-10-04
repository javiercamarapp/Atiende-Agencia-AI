// @vitest-environment jsdom
//
// H-42 -- paginas PUBLICAS de reserva directa del hotel (/hoteles/:orgSlug/reservar y /reservar/estado/:token), con la red simulada por ruta real
// (contrato: apps/api/src/routes/verticals/hoteles/reservar-publico.ts). Cubre: pagina limpia sin menu, buscar -> cotizar -> reservar, validacion previa,
// precio cambiado (409) vuelve a cotizar, pago pendiente honesto, base sin migrar, estado por token (sin enumeracion) y cancelacion con confirmacion.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReservarPage, validarHuesped } from "../src/verticals/hoteles/reservar-publico/ReservarPage.tsx";
import { EstadoReservaPage } from "../src/verticals/hoteles/reservar-publico/EstadoReservaPage.tsx";
import { ReservarError, crearClienteReservar, pesos } from "../src/verticals/hoteles/reservar-publico/cliente.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const API = "https://api.test";
const BASE = `${API}/v1/hoteles/demo/reservar`;
const PROP = { slug: "centro", nombre: "Hotel Centro", reservaEnLinea: true, anticipoPct: 0.3, maxHuespedes: 4, maxNoches: 14, cancelacion: { ventanaGratisHoras: 48, penalidadPct: 0.25 } };
const OPCION = { tipoHabitacionId: "11111111-1111-4111-8111-111111111111", nombre: "Doble", maxOcupacion: 2, disponible: true, motivo: null, desdePorNocheCentavos: 100000, totalCentavos: 238000 };
const COT = {
  quoteToken: "q1.eyJ0b3QiOjIzODAwMH0.firma-de-prueba-123456",
  venceEn: "2026-10-04T00:15:00.000Z",
  propiedad: { slug: "centro", nombre: "Hotel Centro" },
  tipoHabitacion: { id: OPCION.tipoHabitacionId, nombre: "Doble" },
  llegada: "2026-10-10",
  salida: "2026-10-12",
  noches: 2,
  huespedes: 2,
  cotizacion: { netoCentavos: 200000, ivaCentavos: 32000, ishCentavos: 6000, totalCentavos: 238000 },
  anticipo: { porcentaje: 0.3, centavos: 71400, requerido: true },
  cancelacion: { gratisHasta: "2026-10-08T00:00:00.000Z", penalidadPct: 0.25 },
};
const VISTA = {
  estado: "confirmada",
  hotel: "Hotel Centro",
  tipoHabitacion: "Doble",
  llegada: "2026-10-10",
  salida: "2026-10-12",
  noches: 2,
  huespedes: 2,
  totalCentavos: 238000,
  anticipoCentavos: 71400,
  pago: { estado: "capturado", reembolso: null },
  vigenteHasta: null,
  cancelable: true,
  cancelacion: { gratisHasta: "2026-10-08T00:00:00.000Z", penalidadPct: 0.25, siCancelasAhora: { penalidadCents: 0, reembolsoCents: 71400 }, resultado: null },
};

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
type Ruta = (url: string, init?: RequestInit) => Response | undefined;
function stub(...rutas: Ruta[]) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    for (const r of rutas) {
      const res = r(url, init);
      if (res) return res;
    }
    throw new Error(`fetch inesperado: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const config: Ruta = (url, init) => ((init?.method ?? "GET") === "GET" && url === BASE ? json({ disponible: true, hotel: { nombre: "Hotel Demo" }, propiedades: [PROP] }) : undefined);
const disp: Ruta = (url) => (url.startsWith(`${BASE}/disponibilidad?`) ? json({ disponible: true, reservaEnLinea: true, propiedad: { slug: "centro", nombre: "Hotel Centro" }, llegada: "2026-10-10", salida: "2026-10-12", noches: 2, huespedes: 2, anticipoPct: 0.3, opciones: [OPCION] }) : undefined);
const cotiza: Ruta = (url, init) => (init?.method === "POST" && url === `${BASE}/cotizacion` ? json(COT) : undefined);

function montarReservar() {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/hoteles/demo/reservar"]}>
      <Routes>
        <Route path="/hoteles/:orgSlug/reservar" element={<ReservarPage apiBaseUrl={API} orgSlug="demo" />} />
      </Routes>
    </MemoryRouter>,
  );
}
async function hastaFormulario() {
  montarReservar();
  await esperar();
  await submitForm(q<HTMLFormElement>('form[aria-label="Buscar disponibilidad"]'));
  await esperar();
  click(boton("Cotizar"));
  await esperar();
}
async function llenar(extra: { acepta?: boolean } = {}) {
  changeValue(q<HTMLInputElement>("#rp-nombre"), "Ana Torres");
  changeValue(q<HTMLInputElement>("#rp-telefono"), "999 123 4567");
  changeValue(q<HTMLInputElement>("#rp-correo"), "ana@example.com");
  if (extra.acepta !== false) click(q<HTMLInputElement>('input[type="checkbox"]'));
  await esperar();
}

describe("ReservarPage", () => {
  it("es una pagina limpia sin menu de panel: solo barra superior, el flujo y el aviso de privacidad", async () => {
    stub(config);
    montarReservar();
    await esperar();
    expect(texto()).toContain("Reserva directa");
    expect(texto()).toContain("Hotel Demo");
    expect(rendered!.container.querySelector("nav, aside")).toBeNull();
    expect(q<HTMLAnchorElement>('a[href="/hoteles/demo/aviso"]')).toBeTruthy();
  });

  it("buscar -> cotizar muestra el desglose y el anticipo que mando el servidor, y no hay campo de tarjeta", async () => {
    stub(config, disp, cotiza);
    await hastaFormulario();
    expect(texto()).toContain("Desde");
    expect(texto()).toContain(pesos(238000));
    expect(texto()).toContain(pesos(71400));
    expect(texto()).toContain("pago pendiente");
    expect(rendered!.container.querySelector('input[autocomplete="cc-number"]')).toBeNull();
    const consulta = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/disponibilidad?"))!;
    expect(consulta).toContain("llegada=");
    expect(consulta).toContain("huespedes=2");
  });

  it("valida en el navegador antes de enviar y exige aceptar el aviso", async () => {
    stub(config, disp, cotiza);
    await hastaFormulario();
    await submitForm(q<HTMLFormElement>('form[aria-label="Confirmar reserva"]'));
    await esperar();
    expect(texto()).toContain("Escribe tu nombre completo.");
    expect(texto()).toContain("Debes aceptar el aviso de privacidad");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/confirmar"))).toBe(false);
    expect(validarHuesped({ nombre: "Ana Torres", telefono: "999 123 4567", correo: "ana@example.com" }, true)).toEqual({});
  });

  it("reservar manda quoteToken, huesped, consentimiento y Idempotency-Key; el servidor responde pago pendiente (202) y se muestra honesto con el enlace de estado", async () => {
    stub(config, disp, cotiza, (url, init) =>
      init?.method === "POST" && url === `${BASE}/confirmar`
        ? json({ rastreoToken: "tok-abc", ...VISTA, estado: "pago_pendiente", pago: { estado: "pendiente", reembolso: null, requiereAccion: "El hotel te contactará para registrar tu anticipo." }, vigenteHasta: "2026-10-04T01:00:00.000Z" }, 202)
        : undefined,
    );
    await hastaFormulario();
    await llenar();
    await submitForm(q<HTMLFormElement>('form[aria-label="Confirmar reserva"]'));
    await esperar();
    const llamada = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/confirmar"))!;
    const init = llamada[1] as RequestInit;
    const cuerpo = JSON.parse(String(init.body));
    expect(cuerpo).toMatchObject({ quoteToken: COT.quoteToken, consentimientoAviso: true, huesped: { nombre: "Ana Torres", correo: "ana@example.com" } });
    expect(cuerpo).not.toHaveProperty("totalCentavos");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toMatch(/.{8,}/);
    expect(texto()).toContain("Reserva apartada");
    expect(texto()).toContain("Pago pendiente");
    expect(texto()).toContain("El hotel te contactará para registrar tu anticipo.");
    expect(q<HTMLAnchorElement>('a[href="/hoteles/demo/reservar/estado/tok-abc"]')).toBeTruthy();
  });

  it("si el precio cambio (409 precio_cambio) vuelve a pedir cotizacion en vez de reservar con un precio viejo", async () => {
    stub(config, disp, cotiza, (url, init) => (init?.method === "POST" && url === `${BASE}/confirmar` ? json({ code: "precio_cambio", message: "El precio cambió.", totalCentavos: 285600 }, 409) : undefined));
    await hastaFormulario();
    await llenar();
    await submitForm(q<HTMLFormElement>('form[aria-label="Confirmar reserva"]'));
    await esperar();
    expect(texto()).toContain("Tu cotización cambió o venció");
    expect(rendered!.container.querySelector('form[aria-label="Confirmar reserva"]')).toBeNull();
  });

  it("base sin migrar o hotel sin reserva en linea: lo dice, sin inventar disponibilidad", async () => {
    stub((url) => (url === BASE ? json({ disponible: false, motivo: "La reserva en linea aun no esta disponible: falta aplicar la migracion 044 en esta base." }) : undefined));
    montarReservar();
    await esperar();
    expect(texto()).toContain("No disponible aún");
    expect(rendered!.container.querySelector("form")).toBeNull();
  });

  it("hotel inexistente (404) muestra un vacio, no un error tecnico", async () => {
    stub((url) => (url === BASE ? json({ code: "no_encontrado", message: "Hotel no encontrado." }, 404) : undefined));
    montarReservar();
    await esperar();
    expect(texto()).toContain("No encontramos ese hotel");
  });
});

describe("EstadoReservaPage", () => {
  function montarEstado(token = "tok-abc") {
    rendered = renderComponent(
      <MemoryRouter initialEntries={[`/hoteles/demo/reservar/estado/${token}`]}>
        <Routes>
          <Route path="/hoteles/:orgSlug/reservar/estado/:token" element={<EstadoReservaPage apiBaseUrl={API} orgSlug="demo" token={token} />} />
        </Routes>
      </MemoryRouter>,
    );
  }
  it("muestra la reserva, y cancelar pide confirmacion, muestra la prevision del servidor y manda Idempotency-Key con cuerpo vacio", async () => {
    stub(
      (url, init) => ((init?.method ?? "GET") === "GET" && url === `${BASE}/estado/tok-abc` ? json(VISTA) : undefined),
      (url, init) => (init?.method === "POST" && url === `${BASE}/estado/tok-abc/cancelar` ? json({ ...VISTA, estado: "cancelada", cancelable: false, pago: { estado: "capturado", reembolso: "procesado" }, cancelacion: { ...VISTA.cancelacion, siCancelasAhora: null, resultado: { penalidadCentavos: 0, reembolsoCentavos: 71400 } } }) : undefined),
    );
    montarEstado();
    await esperar();
    expect(texto()).toContain("Confirmada");
    expect(texto()).toContain(pesos(238000));
    click(boton("Cancelar reserva"));
    await esperar();
    expect(texto()).toContain(`reembolso ${pesos(71400)}`);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/cancelar"))).toBe(false);
    click(boton("Sí, cancelar"));
    await esperar();
    const llamada = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/cancelar"))!;
    expect(JSON.parse(String((llamada[1] as RequestInit).body))).toEqual({});
    expect(((llamada[1] as RequestInit).headers as Record<string, string>)["idempotency-key"]).toMatch(/.{8,}/);
    expect(texto()).toContain("Cancelada");
    expect(texto()).toContain("El reembolso ya fue procesado.");
    expect(boton("Cancelar reserva")).toBeUndefined();
  });
  it("token invalido: mensaje uniforme sin detalles", async () => {
    stub((url) => (url.includes("/estado/") ? json({ code: "no_encontrado", message: "No encontramos esa reserva." }, 404) : undefined));
    montarEstado("malo");
    await esperar();
    expect(texto()).toContain("No encontramos esa reserva");
  });
  it("si cancelar falla muestra el error del servidor y deja reintentar", async () => {
    stub(
      (url, init) => ((init?.method ?? "GET") === "GET" ? json(VISTA) : undefined),
      (url, init) => (init?.method === "POST" ? json({ code: "x", message: "El hotel no pudo procesar la cancelación." }, 500) : undefined),
    );
    montarEstado();
    await esperar();
    click(boton("Cancelar reserva"));
    await esperar();
    click(boton("Sí, cancelar"));
    await esperar();
    expect(texto()).toContain("El hotel no pudo procesar la cancelación.");
    expect(boton("Sí, cancelar")).toBeTruthy();
  });
});

describe("cliente de reserva directa", () => {
  it("confirmar con 503 y rastreoToken devuelve la reserva apartada; sin token lanza ReservarError con el codigo", async () => {
    const f1 = vi.fn(async () => json({ rastreoToken: "t", ...VISTA, estado: "pago_pendiente", code: "pago_no_disponible", message: "El cobro en línea no está disponible por ahora." }, 503)) as unknown as typeof fetch;
    const r = await crearClienteReservar(f1, API, "demo").confirmar({ quoteToken: COT.quoteToken, huesped: { nombre: "Ana Torres", telefono: "9991234567", correo: "a@b.co" } }, "clave-12345");
    expect(r).toMatchObject({ rastreoToken: "t", code: "pago_no_disponible", httpStatus: 503 });
    const f2 = vi.fn(async () => json({ code: "sin_disponibilidad", message: "Ya no hay habitaciones." }, 409)) as unknown as typeof fetch;
    await expect(crearClienteReservar(f2, API, "demo").confirmar({ quoteToken: COT.quoteToken, huesped: { nombre: "Ana", telefono: "1", correo: "a@b.co" } }, "clave-12345")).rejects.toMatchObject({ status: 409, code: "sin_disponibilidad" });
    const f3 = vi.fn(async () => json({}, 429)) as unknown as typeof fetch;
    await expect(crearClienteReservar(f3, API, "demo").estado("t")).rejects.toBeInstanceOf(ReservarError);
  });
});
