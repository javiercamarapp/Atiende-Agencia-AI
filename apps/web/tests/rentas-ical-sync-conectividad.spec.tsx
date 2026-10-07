// @vitest-environment jsdom
//
// <IcalSyncPage /> paridad3: URL de exportación con TOKEN (se muestra una vez, rotar pide confirmación), aviso de deprecación de la URL
// por UUID, latencia declarada y advertencia de Booking.com desde el catálogo, "Probar URL" sin guardar y "Sincronizar ahora".
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IcalSyncPage } from "../src/verticals/rentas/pages/IcalSync.tsx";
import { MonitorSyncPage } from "../src/verticals/rentas/pages/MonitorSync.tsx";
import type { RentasShellContext } from "../src/verticals/rentas/RentasShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function ctx(rol = "admin_gestora"): RentasShellContext {
  return {
    apiBaseUrl: "https://api.test",
    token: "tok",
    propertyId: "prop-1",
    setPropertyId: () => {},
    properties: [{ propertyId: "prop-1", nombre: "Depa Marina" }],
    orgSlug: "demo",
    session: { token: "tok", refreshToken: "ref", email: "g@example.com", organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "rentas", rol }] },
  };
}
const res = (body: unknown, ok = true, status = ok ? 200 : 409): Response => ({ ok, status, json: async () => body }) as unknown as Response;
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}

const CAT = (codigo: string, nombre: string, extra: Record<string, unknown> = {}) => ({
  codigo,
  nombre,
  canal_atiende: codigo,
  via_hoy: "ical",
  via_ical: "disponible",
  descripcion_via: "iCal import/export",
  latencia: { texto: "~3 horas", confianza: "baja", fuente: "RV03 S1", nota: "" },
  bloqueo: null,
  requisitos: [],
  url_proceso_oficial: null,
  nota_anti_paridad: "",
  ...extra,
});
const CATALOGO = [
  CAT("airbnb", "Airbnb"),
  CAT("vrbo", "Vrbo", { latencia: { texto: "~30 min + 20 min de propagación", confianza: "media", fuente: "RV22 F14", nota: "" } }),
  CAT("booking", "Booking.com", {
    via_ical: "sin_evidencia",
    via_hoy: "sin_evidencia",
    descripcion_via: "Ninguna vía directa documentada",
    latencia: { texto: "SIN EVIDENCIA", confianza: "sin_evidencia", fuente: null, nota: "" },
    bloqueo: { motivo: "Pausado activamente por el canal", cita: "b002-archivo F01" },
  }),
];
const FEED_AIRBNB = {
  id: "f1", canal: "airbnb", url_importacion: "https://www.airbnb.com/calendar/ical/1.ics", activo: true, ultima_sincronizacion_exitosa_en: "2026-10-07T11:50:00Z",
  en_cuarentena_desde: null, intentos_fallidos_consecutivos: 0, motivo_cuarentena: null, drift_ultima_reconciliacion_completa: 0, ultimo_resumen: null,
};

