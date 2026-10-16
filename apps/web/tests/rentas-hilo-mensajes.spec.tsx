// @vitest-environment jsdom
//
// Rn-P3-20/21/22 -- el hilo de una conversación dentro de Aprobaciones y los filtros de la bandeja.
//   - Hilo: mensajes entrantes y salientes en orden con su origen; el texto del huésped como TEXTO (nunca HTML); marca de
//     contenido redactado; cada borrador junto al mensaje que responde; insignia «Requiere atención humana» con su señal;
//     «Generar borrador» por mensaje entrante sin borrador pendiente; aviso de política del canal; estados cargando/vacío/error;
//     Cancelar en «Rechazar» no ejecuta nada.
//   - Bandeja: filtros por canal, «con pendientes», «requiere atención» y búsqueda, con su estado en la URL; los escalados primero.
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AprobacionesPage } from "../src/verticals/rentas/pages/Aprobaciones.tsx";
import { HiloPage } from "../src/verticals/rentas/pages/aprobaciones/Hilo.tsx";
import type { RentasShellContext } from "../src/verticals/rentas/RentasShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function ctxConRol(rol: string): RentasShellContext {
  return {
    apiBaseUrl: "https://api.test",
    token: "tok-123",
    propertyId: "prop-1",
    setPropertyId: () => {},
    properties: [{ propertyId: "prop-1", nombre: "Depa Marina" }],
    orgSlug: "demo",
    session: { token: "tok-123", refreshToken: "ref", email: "g@example.com", organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "rentas", rol }] },
  };
}

const res = (body: unknown, ok = true, status = ok ? 200 : 400): Response => ({ ok, status, json: async () => body }) as unknown as Response;

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}

const mutaciones = () => fetchMock.mock.calls.filter(([, init]) => ["POST", "DELETE", "PATCH"].includes((init as RequestInit | undefined)?.method ?? "GET"));
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const botones = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === texto);

const MSG_BASE = { conversacionId: "c1", redactado: false };
const BORRADOR_BASE = {
  conversacionId: "c1", mensajeEntranteId: null, canal: "airbnb", texto: "Respuesta propuesta", estado: "pendiente_aprobacion", generadoPor: "motor_borrador", redactado: false, necesitaEscalamiento: false, senales: [],
  aprobadoPor: null, aprobadoEn: null, rechazadoPor: null, rechazadoEn: null, motivoRechazo: null, mensajeEnviadoId: null, creadoEn: "2026-10-01T10:05:00Z", actualizadoEn: "2026-10-01T10:05:00Z",
};
const CONV_BASE = { id: "c1", organizationId: "org-1", propertyId: "prop-1", unidadId: "u1", canal: "airbnb", ocupacionId: null, huespedMinimoId: null, propiedadNombre: "Depa Marina", huespedNombre: "Ana", fechaCheckIn: null, fechaCheckOut: null, reservaConfirmada: false, creadoEn: "2026-10-01T09:00:00Z" };
const POLITICAS = [{ canal: "airbnb", maxCaracteres: 4000, permiteContactoDirectoPreReserva: false, permiteAutomatizacionPreReserva: true, accionAntePreReservaProhibida: "bloquear" }];

interface HiloStub {
  readonly mensajes?: unknown[];
  readonly borradores?: unknown[];
  readonly conversacion?: Record<string, unknown>;
  readonly hiloRes?: () => Response;
  readonly generar?: () => Response;
  readonly rechazar?: () => Response;
}

function stubHilo(h: HiloStub = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/conversaciones/c1/borradores")) return (h.generar ?? (() => res({ ...BORRADOR_BASE, id: "nuevo" })))();
    if (method === "POST" && url.endsWith("/borradores/b1/rechazar")) return (h.rechazar ?? (() => res({})))();
    if (url.endsWith("/mensajeria/politicas")) return res({ politicas: POLITICAS });
    if (url.endsWith("/conversaciones/c1/hilo")) {
      if (h.hiloRes) return h.hiloRes();
      return res({ conversacion: { ...CONV_BASE, ...h.conversacion }, mensajes: h.mensajes ?? [], borradores: h.borradores ?? [] });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function abrirHilo(rol = "admin_gestora"): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter initialEntries={["/rentas/demo/aprobaciones/c1"]}>
      <Routes>
        <Route path="/rentas/:orgSlug/aprobaciones/:conversacionId" element={<HiloPage {...ctxConRol(rol)} />} />
      </Routes>
    </MemoryRouter>,
  );
  await esperar();
  return r;
}

