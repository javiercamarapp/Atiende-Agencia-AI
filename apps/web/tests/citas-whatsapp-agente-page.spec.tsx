// @vitest-environment jsdom
//
// <AgenteWhatsappPage /> (citas): gate por rol, base sin migrar (solo lectura, no un vacio real), estados honestos de la conexion,
// conectar / pausar / desconectar con confirmacion, y flujo revisar -> confirmar -> guardar de la personalidad con version y conflicto.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgenteWhatsappPage } from "../src/verticals/citas/pages/AgenteWhatsapp.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, ok = true, status = ok ? 200 : 500): Response => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const ctx = (role: string): CitasShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role, staffFullName: "Sam", staffEmail: "sam@example.com" }) as CitasShellContext;

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const CONFIG = { agentName: null, toneStyle: null, greetingText: null, rulesText: null };
const OPCIONES = {
  tonos: [
    { valor: "calido_cercano", etiqueta: "Cálido y cercano" },
    { valor: "formal_directo", etiqueta: "Formal y directo" },
  ],
  limites: { agentName: 60, greetingText: 200, rulesMaxLines: 5, ruleLength: 160, rulesText: 800 },
};
const NOTAS = {
  sin_numero: "Todavía no hay un número conectado.",
  pausado: "El número está pausado.",
  sin_credenciales_de_envio: "Falta la credencial de envío de Meta de la plataforma.",
  registrado: "Número registrado. No es una verificación con Meta.",
};

interface Estado {
  disponible?: boolean;
  version?: number;
  numero?: { phoneNumberId: string; activo: boolean } | null;
  estado?: keyof typeof NOTAS;
  put?: (body: Record<string, unknown>) => Response;
  conexionPut?: (body: Record<string, unknown>) => Response;
}
function panel(e: Estado) {
  const estado = e.estado ?? (e.numero ? "registrado" : "sin_numero");
  return {
    disponible: e.disponible ?? true,
    agente: { version: e.version ?? 0, config: CONFIG, actualizadoEn: null, promptDeMuestra: "PROMPT" },
    conexion: { numero: e.numero ?? null, estado, credencialDeEnvioDisponible: estado === "registrado", nota: NOTAS[estado] },
    opciones: OPCIONES,
  };
}
function stub(e: Estado = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    if (url.endsWith("/vista-previa")) return json({ prompt: "PROMPT COMPLETO DE MUESTRA", diferencias: [{ campo: "Nombre del agente", antes: "", despues: "Sofi" }], version: e.version ?? 0 });
    if (url.endsWith("/restablecer")) return json({ disponible: true, agente: panel(e).agente });
    if (url.endsWith("/conexion")) {
      if (metodo === "PUT") return e.conexionPut ? e.conexionPut(JSON.parse(String(init?.body))) : json({ conexion: panel(e).conexion });
      return json({ conexion: panel({ ...e, numero: null }).conexion });
    }
    if (metodo === "PUT") return e.put ? e.put(JSON.parse(String(init?.body))) : json({ disponible: true, agente: panel(e).agente });
    return json(panel(e));
  });
  vi.stubGlobal("fetch", fetchMock);
}

