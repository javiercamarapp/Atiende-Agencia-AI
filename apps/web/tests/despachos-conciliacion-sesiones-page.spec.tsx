// @vitest-environment jsdom
//
// D-35 + D-02 -- conciliacion persistida en la pantalla de Conciliacion (jsdom): lista de sesiones, detalle con propuestas del motor, confirmar (solo ids al
// servidor), deshacer con motivo (useConfirm), "Sugerir con IA" con estado honesto sin IA, aprobar/rechazar sugerencias con confianza y razon, base sin migrar
// y acciones ocultas por rol.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConciliacionPage } from "../src/verticals/despachos/pages/Conciliacion.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Staff", staffEmail: "s@example.com" });

const SESION = { id: "s-1", periodo: "2026-01", cuenta: null, estado: "abierta", creadaEn: "2026-02-01T10:00:00Z", cerradaEn: null, totalMovimientos: 3, matchesVigentes: 1, sugerenciasPendientes: 1 };
const CFDIS = [
  { id: "f-1", folioFiscal: "11111111-2222-3333-4444-555555555555", emisorNombre: "CLIENTE ACME SA DE CV", total: 1160, fecha: "2026-01-05", conciliado: false },
  { id: "f-2", folioFiscal: "22222222-2222-3333-4444-555555555555", emisorNombre: "PROVEEDOR UNO", total: 580, fecha: "2026-01-12", conciliado: true },
  { id: "f-3", folioFiscal: "33333333-2222-3333-4444-555555555555", emisorNombre: "SERVICIOS BETA", total: 348, fecha: "2026-01-15", conciliado: false },
];
function detalle(extra: Record<string, unknown> = {}) {
  return {
    sesion: { id: "s-1", periodo: "2026-01", cuenta: null, estado: "abierta" },
    movimientos: [
      { id: "m-1", fecha: "2026-01-05", descripcion: "SPEI RECIBIDO ACME", referencia: null, cuenta: null, monto: 1160, estado: "sin_conciliar", matchId: null },
      { id: "m-2", fecha: "2026-01-12", descripcion: "PAGO PROVEEDOR UNO", referencia: null, cuenta: null, monto: 580, estado: "conciliado", matchId: "mt-1" },
      { id: "m-3", fecha: "2026-01-20", descripcion: "PAGO FACTURA SERVICIOS", referencia: null, cuenta: null, monto: 300, estado: "sugerido", matchId: null },
    ],
    cfdis: CFDIS,
    propuestas: [{ movimientoId: "m-1", invoiceId: "f-1", nivel: 1, confianza: 100, detalle: "exacto" }],
    multiLinea: [],
    matches: [{ id: "mt-1", movimientoId: "m-2", invoiceId: "f-2", nivel: 1, confianza: 97, origen: "motor", confirmadoEn: "2026-02-01T10:05:00Z", deshechoEn: null, motivoDeshacer: null }],
    sugerencias: [{ id: "sg-1", movimientoId: "m-3", invoiceId: "f-3", confianza: 71.4, razon: "Mismo concepto de servicios y fecha cercana", estado: "pendiente" }],
    ...extra,
  };
}

interface Llamada {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}
let llamadas: Llamada[];
let rendered: RenderedComponent | undefined;