interface Escenario {
  tokens?: { disponible: boolean; url_uuid_activa: boolean; tokens: { canal: string; creado_en: string; ultimo_acceso_en: string | null }[] };
  feeds?: unknown[];
  rotar?: () => Response;
  probar?: () => Response;
  sincronizar?: () => Response;
}
function stub(e: Escenario = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const m = init?.method ?? "GET";
    if (m === "GET" && url.endsWith("/unidades")) return res({ unidades: [{ id: "u1", name: "Depa 101", nombre: "Depa 101" }] });
    if (m === "GET" && url.endsWith("/unidades/u1/ical-sync")) return res({ feeds: e.feeds ?? [] });
    if (m === "GET" && url.endsWith("/canales/catalogo")) return res({ canales: CATALOGO });
    if (m === "GET" && url.endsWith("/unidades/u1/feed-tokens")) return res(e.tokens ?? { disponible: true, url_uuid_activa: true, tokens: [] });
    if (m === "POST" && url.endsWith("/feed-token/rotar")) return (e.rotar ?? (() => res({ canal: "airbnb", token: "N".repeat(43), ruta: `/rentas/feed/${"N".repeat(43)}.ics`, creado_en: "2026-10-07T12:00:00.000Z" }, true, 201)))();
    if (m === "POST" && url.endsWith("/ical-feeds/probar")) return (e.probar ?? (() => res({ ok: true, eventos: 4, cancelados: 0, desde: "2027-01-10", hasta: "2027-03-01", errores: [] })))();
    if (m === "POST" && url.endsWith("/sincronizar")) return (e.sincronizar ?? (() => res({ canal: "airbnb", ok: true, resultado: "exito_con_eventos", eventos_aplicados: 2, reservas_nuevas: 1, conflictos_detectados: 0 })))();
    throw new Error(`fetch inesperado en el test: ${m} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const mutaciones = () => fetchMock.mock.calls.filter(([, init]) => ["POST", "DELETE", "PATCH"].includes((init as RequestInit | undefined)?.method ?? "GET"));
const llamadasA = (sufijo: string) => mutaciones().filter(([u]) => String(u).endsWith(sufijo));
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonEn = (raiz: ParentNode, texto: string) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.trim().includes(texto)) as HTMLButtonElement | undefined;

async function montar(rol = "admin_gestora"): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter>
      <IcalSyncPage {...ctx(rol)} />
    </MemoryRouter>,
  );
  await esperar();
  return r;
}

describe("IcalSyncPage -- URL de exportación con token", () => {
  it("sin token todavía: ofrece generarlo, y al generarlo muestra la URL una vez con aviso y botón de copiar", async () => {
    stub();
    rendered = await montar();
    expect(rendered.container.textContent).toContain("Todavía no generas una URL con token para este canal.");
    const generar = botonEn(rendered.container, "Generar URL con token")!;
    click(generar);
    await esperar();

    expect(llamadasA("/canales/airbnb/feed-token/rotar")).toHaveLength(1);
    const input = rendered.container.querySelector<HTMLInputElement>('input[aria-label="URL con token para Airbnb"]')!;
    expect(input.value).toBe(`https://api.test/rentas/feed/${"N".repeat(43)}.ics`);
    expect(rendered.container.textContent).toContain("por seguridad no se vuelve a mostrar");
  });

  it("con token vigente: muestra la fecha de creación y la última consulta del canal; rotar pide confirmación y Cancelar NO rota", async () => {
    stub({ tokens: { disponible: true, url_uuid_activa: true, tokens: [{ canal: "airbnb", creado_en: "2026-10-01T00:00:00.000Z", ultimo_acceso_en: null }] } });
    rendered = await montar();
    expect(rendered.container.textContent).toContain("aún no la ha consultado");

    click(botonEn(rendered.container, "Rotar URL")!);
    await esperar();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("Airbnb dejará de ver tu calendario hasta que pegues la URL nueva");

    click(botonEn(dialogo()!, "Cancelar")!);
    await esperar();
    expect(llamadasA("/feed-token/rotar")).toHaveLength(0);
    expect(rendered.container.querySelector('input[aria-label="URL con token para Airbnb"]')).toBeNull();

    click(botonEn(rendered.container, "Rotar URL")!);
    await esperar();
    click(botonEn(dialogo()!, "Sí, rotar URL")!);
    await esperar();
    expect(llamadasA("/feed-token/rotar")).toHaveLength(1);
    expect(rendered.container.querySelector<HTMLInputElement>('input[aria-label="URL con token para Airbnb"]')!.value).toContain("/rentas/feed/");
  });

  it("muestra la última consulta de la OTA cuando existe", async () => {
    stub({ tokens: { disponible: true, url_uuid_activa: true, tokens: [{ canal: "airbnb", creado_en: "2026-10-01T00:00:00.000Z", ultimo_acceso_en: "2026-10-07T11:55:00.000Z" }] } });
    rendered = await montar();
    expect(rendered.container.textContent).toContain("Última consulta de Airbnb:");
    expect(rendered.container.textContent).not.toContain("aún no la ha consultado");
  });

  it("la URL por UUID queda como 'anterior' con el aviso de deprecación; si se apagó, desaparece", async () => {
    stub();
    rendered = await montar();
    expect(rendered.container.textContent).toContain("Actualiza la URL en Airbnb: la anterior dejará de funcionar.");
    expect(rendered.container.querySelector('input[aria-label="URL de exportación por UUID para Airbnb"]')).not.toBeNull();
    rendered.unmount();

    stub({ tokens: { disponible: true, url_uuid_activa: false, tokens: [] } });
    rendered = await montar();
    expect(rendered.container.querySelector('input[aria-label="URL de exportación por UUID para Airbnb"]')).toBeNull();
  });

  it("base sin la migración: solo la URL por UUID, sin aviso de deprecación, y lo dice (no hay botón de generar)", async () => {
    stub({ tokens: { disponible: false, url_uuid_activa: true, tokens: [] } });
    rendered = await montar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("La URL con token aún no está disponible en este entorno");
    expect(texto).not.toContain("la anterior dejará de funcionar");
    expect(botonEn(rendered.container, "Generar URL con token")).toBeUndefined();
    expect(rendered.container.querySelector('input[aria-label="URL de exportación por UUID para Airbnb"]')).not.toBeNull();
  });

  it("un rol de solo lectura ve el estado del token pero no puede generarlo ni rotarlo", async () => {
    stub({ tokens: { disponible: true, url_uuid_activa: true, tokens: [{ canal: "airbnb", creado_en: "2026-10-01T00:00:00.000Z", ultimo_acceso_en: null }] } });
    rendered = await montar("operador:solo_calendario");
    expect(rendered.container.textContent).toContain("URL con token creada");
    expect(botonEn(rendered.container, "Rotar URL")).toBeUndefined();
    expect(botonEn(rendered.container, "Generar URL con token")).toBeUndefined();
  });

  it("si generar falla, muestra el error del servidor y no deja una URL a medias", async () => {
    stub({ rotar: () => res({ message: "La URL con token aún no está disponible en este entorno." }, false, 409) });
    rendered = await montar();
    click(botonEn(rendered.container, "Generar URL con token")!);
    await esperar();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("aún no está disponible");
    expect(rendered.container.querySelector('input[aria-label="URL con token para Airbnb"]')).toBeNull();
  });
});

