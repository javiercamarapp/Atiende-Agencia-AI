// API simulada del pre-check-in publico de rentas (Rn-P3-08) y de los accesos pendientes de entregar (Rn-P3-09). Solo existe en la API simulada de e2e.
// Reglas del mock: un codigo `HME2E` + 5 alfanumericos con los ultimos 4 digitos `0123` es una reserva valida (cada prueba usa uno unico, porque las
// peticiones sin sesion comparten el escenario "anon"); cualquier otra cosa es "invalido"; 5 fallos con el mismo codigo lo bloquean (429).
import { conStatus, fallo } from "../respuestas.ts";
import { propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("rentas");
const R = "/rentas/:id";
const PUB = "/rentas/precheckin/:pid";
const ROLES_ACCESO = ["admin"] as const;
const CODIGO_VALIDO = /^HME2E[A-Z0-9]{5}$/;
const TOKEN = (codigo: string) => `${codigo}`.padEnd(43, "x");

interface EstadoPublico {
  fallos: Map<string, number>;
  capturas: Map<string, { correo: string; whatsapp: string | null }>;
}
const publico = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<EstadoPublico>("rentas.precheckin.publico", () => ({ fallos: new Map(), capturas: new Map() }));

const INFO = { propiedad: "Casa Playa Norte", organizacion: "Rentas Sol y Mar", reglamento: "No fiestas. Silencio de 22:00 a 8:00.", aviso: { version: "2026-10-v1", titulo: "Aviso de privacidad del pre-check-in", parrafos: ["Rentas Sol y Mar es responsable de los datos que captures aqui.", "Pedimos tu correo (obligatorio) y tu WhatsApp (opcional) para enviarte las instrucciones de acceso."] } };

interface Pendiente {
  reserva_id: string;
  unidad_id: string;
  unidad_nombre: string;
  canal: string;
  check_in: string;
  check_out: string;
  huesped_nombre: string | null;
  omitida_en: string;
}
function dia(desdeHoy: number): string {
  return new Date(Date.now() + desdeHoy * 86_400_000).toISOString().slice(0, 10);
}
const pendientesSemilla = (): Pendiente[] => [{ reserva_id: "ocu-ota-1", unidad_id: "uni-1", unidad_nombre: "Casa Playa Norte", canal: "airbnb", check_in: dia(2), check_out: dia(5), huesped_nombre: null, omitida_en: new Date().toISOString() }];
interface EstadoStaff {
  pendientes: Pendiente[];
  bitacora: { id: string; reserva_id: string; evento: string; canal: string | null; creado_en: string }[];
  reglamento: string | null;
  version: number;
}
const staff = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) =>
  p.estado.obtener<EstadoStaff>("rentas.acceso.staff", () => ({
    pendientes: pendientesSemilla(),
    bitacora: [{ id: "bit-1", reserva_id: "ocu-ota-1", evento: "omitida_sin_contacto", canal: null, creado_en: new Date().toISOString() }],
    reglamento: "No fiestas.",
    version: 1,
  }));
const config = (s: EstadoStaff) => ({ disponible: true, enlace_publico: `http://127.0.0.1:4173/rentas/precheckin/${PROP.id}`, texto_sugerido: `Hola, completa tu pre-check-in:\nhttp://127.0.0.1:4173/rentas/precheckin/${PROP.id}`, reglamento: s.reglamento, reglamento_version: s.version });

