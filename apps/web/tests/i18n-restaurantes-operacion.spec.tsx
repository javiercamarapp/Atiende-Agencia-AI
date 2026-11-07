// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes, operacion del dia (Cola, Turno, Nuevo pedido, Viajes, Agregados). Con la consola en espanol el DOM es identico al
// de sin proveedor; con EN (diseno ds3) la cola sale en ingles natural, sin claves crudas, y los datos del cliente quedan tal cual. Las etiquetas
// de los lib/*.ts del panel siguen al idioma activo. El guion de consentimiento que se lee al cliente final se queda en espanol.
import { act } from "react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColaSalida, TarjetaPedido } from "@atiende/domain-restaurantes/operacion";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { OperacionColaPage } from "../src/verticals/restaurantes/pages/OperacionCola.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { ETIQUETA_ESTADO, OPCIONES_RECHAZO, textoCronometro, textoPendientes } from "../src/verticals/restaurantes/lib/agregados-presentacion.ts";
import { GUION_CONSENTIMIENTO, faltantes, formularioVacio, textoAviso } from "../src/verticals/restaurantes/lib/captura-pedido.ts";
import { PESTANAS_COLA, etiquetaOrigen } from "../src/verticals/restaurantes/lib/operacion-presentacion.ts";
import { ETIQUETA_SEMAFORO, textoMinutos } from "../src/verticals/restaurantes/lib/semaforo.ts";
import { alertasTurno, etiquetaCanal } from "../src/verticals/restaurantes/lib/turno-hoy.ts";
import { mensajesLote, textoBotonSalio } from "../src/verticals/restaurantes/lib/viajes.ts";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "t", propertyId: "prop-1", orgSlug: "demo", role: "staff", staffFullName: "Persona de prueba", staffEmail: "persona@example.test", nombreSucursal: "Sucursal de prueba" };

const PEDIDO: TarjetaPedido = {
  id: "00000000-0000-4000-8000-000000000001", numero: 1150, estado: "pending", canal: "domicilio", origen: "whatsapp", clienteNombre: "Cliente de prueba", resumenItems: "4 taquitos pastor", total: 708,
  creadoEn: "2026-11-07T18:00:00.000Z", aceptadoEn: null, listoAt: null, salioAt: null, minutos: 2, semaforo: "verde", repartidorId: null, sinAviso: true, accionesDisponibles: ["aceptar", "cancelar"],
};
const COLA: ColaSalida = { pedidos: [PEDIDO], conteos: {}, actualizadoEn: "2026-11-07T18:02:00.000Z" };

let rendered: RenderedComponent | undefined;

beforeAll(() => cargarIdioma("en"));
beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.dataset.diseno = "ds3";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(COLA), { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  fijarIdiomaActivo("es");
  delete document.documentElement.dataset.diseno;
});

