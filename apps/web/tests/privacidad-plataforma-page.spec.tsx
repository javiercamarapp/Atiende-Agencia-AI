// @vitest-environment jsdom
// Privacidad de plataforma (PL-13): pantalla por organizacion (owner/admin) y de superadmin (solo lectura).
// fetch simulado; cubre estados (cargando, no disponible, 403, error), plazos, retencion, bloqueo, aviso y
// que NUNCA se pinten datos del titular.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacidadOrganizacionPage } from "../src/pages/PrivacidadOrganizacion.tsx";
import { SuperAdminPrivacidadPage } from "../src/superadmin/pages/Privacidad.tsx";
import { textoPlazo } from "../src/lib/privacidad-plataforma.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;
const esperar = () =>
  act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const solicitud = (id: string, estadoPlazo: "vencida" | "en_plazo" | "cerrada", extra: Record<string, unknown> = {}) => ({
  vertical: "hoteles",
  id,
  referencia: id.slice(0, 8).toUpperCase(),
  derecho: "acceso",
  canal: "web",
  estado: estadoPlazo === "cerrada" ? "resuelta" : "abierta",
  estadoOriginal: "recibida",
  abiertaEnMs: Date.UTC(2026, 8, 1),
  respuestaVenceEnMs: null,
  ejecucionVenceEnMs: null,
  resueltaEnMs: null,
  abierta: estadoPlazo !== "cerrada",
  plazo: { estado: estadoPlazo, diasRestantes: estadoPlazo === "vencida" ? -3 : estadoPlazo === "en_plazo" ? 12 : null, venceEnMs: null },
  ...extra,
});

const RESUMEN_ORG = {
  disponible: true,
  plazos: { respuestaDias: 20, ejecucionDias: 15, porVencerDias: 5 },
  arco: { total: 2, solicitudes: [solicitud("aaaaaaaa-1111-4111-8111-111111111111", "vencida"), solicitud("bbbbbbbb-2222-4222-8222-222222222222", "en_plazo")] },
  retencion: [
    { claseDato: "restaurantes_whatsapp_conversaciones", vertical: "restaurantes", descripcion: "Mensajes de WhatsApp.", ejecuta: "plataforma", defectoDias: 180, minimoDias: 30, maximoDias: 1095, diasEfectivos: 180, origen: "defecto" },
    { claseDato: "hoteles_identidad_documento", vertical: "hoteles", descripcion: "Documento del huésped.", ejecuta: "vertical", defectoDias: 30, minimoDias: 0, maximoDias: 365, diasEfectivos: 30, origen: "defecto" },
  ],
  bloqueos: [{ id: "h1", claseDato: null, motivo: "Requerimiento de autoridad", colocadoEnMs: Date.UTC(2026, 8, 2), liberadoEnMs: null, notaLiberacion: null, activo: true }],
  purgas: [{ seq: 1, claseDato: "restaurantes_whatsapp_conversaciones", estado: "bloqueada", retencionDias: 180, corteEnMs: null, filasAfectadas: 0, filasAnonimizadas: 0, filasProtegidas: 0, motivoBloqueo: "retencion_legal_activa", ocurrioEnMs: Date.UTC(2026, 8, 3) }],
  avisos: [{ version: 2, titulo: "Aviso", resumen: "Usamos tus datos para tu pedido.", url: "https://ejemplo.mx/aviso", huellaSha256: "0".repeat(64), publicadoEnMs: Date.UTC(2026, 8, 4), aceptaciones: 1, aceptadoPorMi: false, vigente: true }],
};

function stubOrg(resumen: unknown, calls: Array<{ url: string; method: string; body: unknown }> = [], resumenOk = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return json({});
      }
      return json(resumen, resumenOk);
    }),
  );
  return calls;
}

describe("textoPlazo", () => {
  it("redacta vencimientos en singular y plural", () => {
    expect(textoPlazo({ estado: "vencida", diasRestantes: -1, venceEnMs: 1 })).toBe("Venció hace 1 día");
    expect(textoPlazo({ estado: "vencida", diasRestantes: -4, venceEnMs: 1 })).toBe("Venció hace 4 días");
    expect(textoPlazo({ estado: "vencida", diasRestantes: 0, venceEnMs: 1 })).toBe("Venció hoy");
    expect(textoPlazo({ estado: "por_vencer", diasRestantes: 0, venceEnMs: 1 })).toBe("Vence hoy");
    expect(textoPlazo({ estado: "en_plazo", diasRestantes: 1, venceEnMs: 1 })).toBe("Vence en 1 día");
    expect(textoPlazo({ estado: "en_plazo", diasRestantes: null, venceEnMs: null })).toBe("Sin plazo registrado");
    expect(textoPlazo({ estado: "cerrada", diasRestantes: null, venceEnMs: null })).toBe("—");
  });
});