describe("IcalSyncPage -- catálogo, Booking, probar y sincronizar", () => {
  it("muestra la latencia declarada con su confianza y fuente, y el enlace al asistente", async () => {
    stub();
    rendered = await montar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Latencia declarada: ~3 horas (confianza baja; fuente RV03 S1)");
    expect(texto).toContain("~30 min + 20 min de propagación (confianza media");
    expect(rendered.container.querySelector('a[href="/rentas/demo/conectividad?unidad=u1&canal=airbnb"]')).not.toBeNull();
  });

  it("Booking.com advierte que no hay evidencia de iCal, con el motivo y la cita, sin inventar una cifra", async () => {
    stub();
    rendered = await montar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Sin evidencia de que Booking.com ofrezca iCal");
    expect(texto).toContain("Pausado activamente por el canal");
    expect(texto).toContain("b002-archivo F01");
    expect(texto).toContain("No hay ninguna cifra de latencia con fuente");
    // Airbnb y Vrbo no llevan esa advertencia.
    expect(texto.match(/Sin evidencia de que/g)).toHaveLength(1);
  });

  it("Probar URL descarga y resume SIN guardar: no hay ninguna llamada de conectar", async () => {
    stub();
    rendered = await montar();
    const conectar = [...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Conectar")[0]!;
    click(conectar);
    await esperar();
    const input = document.body.querySelector<HTMLInputElement>('input[type="url"]')!;
    changeValue(input, "https://www.airbnb.com/calendar/ical/1.ics");
    click(botonEn(document.body, "Probar URL")!);
    await esperar();

    expect(llamadasA("/ical-feeds/probar")).toHaveLength(1);
    expect(JSON.parse(String((llamadasA("/ical-feeds/probar")[0]![1] as RequestInit).body))).toEqual({ url: "https://www.airbnb.com/calendar/ical/1.ics" });
    expect(document.body.textContent).toContain("La URL funciona: 4 eventos, del 2027-01-10 al 2027-03-01.");
    expect(llamadasA("/ical-sync")).toHaveLength(0);
  });

  it("Probar URL con un calendario inválido muestra el error y nada se guarda", async () => {
    stub({ probar: () => res({ ok: false, tipo: "parseo", mensaje: "La URL respondió, pero el contenido no es un calendario .ics válido.", errores: [{ codigo: "estructura_desbalanceada", mensaje: "el feed no inicia con BEGIN:VCALENDAR" }] }) });
    rendered = await montar();
    click([...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Conectar")[0]!);
    await esperar();
    changeValue(document.body.querySelector<HTMLInputElement>('input[type="url"]')!, "https://www.airbnb.com/x");
    click(botonEn(document.body, "Probar URL")!);
    await esperar();
    expect(document.body.textContent).toContain("no es un calendario .ics válido");
    expect(document.body.textContent).toContain("BEGIN:VCALENDAR");
    expect(llamadasA("/ical-sync")).toHaveLength(0);
  });

  it("Sincronizar ahora llama al endpoint del feed y muestra el resultado real", async () => {
    stub({ feeds: [FEED_AIRBNB] });
    rendered = await montar();
    click(botonEn(rendered.container, "Sincronizar ahora")!);
    await esperar();
    expect(llamadasA("/ical-feeds/airbnb/sincronizar")).toHaveLength(1);
    expect(rendered.container.textContent).toContain("Sincronizado: 2 eventos aplicados, 1 reserva nueva.");
  });

  it("si otro proceso ya sincroniza el feed, muestra el 409 del servidor", async () => {
    stub({ feeds: [FEED_AIRBNB], sincronizar: () => res({ message: "Este feed ya se está sincronizando. Vuelve a intentar en unos segundos." }, false, 409) });
    rendered = await montar();
    click(botonEn(rendered.container, "Sincronizar ahora")!);
    await esperar();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("ya se está sincronizando");
  });

  it("un rol de solo lectura no ve 'Sincronizar ahora'", async () => {
    stub({ feeds: [FEED_AIRBNB] });
    rendered = await montar("operador:solo_calendario");
    expect(botonEn(rendered.container, "Sincronizar ahora")).toBeUndefined();
  });
});

describe("MonitorSyncPage -- Sincronizar ahora en la tabla de feeds", () => {
  const MONITOR = {
    ahora: "2026-10-07T12:00:00.000Z", zona_horaria: "America/Cancun", resumen_por_canal: [],
    feeds: [{ id: "f1", unidad_id: "u1", unidad_nombre: "Depa 101", canal: "airbnb", activo: true, salud: "ok", ultima_sincronizacion_exitosa_en: "2026-10-07T11:50:00Z", en_cuarentena_desde: null, motivo_cuarentena: null, intentos_fallidos_consecutivos: 0, ultimo_intento_en: null, proximo_intento_en: null }],
    alertas: { disponible: true, abiertas: [] },
    conflictos_abiertos: 0,
  };
  function stubMonitor() {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/unidades/u1/ical-feeds/airbnb/sincronizar")) return res({ canal: "airbnb", ok: true, resultado: "no_modificado", eventos_aplicados: 0, reservas_nuevas: 0, conflictos_detectados: 0 });
      if (url.endsWith("/sync-monitor")) return res(MONITOR);
      if (url.includes("/conflictos?estado=abiertos")) return res({ total_abiertos: 0, conflictos: [] });
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  it("el botón sincroniza el feed de esa fila y recarga el monitor", async () => {
    stubMonitor();
    rendered = renderComponent(<MonitorSyncPage {...ctx()} />);
    await esperar();
    click(botonEn(rendered.container, "Sincronizar ahora")!);
    await esperar();
    expect(llamadasA("/unidades/u1/ical-feeds/airbnb/sincronizar")).toHaveLength(1);
    expect(rendered.container.textContent).toContain("El canal no tiene cambios desde la última vez.");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/sync-monitor")).length).toBeGreaterThanOrEqual(2);
  });

  it("un rol de solo lectura no ve el botón", async () => {
    stubMonitor();
    rendered = renderComponent(<MonitorSyncPage {...ctx("operador:solo_calendario")} />);
    await esperar();
    expect(botonEn(rendered.container, "Sincronizar ahora")).toBeUndefined();
  });
});