export const rutasRentasPrecheckin: readonly Ruta[] = [
  { metodo: "GET", patron: PUB, publica: true, manejador: () => INFO },
  {
    metodo: "POST",
    patron: `${PUB}/verificar`,
    publica: true,
    manejador: (p) => {
      const { codigo = "", ultimos4 = "" } = (p.cuerpo ?? {}) as { codigo?: string; ultimos4?: string };
      const cod = String(codigo).replace(/\s+/g, "").toUpperCase();
      const e = publico(p);
      if ((e.fallos.get(cod) ?? 0) >= 5) return fallo(429, "Demasiados intentos con ese código. Intenta de nuevo en una hora o escribe a tu anfitrión.");
      if (!CODIGO_VALIDO.test(cod) || ultimos4 !== "0123") {
        e.fallos.set(cod, (e.fallos.get(cod) ?? 0) + 1);
        return { estado: "invalido", mensaje: "No pudimos validar tus datos. Revisa el código de confirmación y los últimos 4 dígitos de tu teléfono." };
      }
      e.fallos.delete(cod);
      return { estado: "ok", token: TOKEN(cod), token_expira_en: new Date(Date.now() + 900_000).toISOString(), propiedad: INFO.propiedad, unidad: "Casa Playa Norte", check_in: dia(2), check_out: dia(5), ya_capturado: e.capturas.has(cod) };
    },
  },
  {
    metodo: "POST",
    patron: `${PUB}/capturar`,
    publica: true,
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { token?: string; correo?: string; whatsapp?: string | null; aceptaPrivacidad?: boolean; aceptaReglamento?: boolean };
      const cod = String(c.token ?? "").replace(/x+$/, "");
      const e = publico(p);
      if (!CODIGO_VALIDO.test(cod)) return fallo(400, "La verificación expiró o ya se usó. Vuelve a empezar.");
      if (c.aceptaPrivacidad !== true) return fallo(400, "Debes aceptar el aviso de privacidad para continuar.");
      if (c.aceptaReglamento !== true) return fallo(400, "Debes aceptar el reglamento de la casa para continuar.");
      if (e.capturas.has(cod)) return { estado: "ya_capturado", mensaje: "Ya recibimos tus datos para esta reserva. Si necesitas cambiarlos, escribe a tu anfitrión." };
      e.capturas.set(cod, { correo: String(c.correo), whatsapp: c.whatsapp ?? null });
      return { estado: "ok", mensaje: "Listo. Te enviaremos las instrucciones de acceso por correo antes de tu llegada." };
    },
  },
  { metodo: "GET", patron: `${R}/acceso-huesped/politica`, roles: ROLES_ACCESO, manejador: () => ({ disponible: true, configurada: true, politica: { activo: true, horas_antes_checkin: 24, hora_checkin: "15:00", exigir_pago: true, ota_cuenta_como_pagada: true } }) },
  { metodo: "GET", patron: `${R}/acceso-huesped/reservas`, roles: ROLES_ACCESO, manejador: () => ({ disponible: true, reservas: [] }) },
  { metodo: "GET", patron: `${R}/acceso-huesped/bitacora`, roles: ROLES_ACCESO, manejador: (p) => ({ disponible: true, eventos: staff(p).bitacora }) },
  { metodo: "GET", patron: `${R}/acceso-huesped/pendientes`, roles: ROLES_ACCESO, manejador: (p) => ({ disponible: true, pendientes: staff(p).pendientes }) },
  { metodo: "GET", patron: `${R}/acceso-huesped/precheckin`, roles: ROLES_ACCESO, manejador: (p) => config(staff(p)) },
  {
    metodo: "PUT",
    patron: `${R}/acceso-huesped/precheckin`,
    roles: ROLES_ACCESO,
    manejador: (p) => {
      const s = staff(p);
      const nuevo = ((p.cuerpo ?? {}) as { reglamento?: string | null }).reglamento ?? null;
      if (nuevo !== s.reglamento) s.version += 1;
      s.reglamento = nuevo;
      return config(s);
    },
  },
  {
    metodo: "GET",
    patron: `${R}/reservas/:oid/acceso-mensaje`,
    roles: ROLES_ACCESO,
    manejador: (p) => (staff(p).pendientes.some((x) => x.reserva_id === p.params.oid) ? conStatus(200, { disponible: true, mensaje: "Hola,\n\nDireccion: Calle 60 #123\nCodigo de acceso: 9137" }) : fallo(404, "Reserva no encontrada en esta property.")),
  },
  {
    metodo: "POST",
    patron: `${R}/reservas/:oid/entrega-manual`,
    roles: ROLES_ACCESO,
    manejador: (p) => {
      const s = staff(p);
      const i = s.pendientes.findIndex((x) => x.reserva_id === p.params.oid);
      if (i < 0) return fallo(404, "Reserva no encontrada en esta property.");
      s.pendientes.splice(i, 1);
      s.bitacora.unshift({ id: `bit-${s.bitacora.length + 1}`, reserva_id: String(p.params.oid), evento: "entregada_manual", canal: null, creado_en: new Date().toISOString() });
      return { reserva_id: p.params.oid, entregada: true, nueva: true };
    },
  },
];
