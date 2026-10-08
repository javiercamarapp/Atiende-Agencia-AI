// Rn-P3-09 -- texto del mensaje de acceso que la gestora pega a mano en la mensajeria de la OTA (Airbnb, Booking, Vrbo) cuando la
// reserva llego por iCal sin correo del huesped y la liberacion automatica no pudo entregarlo. Funcion pura: recibe las instrucciones YA
// descifradas por quien llama (la ruta las lee con bitacora `lectura_admin` y responde con `Cache-Control: no-store`).
import type { InstruccionAcceso, ReservaParaMensajeOta } from "./tipos.ts";

function formatearFecha(fecha: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${fecha}T00:00:00Z`));
}

export function mensajeAccesoParaOta(reserva: Pick<ReservaParaMensajeOta, "unidadNombre" | "checkIn" | "checkOut" | "huespedNombre">, instruccion: Pick<InstruccionAcceso, "direccionExacta" | "codigoAcceso" | "instrucciones">): string {
  const nombre = reserva.huespedNombre?.trim();
  const lineas = [
    nombre ? `Hola ${nombre},` : "Hola,",
    "",
    `Estas son las instrucciones de acceso de tu estancia en ${reserva.unidadNombre}.`,
    `Llegada: ${formatearFecha(reserva.checkIn)}. Salida: ${formatearFecha(reserva.checkOut)}.`,
    "",
    `Direccion: ${instruccion.direccionExacta}`,
  ];
  if (instruccion.codigoAcceso) lineas.push(`Codigo de acceso: ${instruccion.codigoAcceso}`);
  if (instruccion.instrucciones) lineas.push("", instruccion.instrucciones);
  lineas.push("", "Si tienes cualquier duda al llegar, respondenos por este mismo chat. Buen viaje.");
  return lineas.join("\n");
}
