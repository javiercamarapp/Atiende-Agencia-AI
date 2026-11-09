// R-15 -- cliente HTTP del perfil operativo del repartidor (migracion 044) y de su historial del dia. Rutas reales de
// apps/api/src/routes/verticals/restaurantes/repartidor-perfil.ts y repartidor-historial.ts. Mismo aislamiento que el resto de
// apps/web: no depende de @atiende/domain-restaurantes (el servidor es la fuente de verdad; la validacion de abajo solo evita
// ida y vuelta). `disponible: false` = la base aun no tiene la migracion 044 (estado honesto, nunca datos inventados).
import { etiquetasTraducidas, traductorActivo } from "@atiende/ui";
import { restaurantesStaff } from "@atiende/ui/i18n/restaurantes/staff";
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

const tr = traductorActivo(restaurantesStaff);

export type VehiculoTipo = "moto" | "bicicleta" | "auto" | "a_pie" | "otro";
export type Disponibilidad = "disponible" | "en_descanso" | "fuera_de_turno";
export type LicenciaEstado = "sin_licencia" | "vigente" | "por_vencer" | "vencida";

/** Etiquetas en el idioma activo (i18n): cada lectura traduce; en espanol, los textos de siempre (mismo orden de claves). */
export const VEHICULO_ETIQUETAS: Readonly<Record<VehiculoTipo, string>> = etiquetasTraducidas<VehiculoTipo>(
  ["moto", "bicicleta", "auto", "a_pie", "otro"],
  (v) => `restaurantes.staff.vehiculo.${v}` as const,
  restaurantesStaff,
);
export const DISPONIBILIDAD_ETIQUETAS: Readonly<Record<Disponibilidad, string>> = etiquetasTraducidas<Disponibilidad>(
  ["disponible", "en_descanso", "fuera_de_turno"],
  (d) => `restaurantes.staff.disp.${d}` as const,
  restaurantesStaff,
);

export interface PerfilRepartidor {
  readonly userId: string;
  readonly vehiculoTipo: VehiculoTipo | null;
  readonly placas: string | null;
  readonly disponibilidad: Disponibilidad;
  readonly turno: string | null;
  readonly licenciaNumero: string | null;
  /** YYYY-MM-DD. */
  readonly licenciaVigencia: string | null;
  readonly licenciaEstado: LicenciaEstado;
  /** Dias hasta la vigencia (negativo = ya vencio); null sin licencia. Calculado por el servidor con el dia local de la sucursal. */
  readonly licenciaDias: number | null;
  readonly emergenciaNombre: string | null;
  /** 10 digitos. */
  readonly emergenciaTelefono: string | null;
  readonly updatedAt: string;
}

export interface PerfilRespuesta {
  readonly disponible: boolean;
  readonly hoy: string;
  readonly perfil: PerfilRepartidor | null;
}

/** Valores de los campos tal como los escribe la persona (todo texto). */
export interface PerfilForm {
  vehiculoTipo: string;
  placas: string;
  disponibilidad: string;
  turno: string;
  licenciaNumero: string;
  licenciaVigencia: string;
  emergenciaNombre: string;
  emergenciaTelefono: string;
}

export type PerfilFormErrores = Partial<Record<keyof PerfilForm, string>>;

export const PERFIL_FORM_VACIO: PerfilForm = {
  vehiculoTipo: "",
  placas: "",
  disponibilidad: "disponible",
  turno: "",
  licenciaNumero: "",
  licenciaVigencia: "",
  emergenciaNombre: "",
  emergenciaTelefono: "",
};

export function formDesdePerfil(p: PerfilRepartidor | null): PerfilForm {
  if (!p) return { ...PERFIL_FORM_VACIO };
  return {
    vehiculoTipo: p.vehiculoTipo ?? "",
    placas: p.placas ?? "",
    disponibilidad: p.disponibilidad,
    turno: p.turno ?? "",
    licenciaNumero: p.licenciaNumero ?? "",
    licenciaVigencia: p.licenciaVigencia ?? "",
    emergenciaNombre: p.emergenciaNombre ?? "",
    emergenciaTelefono: p.emergenciaTelefono ?? "",
  };
}

/** Telefono nacional de 10 digitos (acepta +52 / 52 / 521 delante, igual que el servidor). */
function telefonoValido(t: string): boolean {
  const d = t.replace(/\D/g, "");
  return d.length === 10 || (d.length === 12 && d.startsWith("52")) || (d.length === 13 && d.startsWith("521"));
}