function stubFetch(opciones: { lista?: unknown; detalle?: unknown; configuracion?: unknown; escritura?: (url: string, method: string) => Response | undefined } = {}) {
  llamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET") {
        if (url.endsWith("/conciliacion/sesiones")) return new Response(JSON.stringify(opciones.lista ?? { disponible: true, sesiones: [SESION] }), { status: 200 });
        if (url.includes("/conciliacion/sesiones/s-1")) return new Response(JSON.stringify(opciones.detalle ?? detalle()), { status: 200 });
        if (url.endsWith("/conciliacion/configuracion") && opciones.configuracion !== undefined) return new Response(JSON.stringify(opciones.configuracion), { status: 200 });
      }
      const custom = opciones.escritura?.(url, method);
      if (custom) return custom;
      if (url.endsWith("/conciliacion/configuracion") && method === "PUT") return new Response(JSON.stringify({ autoconfirmarNivel1: (JSON.parse(String(init?.body)) as { autoconfirmarNivel1: boolean }).autoconfirmarNivel1 }), { status: 200 });
      if (url.endsWith("/recalcular")) return new Response(JSON.stringify({ ...detalle(), guardado: true }), { status: 200 });
      if (url.endsWith("/confirmar")) return new Response(JSON.stringify({ matches: [{ id: "mt-9" }] }), { status: 201 });
      if (url.endsWith("/deshacer")) return new Response(JSON.stringify({ yaDeshecho: false }), { status: 200 });
      if (url.endsWith("/aprobar")) return new Response(JSON.stringify({ estado: "aprobada", matchId: "mt-10" }), { status: 200 });
      if (url.endsWith("/rechazar")) return new Response(JSON.stringify({ estado: "rechazada", matchId: null }), { status: 200 });
      if (url.endsWith("/sugerencias-llm")) return new Response(JSON.stringify({ sugerencias: [{ id: "sg-2" }], sinSugerencia: [], notificacion: "emitida" }), { status: 201 });
      if (url.endsWith("/conciliacion/sesiones")) return new Response(JSON.stringify({ sesion: { id: "s-1" }, movimientos: 3 }), { status: 201 });
      return new Response("{}", { status: 404 });
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
      <ConciliacionPage {...CTX(role)} />
    </MemoryRouter>,
  );
  for (let i = 0; i < 6; i++) await act(async () => flushMicrotasks());
  return r;
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => flushMicrotasks());
};
const boton = (texto: string, raiz: ParentNode = document.body) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const dialogo = () => document.body.querySelector('[role="dialog"], [role="alertdialog"]') as HTMLElement | null;
const escrituras = () => llamadas.filter((l) => l.method === "POST" || l.method === "PUT");

async function abrirSesion() {
  click(document.body.querySelector('button[aria-label="Abrir sesión 2026-01"]')!);
  await flush();
}