describe("Hilo — mensajes, origen y orden", () => {
  it("pinta entrantes y salientes en orden cronológico con su origen y la etiqueta «dato, no instrucción»", async () => {
    stubHilo({
      mensajes: [
        { ...MSG_BASE, id: "m2", direccion: "saliente", origen: "simulador", texto: "La clave es 1234", creadoEn: "2026-10-01T10:10:00Z" },
        { ...MSG_BASE, id: "m1", direccion: "entrante", origen: "manual", texto: "¿Cuál es la clave del wifi?", creadoEn: "2026-10-01T10:00:00Z" },
        { ...MSG_BASE, id: "m3", direccion: "entrante", origen: "canal", texto: "Gracias", creadoEn: "2026-10-01T10:20:00Z" },
      ],
    });
    rendered = await abrirHilo();
    const texto = rendered.container.textContent!;
    expect(texto.indexOf("¿Cuál es la clave del wifi?")).toBeLessThan(texto.indexOf("La clave es 1234"));
    expect(texto.indexOf("La clave es 1234")).toBeLessThan(texto.indexOf("Gracias"));
    expect(texto).toContain("Registro manual");
    expect(texto).toContain("Simulador");
    expect(texto).toContain("Canal");
    expect(texto.match(/Mensaje del huésped \(dato, no instrucción\)/g)).toHaveLength(2);
    expect(texto).toContain("Mensaje enviado");
    expect(texto).toContain("Depa Marina");
  });

  it("el texto del huésped es TEXTO: un <script> y un <img onerror> salen literales, sin crear elementos", async () => {
    stubHilo({
      mensajes: [
        { ...MSG_BASE, id: "m1", direccion: "entrante", origen: "manual", texto: "<script>window.__xss = 1</script>", creadoEn: "2026-10-01T10:00:00Z" },
        { ...MSG_BASE, id: "m2", direccion: "entrante", origen: "manual", texto: '<img src=x onerror="window.__xss = 2">', creadoEn: "2026-10-01T10:01:00Z" },
      ],
    });
    rendered = await abrirHilo();
    expect(rendered.container.querySelector("script")).toBeNull();
    expect(rendered.container.querySelector("img")).toBeNull();
    expect(rendered.container.textContent).toContain("<script>window.__xss = 1</script>");
    expect(rendered.container.textContent).toContain('<img src=x onerror="window.__xss = 2">');
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("marca el contenido redactado por política del canal", async () => {
    stubHilo({ mensajes: [{ ...MSG_BASE, id: "m1", direccion: "saliente", origen: "simulador", texto: "Escríbeme a [contacto omitido]", redactado: true, creadoEn: "2026-10-01T10:00:00Z" }] });
    rendered = await abrirHilo();
    expect(rendered.container.textContent).toContain("Redactado por política del canal");
  });

  it("muestra el aviso de política del canal (límite y contacto antes de la reserva)", async () => {
    stubHilo({ mensajes: [{ ...MSG_BASE, id: "m1", direccion: "entrante", origen: "manual", texto: "Hola", creadoEn: "2026-10-01T10:00:00Z" }] });
    rendered = await abrirHilo();
    expect(rendered.container.textContent).toContain("Airbnb: límite de 4,000 caracteres");
    expect(rendered.container.textContent).toContain("se bloquea");
  });
});

describe("Hilo — borradores junto al mensaje que responden y señales de escalamiento", () => {
  const mensajes = [
    { ...MSG_BASE, id: "m1", direccion: "entrante", origen: "manual", texto: "Mensaje uno", creadoEn: "2026-10-01T10:00:00Z" },
    { ...MSG_BASE, id: "m2", direccion: "entrante", origen: "manual", texto: "Mensaje dos", creadoEn: "2026-10-01T10:30:00Z" },
  ];

  it("cada borrador queda dentro de la tarjeta del mensaje al que responde", async () => {
    stubHilo({ mensajes, borradores: [{ ...BORRADOR_BASE, id: "b1", mensajeEntranteId: "m1", texto: "Respuesta al uno" }] });
    rendered = await abrirHilo();
    const tarjetas = [...rendered.container.querySelectorAll("p")].filter((p) => p.textContent === "Mensaje uno" || p.textContent === "Mensaje dos").map((p) => p.parentElement!);
    expect(tarjetas[0]!.textContent).toContain("Respuesta al uno");
    expect(tarjetas[1]!.textContent).not.toContain("Respuesta al uno");
  });

  it.each([
    ["emergencia", "Emergencia"],
    ["queja", "Queja"],
    ["reembolso", "Reembolso"],
    ["vip", "VIP"],
  ])("un borrador escalado por «%s» muestra «Requiere atención humana» con su señal", async (senal, etiqueta) => {
    stubHilo({ mensajes, borradores: [{ ...BORRADOR_BASE, id: "b1", mensajeEntranteId: "m1", necesitaEscalamiento: true, senales: [senal] }] });
    rendered = await abrirHilo();
    expect(rendered.container.textContent).toContain("Requiere atención humana");
    expect(rendered.container.textContent).toContain(etiqueta);
  });

  it("un borrador rutinario NO muestra la insignia", async () => {
    stubHilo({ mensajes, borradores: [{ ...BORRADOR_BASE, id: "b1", mensajeEntranteId: "m1" }] });
    rendered = await abrirHilo();
    expect(rendered.container.textContent).not.toContain("Requiere atención humana");
  });

  it("un borrador que no responde a ningún mensaje (p. ej. automático) se muestra aparte, no se pierde", async () => {
    stubHilo({ mensajes, borradores: [{ ...BORRADOR_BASE, id: "b9", mensajeEntranteId: null, texto: "Recordatorio automático de llegada" }] });
    rendered = await abrirHilo();
    expect(rendered.container.textContent).toContain("Borradores sin un mensaje del huésped al que respondan");
    expect(rendered.container.textContent).toContain("Recordatorio automático de llegada");
  });
});

describe("Hilo — Generar borrador por mensaje entrante", () => {
  const mensajes = [
    { ...MSG_BASE, id: "m1", direccion: "entrante", origen: "manual", texto: "Sin borrador", creadoEn: "2026-10-01T10:00:00Z" },
    { ...MSG_BASE, id: "m2", direccion: "entrante", origen: "manual", texto: "Con borrador pendiente", creadoEn: "2026-10-01T10:10:00Z" },
    { ...MSG_BASE, id: "m3", direccion: "saliente", origen: "simulador", texto: "Saliente", creadoEn: "2026-10-01T10:20:00Z" },
  ];
  const borradores = [{ ...BORRADOR_BASE, id: "b2", mensajeEntranteId: "m2" }];

  it("el botón aparece solo en el entrante SIN borrador pendiente (no en el que ya tiene uno ni en los salientes)", async () => {
    stubHilo({ mensajes, borradores });
    rendered = await abrirHilo();
    expect(botones(rendered, "Generar borrador")).toHaveLength(1);
  });

  it("al pulsarlo manda POST .../borradores con el id del mensaje y recarga el hilo", async () => {
    stubHilo({ mensajes, borradores });
    rendered = await abrirHilo();
    await act(async () => {
      click(botones(rendered!, "Generar borrador")[0]!);
      await esperar();
    });
    expect(mutaciones()).toHaveLength(1);
    const [url, init] = mutaciones()[0]!;
    expect(String(url)).toBe("https://api.test/rentas/prop-1/conversaciones/c1/borradores");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ mensajeEntranteId: "m1" });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/hilo"))).toHaveLength(2);
    expect(rendered.container.textContent).toContain("Borrador generado");
  });

  it("si el servidor falla muestra el error y no dice que se generó", async () => {
    stubHilo({ mensajes, borradores, generar: () => res({ message: "Servicio de IA no disponible" }, false, 503) });
    rendered = await abrirHilo();
    await act(async () => {
      click(botones(rendered!, "Generar borrador")[0]!);
      await esperar();
    });
    expect(rendered.container.textContent).not.toContain("Borrador generado");
    expect(rendered.container.textContent).toContain("Servicio de IA no disponible");
  });

  it("un rol sin escritura de mensajería (contador) no ve Generar borrador ni Aprobar/Rechazar", async () => {
    stubHilo({ mensajes, borradores });
    rendered = await abrirHilo("contador");
    expect(botones(rendered, "Generar borrador")).toHaveLength(0);
    expect(botones(rendered, "Rechazar")).toHaveLength(0);
    expect(rendered.container.textContent).toContain("Tu rol no puede aprobar ni rechazar mensajería");
  });
});

