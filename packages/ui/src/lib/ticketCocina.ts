/**
 * Ticket de cocina imprimible (PM PR-7) -- mientras no exista la integración real de
 * SoftRestaurant, la comanda sale por impresora de cocina desde el navegador.
 *
 * Todo este módulo es PURO (sin DOM, sin red, sin React): recibe un pedido tal como lo
 * entrega `GET .../admin/orders` y devuelve (a) un modelo `TicketCocina` ya normalizado y
 * (b) el HTML autocontenido para impresora térmica de 80 mm. No envía nada a ningún
 * servicio externo; imprimir es decisión del navegador (`imprimirTicketsCocina`).
 *
 * Los datos que no tienen columna dedicada en `orders` viajan en `orders.notes` (ver
 * domain-restaurantes/src/orders.ts: "Canal: ...", "Propina: ...", "Complementos ...");
 * aquí se separan de las notas libres del cliente. Compatible con la base sin migrar:
 * no requiere ninguna columna ni función nueva.
 */

export interface TicketPedidoItem {
  readonly name: string;
  readonly quantity: number;
  readonly tortilla?: string;
}

/** Subconjunto de `OrderSummary` (apps/web) que necesita el ticket. */
export interface TicketPedidoFuente {
  readonly id: string;
  readonly branch: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress: string | null;
  readonly total: number;
  readonly items: readonly TicketPedidoItem[];
  readonly notes: string | null;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
  readonly createdAt: string;
  readonly estimatedDeliveryAt: string | null;
}

export type TicketCanal = "domicilio" | "recoger" | "sin_especificar";

export interface TicketCocinaLinea {
  readonly cantidad: string;
  readonly nombre: string;
  /** Modificadores de la línea (hoy solo la tortilla elegida). */
  readonly modificadores: readonly string[];
}

export interface TicketCocina {
  /** Folio interno corto derivado del id del pedido (no es el folio de SoftRestaurant). */
  readonly folio: string;
  readonly sucursal: string;
  readonly canal: TicketCanal;
  readonly canalEtiqueta: string;
  readonly creadoEn: string;
  /** null = el pedido no tiene hora prometida capturada (se imprime "sin hora prometida"). */
  readonly horaPrometida: string | null;
  readonly cliente: string;
  readonly telefono: string;
  /** Solo para domicilio; incluye referencias si el cliente las escribió en la dirección. */
  readonly direccion: string | null;
  /** Pin de entrega que dio el cliente (coordenadas o enlace corto de Maps); solo a domicilio. */
  readonly pin: string | null;
  readonly lineas: readonly TicketCocinaLinea[];
  readonly salsas: readonly string[];
  readonly notas: readonly string[];
  readonly formaPago: string;
  readonly total: string;
  /** Pago en efectivo: monto con el que paga y cambio que debe llevar el repartidor (null = no lo dijo). */
  readonly pagaCon: string | null;
  readonly cambio: string | null;
  /** Domicilio con tarjeta: el repartidor lleva terminal (implícito con tarjeta a domicilio, o explícito en la comanda). */
  readonly llevarTerminal: boolean;
  /** Indicaciones de acceso o aviso al llegar; solo a domicilio. */
  readonly acceso: string | null;
  readonly telefonoAlterno: string | null;
  /** Solo se llena con pago con tarjeta (política PM). */
  readonly propina: string | null;
  /** 0 = original; n>0 = n-ésima reimpresión (se marca en el ticket). */
  readonly reimpresion: number;
}

export interface OpcionesTicketCocina {
  /** Zona IANA del negocio para las horas impresas (default: America/Mexico_City). */
  readonly timeZone?: string;
  readonly reimpresion?: number;
}

const ZONA_DEFAULT = "America/Mexico_City";

// Caracteres de control (salvo \n y \t) que una impresora térmica interpretaría como
// comandos o que romperían el HTML: se eliminan en lugar de imprimirse.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function limpiarTexto(valor: string | null | undefined): string {
  return (valor ?? "").replace(CONTROL, "").replace(/\t/g, " ").trim();
}