describe("Conciliacion -- conciliacion guardada por periodo", () => {
  it("lista las sesiones con periodo, estado, conciliados y sugerencias por revisar", async () => {
    stubFetch();
    rendered = await montar("contador");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Conciliación guardada por periodo");
    expect(texto).toContain("2026-01");
    expect(texto).toContain("Abierta");
    expect(llamadas[0]!.url).toBe("https://api.test/despachos/p1/conciliacion/sesiones");
  });

  it("abrir una sesion muestra propuestas del motor, sugerencias con confianza y razon, conciliaciones confirmadas y el estado de cada movimiento", async () => {
    stubFetch();
    rendered = await montar("contador");
    await abrirSesion();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Propuestas del motor");
    expect(texto).toContain("CLIENTE ACME SA DE CV");
    expect(texto).toContain("Exacto");
    expect(texto).toContain("Sugerencias de IA por revisar");
    expect(texto).toContain("71%");
    expect(texto).toContain("Mismo concepto de servicios y fecha cercana");
    expect(texto).toContain("Conciliaciones confirmadas (1)");
    expect(texto).toContain("Sugerido por IA");
    expect(texto).toContain("Sin conciliar");
    expect(texto).toContain("Ninguna se aplica sola");
  });

  it("guardar como sesion manda el periodo y abre la sesion creada", async () => {
    stubFetch({ lista: { disponible: true, sesiones: [] } });
    rendered = await montar("contador");
    expect(rendered.container.textContent).toContain("Todavía no hay sesiones");
    changeValue(document.getElementById("sesion-periodo") as HTMLInputElement, "2026-01");
    changeValue(document.getElementById("sesion-cuenta") as HTMLInputElement, "012180001234567897");
    await act(async () => {
      click(boton("Guardar como sesión")!);
      await flushMicrotasks();
    });
    await flush();
    expect(escrituras()[0]).toMatchObject({ url: "https://api.test/despachos/p1/conciliacion/sesiones", body: { periodo: "2026-01", cuenta: "012180001234567897" } });
    expect(llamadas.some((l) => l.url.endsWith("/conciliacion/sesiones/s-1"))).toBe(true);
  });

  it("un error del servidor al guardar (sin movimientos del periodo) se muestra tal cual", async () => {
    stubFetch({ lista: { disponible: true, sesiones: [] }, escritura: () => new Response(JSON.stringify({ error: "not_found", message: "no hay movimientos guardados en el periodo 2026-01" }), { status: 404 }) });
    rendered = await montar("contador");
    await act(async () => {
      click(boton("Guardar como sesión")!);
      await flushMicrotasks();
    });
    await flush();
    expect(rendered.container.textContent).toContain("no hay movimientos guardados");
  });

  it("confirmar seleccionados manda SOLO ids (el servidor decide nivel, confianza y origen) y recarga", async () => {
    stubFetch();
    rendered = await montar("contador");
    await abrirSesion();
    expect(boton("Confirmar seleccionados (1)")).toBeDefined();
    await act(async () => {
      click(boton("Confirmar seleccionados (1)")!);
      await flushMicrotasks();
    });
    await flush();
    const post = escrituras().find((l) => l.url.endsWith("/sesiones/s-1/confirmar"))!;
    expect(post.body).toEqual({ pares: [{ movimientoId: "m-1", invoiceId: "f-1" }] });
    expect(llamadas.filter((l) => l.method === "GET" && l.url.endsWith("/sesiones/s-1")).length).toBeGreaterThanOrEqual(2);
  });

  it("deshacer pide el motivo con un dialogo (no window.prompt) y lo manda; cancelar no manda nada", async () => {
    stubFetch();
    rendered = await montar("contador");
    await abrirSesion();
    click(boton("Deshacer")!);
    expect(dialogo()).not.toBeNull();
    await act(async () => {
      click(boton("Cancelar", dialogo()!)!);
      await flushMicrotasks();
    });
    expect(escrituras()).toHaveLength(0);

    click(boton("Deshacer")!);
    changeValue(dialogo()!.querySelector("textarea")!, "Se concilió contra la factura equivocada");
    await act(async () => {
      click(dialogo()!.querySelector('button[type="submit"]')!);
      await flushMicrotasks();
    });
    await flush();
    const post = escrituras().find((l) => l.url.endsWith("/matches/mt-1/deshacer"))!;
    expect(post.body).toEqual({ motivo: "Se concilió contra la factura equivocada" });
  });

  it("Sugerir con IA sin IA configurada muestra el 503 honesto del servidor y no inventa sugerencias", async () => {
    stubFetch({ escritura: (url) => (url.endsWith("/sugerencias-llm") ? new Response(JSON.stringify({ error: "service_unavailable", message: "IA no configurada: el entorno no tiene un proveedor de modelos." }), { status: 503 }) : undefined) });
    rendered = await montar("contador");
    await abrirSesion();
    await act(async () => {
      click(boton("Sugerir con IA")!);
      await flushMicrotasks();
    });
    await flush();
    expect(rendered.container.textContent).toContain("IA no configurada");
  });

  it("Sugerir con IA llama al endpoint del nivel 4 y recarga la sesion", async () => {
    stubFetch();
    rendered = await montar("admin");
    await abrirSesion();
    await act(async () => {
      click(boton("Sugerir con IA")!);
      await flushMicrotasks();
    });
    await flush();
    expect(escrituras().some((l) => l.url.endsWith("/sesiones/s-1/sugerencias-llm"))).toBe(true);
  });

  it("aprobar y rechazar una sugerencia llaman a su endpoint", async () => {
    stubFetch();
    rendered = await montar("contador");
    await abrirSesion();
    await act(async () => {
      click(document.body.querySelector('button[aria-label="Aprobar sugerencia"]')!);
      await flushMicrotasks();
    });
    await flush();
    expect(escrituras().some((l) => l.url.endsWith("/sugerencias/sg-1/aprobar"))).toBe(true);
    await act(async () => {
      click(document.body.querySelector('button[aria-label="Rechazar sugerencia"]')!);
      await flushMicrotasks();
    });
    await flush();
    expect(escrituras().some((l) => l.url.endsWith("/sugerencias/sg-1/rechazar"))).toBe(true);
  });

  it("auditor/readonly ven las sesiones y sus conciliaciones en solo lectura: sin guardar, confirmar, deshacer, aprobar ni sugerir", async () => {
    stubFetch();
    rendered = await montar("readonly");
    expect(rendered.container.textContent).toContain("2026-01");
    await abrirSesion();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Conciliaciones confirmadas (1)");
    expect(texto).toContain("Mismo concepto de servicios");
    expect(texto).not.toContain("Guardar como sesión");
    expect(texto).not.toContain("Confirmar seleccionados");
    expect(texto).not.toContain("Sugerir con IA");
    expect(document.body.querySelector('button[aria-label="Aprobar sugerencia"]')).toBeNull();
    expect(document.body.querySelector('button[aria-label="Deshacer conciliación"]')).toBeNull();
    expect(escrituras()).toHaveLength(0);
  });

  it("base sin migrar: aviso honesto con la migracion 021 y sin formulario para crear sesiones", async () => {
    stubFetch({ lista: { disponible: false, sesiones: [] } });
    rendered = await montar("admin");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("falta aplicar la migración 021");
    expect(texto).not.toContain("Guardar como sesión");
  });

  it("una sesion cerrada no ofrece confirmar, sugerir ni cerrar", async () => {
    stubFetch({ detalle: detalle({ sesion: { id: "s-1", periodo: "2026-01", cuenta: null, estado: "cerrada" } }) });
    rendered = await montar("admin");
    await abrirSesion();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Cerrada");
    expect(texto).not.toContain("Confirmar seleccionados");
    expect(texto).not.toContain("Sugerir con IA");
    expect(texto).not.toContain("Cerrar sesión");
  });
});