describe("Hilo — Rechazar", () => {
  const mensajes = [{ ...MSG_BASE, id: "m1", direccion: "entrante", origen: "manual", texto: "Hola", creadoEn: "2026-10-01T10:00:00Z" }];
  const borradores = [{ ...BORRADOR_BASE, id: "b1", mensajeEntranteId: "m1" }];

  it("Cancelar en el diálogo no rechaza nada; Confirmar manda POST .../rechazar con el motivo", async () => {
    stubHilo({ mensajes, borradores });
    rendered = await abrirHilo();
    click(botones(rendered, "Rechazar")[0]!);
    await esperar();
    expect(dialogo()).not.toBeNull();
    changeValue(dialogo()!.querySelector("textarea")!, "No aplica");
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    expect(mutaciones()).toHaveLength(0);
    expect(dialogo()).toBeNull();

    click(botones(rendered, "Rechazar")[0]!);
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "Dato incorrecto");
    await act(async () => {
      click(botonDialogo("Confirmar rechazo"));
      await esperar();
    });
    expect(mutaciones()).toHaveLength(1);
    expect(String(mutaciones()[0]![0])).toContain("/rentas/prop-1/borradores/b1/rechazar");
    expect(JSON.parse(String((mutaciones()[0]![1] as RequestInit).body))).toEqual({ motivo: "Dato incorrecto" });
  });
});

