// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes, pantalla del repartidor (Mis entregas del panel nuevo y de la vista anterior, tarjeta de entrega, confirmar,
// «No pude entregar», Historial del dia y acceso por celular). Con la consola en espanol el DOM es identico al de sin proveedor; con EN
// (diseno ds3) sale en ingles natural, sin claves crudas, y los datos del cliente (nombre, direccion, indicaciones, productos) quedan tal
// cual. Los mensajes de respaldo de lib/ siguen al idioma activo; el `message` que manda el servidor se muestra sin traducir.
import { act } from "react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntregaChofer } from "@atiende/domain-restaurantes/operacion";
import { esquemaEntregasChoferSalida } from "@atiende/domain-restaurantes/operacion";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { HistorialDiaTab } from "../src/verticals/restaurantes/components/RepartidorPestanas.tsx";
import { ConfirmarEntrega } from "../src/verticals/restaurantes/components/chofer/ConfirmarEntrega.tsx";
import { MisEntregas } from "../src/verticals/restaurantes/components/chofer/MisEntregas.tsx";
import { ReportarProblema } from "../src/verticals/restaurantes/components/chofer/ReportarProblema.tsx";
import { ETIQUETA_MOTIVO_PROBLEMA } from "../src/verticals/restaurantes/lib/chofer-entregas.ts";
import { solicitarCodigoCelular, verificarCodigoCelular } from "../src/verticals/restaurantes/lib/login-telefono-client.ts";
import { pedirContrato } from "../src/verticals/restaurantes/lib/repartidor-client.ts";
import { AccesoRepartidorPage } from "../src/verticals/restaurantes/pages/AccesoRepartidor.tsx";
import { RepartidorPedidosView } from "../src/verticals/restaurantes/pages/Repartidor.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const API = "https://api.test";
const BASE = `${API}/v1/restaurantes/prop-1/repartidor`;

const ENTREGA: EntregaChofer = {
  id: "00000000-0000-4000-8000-000000000145",
  numero: 145,
  estado: "en_camino",
  clienteNombre: "Ana R.",
  direccion: { texto: "Calle 60 #320", colonia: "Centro" },
  indicaciones: "Portón negro",
  total: 708,
  pago: { forma: "efectivo", pagaCon: 1000 },
  resumenItems: "4 taquitos al pastor",
  totalPiezas: 4,
  salioAt: null,
  etaAt: null,
  minutos: 22,
  semaforo: "verde",
} as EntregaChofer;

const HISTORIAL = {
  fecha: "2026-11-07",
  zonaHoraria: "America/Merida",
  entregas: [{ id: "h1", customerName: "Marisol Pech", deliveredAt: null, paymentMethod: null, total: 250 }],
  totales: { pedidos: 1, totalCentavos: 25000, efectivoCentavos: 0, efectivoPedidos: 0, tarjetaCentavos: 0, sinMetodoPedidos: 2 },
};

const PEDIDO_LEGADO = {
  id: "o1", propertyId: "prop-1", branch: null, customerName: "Ana R.", customerPhone: "***4567", customerAddress: "Calle 60 #320", total: 708, status: "en_camino",
  items: [{ id: "i1", name: "Taquitos al pastor", price: 177, quantity: 4 }], notes: null, paymentMethod: "efectivo", estimatedDeliveryAt: null, incidentNote: null, createdAt: "2026-11-07T18:00:00.000Z",
};

const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

function servidor(url: string): Response {
  if (url === `${BASE}/entregas`) return json(200, { entregas: [ENTREGA], actualizadoEn: "2026-11-07T18:00:00.000Z" });
  if (url === `${BASE}/historial-dia`) return json(200, HISTORIAL);
  if (url === `${BASE}/orders`) return json(200, { orders: [PEDIDO_LEGADO] });
  if (url.endsWith("/auth/login-telefono/estado")) return json(200, { disponible: true });
  return json(404, { code: "not_found", message: "?" });
}
const fetchSimulado = vi.fn(async (url: string | URL) => servidor(String(url))) as unknown as typeof fetch;

let rendered: RenderedComponent | undefined;

beforeAll(() => cargarIdioma("en"));
beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.dataset.diseno = "ds3";
  vi.stubGlobal("fetch", fetchSimulado);
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
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return rendered!.container;
}

/** Sin lo que cambia entre un montaje y otro: la hora relativa («Actualizado hace…») y los ids que genera Radix (`radix-:r5:`). */
const htmlEstable = (c: HTMLElement) => c.innerHTML.replace(/Actualizado [^<]*/g, "").replace(/radix-:r\w+:/g, "radix-id").replace(/campo-r\w+/g, "campo-id");

async function mismoDomEnEspanol(crear: () => ReactElement): Promise<string> {
  const sin = htmlEstable(await montar(crear()));
  rendered?.unmount();
  rendered = undefined;
  const con = htmlEstable(await montar(<IdiomaProvider idiomaInicial="es">{crear()}</IdiomaProvider>));
  expect(con).toBe(sin);
  return sin;
}

