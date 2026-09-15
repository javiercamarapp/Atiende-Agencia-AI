// Plantillas concretas de correo transaccional al huésped, construidas sobre el
// marco de layout.ts — mismo patrón que packages/domain-citas/src/emails/appointment-templates.ts.
// Un objeto {asunto, html, texto} por evento real del ciclo de vida de una reserva
// (ver ../guest-email-notifications.ts, que es quien las invoca).
//
// Todo dato dinámico (nombre del huésped, del hotel, tipo de habitación, etiqueta
// de folio) pasa por escapeHtml antes de entrar al HTML — el nombre del huésped en
// particular puede llegar tal cual lo transcribió el agente de voz/WhatsApp o lo
// tecleó recepción, nunca es un dato de confianza. Los montos/fechas ya llegan
// FORMATEADOS como texto (ver guest-email-notifications.ts) — este archivo es
// puramente presentacional, ninguna regla de negocio (cálculo de impuestos,
// resolución de timezone) vive aquí.
import { escapeHtml, renderCorreo } from "./layout.ts";

export interface Correo {
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

const PIE_ESTANDAR = (hotelNombre: string) => `Recibes este correo porque hiciste una reserva en ${hotelNombre} a través de atiende.`;

// ============================================================================
// 1) Confirmación de reserva — al crear POST /hoteles/:propertyId/reservas.
// ============================================================================

export interface ReservaCorreo {
  readonly huespedNombre: string;
  readonly hotelNombre: string;
  readonly tipoHabitacionNombre: string;
  readonly checkInTexto: string; // fecha ya formateada (es-MX, día completo)
  readonly checkOutTexto: string;
  readonly totalConImpuestosTexto: string; // monto ya formateado como moneda MXN
}

export function correoReservaConfirmada(r: ReservaCorreo): Correo {
  const nombre = escapeHtml(r.huespedNombre);
  const hotel = escapeHtml(r.hotelNombre);
  const html = renderCorreo({
    titulo: "Tu reserva quedó confirmada",
    preheader: `${r.hotelNombre} — check-in ${r.checkInTexto}`,
    etiqueta: { texto: "Reserva confirmada", color: "#1D4ED8" },
    parrafosHtml: [`Hola ${nombre}, tu reserva en <strong>${hotel}</strong> quedó confirmada. Aquí el detalle:`],
    tabla: {
      filas: [
        { etiqueta: "Habitación", valor: r.tipoHabitacionNombre },
        { etiqueta: "Check-in", valor: r.checkInTexto },
        { etiqueta: "Check-out", valor: r.checkOutTexto },
        { etiqueta: "Total estimado", valor: r.totalConImpuestosTexto },
      ],
    },
    nota: "El total estimado ya incluye impuestos; cualquier consumo adicional durante tu estancia (alimentos, extras) se reflejará en tu folio al cerrar tu cuenta.",
    piePorQueLlego: PIE_ESTANDAR(r.hotelNombre),
  });
  return {
    asunto: `Reserva confirmada · ${r.hotelNombre} · ${r.checkInTexto}`,
    html,
    texto: `Hola ${r.huespedNombre}, tu reserva en ${r.hotelNombre} quedó confirmada.\nHabitación: ${r.tipoHabitacionNombre}\nCheck-in: ${r.checkInTexto}\nCheck-out: ${r.checkOutTexto}\nTotal estimado: ${r.totalConImpuestosTexto}`,
  };
}

// ============================================================================
// 2) Recibo de folio — al cerrar POST /hoteles/:propertyId/folios/:folioId/cerrar.
// ============================================================================

export interface FolioCorreo {
  readonly huespedNombre: string;
  readonly hotelNombre: string;
  readonly folioEtiqueta: string;
  readonly motivoCierreTexto: string; // "Saldo en cero" | "Cuenta por cobrar"
  readonly totalCargosTexto: string;
  readonly totalPagosTexto: string;
  readonly saldoTexto: string;
  readonly esCuentaPorCobrar: boolean;
}

export function correoFolioRecibo(f: FolioCorreo): Correo {
  const nombre = escapeHtml(f.huespedNombre);
  const hotel = escapeHtml(f.hotelNombre);
  const nota = f.esCuentaPorCobrar
    ? "Tu cuenta se cerró como cuenta por cobrar: el saldo pendiente arriba se facturará por separado, fuera de este correo."
    : "Gracias por tu estancia. Conserva este recibo para tus registros.";
  const html = renderCorreo({
    titulo: "Recibo de tu cuenta",
    preheader: `${f.hotelNombre} — folio "${f.folioEtiqueta}" cerrado`,
    etiqueta: { texto: "Folio cerrado", color: "#15803d" },
    parrafosHtml: [`Hola ${nombre}, tu cuenta en <strong>${hotel}</strong> quedó cerrada. Este es tu recibo:`],
    tabla: {
      filas: [
        { etiqueta: "Folio", valor: f.folioEtiqueta },
        { etiqueta: "Motivo de cierre", valor: f.motivoCierreTexto },
        { etiqueta: "Cargos totales", valor: f.totalCargosTexto },
        { etiqueta: "Pagos totales", valor: f.totalPagosTexto },
        { etiqueta: "Saldo", valor: f.saldoTexto },
      ],
    },
    nota,
    piePorQueLlego: PIE_ESTANDAR(f.hotelNombre),
  });
  return {
    asunto: `Recibo de tu cuenta · ${f.hotelNombre} · folio ${f.folioEtiqueta}`,
    html,
    texto: `Hola ${f.huespedNombre}, tu cuenta en ${f.hotelNombre} quedó cerrada.\nFolio: ${f.folioEtiqueta}\nMotivo de cierre: ${f.motivoCierreTexto}\nCargos totales: ${f.totalCargosTexto}\nPagos totales: ${f.totalPagosTexto}\nSaldo: ${f.saldoTexto}`,
  };
}

// ============================================================================
// 3) Aviso de CFDI disponible — al timbrar POST .../folios/:folioId/cfdi.
// ============================================================================

export interface CfdiCorreo {
  readonly huespedNombre: string;
  readonly hotelNombre: string;
  readonly folioEtiqueta: string;
  readonly uuidFiscal: string;
  readonly totalTexto: string;
}

export function correoCfdiDisponible(c: CfdiCorreo): Correo {
  const nombre = escapeHtml(c.huespedNombre);
  const hotel = escapeHtml(c.hotelNombre);
  const html = renderCorreo({
    titulo: "Tu factura (CFDI) está disponible",
    preheader: `${c.hotelNombre} — CFDI del folio "${c.folioEtiqueta}" ya timbrado`,
    etiqueta: { texto: "CFDI timbrado", color: "#7c3aed" },
    parrafosHtml: [`Hola ${nombre}, tu comprobante fiscal digital (CFDI) de tu estancia en <strong>${hotel}</strong> ya fue timbrado ante el SAT:`],
    tabla: {
      filas: [
        { etiqueta: "Folio", valor: c.folioEtiqueta },
        { etiqueta: "UUID fiscal", valor: c.uuidFiscal },
        { etiqueta: "Total", valor: c.totalTexto },
      ],
    },
    nota: "Conserva este UUID fiscal para tus registros. Si necesitas el archivo PDF/XML completo, contáctanos por el mismo medio por el que hiciste tu reserva.",
    piePorQueLlego: PIE_ESTANDAR(c.hotelNombre),
  });
  return {
    asunto: `CFDI disponible · ${c.hotelNombre} · folio ${c.folioEtiqueta}`,
    html,
    texto: `Hola ${c.huespedNombre}, tu CFDI de tu estancia en ${c.hotelNombre} ya fue timbrado.\nFolio: ${c.folioEtiqueta}\nUUID fiscal: ${c.uuidFiscal}\nTotal: ${c.totalTexto}`,
  };
}