describe("PrivacidadOrganizacionPage", () => {
  it("muestra cargando y luego ARCO con plazos, retencion con su defecto, bloqueo, purgas y aviso", async () => {
    stubOrg(RESUMEN_ORG);
    rendered = renderComponent(<PrivacidadOrganizacionPage apiBaseUrl="https://api.test" token="tok" />);
    expect(rendered.container.textContent).toContain("Cargando privacidad");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("20 días para responder y 15 más para ejecutar");
    expect(t).toContain("1 vencida");
    expect(t).toContain("AAAAAAAA");
    expect(t).toContain("Venció hace 3 días");
    expect(t).toContain("Vence en 12 días");
    expect(t).toContain("Defecto 180 días · rango 30 a 1095 · hoy 180 días (Valor por defecto)");
    expect(t).toContain("La purga de esta clase la corre el propio vertical");
    expect(t).toContain("Hay purgas detenidas por retención legal");
    expect(t).toContain("Todas las clases");
    expect(t).toContain("Bloqueada");
    expect(t).toContain("Versión 2");
    expect(t).toContain("Falta tu aceptación de la versión 2");
    expect(t).toContain("no asesoría legal");
    expect(t).not.toMatch(/tel[eé]fono|correo del titular|\+52/iu);
  });

  it("403 de la API: mensaje de que solo owner/admin administra la privacidad", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Solo el owner o un admin de la organización puede administrar la privacidad." }, false)));
    rendered = renderComponent(<PrivacidadOrganizacionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("Solo el owner o un admin");
  });

  it("error de red: pantalla de error con reintento", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "falla" }, false)));
    rendered = renderComponent(<PrivacidadOrganizacionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar la privacidad de la organización");
  });

  it("base sin migrar: aviso honesto y ningun formulario", async () => {
    stubOrg({ disponible: false, mensaje: "x" });
    rendered = renderComponent(<PrivacidadOrganizacionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("migración 0036 pendiente");
    expect(rendered.container.querySelector("form")).toBeNull();
  });

  it("guardar la politica manda PUT con los dias y recarga", async () => {
    const calls = stubOrg(RESUMEN_ORG);
    rendered = renderComponent(<PrivacidadOrganizacionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    const input = rendered.container.querySelector<HTMLInputElement>('input[type="number"]')!;
    changeValue(input, "90");
    const guardar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Guardar")!;
    click(guardar);
    await esperar();
    expect(calls).toEqual([{ url: "https://api.test/v1/privacidad/retencion/restaurantes_whatsapp_conversaciones", method: "PUT", body: { dias: 90 } }]);
  });

  it("solo la clase que ejecuta la plataforma es editable (la del vertical no tiene campo ni boton)", async () => {
    stubOrg(RESUMEN_ORG);
    rendered = renderComponent(<PrivacidadOrganizacionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.querySelectorAll('input[type="number"]')).toHaveLength(1);
  });

  it("colocar un bloqueo exige motivo de 10 caracteres y manda claseDato null para 'todas'", async () => {
    const calls = stubOrg(RESUMEN_ORG);
    rendered = renderComponent(<PrivacidadOrganizacionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Colocar bloqueo")!;
    expect(boton.disabled).toBe(true);
    const motivo = [...rendered.container.querySelectorAll("textarea")].find((t) => t.getAttribute("placeholder")?.includes("Requerimiento"))!;
    changeValue(motivo, "Requerimiento de autoridad nuevo");
    expect(boton.disabled).toBe(false);
    const form = boton.closest("form")!;
    await submitForm(form);
    await esperar();
    expect(calls).toEqual([{ url: "https://api.test/v1/privacidad/bloqueos", method: "POST", body: { claseDato: null, motivo: "Requerimiento de autoridad nuevo" } }]);
  });

  it("liberar un bloqueo activo manda POST a /liberar", async () => {
    const calls = stubOrg(RESUMEN_ORG);
    rendered = renderComponent(<PrivacidadOrganizacionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Liberar")!);
    await esperar();
    expect(calls[0]).toEqual({ url: "https://api.test/v1/privacidad/bloqueos/h1/liberar", method: "POST", body: {} });
  });

  it("publicar un aviso solo se habilita con https y campos validos, y acepta la version vigente", async () => {
    const calls = stubOrg(RESUMEN_ORG);
    rendered = renderComponent(<PrivacidadOrganizacionPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    const publicar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Publicar nueva versión")!;
    expect(publicar.disabled).toBe(true);
    const campos = publicar.closest("form")!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    changeValue(campos[0]!, "Aviso de privacidad");
    changeValue(campos[1]!, "Usamos tus datos para atender tu pedido.");
    changeValue(campos[2]!, "http://inseguro.mx/aviso");
    expect(publicar.disabled).toBe(true);
    changeValue(campos[2]!, "https://ejemplo.mx/aviso");
    expect(publicar.disabled).toBe(false);
    await submitForm(publicar.closest("form")!);
    await esperar();
    expect(calls[0]).toEqual({ url: "https://api.test/v1/privacidad/avisos", method: "POST", body: { titulo: "Aviso de privacidad", resumen: "Usamos tus datos para atender tu pedido.", url: "https://ejemplo.mx/aviso" } });
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Aceptar versión 2")!);
    await esperar();
    expect(calls[1]).toEqual({ url: "https://api.test/v1/privacidad/avisos/2/aceptar", method: "POST", body: {} });
  });
});

describe("SuperAdminPrivacidadPage", () => {
  const RESUMEN_SA = {
    disponible: true,
    total: 2,
    organizaciones: [
      { organizacionId: "o1", organizacion: "Org Uno", vertical: "restaurantes", arcoAbiertas: 3, arcoVencidas: 2, avisoVersion: null, avisoAceptaciones: 0, bloqueosActivos: 1, ultimaPurgaEnMs: Date.UTC(2026, 8, 3), ultimaPurgaEstado: "ok" },
      { organizacionId: "o2", organizacion: "Org Dos", vertical: "hoteles", arcoAbiertas: 0, arcoVencidas: 0, avisoVersion: 3, avisoAceptaciones: 2, bloqueosActivos: 0, ultimaPurgaEnMs: null, ultimaPurgaEstado: null },
    ],
  };
  const ARCO_SA = {
    disponible: true,
    plazos: { respuestaDias: 20, ejecucionDias: 15, porVencerDias: 5 },
    total: 2,
    solicitudes: [solicitud("cccccccc-1111-4111-8111-111111111111", "vencida", { organizacion: "Org Uno" }), solicitud("dddddddd-2222-4222-8222-222222222222", "en_plazo", { organizacion: "Org Dos" })],
  };
  const PURGAS_SA = { disponible: true, purgas: [{ seq: 5, organizacionId: "o1", organizacion: "Org Uno", claseDato: "restaurantes_voz_transcripciones", estado: "ok", retencionDias: 30, corteEnMs: null, filasAfectadas: 4, filasAnonimizadas: 1, filasProtegidas: 2, motivoBloqueo: null, ocurrioEnMs: Date.UTC(2026, 8, 3) }] };

  function stubSa(over: { resumen?: unknown; arco?: unknown; purgas?: unknown } = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/resumen")) return json(over.resumen ?? RESUMEN_SA);
        if (url.includes("/arco")) return json(over.arco ?? ARCO_SA);
        return json(over.purgas ?? PURGAS_SA);
      }),
    );
  }

  it("resumen por organizacion con vencidas, aviso, bloqueos y ultima purga; aviso de vencidas arriba", async () => {
    stubSa();
    rendered = renderComponent(<SuperAdminPrivacidadPage apiBaseUrl="https://api.test" token="tok" />);
    expect(rendered.container.textContent).toContain("Cargando privacidad");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("2 solicitudes ARCO vencidas");
    expect(t).toContain("Org Uno");
    expect(t).toContain("Sin aviso");
    expect(t).toContain("Versión 3 (2 aceptaciones)");
    expect(t).toContain("1 activo");
    expect(t).toContain("Ejecutada");
    expect(t).toContain("Solo lectura");
  });

  it("base sin migrar: aviso honesto", async () => {
    stubSa({ resumen: { disponible: false, mensaje: "x", total: 0, organizaciones: [] } });
    rendered = renderComponent(<SuperAdminPrivacidadPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("migración 0036 pendiente");
  });

  it("error de carga: pantalla de error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, false)));
    rendered = renderComponent(<SuperAdminPrivacidadPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar la privacidad de plataforma");
  });

  it("la pestana ARCO lista las solicitudes con su plazo y filtra solo vencidas", async () => {
    stubSa();
    rendered = renderComponent(<SuperAdminPrivacidadPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    const tab = [...rendered.container.querySelectorAll('[role="tab"]')].find((b) => b.textContent === "Solicitudes ARCO")!;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("CCCCCCCC");
    expect(t).toContain("DDDDDDDD");
    const check = rendered.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    click(check);
    expect(rendered.container.textContent).not.toContain("DDDDDDDD");
    expect(rendered.container.textContent).toContain("CCCCCCCC");
    expect(t).not.toMatch(/tel[eé]fono|\+52/iu);
  });
});