export function escaparHtml(valor: string): string {
  return valor.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function folioTicket(orderId: string): string {
  const compacto = orderId.replace(/[^A-Za-z0-9]/g, "");
  const cola = compacto.slice(-6).toUpperCase();
  return cola.length > 0 ? cola : "SIN-ID";
}

function formatoCantidad(n: number): string {
  if (!Number.isFinite(n)) return "?";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatoDinero(n: number): string {
  const valor = Number.isFinite(n) ? n : 0;
  return `$${valor.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatoHora(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
  } catch {
    return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ZONA_DEFAULT });
  }
}

function formatoFechaHora(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "fecha desconocida";
  try {
    return d.toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short", hour12: false, timeZone });
  } catch {
    return d.toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short", hour12: false, timeZone: ZONA_DEFAULT });
  }
}

const RE_CANAL = /^Canal:\s*(.+?)\.?$/i;
const RE_PROPINA = /^Propina:\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i;
const RE_COMPLEMENTOS_INCLUIDOS = /^Complementos incluidos:\s*(.+?)\.?$/i;
const RE_COMPLEMENTOS_SOLICITADOS = /^Complementos solicitados:\s*(.+?)\.?$/i;
const PREFIJO_BASICAS = /^B[aá]sicas: /i;
const PREFIJO_PEDIDAS = /^Pedidas(?: \(sin costo\))?: /i;
const RE_UBICACION_COORD = /^Ubicaci[oó]n de entrega \((?:pin de WhatsApp|enlace de Maps)\):\s*lat=(-?\d{1,2}(?:\.\d+)?)\s+lng=(-?\d{1,3}(?:\.\d+)?)\.?$/i;
const RE_UBICACION_CORTA = /^Ubicaci[oó]n de entrega \(enlace corto de Maps\):\s*(https:\/\/(?:maps\.app\.goo\.gl\/|goo\.gl\/maps)\S*)$/i;
// Formato EXACTO que escribe el servidor («Paga con: $500.00 (cambio: $410.00).»): sin cuantificadores que se solapen (defensa contra ReDoS).
const RE_PAGA_CON = /^Paga con: \$([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?: \(cambio: \$([0-9][0-9,]*(?:\.[0-9]{1,2})?)\))?\.?$/i;
const RE_LLEVAR_TERMINAL = /^Llevar terminal\.?$/i;
const PREFIJO_ACCESO = /^Indicaciones de acceso: /i;
const RE_TEL_ALTERNO = /^Tel[eé]fono alterno:\s*(\d{10})\.?$/i;
const RE_SIN_COMPLEMENTOS = /^No enviar complementos de cortes[ií]a\.?$/i;

interface NotasSeparadas {
  canal: TicketCanal | null;
  propina: number | null;
  salsas: string[];
  libres: string[];
  pin: string | null;
  pagaCon: number | null;
  cambio: number | null;
  llevarTerminal: boolean;
  acceso: string | null;
  telefonoAlterno: string | null;
}

/** Valor de una línea «Etiqueta: valor.» sin el punto final (sin regex con backtracking sobre texto del cliente). */
function valorSinPunto(valor: string): string {
  const limpio = valor.trim();
  return limpio.endsWith(".") ? limpio.slice(0, -1) : limpio;
}

/** Separa de `orders.notes` las líneas estructuradas (canal, propina, complementos) de la
 * nota libre. El servidor las agrega AL FINAL; si el cliente escribió una línea con el
 * mismo formato en su nota libre, gana la última (la del servidor). */
export function separarNotas(notes: string | null): NotasSeparadas {
  const out: NotasSeparadas = { canal: null, propina: null, salsas: [], libres: [], pin: null, pagaCon: null, cambio: null, llevarTerminal: false, acceso: null, telefonoAlterno: null };
  for (const bruta of limpiarTexto(notes).split("\n")) {
    const linea = bruta.trim();
    if (!linea) continue;
    const canal = RE_CANAL.exec(linea);
    if (canal) {
      const t = (canal[1] ?? "").toLowerCase();
      if (t.startsWith("recoger")) out.canal = "recoger";
      else if (t.startsWith("domicilio")) out.canal = "domicilio";
      else out.libres.push(linea);
      continue;
    }
    const propina = RE_PROPINA.exec(linea);
    if (propina) {
      const n = Number((propina[1] ?? "").replace(/,/g, ""));
      if (Number.isFinite(n)) out.propina = n;
      continue;
    }
    const incl = RE_COMPLEMENTOS_INCLUIDOS.exec(linea);
    if (incl) {
      out.salsas.push(`Incluir: ${incl[1]}`);
      continue;
    }
    const paga = RE_PAGA_CON.exec(linea);
    if (paga) {
      out.pagaCon = Number((paga[1] ?? "").replace(/,/g, ""));
      out.cambio = paga[2] !== undefined ? Number(paga[2].replace(/,/g, "")) : null;
      continue;
    }
    if (RE_LLEVAR_TERMINAL.test(linea)) {
      out.llevarTerminal = true;
      continue;
    }
    const acceso = PREFIJO_ACCESO.exec(linea);
    if (acceso) {
      out.acceso = valorSinPunto(linea.slice(acceso[0].length));
      continue;
    }
    const alterno = RE_TEL_ALTERNO.exec(linea);
    if (alterno) {
      out.telefonoAlterno = alterno[1] ?? null;
      continue;
    }
    const basicas = PREFIJO_BASICAS.exec(linea);
    if (basicas) {
      out.salsas.push(`Básicas: ${valorSinPunto(linea.slice(basicas[0].length))}`);
      continue;
    }
    const pedidas = PREFIJO_PEDIDAS.exec(linea);
    if (pedidas) {
      out.salsas.push(`PEDIDAS (sin costo): ${valorSinPunto(linea.slice(pedidas[0].length))}`);
      continue;
    }
    const coord = RE_UBICACION_COORD.exec(linea);
    if (coord) {
      out.pin = `${coord[1]}, ${coord[2]}`;
      continue;
    }
    const corta = RE_UBICACION_CORTA.exec(linea);
    if (corta) {
      out.pin = corta[1] ?? null;
      continue;
    }
    const sol = RE_COMPLEMENTOS_SOLICITADOS.exec(linea);
    if (sol) {
      out.salsas.push(`Extra: ${sol[1]}`);
      continue;
    }
    if (RE_SIN_COMPLEMENTOS.test(linea)) {
      out.salsas.push("NO enviar complementos de cortesía");
      continue;
    }
    out.libres.push(linea);
  }
  return out;
}

export function construirTicketCocina(pedido: TicketPedidoFuente, opciones: OpcionesTicketCocina = {}): TicketCocina {
  const timeZone = opciones.timeZone ?? ZONA_DEFAULT;
  const notas = separarNotas(pedido.notes);
  const direccionLimpia = limpiarTexto(pedido.customerAddress);
  const canal: TicketCanal = notas.canal ?? (direccionLimpia ? "domicilio" : "sin_especificar");
  const formaPago = pedido.paymentMethod === "tarjeta" ? "Tarjeta" : pedido.paymentMethod === "efectivo" ? "Efectivo" : "Por definir";
  return {
    folio: folioTicket(pedido.id),
    sucursal: limpiarTexto(pedido.branch) || "Sin sucursal",
    canal,
    canalEtiqueta: canal === "domicilio" ? "DOMICILIO" : canal === "recoger" ? "RECOGER EN SUCURSAL" : "CANAL NO ESPECIFICADO",
    creadoEn: formatoFechaHora(pedido.createdAt, timeZone),
    horaPrometida: formatoHora(pedido.estimatedDeliveryAt, timeZone),
    cliente: limpiarTexto(pedido.customerName) || "Sin nombre",
    telefono: limpiarTexto(pedido.customerPhone),
    direccion: canal === "recoger" ? null : direccionLimpia || null,
    pin: canal === "recoger" ? null : notas.pin,
    lineas: pedido.items.map((it) => ({
      cantidad: formatoCantidad(it.quantity),
      nombre: limpiarTexto(it.name) || "(sin nombre)",
      modificadores: it.tortilla ? [`Tortilla: ${limpiarTexto(it.tortilla)}`] : [],
    })),
    salsas: notas.salsas,
    notas: notas.libres,
    pagaCon: pedido.paymentMethod === "efectivo" && notas.pagaCon !== null ? formatoDinero(notas.pagaCon) : null,
    cambio: pedido.paymentMethod === "efectivo" && notas.pagaCon !== null && notas.cambio !== null ? formatoDinero(notas.cambio) : null,
    llevarTerminal: canal !== "recoger" && pedido.paymentMethod === "tarjeta" && (notas.llevarTerminal || canal === "domicilio"),
    acceso: canal === "recoger" ? null : notas.acceso,
    telefonoAlterno: notas.telefonoAlterno,
    formaPago,
    total: formatoDinero(pedido.total),
    // Política PM: la propina solo existe con tarjeta; con otra forma de pago no se imprime.
    propina: pedido.paymentMethod === "tarjeta" && notas.propina !== null && notas.propina > 0 ? formatoDinero(notas.propina) : null,
    reimpresion: Math.max(0, Math.floor(opciones.reimpresion ?? 0)),
  };
}

/** Estilos del ticket, TODOS acotados a `.tk`: es la hoja que también usa la vista previa de
 * pantalla, así que no puede tocar html/body ni @page (rompería el tema de la app). */
export const TICKET_COCINA_CSS = `
.tk, .tk * { box-sizing: border-box; }
.tk { width: 72mm; max-width: 100%; margin: 0 auto; padding: 3mm 0; font: 12px/1.35 "Courier New", Courier, monospace; color: #000; background: #fff; overflow-wrap: anywhere; word-break: break-word; }
.tk + .tk { page-break-before: always; break-before: page; }
.tk h1 { margin: 0; font-size: 15px; text-align: center; text-transform: uppercase; }
.tk .centro { text-align: center; }
.tk .sep { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
.tk .reimp { text-align: center; font-weight: 700; border: 2px solid #000; padding: 1mm; margin: 1mm 0 2mm; }
.tk .fila { display: flex; justify-content: space-between; gap: 2mm; }
.tk .fila > span:last-child { text-align: right; }
.tk .canal { text-align: center; font-size: 14px; font-weight: 700; margin: 1mm 0; }
.tk .linea { margin: 1mm 0; font-size: 13px; font-weight: 700; display: flex; gap: 2mm; }
.tk .linea .cant { min-width: 8mm; }
.tk .mod { margin: 0 0 0 10mm; font-size: 12px; font-weight: 400; }
.tk .nota { margin: 0.5mm 0; }
.tk .etq { font-weight: 700; }
@media print { .tk { padding: 0; } }
`;

/** Reglas globales que solo valen dentro del documento de impresión (iframe propio). */
export const TICKET_COCINA_CSS_DOCUMENTO = `
@page { size: 80mm auto; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
${TICKET_COCINA_CSS}`;

function seccion(titulo: string, cuerpo: string): string {
  return `<hr class="sep"><div class="etq">${escaparHtml(titulo)}</div>${cuerpo}`;
}

/** HTML de UN ticket (sin <html>): lo usa la vista previa y el documento de impresión. */
export function renderTicketCocinaHtml(t: TicketCocina): string {
  const e = escaparHtml;
  const partes: string[] = [];
  partes.push(`<article class="tk" data-folio="${e(t.folio)}">`);
  if (t.reimpresion > 0) partes.push(`<div class="reimp">*** REIMPRESIÓN #${t.reimpresion} ***</div>`);
  partes.push(`<h1>COCINA · ${e(t.sucursal)}</h1>`);
  partes.push(`<div class="centro">Folio <strong>#${e(t.folio)}</strong></div>`);
  partes.push(`<div class="canal">${e(t.canalEtiqueta)}</div>`);
  partes.push(`<div class="fila"><span>Recibido</span><span>${e(t.creadoEn)}</span></div>`);
  partes.push(`<div class="fila"><span>Hora prometida</span><span><strong>${t.horaPrometida ? e(t.horaPrometida) : "sin hora prometida"}</strong></span></div>`);
  partes.push(
    seccion(
      "CLIENTE",
      `<div>${e(t.cliente)}</div><div>Tel: ${e(t.telefono || "sin teléfono")}</div>${t.direccion ? `<div class="nota">Dir: ${e(t.direccion).replace(/\n/g, "<br>")}</div>` : ""}${t.pin ? `<div class="nota">Pin: ${e(t.pin)}</div>` : ""}${t.acceso ? `<div class="nota">Acceso: ${e(t.acceso)}</div>` : ""}${t.telefonoAlterno ? `<div class="nota">Tel. alterno: ${e(t.telefonoAlterno)}</div>` : ""}`,
    ),
  );
  const lineas = t.lineas
    .map(
      (l) =>
        `<div class="linea"><span class="cant">${e(l.cantidad)}x</span><span>${e(l.nombre)}</span></div>${l.modificadores.map((m) => `<div class="mod">+ ${e(m)}</div>`).join("")}`,
    )
    .join("");
  partes.push(seccion("PEDIDO", lineas || `<div class="nota">(sin líneas)</div>`));
  if (t.salsas.length > 0) partes.push(seccion("SALSAS / COMPLEMENTOS", t.salsas.map((s) => `<div class="nota">${e(s)}</div>`).join("")));
  if (t.notas.length > 0) partes.push(seccion("NOTAS", t.notas.map((n) => `<div class="nota">${e(n)}</div>`).join("")));
  partes.push(
    `<hr class="sep"><div class="fila"><span>Pago</span><span>${e(t.formaPago)}</span></div>` +
      (t.pagaCon ? `<div class="fila"><span>Paga con</span><span>${e(t.pagaCon)}</span></div>` : "") +
      (t.cambio ? `<div class="fila"><span>Cambio a llevar</span><span><strong>${e(t.cambio)}</strong></span></div>` : "") +
      (t.llevarTerminal ? `<div class="canal">LLEVAR TERMINAL</div>` : "") +
      (t.propina ? `<div class="fila"><span>Propina (tarjeta)</span><span>${e(t.propina)}</span></div>` : "") +
      `<div class="fila"><span class="etq">Total</span><span class="etq">${e(t.total)}</span></div>`,
  );
  partes.push(`</article>`);
  return partes.join("");
}

/** Documento HTML completo (uno o varios tickets, un salto de página entre cada uno). */
export function renderDocumentoTicketsCocina(tickets: readonly TicketCocina[]): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Tickets de cocina</title><style>${TICKET_COCINA_CSS_DOCUMENTO}</style></head><body>${tickets.map(renderTicketCocinaHtml).join("")}</body></html>`;
}

/** Imprime desde el navegador usando un iframe oculto (no abre ventanas ni envía nada a
 * ningún servicio). Devuelve false si el entorno no puede imprimir. */
export function imprimirTicketsCocina(tickets: readonly TicketCocina[]): boolean {
  if (typeof document === "undefined" || tickets.length === 0) return false;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) {
    iframe.remove();
    return false;
  }
  doc.open();
  doc.write(renderDocumentoTicketsCocina(tickets));
  doc.close();
  const limpiar = () => window.setTimeout(() => iframe.remove(), 1000);
  win.addEventListener("afterprint", limpiar, { once: true });
  window.setTimeout(() => {
    try {
      win.focus();
      win.print();
    } finally {
      // Respaldo si el navegador no emite `afterprint`.
      window.setTimeout(() => iframe.remove(), 60_000);
    }
  }, 50);
  return true;
}