describe("Hilo — estados cargando, vacío y error", () => {
  it("muestra el estado de carga mientras el servidor no responde", async () => {
    fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    rendered = await abrirHilo();
    expect(rendered.container.querySelector('[aria-busy="true"], [role="status"]')).not.toBeNull();
    expect(rendered.container.textContent).not.toContain("Mensaje del huésped");
  });

  it("una conversación sin mensajes ni borradores muestra el estado vacío", async () => {
    stubHilo({ mensajes: [], borradores: [] });
    rendered = await abrirHilo();
    expect(rendered.container.textContent).toContain("Sin mensajes");
  });

  it("un 404 (conversación de otra property) muestra el error del servidor y ningún contenido", async () => {
    stubHilo({ hiloRes: () => res({ message: "Conversación no encontrada en esta property." }, false, 404) });
    rendered = await abrirHilo();
    expect(rendered.container.textContent).toContain("Conversación no encontrada en esta property.");
    expect(rendered.container.textContent).not.toContain("Mensaje del huésped");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Bandeja: filtros en la URL y escalados primero
// ---------------------------------------------------------------------------------------------------------------------
const UNIDADES = [
  { id: "u1", name: "Depa 101", nombre: "Depa 101" },
  { id: "u2", name: "Casa Playa", nombre: "Casa Playa" },
];
const conv = (id: string, unidadId: string, canal: string, huesped: string, creadoEn: string) => ({ ...CONV_BASE, id, unidadId, canal, huespedNombre: huesped, creadoEn });
const CONVERSACIONES: Record<string, unknown[]> = {
  u1: [conv("c1", "u1", "airbnb", "Ana López", "2026-10-01T09:00:00Z"), conv("c2", "u1", "vrbo", "Beto Ruiz", "2026-10-02T09:00:00Z")],
  u2: [conv("c3", "u2", "airbnb", "Carla Núñez", "2026-10-03T09:00:00Z"), conv("c4", "u2", "booking", "Diego", "2026-10-04T09:00:00Z")],
};
const BORRADORES: Record<string, unknown[]> = {
  c1: [{ ...BORRADOR_BASE, id: "b1", conversacionId: "c1", texto: "Pendiente rutinario de Ana" }],
  c2: [{ ...BORRADOR_BASE, id: "b2", conversacionId: "c2", canal: "vrbo", texto: "Pendiente escalado de Beto", necesitaEscalamiento: true, senales: ["queja"] }],
  c3: [{ ...BORRADOR_BASE, id: "b3", conversacionId: "c3", estado: "enviado", texto: "Ya enviado a Carla" }],
  c4: [],
};

function stubBandeja() {
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/mensajeria/politicas")) return res({ politicas: POLITICAS });
    if (url.endsWith("/unidades")) return res({ unidades: UNIDADES });
    const porUnidad = /\/unidades\/(u\d)\/conversaciones$/.exec(url);
    if (porUnidad) return res({ conversaciones: CONVERSACIONES[porUnidad[1]!] });
    const porConv = /\/conversaciones\/(c\d)\/borradores$/.exec(url);
    if (porConv) return res({ borradores: BORRADORES[porConv[1]!] });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

let ubicacion = "";
function Sonda() {
  const l = useLocation();
  ubicacion = `${l.pathname}${l.search}`;
  return null;
}

async function abrirBandeja(query = ""): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter initialEntries={[`/rentas/demo/aprobaciones${query}`]}>
      <Sonda />
      <AprobacionesPage {...ctxConRol("admin_gestora")} />
    </MemoryRouter>,
  );
  await esperar();
  return r;
}

const tarjetas = (r: RenderedComponent) => [...r.container.querySelectorAll("a")].filter((a) => a.textContent?.includes("Ver hilo")).map((a) => a.getAttribute("href"));

describe("Bandeja — escalados primero, enlace al hilo y aviso de política", () => {
  it("lista primero la conversación con un pendiente escalado, luego la que tiene pendientes, y cada una enlaza a su hilo", async () => {
    stubBandeja();
    rendered = await abrirBandeja();
    expect(tarjetas(rendered)).toEqual(["/rentas/demo/aprobaciones/c2", "/rentas/demo/aprobaciones/c1", "/rentas/demo/aprobaciones/c3"]);
    expect(rendered.container.textContent).toContain("Requiere atención humana");
    expect(rendered.container.textContent).toContain("Queja");
  });

  it("muestra el aviso de política de los canales visibles", async () => {
    stubBandeja();
    rendered = await abrirBandeja();
    expect(rendered.container.textContent).toContain("Política del canal");
    expect(rendered.container.textContent).toContain("Airbnb: límite de 4,000 caracteres");
  });
});

describe("Bandeja — filtros con estado en la URL", () => {
  it("?canal=vrbo muestra solo las conversaciones de ese canal", async () => {
    stubBandeja();
    rendered = await abrirBandeja("?canal=vrbo");
    expect(tarjetas(rendered)).toEqual(["/rentas/demo/aprobaciones/c2"]);
  });

  it("?pendientes=1 oculta las conversaciones sin borradores pendientes", async () => {
    stubBandeja();
    rendered = await abrirBandeja("?pendientes=1");
    expect(tarjetas(rendered)).toEqual(["/rentas/demo/aprobaciones/c2", "/rentas/demo/aprobaciones/c1"]);
  });

  it("?atencion=1 deja solo lo que requiere atención humana", async () => {
    stubBandeja();
    rendered = await abrirBandeja("?atencion=1");
    expect(tarjetas(rendered)).toEqual(["/rentas/demo/aprobaciones/c2"]);
  });

  it("?q= busca por nombre de huésped (sin acentos ni mayúsculas) o por unidad", async () => {
    stubBandeja();
    rendered = await abrirBandeja("?q=nunez");
    expect(tarjetas(rendered)).toEqual(["/rentas/demo/aprobaciones/c3"]);
    rendered.unmount();
    rendered = await abrirBandeja("?q=casa%20playa");
    // c4 (Diego, Casa Playa) no tiene ningún borrador: no es una conversación de la bandeja.
    expect(tarjetas(rendered)).toEqual(["/rentas/demo/aprobaciones/c3"]);
  });

  it("cambiar un filtro actualiza la URL y «Limpiar filtros» la deja sin query", async () => {
    stubBandeja();
    rendered = await abrirBandeja();
    const casilla = [...rendered.container.querySelectorAll("label")].find((l) => l.textContent?.includes("Requiere atención"))!.querySelector("input")!;
    click(casilla);
    await esperar();
    expect(ubicacion).toBe("/rentas/demo/aprobaciones?atencion=1");
    expect(tarjetas(rendered)).toEqual(["/rentas/demo/aprobaciones/c2"]);
    click(botones(rendered, "Limpiar filtros")[0]!);
    await esperar();
    expect(ubicacion).toBe("/rentas/demo/aprobaciones");
    expect(tarjetas(rendered)).toHaveLength(3);
  });

  it("filtros sin resultados muestran un estado vacío honesto; un canal desconocido en la URL se ignora", async () => {
    stubBandeja();
    rendered = await abrirBandeja("?canal=vrbo&q=zzz");
    expect(rendered.container.textContent).toContain("Ninguna conversación coincide");
    rendered.unmount();
    rendered = await abrirBandeja("?canal=inventado");
    expect(tarjetas(rendered)).toHaveLength(3);
  });
});