async function montar(el: ReactElement): Promise<HTMLElement> {
  await act(async () => {
    rendered = renderComponent(<MemoryRouter>{el}</MemoryRouter>);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return rendered!.container;
}

/** Sin lo que cambia entre un montaje y otro: la hora relativa («Actualizado hace…») y los ids que genera Radix (`radix-:r5:`). */
const htmlEstable = (c: HTMLElement) => c.innerHTML.replace(/Actualizado [^<]*/g, "").replace(/radix-:r\w+:/g, "radix-id");

describe("Cola del encargado ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const sin = htmlEstable(await montar(<OperacionColaPage {...CTX} />));
    rendered?.unmount();
    rendered = undefined;
    const con = htmlEstable(
      await montar(
        <IdiomaProvider idiomaInicial="es">
          <OperacionColaPage {...CTX} />
        </IdiomaProvider>,
      ),
    );
    expect(con).toBe(sin);
    expect(sin).toContain("Pedido nuevo #1150");
    expect(sin).toContain("Sin aviso al cliente: llamar");
  });

  it("en ingles la cola sale en ingles, sin claves crudas, con los datos del cliente tal cual", async () => {
    const c = await montar(
      <IdiomaProvider idiomaInicial="en">
        <OperacionColaPage {...CTX} />
      </IdiomaProvider>,
    );
    const texto = c.textContent ?? "";
    for (const en of ["New order #1150", "Customer not notified: call them", "Accept", "Turn on sound and keep the screen on", "New", "Preparing", "Ready", "On the way", "Delivery"]) expect(texto, en).toContain(en);
    for (const es of ["Pedido nuevo", "Sin aviso al cliente", "Aceptar", "Activar sonido", "En preparación", "Domicilio", "Esperando"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("Cliente de prueba");
    expect(texto).toContain("4 taquitos pastor");
    expect(c.innerHTML).not.toMatch(/\brestaurantes\.[a-z]+\.[A-Za-z0-9.]+/);
  });
});

describe("etiquetas de lib/ del panel del operador", () => {
  it("en espanol son los textos de siempre", () => {
    expect(PESTANAS_COLA.map((p) => p.etiqueta)).toEqual(["Nuevos", "En preparación", "Listos", "En camino"]);
    expect(etiquetaOrigen("voice")).toBe("Voz");
    expect(etiquetaOrigen("desconocido")).toBe("desconocido");
    expect(ETIQUETA_SEMAFORO.rojo).toBe("Atrasado");
    expect(textoMinutos(65)).toBe("1 h 05 min");
    expect(etiquetaCanal("mostrador")).toBe("Mostrador");
    expect(alertasTurno({ enCaminoMas90: [{ pedidoId: "a", numero: 1200, minutos: 95 }], sinAceptar: [] } as never)[0]?.texto).toBe("#1200 lleva 95 min en camino");
    expect(textoBotonSalio(1)).toBe("Salió (1 pedido)");
    expect(textoBotonSalio(3)).toBe("Salió (3 pedidos)");
    expect(mensajesLote({ salieron: [7], yaEstaban: [8, 9], reasignados: [], sinRespuesta: [], sinAviso: 2 }, "Juan")).toEqual({
      exito: "El pedido #7 salió con Juan.",
      atencion: ["#8, #9 ya estaban en camino con Juan.", "2 clientes quedaron sin aviso por WhatsApp: avísales por llamada."],
    });
    expect(OPCIONES_RECHAZO[0]?.etiqueta).toBe("Ya salió de cocina");
    expect(ETIQUETA_ESTADO.vencido).toBe("Vencido sin respuesta");
    expect(textoCronometro(130)).toBe("Hace 2 min 10 s");
    expect(textoPendientes(1)).toBe("1 agregado por validar");
    expect(faltantes(formularioVacio("p"), null, null)[0]).toBe("Teléfono de 10 dígitos");
    expect(textoAviso({ estado: "omitido", motivo: "sin_telefono" })).toBe("sin aviso por WhatsApp (sin teléfono): avísale al cliente por llamada");
  });

  it("en ingles siguen al idioma activo; el guion que oye el cliente se queda en espanol", () => {
    fijarIdiomaActivo("en");
    expect(PESTANAS_COLA.map((p) => p.etiqueta)).toEqual(["New", "Preparing", "Ready", "On the way"]);
    expect(ETIQUETA_SEMAFORO.rojo).toBe("Late");
    expect(alertasTurno({ enCaminoMas90: [{ pedidoId: "a", numero: 1200, minutos: 95 }], sinAceptar: [] } as never)[0]?.texto).toBe("#1200 has been on the way for 95 min");
    expect(textoBotonSalio(3)).toBe("Sent out (3 orders)");
    expect(OPCIONES_RECHAZO[1]?.etiqueta).toBe("Item sold out");
    expect(textoPendientes(2)).toBe("2 add-ons to review");
    expect(textoAviso({ estado: "encolado", motivo: null })).toBe("WhatsApp notice on its way");
    expect(GUION_CONSENTIMIENTO).toBe("Le mandamos el aviso de su pedido por WhatsApp a este número, ¿está bien?");
  });
});
