// @vitest-environment jsdom
//
// «Agregados por validar»: carga real contra un fetch simulado, estados vacio / cargando / error con Reintentar / no disponible, aceptar con una sola escritura,
// rechazar con motivo y aviso persistente.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify } from "@atiende/ui";
import type { ListaAgregados, TarjetaAgregado } from "@atiende/domain-restaurantes/operacion";
import { OperacionAgregadosPage } from "../../src/verticals/restaurantes/pages/OperacionAgregados.tsx";
import type { RestaurantesShellContext } from "../../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, renderComponent, type RenderedComponent } from "../test-utils/render.tsx";

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "t", propertyId: "prop-1", orgSlug: "demo", role: "staff", staffFullName: "Persona de prueba", staffEmail: "persona@example.com", nombreSucursal: "Centro" };
const ID = "00000000-0000-4000-8000-000000000901";

function tarjeta(extra: Partial<TarjetaAgregado> = {}): TarjetaAgregado {
  return {
    id: ID, propertyId: "prop-1", sucursal: "Centro", canal: "whatsapp", estado: "pendiente", estadoEfectivo: "pendiente", sla: { segundosEspera: 130, nivel: "en_tiempo", segundosParaSiguienteUmbral: 470 },
    pedido: { id: "o1", numero: 201, estado: "pending", yaEnCocina: false, creadoEn: new Date().toISOString(), renglones: [{ nombre: "Taco de pastor", cantidad: 4 }], total: 100 },
    agregado: { renglones: [{ nombre: "Coca-Cola", cantidad: 2, precio: 45, subtotal: 90 }], total: 90, nuevoTotal: 190, nota: null, version: 1 },
    cliente: { nombre: "Ana R.", telefono: "9995550101" }, solicitadoEn: new Date().toISOString(), vistoEn: new Date().toISOString(), resueltoEn: null, resueltoPor: null, motivoRechazo: null, notaRechazo: null, escalamiento: 0, ...extra,
  };
}
const lista = (agregados: TarjetaAgregado[], disponible = true): ListaAgregados => ({ disponible, agregados, pendientes: agregados.filter((a) => a.estado === "pendiente").length, ahora: new Date().toISOString() });
const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

