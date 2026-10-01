// Rn-04 -- correo transaccional con las instrucciones de acceso (liberado N horas antes
// del check-in). Todo dato dinámico pasa por escapeHtml: el nombre del huésped, la
// dirección y las instrucciones los tecleó el staff/huésped, nunca son de confianza.
import { escapeHtml, renderCorreo } from "./layout.ts";
import type { Correo } from "./reserva-templates.ts";

export interface AccesoCorreoDatos {
  readonly huespedNombre: string;
  readonly tenantNombre: string;
  readonly unidadNombre: string;
  readonly checkInTexto: string;
  readonly checkOutTexto: string;
  readonly direccionExacta: string;
  readonly codigoAcceso: string | null;
  readonly instrucciones: string | null;
}

export function correoAccesoHuesped(d: AccesoCorreoDatos): Correo {
  const filas = [
    { etiqueta: "Alojamiento", valor: d.unidadNombre },
    { etiqueta: "Check-in", valor: d.checkInTexto },
    { etiqueta: "Check-out", valor: d.checkOutTexto },
    { etiqueta: "Dirección", valor: d.direccionExacta },
    ...(d.codigoAcceso ? [{ etiqueta: "Código de acceso", valor: d.codigoAcceso }] : []),
    ...(d.instrucciones ? [{ etiqueta: "Indicaciones", valor: d.instrucciones }] : []),
  ];
  const html = renderCorreo({
    titulo: "Tus instrucciones de acceso",
    preheader: `Cómo llegar a ${d.unidadNombre} — check-in ${d.checkInTexto}`,
    etiqueta: { texto: "Acceso", color: "#1D4ED8" },
    parrafosHtml: [`Hola ${escapeHtml(d.huespedNombre)}, tu llegada a <strong>${escapeHtml(d.tenantNombre)}</strong> se acerca. Estas son tus instrucciones de acceso:`],
    tabla: { filas },
    nota: "Por seguridad, este código es solo para tu estancia: no lo compartas. Si algo no funciona, contáctanos por el mismo medio por el que reservaste.",
    piePorQueLlego: `Recibes este correo porque tienes una reserva confirmada en ${d.tenantNombre} a través de atiende.`,
  });
  const texto = [
    `Hola ${d.huespedNombre}, tu llegada a ${d.tenantNombre} se acerca. Estas son tus instrucciones de acceso:`,
    `Alojamiento: ${d.unidadNombre}`,
    `Check-in: ${d.checkInTexto}`,
    `Check-out: ${d.checkOutTexto}`,
    `Direccion: ${d.direccionExacta}`,
    ...(d.codigoAcceso ? [`Codigo de acceso: ${d.codigoAcceso}`] : []),
    ...(d.instrucciones ? [`Indicaciones: ${d.instrucciones}`] : []),
    "Este codigo es solo para tu estancia: no lo compartas.",
  ].join("\n");
  return { asunto: `Tus instrucciones de acceso · ${d.tenantNombre} · ${d.checkInTexto}`, html, texto };
}