export function validarPerfilForm(f: PerfilForm): PerfilFormErrores {
  const e: PerfilFormErrores = {};
  if (f.placas.trim().length > 15) e.placas = tr("restaurantes.staff.val.max15");
  if (f.turno.trim().length > 120) e.turno = tr("restaurantes.staff.val.max120");
  if (f.licenciaNumero.trim().length > 40) e.licenciaNumero = tr("restaurantes.staff.val.max40");
  const tieneNumero = f.licenciaNumero.trim() !== "";
  const tieneVigencia = f.licenciaVigencia.trim() !== "";
  if (tieneNumero && !tieneVigencia) e.licenciaVigencia = tr("restaurantes.staff.val.vigencia");
  if (!tieneNumero && tieneVigencia) e.licenciaNumero = tr("restaurantes.staff.val.licencia");
  if (f.emergenciaNombre.trim().length > 100) e.emergenciaNombre = tr("restaurantes.staff.val.max100");
  const tieneNombre = f.emergenciaNombre.trim() !== "";
  const tieneTel = f.emergenciaTelefono.trim() !== "";
  if (tieneTel && !telefonoValido(f.emergenciaTelefono)) e.emergenciaTelefono = tr("restaurantes.staff.val.telefono");
  if (tieneNombre && !tieneTel) e.emergenciaTelefono = tr("restaurantes.staff.val.telefonoContacto");
  if (!tieneNombre && tieneTel && !e.emergenciaTelefono) e.emergenciaNombre = tr("restaurantes.staff.val.nombreContacto");

  return e;
}

export function formABody(f: PerfilForm): Record<string, string | null> {
  const t = (v: string): string | null => (v.trim() === "" ? null : v.trim());
  return {
    vehiculoTipo: t(f.vehiculoTipo),
    placas: t(f.placas),
    disponibilidad: f.disponibilidad,
    turno: t(f.turno),
    licenciaNumero: t(f.licenciaNumero),
    licenciaVigencia: t(f.licenciaVigencia),
    emergenciaNombre: t(f.emergenciaNombre),
    emergenciaTelefono: t(f.emergenciaTelefono),
  };
}

const propio = (api: string, propertyId: string) => `${api}/v1/restaurantes/${propertyId}/repartidor/perfil`;
const gestion = (api: string, propertyId: string, userId: string) => `${api}/v1/restaurantes/${propertyId}/admin/staff/${userId}/perfil-repartidor`;

export function fetchMiPerfil(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<PerfilRespuesta> {
  return fetchJson<PerfilRespuesta>(fetchImpl, propio(apiBaseUrl, propertyId), token);
}
export function guardarMiPerfil(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, form: PerfilForm): Promise<PerfilRespuesta> {
  return sendJson<PerfilRespuesta>(fetchImpl, propio(apiBaseUrl, propertyId), token, "PUT", formABody(form));
}
export function fetchPerfilDeRepartidor(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, userId: string): Promise<PerfilRespuesta> {
  return fetchJson<PerfilRespuesta>(fetchImpl, gestion(apiBaseUrl, propertyId, userId), token);
}
export function guardarPerfilDeRepartidor(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, userId: string, form: PerfilForm): Promise<PerfilRespuesta> {
  return sendJson<PerfilRespuesta>(fetchImpl, gestion(apiBaseUrl, propertyId, userId), token, "PUT", formABody(form));
}
export function suprimirPerfilDeRepartidor(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, userId: string): Promise<{ ok: boolean; borrado: boolean }> {
  return deleteJson<{ ok: boolean; borrado: boolean }>(fetchImpl, gestion(apiBaseUrl, propertyId, userId), token);
}

// ---- Historial del dia ----

export interface EntregaDia {
  readonly id: string;
  readonly customerName: string;
  readonly total: number;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
  readonly status: string;
  readonly deliveredAt: string | null;
}

export interface HistorialDia {
  /** Dia local de la sucursal, YYYY-MM-DD. */
  readonly fecha: string;
  readonly zonaHoraria: string;
  readonly entregas: readonly EntregaDia[];
  readonly totales: {
    readonly pedidos: number;
    readonly totalCentavos: number;
    readonly efectivoCentavos: number;
    readonly efectivoPedidos: number;
    readonly tarjetaCentavos: number;
    /** Pedidos entregados sin metodo de pago registrado: NO se suman al efectivo. */
    readonly sinMetodoPedidos: number;
  };
}

export function fetchHistorialDia(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<HistorialDia> {
  return fetchJson<HistorialDia>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/repartidor/historial-dia`, token);
}