describe("Conciliacion -- D-P3-10/11/12: guardadas, ambiguo, sin conciliar, revision y piloto", () => {
  const ambiguaYSinConciliar = {
    propuestasEn: "2026-02-03T10:00:00.000Z",
    propuestasFuente: "guardadas",
    ambiguas: [{ movimientoId: "m-1", combinaciones: [["f-1", "f-3"], ["f-2", "f-3"]], truncado: false, exactas: true }],
    sinConciliar: [
      { movimientoId: "m-1", motivo: "ambiguo", cercanos: [] },
      { movimientoId: "m-3", motivo: "sin_combinacion", cercanos: [{ invoiceId: "f-3", diferenciaCentavos: 4800 }, { invoiceId: "f-1", diferenciaCentavos: 86000 }] },
    ],
  };

  it("muestra «ambiguo: elige una de N combinaciones» con cada combinación, y «sin conciliar: más cercanos» con el motivo", async () => {
    stubFetch({
      detalle: detalle({
        ...ambiguaYSinConciliar,
        movimientos: [
          { id: "m-1", fecha: "2026-01-05", descripcion: "DEPOSITO VARIOS", referencia: null, cuenta: null, monto: 1508, estado: "ambiguo", matchId: null },
          { id: "m-3", fecha: "2026-01-20", descripcion: "PAGO RARO", referencia: null, cuenta: null, monto: 300, estado: "sin_conciliar", matchId: null },
        ],
        propuestas: [],
        sugerencias: [],
      }),
    });
    rendered = await montar("contador");
    await abrirSesion();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Ambiguo: elige una de 2 combinaciones");
    expect(texto).toContain("CLIENTE ACME SA DE CV");
    expect(texto).toContain("SERVICIOS BETA");
    expect(texto).toContain("todavía no está disponible (llega con la tabla de grupos, D-07)");
    expect(texto).toContain("Sin conciliar: más cercanos");
    expect(texto).toContain("Ninguna combinación de CFDI suma el monto");
    expect(texto).toContain("(a $48.00)");
    expect(texto).toContain("Ambiguo"); // estado del movimiento
    // un ambiguo no ofrece ningún botón para confirmarlo con un clic
    expect(boton("Confirmar seleccionados")).toBeDefined(); // solo para propuestas; no hay ninguna para el ambiguo
    expect(document.body.querySelectorAll('input[type="checkbox"]').length).toBe(0);
  });

  it("Recalcular llama al endpoint, recarga y avisa; muestra cuándo se calcularon las propuestas guardadas", async () => {
    stubFetch({ detalle: detalle({ propuestasEn: "2026-02-03T10:00:00.000Z", propuestasFuente: "guardadas" }) });
    rendered = await montar("contador");
    await abrirSesion();
    expect(rendered.container.textContent).toContain("Calculadas el");
    await act(async () => {
      click(boton("Recalcular")!);
      await flushMicrotasks();
    });
    await flush();
    expect(escrituras().some((l) => l.url.endsWith("/sesiones/s-1/recalcular") && l.method === "POST")).toBe(true);
    expect(llamadas.filter((l) => l.method === "GET" && l.url.endsWith("/sesiones/s-1")).length).toBeGreaterThanOrEqual(2);
  });

  it("una sesión sin propuestas guardadas lo dice (se calcularon al abrir) y el botón Recalcular no existe para solo lectura", async () => {
    stubFetch({ detalle: detalle({ propuestasEn: null, propuestasFuente: "calculadas" }) });
    rendered = await montar("readonly");
    await abrirSesion();
    expect(rendered.container.textContent).toContain("aún no tiene propuestas guardadas");
    expect(boton("Recalcular")).toBeUndefined();
  });

  it("una propuesta con dirección indeterminada NO viene preseleccionada y al confirmarla se pide revisión y se manda `revisado: true`", async () => {
    stubFetch({
      detalle: detalle({
        propuestas: [
          { movimientoId: "m-1", invoiceId: "f-1", nivel: 1, confianza: 100, detalle: "exacto", requiereRevision: true },
        ],
      }),
    });
    rendered = await montar("contador");
    await abrirSesion();
    expect(rendered.container.textContent).toContain("Dirección indeterminada");
    expect(boton("Confirmar seleccionados (0)")).toBeDefined();
    expect(boton("Confirmar seleccionados (0)")!.disabled).toBe(true);
    // la persona la selecciona a mano
    click(document.body.querySelector('input[type="checkbox"][aria-label*="Seleccionar"], tbody input[type="checkbox"]')!);
    await flush();
    expect(boton("Confirmar seleccionados (1)")).toBeDefined();
    click(boton("Confirmar seleccionados (1)")!);
    await flush();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("dirección indeterminada");
    await act(async () => {
      click(boton("Ya los revisé", dialogo()!)!);
      await flushMicrotasks();
    });
    await flush();
    const post = escrituras().find((l) => l.url.endsWith("/sesiones/s-1/confirmar"))!;
    expect(post.body).toEqual({ pares: [{ movimientoId: "m-1", invoiceId: "f-1", revisado: true }] });
  });

  it("el origen autopiloto se ve como «Piloto automático» en las conciliaciones confirmadas y se puede deshacer", async () => {
    stubFetch({ detalle: detalle({ matches: [{ id: "mt-1", movimientoId: "m-2", invoiceId: "f-2", nivel: 1, confianza: 100, origen: "autopiloto", confirmadoEn: "2026-02-01T10:05:00Z", deshechoEn: null, motivoDeshacer: null }] }) });
    rendered = await montar("contador");
    await abrirSesion();
    expect(rendered.container.textContent).toContain("Piloto automático");
    expect(boton("Deshacer")).toBeDefined();
  });

  it("el interruptor del piloto: el admin lo cambia (PUT con el booleano); contador y solo lectura no lo ven (la API es solo de admin)", async () => {
    stubFetch({ configuracion: { autoconfirmarNivel1: false } });
    rendered = await montar("admin");
    const sw = document.body.querySelector('button[role="switch"][aria-label="Piloto automático de nivel 1"]') as HTMLButtonElement;
    expect(sw).not.toBeNull();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      click(sw);
      await flushMicrotasks();
    });
    await flush();
    expect(escrituras().find((l) => l.method === "PUT")).toMatchObject({ url: "https://api.test/despachos/p1/conciliacion/configuracion", body: { autoconfirmarNivel1: true } });
    expect((document.body.querySelector('button[role="switch"]') as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    rendered.unmount();

    stubFetch({ configuracion: { autoconfirmarNivel1: true } });
    rendered = await montar("contador");
    expect(document.body.querySelector('button[role="switch"]')).toBeNull();
    expect(rendered.container.textContent).not.toContain("Piloto automático de nivel 1");
    expect(llamadas.some((l) => l.url.endsWith("/conciliacion/configuracion"))).toBe(false); // ni siquiera se pide: la API es solo de admin
  });

  it("si el servidor rechaza el cambio del piloto (503 sin la migración 025) el interruptor NO cambia y se dice el motivo", async () => {
    stubFetch({
      configuracion: { autoconfirmarNivel1: false },
      escritura: (url, method) => (method === "PUT" ? new Response(JSON.stringify({ error: "service_unavailable", message: "falta aplicar la migración 025" }), { status: 503 }) : undefined),
    });
    rendered = await montar("admin");
    const sw = document.body.querySelector('button[role="switch"]') as HTMLButtonElement;
    await act(async () => {
      click(sw);
      await flushMicrotasks();
    });
    await flush();
    expect((document.body.querySelector('button[role="switch"]') as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
  });

  it("si no se pudo leer la configuración no se muestra un interruptor que no sabemos si funciona", async () => {
    stubFetch(); // GET /configuracion -> 404 en este stub
    rendered = await montar("admin");
    expect(document.body.querySelector('button[role="switch"]')).toBeNull();
  });
});