const sinClavesCrudas = (html: string) => expect(html).not.toMatch(/\brestaurantes\.[a-z]+[A-Za-z]*\.[A-Za-z0-9.]+/);
const enIngles = (el: ReactElement) => montar(<IdiomaProvider idiomaInicial="en">{el}</IdiomaProvider>);

const misEntregas = () => <MisEntregas apiBaseUrl={API} token="tok" propertyId="prop-1" fetchImpl={fetchSimulado} identidad="ana@example.test" almacen={null} />;

describe("Mis entregas del chofer ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const html = await mismoDomEnEspanol(misEntregas);
    for (const es of ["1 entrega en camino", "Total $708.00", "Paga con $1,000.00 · cambio $292.00", "4 piezas · 4 taquitos al pastor", "Indicaciones: Portón negro", 'aria-label="Pedido 145"', "No pude entregar"]) expect(html, es).toContain(es);
  });

  it("en ingles la tarjeta sale en ingles con los datos del cliente tal cual", async () => {
    const c = await enIngles(misEntregas());
    const texto = c.textContent ?? "";
    for (const en of ["1 delivery on the way", "Total: $", "Pays with $", " · change $", "4 items · 4 taquitos al pastor", "Directions: Portón negro", "Cash", "Navigate", "Call", "Delivered", "Couldn't deliver", "Refresh", "22 min"]) expect(texto, en).toContain(en);
    for (const es of ["entrega en camino", "Paga con", "cambio", "piezas", "Indicaciones", "Efectivo", "Navegar", "Llamar", "Entregado", "No pude entregar", "Actualizar"]) expect(texto, es).not.toContain(es);
    expect(c.querySelector('article[aria-label="Order 145"]')).not.toBeNull();
    expect(c.querySelector('[aria-label="Delivered, order 145"]')).not.toBeNull();
    expect(texto).toContain("Ana R.");
    expect(texto).toContain("Calle 60 #320, Centro");
    sinClavesCrudas(c.innerHTML);
  });
});

describe("Historial del dia ES/EN", () => {
  const historial = () => <HistorialDiaTab apiBaseUrl={API} token="tok" propertyId="prop-1" fetchImpl={fetchSimulado} />;

  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const html = await mismoDomEnEspanol(historial);
    for (const es of ["Entregados hoy", "Ningún pedido pagado en efectivo", "2 pedidos entregados hoy no tienen método de pago registrado: no se suman al efectivo a rendir. Confírmalo con administración.", "Sin método"]) expect(html, es).toContain(es);
  });

  it("en ingles los totales y avisos salen en ingles", async () => {
    const c = await enIngles(historial());
    const texto = c.textContent ?? "";
    for (const en of ["Delivered today", "Cash to hand in", "No orders paid in cash", "Paid by card", "2 orders delivered today have no payment method on file", "No method", "Delivered"]) expect(texto, en).toContain(en);
    for (const es of ["Entregados hoy", "Efectivo a rendir", "Ningún pedido", "Pagado con tarjeta", "Sin método"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("Marisol Pech");
    sinClavesCrudas(c.innerHTML);
  });
});

describe("vista anterior del repartidor ES/EN", () => {
  const vista = () => <RepartidorPedidosView apiBaseUrl={API} token="tok" propertyId="prop-1" />;

  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const html = await mismoDomEnEspanol(vista);
    for (const es of ["Mis entregas", "Mis pedidos", "Historial del día", "Mi perfil", "En camino", "Marcar entregado", "Reportar incidencia", "Llamar"]) expect(html, es).toContain(es);
  });

  it("en ingles pestanas, estado y acciones salen en ingles", async () => {
    const c = await enIngles(vista());
    const texto = c.textContent ?? "";
    for (const en of ["My deliveries", "My orders", "Today's history", "My profile", "On the way", "Mark as delivered", "Report an issue", "Call"]) expect(texto, en).toContain(en);
    for (const es of ["Mis entregas", "Mis pedidos", "En camino", "Marcar entregado", "Reportar incidencia", "Llamar"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("4× Taquitos al pastor");
    sinClavesCrudas(c.innerHTML);
  });
});