const boton = (texto: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
const input = (placeholder: string) => rendered!.container.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement;
const llamadas = (metodo: string, sufijo: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(sufijo) && ((c[1] as RequestInit | undefined)?.method ?? "GET") === metodo);

describe("AgenteWhatsappPage (citas)", () => {
  it("rol staff: no edita y no hace ninguna llamada de red", async () => {
    stub();
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("staff")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Solo los roles");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("base sin migrar: avisa que no esta disponible y deshabilita numero, campos y 'Revisar cambios'", async () => {
    stub({ disponible: false });
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("owner")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Edición todavía no disponible");
    expect(input("109876543210987").disabled).toBe(true);
    expect(rendered.container.querySelector("textarea")?.hasAttribute("disabled")).toBe(true);
    expect(boton("Revisar cambios")?.disabled).toBe(true);
  });

  it("error de carga: muestra el error con reintento (no una pantalla vacia)", async () => {
    fetchMock = vi.fn(async () => json({ message: "boom" }, false, 500));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("owner")} />);
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo");
  });

  it("estado honesto de la conexion: cada estado muestra lo que dice la API, y 'registrado' nunca afirma verificacion con Meta", async () => {
    for (const [estado, etiqueta] of [["sin_numero", "Sin número"], ["pausado", "Pausado"], ["sin_credenciales_de_envio", "Registrado, sin envío"], ["registrado", "Registrado"]] as const) {
      stub({ estado, numero: estado === "sin_numero" ? null : { phoneNumberId: "109876543210987", activo: estado !== "pausado" } });
      rendered = renderComponent(<AgenteWhatsappPage {...ctx("owner")} />);
      await esperar();
      const texto = rendered.container.textContent ?? "";
      expect(texto).toContain(etiqueta);
      expect(texto).toContain(NOTAS[estado]);
      rendered.unmount();
    }
    expect(NOTAS.registrado).toContain("No es una verificación con Meta");
  });

  it("sin numero: 'Conectar número' queda deshabilitado hasta escribir un identificador y manda activo=true", async () => {
    stub();
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("owner")} />);
    await esperar();
    expect(boton("Desconectar")).toBeUndefined();
    expect(boton("Conectar número")?.disabled).toBe(true);
    changeValue(input("109876543210987"), "109 876 543 210 987");
    expect(input("109876543210987").value).toBe("109876543210987");
    click(boton("Conectar número")!);
    await esperar();
    const put = llamadas("PUT", "/conexion");
    expect(put).toHaveLength(1);
    expect(JSON.parse(String((put[0]![1] as RequestInit).body))).toEqual({ phoneNumberId: "109876543210987", activo: true });
    expect(rendered.container.textContent).toContain("Número guardado.");
  });

  it("un numero ya conectado a otro negocio (409) muestra el error y no recarga como si hubiera pasado", async () => {
    stub({ conexionPut: () => json({ message: "Ese número ya está conectado a otro negocio." }, false, 409) });
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("owner")} />);
    await esperar();
    changeValue(input("109876543210987"), "109876543210987");
    click(boton("Conectar número")!);
    await esperar();
    expect(rendered.container.textContent).toContain("ya está conectado a otro negocio");
    expect(llamadas("GET", "/whatsapp-agente")).toHaveLength(1);
  });

  it("con numero: 'Guardar número' solo se habilita con un cambio, y 'Desconectar' pide confirmacion antes de llamar", async () => {
    stub({ numero: { phoneNumberId: "109876543210987", activo: true } });
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("admin")} />);
    await esperar();
    expect(input("109876543210987").value).toBe("109876543210987");
    expect(boton("Guardar número")?.disabled).toBe(true);
    click(rendered.container.querySelector('[role="switch"]')!);
    expect(boton("Guardar número")?.disabled).toBe(false);

    click(boton("Desconectar")!);
    await esperar();
    expect(llamadas("DELETE", "/conexion")).toHaveLength(0); // todavia no confirmo
    const confirmar = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Desconectar").pop()!;
    click(confirmar);
    await esperar();
    expect(llamadas("DELETE", "/conexion")).toHaveLength(1);
    expect(rendered.container.textContent).toContain("Número desconectado.");
  });

  it("revisar -> confirmar y guardar manda la version vista, muestra las diferencias y el prompt, y recarga lo vigente", async () => {
    const puts: Record<string, unknown>[] = [];
    stub({ version: 2, put: (b) => (puts.push(b), json({ disponible: true, agente: panel({ version: 3 }).agente })) });
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("owner")} />);
    await esperar();
    expect(boton("Revisar cambios")?.disabled).toBe(true); // sin cambios no se ofrece revisar
    changeValue(input("Sofi"), "Sofi");
    expect(boton("Revisar cambios")?.disabled).toBe(false);
    click(boton("Revisar cambios")!);
    await esperar();
    expect(rendered.container.textContent).toContain("Nombre del agente");
    expect(rendered.container.textContent).toContain("PROMPT COMPLETO DE MUESTRA");
    click(boton("Confirmar y guardar")!);
    await esperar();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ agentName: "Sofi", toneStyle: null, versionEsperada: 2 });
    expect(rendered.container.textContent).toContain("Guardado.");
    expect(llamadas("GET", "/whatsapp-agente")).toHaveLength(2); // carga inicial + recarga
  });

  it("un cambio en el formulario descarta la vista previa vieja (no se guarda algo que no se reviso)", async () => {
    stub();
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("owner")} />);
    await esperar();
    changeValue(input("Sofi"), "Sofi");
    click(boton("Revisar cambios")!);
    await esperar();
    expect(boton("Confirmar y guardar")).toBeDefined();
    changeValue(input("Sofi"), "Sofia");
    expect(boton("Confirmar y guardar")).toBeUndefined();
  });

  it("conflicto 409: muestra el aviso con 'Recargar lo vigente' y no recarga solo", async () => {
    stub({ put: () => json({ message: "La configuración cambió mientras la editabas. Recarga la página y vuelve a intentar." }, false, 409) });
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("owner")} />);
    await esperar();
    changeValue(input("Sofi"), "Sofi");
    click(boton("Revisar cambios")!);
    await esperar();
    click(boton("Confirmar y guardar")!);
    await esperar();
    expect(rendered.container.textContent).toContain("cambió mientras");
    expect(boton("Recargar lo vigente")).toBeDefined();
    expect(llamadas("GET", "/whatsapp-agente")).toHaveLength(1);
  });

  it("'Volver a los valores por defecto' solo aparece con una version guardada y pide confirmacion antes de restablecer", async () => {
    stub({ version: 0 });
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("admin")} />);
    await esperar();
    expect(boton("Volver a los valores por defecto")).toBeUndefined();
    rendered.unmount();

    stub({ version: 2 });
    rendered = renderComponent(<AgenteWhatsappPage {...ctx("admin")} />);
    await esperar();
    click(boton("Volver a los valores por defecto")!);
    await esperar();
    expect(llamadas("POST", "/restablecer")).toHaveLength(0);
    const confirmar = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Volver a los valores por defecto").pop()!;
    click(confirmar);
    await esperar();
    expect(llamadas("POST", "/restablecer")).toHaveLength(1);
    expect(JSON.parse(String((llamadas("POST", "/restablecer")[0]![1] as RequestInit).body))).toEqual({ versionEsperada: 2 });
  });
});