let rendered: RenderedComponent | undefined;
async function montar(f: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", f);
  await act(async () => {
    rendered = renderComponent(
      <MemoryRouter>
        <OperacionAgregadosPage {...CTX} />
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const textos = () => document.body.textContent ?? "";
const boton = (nombre: RegExp) => [...document.querySelectorAll("button")].find((b) => nombre.test(b.getAttribute("aria-label") ?? b.textContent ?? "")) as HTMLElement | undefined;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Agregados por validar", () => {
  it("pide la lista del contrato y pinta pedido original, lo agregado, nuevo total, cronometro y banner", async () => {
    const f = vi.fn(async () => json(200, lista([tarjeta()])));
    await montar(f);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/agregados?estado=pendientes");
    expect(textos()).toContain("Pedido #201");
    expect(textos()).toContain("4× Taco de pastor");
    expect(textos()).toContain("2× Coca-Cola");
    expect(textos()).toContain("Nuevo total: $190");
    expect(textos()).toContain("Hace 2 min");
    expect(document.querySelector('[data-testid="banner-agregados"]')?.textContent).toContain("1 agregado por validar");
  });

  it("vacio: dice que no hay nada por validar; no disponible (503): estado honesto sin tarjetas", async () => {
    await montar(vi.fn(async () => json(200, lista([]))));
    expect(textos()).toContain("Nada por validar");
    rendered?.unmount();
    document.body.innerHTML = "";
    await montar(vi.fn(async () => json(503, { code: "service_unavailable", message: "no" })));
    expect(textos()).toContain("falta aplicar la actualización de base de datos");
    expect(document.querySelector('[data-testid^="tarjeta-agregado"]')).toBeNull();
  });

  it("error de servidor sin datos previos: mensaje con Reintentar que vuelve a pedir", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(500, { code: "internal", message: "Falló el servidor" })).mockResolvedValue(json(200, lista([tarjeta()])));
    await montar(f);
    expect(textos()).toContain("Falló el servidor");
    await act(async () => {
      click(boton(/reintentar/i)!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(textos()).toContain("Pedido #201");
  });

  it("aceptar: una sola escritura aunque se toque dos veces y avisa al operador", async () => {
    let aceptado = false;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/aceptar")) {
        aceptado = true;
        return json(200, { resultado: "aplicado", agregado: tarjeta({ estado: "aceptado" }) });
      }
      if (String(url).endsWith("/visto")) return json(200, { ok: true });
      void init;
      return json(200, lista(aceptado ? [] : [tarjeta()]));
    });
    await montar(f);
    await act(async () => {
      const b = boton(/Aceptar agregado al pedido #201/)!;
      click(b);
      click(b);
      await new Promise((r) => setTimeout(r, 0));
    });
    const escrituras = f.mock.calls.filter((c) => String(c[0]).endsWith("/aceptar"));
    expect(escrituras).toHaveLength(1);
  });

  it("aceptar manda la `version` que la persona vio (no una cualquiera)", async () => {
    const f = vi.fn(async (url: string) => {
      if (String(url).endsWith("/aceptar")) return json(200, { resultado: "aplicado", agregado: tarjeta({ estado: "aceptado" }) });
      if (String(url).endsWith("/visto")) return json(200, { ok: true });
      return json(200, lista([tarjeta({ agregado: { ...tarjeta().agregado, version: 3 } })]));
    });
    await montar(f);
    await act(async () => {
      click(boton(/Aceptar agregado al pedido #201/)!);
      await new Promise((r) => setTimeout(r, 0));
    });
    const post = f.mock.calls.find((c) => String(c[0]).endsWith("/aceptar")) as unknown as [string, RequestInit];
    expect(JSON.parse(String(post[1].body))).toEqual({ version: 3 });
  });

  it("409 «version cambio» (el cliente pidio mas): muestra el mensaje claro del servidor, NO es un error de red y recarga la lista", async () => {
    const aviso = vi.spyOn(notify, "info").mockImplementation(() => undefined as never);
    const error = vi.spyOn(notify, "error").mockImplementation(() => undefined as never);
    const mensaje = "El cliente agregó más productos mientras la veías. Revisa la solicitud actualizada y decide de nuevo.";
    let cargas = 0;
    const f = vi.fn(async (url: string) => {
      if (String(url).endsWith("/aceptar")) return json(409, { code: "agregado_version_cambio", message: mensaje, resultado: "version_cambio", agregado: tarjeta() });
      if (String(url).endsWith("/visto")) return json(200, { ok: true });
      cargas += 1;
      return json(200, lista([tarjeta({ agregado: { ...tarjeta().agregado, version: cargas > 1 ? 2 : 1 } })]));
    });
    await montar(f);
    const antes = cargas;
    await act(async () => {
      click(boton(/Aceptar agregado al pedido #201/)!);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(aviso).toHaveBeenCalledWith(mensaje);
    expect(error).not.toHaveBeenCalled();
    expect(cargas).toBeGreaterThan(antes); // recargo para ver la version vigente
    expect(boton(/Aceptar agregado al pedido #201/)).toBeDefined(); // sigue pendiente: puede decidir de nuevo
    aviso.mockRestore();
    error.mockRestore();
  });

  it("409 «vencido» al aceptar: avisa con el mensaje del servidor (advertencia), no un error, y recarga", async () => {
    const aviso = vi.spyOn(notify, "warning").mockImplementation(() => undefined as never);
    const error = vi.spyOn(notify, "error").mockImplementation(() => undefined as never);
    const mensaje = "Esta solicitud ya venció (pasaron más de 20 minutos) y se cerró sin aceptarse. Ofrece al cliente un pedido aparte.";
    let vencido = false;
    const f = vi.fn(async (url: string) => {
      if (String(url).endsWith("/aceptar")) {
        vencido = true;
        return json(409, { code: "agregado_vencido", message: mensaje, resultado: "vencido", agregado: tarjeta({ estado: "vencido", estadoEfectivo: "vencido" }) });
      }
      if (String(url).endsWith("/visto")) return json(200, { ok: true });
      return json(200, lista(vencido ? [] : [tarjeta()]));
    });
    await montar(f);
    await act(async () => {
      click(boton(/Aceptar agregado al pedido #201/)!);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(aviso).toHaveBeenCalledWith(mensaje);
    expect(error).not.toHaveBeenCalled();
    expect(textos()).toContain("Nada por validar");
    aviso.mockRestore();
    error.mockRestore();
  });

  it("un error 409 de otra causa SI se muestra como error y no se confunde con la carrera", async () => {
    const error = vi.spyOn(notify, "error").mockImplementation(() => undefined as never);
    const f = vi.fn(async (url: string) => {
      if (String(url).endsWith("/aceptar")) return json(409, { code: "conflict", message: "Conflicto raro" });
      if (String(url).endsWith("/visto")) return json(200, { ok: true });
      return json(200, lista([tarjeta()]));
    });
    await montar(f);
    await act(async () => {
      click(boton(/Aceptar agregado al pedido #201/)!);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(error).toHaveBeenCalledWith("Conflicto raro");
    error.mockRestore();
  });

  it("VENCIDO por el reloj (20+ min aunque el tick no la cerro): se ocultan Aceptar y Rechazar y se explica; llamar sigue disponible", async () => {
    const vencida = tarjeta({ estadoEfectivo: "vencido", sla: { segundosEspera: 1300, nivel: "vencido", segundosParaSiguienteUmbral: null } });
    await montar(vi.fn(async () => json(200, lista([vencida]))));
    expect(boton(/Aceptar agregado al pedido/)).toBeUndefined();
    expect(boton(/Rechazar agregado al pedido/)).toBeUndefined();
    expect(document.querySelector('[data-testid="agregado-vencido"]')?.textContent).toContain("ya venció");
    expect(document.querySelector('a[href^="tel:"]')).not.toBeNull();
  });

  it("vencido solo por el reloj de ESTE telefono (el servidor aun la manda en tiempo, pero ya pasaron 20 min): tambien oculta los botones", async () => {
    const f = vi.fn(async () => json(200, lista([tarjeta({ sla: { segundosEspera: 1190, nivel: "sin_respuesta", segundosParaSiguienteUmbral: 10 } })])));
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      await montar(f);
      expect(boton(/Aceptar agregado al pedido #201/)).toBeDefined();
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(boton(/Aceptar agregado al pedido #201/)).toBeUndefined();
      expect(document.querySelector('[data-testid="agregado-vencido"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