describe("dialogos de la entrega ES/EN", () => {
  it("confirmar entrega en ingles, con el nombre del cliente tal cual", async () => {
    await enIngles(<ConfirmarEntrega entrega={ENTREGA} onCerrar={() => undefined} onConfirmar={async () => undefined} />);
    const texto = document.body.textContent ?? "";
    for (const en of ["Did you deliver order #145?", "For Ana R.. Total: $", "If you collected cash, leave the amount", "Yes, delivered", "Back", "Amount collected"]) expect(texto, en).toContain(en);
    expect(texto).not.toContain("Entregaste");
    sinClavesCrudas(document.body.innerHTML);
  });

  it("confirmar entrega en espanol, el texto de siempre", async () => {
    await montar(<ConfirmarEntrega entrega={ENTREGA} onCerrar={() => undefined} onConfirmar={async () => undefined} />);
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("¿Entregaste el pedido #145?");
    expect(texto).toContain("Para Ana R.. Total $708.00. Si cobraste en efectivo, deja el monto; si no cobraste, vacíalo.");
  });

  it("«No pude entregar» en ingles: titulo, motivos y botones", async () => {
    await enIngles(<ReportarProblema entrega={ENTREGA} onCerrar={() => undefined} onConfirmar={async () => undefined} />);
    const texto = document.body.textContent ?? "";
    expect(document.body.innerHTML).toContain("Reason");
    expect(document.body.innerHTML).not.toContain("Motivo");
    for (const en of ["Couldn't deliver order #145", "Choose what happened", "I couldn't find the address", "The customer isn't answering", "They refused the order", "Other reason", "Note (optional)", "Report problem", "Back"]) expect(texto, en).toContain(en);
    for (const es of ["No pude entregar", "Motivo", "Otro motivo", "Reportar problema"]) expect(texto, es).not.toContain(es);
    sinClavesCrudas(document.body.innerHTML);
  });
});

describe("acceso del repartidor ES/EN", () => {
  const acceso = () => <AccesoRepartidorPage apiBaseUrl={API} onLoggedIn={() => undefined} fetchImpl={fetchSimulado} />;

  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const html = await mismoDomEnEspanol(acceso);
    for (const es of ["Entrar con tu celular", "Tu celular", "Enviarme el código", "Soy encargado o administrador: entrar con correo"]) expect(html, es).toContain(es);
  });

  it("en ingles el paso del celular sale en ingles", async () => {
    const c = await enIngles(acceso());
    const texto = c.textContent ?? "";
    for (const en of ["Sign in with your phone", "We'll send you a code on WhatsApp", "Your cell phone", "10 digits, the same one you gave your manager.", "Send me the code", "I'm a manager or admin: sign in with email"]) expect(texto, en).toContain(en);
    for (const es of ["Entrar con", "Tu celular", "Enviarme", "encargado"]) expect(texto, es).not.toContain(es);
    sinClavesCrudas(c.innerHTML);
  });
});

describe("mensajes de lib/ del repartidor", () => {
  const fallo = (status: number, cuerpo: unknown = {}) => (async () => json(status, cuerpo)) as unknown as typeof fetch;

  it("en espanol son los textos de siempre", async () => {
    expect(ETIQUETA_MOTIVO_PROBLEMA.direccion).toBe("No encontré la dirección");
    expect(Object.values(ETIQUETA_MOTIVO_PROBLEMA)).toEqual(["No encontré la dirección", "El cliente no contesta", "Rechazó el pedido", "Otro motivo"]);
    expect(await solicitarCodigoCelular(fallo(500), API, "9991234567")).toEqual({ ok: false, motivo: "red", mensaje: "No pudimos enviar el código. Inténtalo de nuevo en un momento." });
    expect(await solicitarCodigoCelular(fallo(503), API, "9991234567")).toMatchObject({ mensaje: "El acceso con celular todavía no está disponible. Entra con tu correo o pídele ayuda a tu encargado." });
    expect(await verificarCodigoCelular(fallo(401), API, "9991234567", "123456")).toMatchObject({ mensaje: "Código incorrecto o vencido. Pide uno nuevo." });
    await expect(pedirContrato(fallo(200, { otra: "forma" }), `${BASE}/entregas`, "tok", esquemaEntregasChoferSalida)).rejects.toThrow("El servidor respondió con un formato inesperado. Intenta de nuevo.");
  });

  it("en ingles siguen al idioma activo; el mensaje del servidor se muestra tal cual", async () => {
    fijarIdiomaActivo("en");
    expect(ETIQUETA_MOTIVO_PROBLEMA.no_contesto).toBe("The customer isn't answering");
    expect(await solicitarCodigoCelular(fallo(500), API, "9991234567")).toMatchObject({ mensaje: "We couldn't send the code. Try again in a moment." });
    expect(await solicitarCodigoCelular(fallo(429), API, "9991234567")).toMatchObject({ mensaje: "You requested too many codes. Wait a few minutes and try again." });
    expect(await solicitarCodigoCelular(fallo(429, { message: "Espera 10 minutos." }), API, "9991234567")).toMatchObject({ mensaje: "Espera 10 minutos." });
    expect(await verificarCodigoCelular(fallo(401), API, "9991234567", "123456")).toMatchObject({ mensaje: "Wrong or expired code. Request a new one." });
    await expect(pedirContrato(fallo(200, { otra: "forma" }), `${BASE}/entregas`, "tok", esquemaEntregasChoferSalida)).rejects.toThrow("The server sent an unexpected response. Try again.");
  });
});
