// Alta autoservicio de restaurantes y «primer valor en <30 min» en la API simulada de e2e. Mismo contrato que las rutas reales:
//   - apps/api/src/routes/registro-restaurantes.ts    GET  /auth/registro/restaurantes/estado
//                                                     POST /auth/registro/restaurantes/iniciar   (202 generico; trampa de bots)
//                                                     POST /auth/registro/restaurantes/confirmar (201 con codigo de intercambio)
//   - apps/api/src/routes/verticals/restaurantes/admin-primer-valor.ts
//                                                     GET  /v1/restaurantes/:id/admin/primer-valor
//                                                     POST /v1/restaurantes/:id/admin/primer-valor/metodos-pago
//   - apps/api/src/routes/alta-sucursal.ts            POST /v1/restaurantes/:orgSlug/admin/alta-sucursal/:propertyId/activar (409 con faltantes)
// El calculo es el MISMO codigo puro del dominio (packages/domain-restaurantes/src/primer-valor.ts); las lecturas salen del estado del
// escenario que ya usan las pantallas (productos, politica, zonas de reparto, sucursal), asi lo que la prueba hace en Productos o
// Sucursales se refleja aqui. La prueba del agente la marca el preview de WhatsApp al llegar a un pedido simulado (restaurantes.ts).
//
// Lo que el mock NO puede ser: no hay correo. El «buzon» es `enlaceDeRegistroSimulado(correo)`: el token que el servidor real mandaria
// por correo se deriva del propio correo, y la prueba lo arma igual. La cuenta nueva nace en el escenario que va como subdireccion del
// correo (`dueno+<escenario>@example.test`), para que el estado quede aislado por prueba; la persona es `restaurantes-owner` (su
// organizacion simulada), con la sucursal sembrada VACIA e INACTIVA y con el nombre que se capturo en el registro.
// Solo existe en la API simulada de e2e: jamas se usa contra el backend ni la base reales.
import { calcularPrimerValor } from "../../../../../packages/domain-restaurantes/src/primer-valor.ts";
import { conStatus, fallo } from "../respuestas.ts";
import { personaDe, propiedadDe, resolverPersona, VERTICALES, ROLES } from "../personas.ts";
import type { EstadoEscenario, Peticion, Ruta } from "../tipos.ts";

const PROP = propiedadDe("restaurantes");
const DUENO = personaDe("restaurantes", "owner");
const GESTION = ["owner", "admin"] as const;

/** Claves del estado del escenario que lee el «primer valor» (las mismas que escriben las pantallas en restaurantes-panel.ts). */
export const CLAVES_ALTA = {
  solicitudes: "alta.registro.solicitudes",
  metodosPago: "alta.metodos-pago-confirmados",
  pruebaAgente: "alta.prueba-agente-whatsapp",
} as const;

const DESECHABLES = new Set(["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "trashmail.com", "maildrop.cc"]);
const ENLACE_RE = /(https?:\/\/|www\.|\.(com|net|org|ru|xyz|top)\b)/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LLENADO_MINIMO_MS = 3_000;

interface Solicitud {
  readonly correo: string;
  readonly nombreNegocio: string;
  readonly nombreSucursal: string;
  readonly nombreCompleto: string;
  usada: boolean;
}

/** El enlace que el servidor real mandaria por correo (`/restaurantes/registro/confirmar#token=...`): aqui el token sale del correo. */
export function enlaceDeRegistroSimulado(correo: string): string {
  return `/restaurantes/registro/confirmar#token=${tokenDeCorreo(correo)}`;
}

function tokenDeCorreo(correo: string): string {
  return `e2e_${Buffer.from(correo.trim().toLowerCase(), "utf8").toString("base64url")}`;
}

function correoDeToken(token: string): string | null {
  if (!token.startsWith("e2e_")) return null;
  return Buffer.from(token.slice(4), "base64url").toString("utf8");
}

/** `dueno+<escenario>@example.test` -> `<escenario>`; sin subdireccion, un escenario propio derivado del correo. */
function escenarioDeCorreo(correo: string): string {
  const local = correo.slice(0, correo.indexOf("@"));
  const sub = local.includes("+") ? local.slice(local.indexOf("+") + 1) : "";
  return /^[a-z0-9]{1,40}$/.test(sub) ? sub : `alta${Buffer.from(correo).toString("hex").slice(0, 24)}`;
}

function texto(v: unknown, campo: string): string | ReturnType<typeof fallo> {
  if (typeof v !== "string") return validacion(`${campo} es obligatorio.`);
  const t = v.trim().replace(/\s+/g, " ");
  if (t.length < 2 || t.length > 120) return validacion(`${campo} debe tener entre 2 y 120 caracteres.`);
  if (ENLACE_RE.test(t)) return validacion(`${campo} no puede llevar enlaces.`);
  return t;
}

const validacion = (message: string) => conStatus(400, { code: "validation_error", message });

function correoConForma(correo: string): boolean {
  const arroba = correo.indexOf("@");
  if (correo.length < 5 || correo.length > 254 || /\s/.test(correo) || arroba < 1 || arroba !== correo.lastIndexOf("@")) return false;
  const dominio = correo.slice(arroba + 1);
  const punto = dominio.lastIndexOf(".");
  return punto > 0 && punto < dominio.length - 1;
}

/** Correos de las personas simuladas: «ya tiene cuenta» (el servidor real responde el mismo 202 y no crea nada). */
function correoConCuenta(correo: string): boolean {
  return VERTICALES.some((v) => ROLES.some((r) => resolverPersona(`${v}-${r}`)?.email === correo));
}

function solicitudes(estado: EstadoEscenario): Record<string, Solicitud> {
  return estado.obtener<Record<string, Solicitud>>(CLAVES_ALTA.solicitudes, () => ({}));
}

/** Organizacion recien creada: sucursal INACTIVA con el nombre del registro, sin menu, sin horario, sin zonas y sin hitos. */
function sembrarRestauranteNuevo(estado: EstadoEscenario, s: Solicitud): void {
  estado.guardar("rest.branches", [{ propertyId: PROP.id, name: s.nombreSucursal, slug: "sucursal-1" }]);
  estado.guardar("rest.sucursal", { propertyId: PROP.id, name: s.nombreSucursal, slug: "sucursal-1", status: "inactive", phone: null, address: null, lat: null, lng: null });
  estado.guardar("rest.categorias", []);
  estado.guardar("rest.productos", []);
  estado.guardar("rest.politica", { horario: null, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null });
  estado.guardar("rest.zonas", []);
  estado.guardar("rest.zonasreparto", []);
  estado.guardar(CLAVES_ALTA.metodosPago, false);
  estado.guardar(CLAVES_ALTA.pruebaAgente, false);
}

interface ProductoEstado {
  readonly isAvailable?: boolean;
  readonly branch?: { readonly propertyId: string; readonly isAvailable: boolean } | null;
}
interface PoliticaEstado {
  readonly horario?: readonly unknown[] | null;
  readonly aceptaDomicilio?: boolean;
}
interface SucursalEstado {
  readonly propertyId: string;
  readonly name: string;
  status: "active" | "inactive";
}

/** Las mismas lecturas que la ruta real (productos disponibles en la sucursal, politica, colonias con cobertura e hitos). */
function lecturas(p: Peticion) {
  // Misma semilla que `sucursal()` de restaurantes-panel.ts (el escenario de siempre: una sucursal activa y completa).
  const sucursal = p.estado.obtener<SucursalEstado>("rest.sucursal", () => ({ propertyId: PROP.id, name: PROP.nombre, slug: "centro", status: "active", phone: "+529995550100", address: "Calle 60 #400, Centro, Merida", lat: 20.9674, lng: -89.6237 }));
  const productos = p.estado.obtener<ProductoEstado[]>("rest.productos", () => []);
  const politica = p.estado.obtener<PoliticaEstado>("rest.politica", () => ({ horario: null }));
  const zonas = p.estado.obtener<string[]>("rest.zonasreparto", () => []);
  const disponibles = productos.filter((x) => x.isAvailable !== false && x.branch?.propertyId === sucursal.propertyId && x.branch.isAvailable).length;
  return {
    sucursal,
    productosDisponibles: disponibles,
    tieneHorario: (politica.horario?.length ?? 0) > 0,
    aceptaDomicilio: politica.aceptaDomicilio !== false,
    coloniasConCobertura: zonas.length,
  };
}

function sucursalDe(p: Peticion): SucursalEstado | ReturnType<typeof fallo> {
  const l = lecturas(p);
  return p.params["id"] === l.sucursal.propertyId ? l.sucursal : conStatus(404, { code: "not_found", message: "Sucursal no encontrada." });
}

export const rutasRestaurantesAlta: readonly Ruta[] = [
  // ---------- Registro autoservicio (sin sesion) ----------
  { metodo: "GET", patron: "/auth/registro/restaurantes/estado", publica: true, manejador: () => ({ disponible: true, google: false, correo: true }) },
  {
    metodo: "POST",
    patron: "/auth/registro/restaurantes/iniciar",
    publica: true,
    manejador: (p) => {
      const b = (p.cuerpo ?? {}) as Record<string, unknown>;
      // Trampa de bots: el mismo 202 generico, sin crear nada (el bot no aprende que lo detectaron).
      const ms = typeof b["msLlenado"] === "number" && Number.isFinite(b["msLlenado"]) ? b["msLlenado"] : 0;
      if ((typeof b["sitioWeb"] === "string" && b["sitioWeb"].trim() !== "") || ms < LLENADO_MINIMO_MS) return conStatus(202, { ok: true, metodo: "correo" });
      const metodo = b["metodo"] === "google" ? "google" : b["metodo"] === "correo" ? "correo" : null;
      if (!metodo) return validacion("metodo debe ser 'correo' o 'google'.");
      if (metodo === "google") return conStatus(503, { code: "service_unavailable", message: "El registro con Google no está disponible aún: usa tu correo." });
      if (typeof b["correo"] !== "string" || !correoConForma(b["correo"].trim())) return validacion("Escribe un correo válido.");
      const correo = b["correo"].trim().toLowerCase();
      if (DESECHABLES.has(correo.slice(correo.lastIndexOf("@") + 1))) return validacion("Usa un correo permanente de tu negocio o personal: los correos temporales no se aceptan.");
      const nombreNegocio = texto(b["nombreNegocio"], "El nombre del restaurante");
      if (typeof nombreNegocio !== "string") return nombreNegocio;
      const nombreSucursal = texto(b["nombreSucursal"], "El nombre de la sucursal");
      if (typeof nombreSucursal !== "string") return nombreSucursal;
      const nombreCompleto = texto(b["nombreCompleto"], "Tu nombre");
      if (typeof nombreCompleto !== "string") return nombreCompleto;
      // Ya tiene cuenta: el servidor real le manda «ya tienes cuenta» y responde lo mismo (anti-enumeracion).
      if (!correoConCuenta(correo)) solicitudes(p.estado)[correo] = { correo, nombreNegocio, nombreSucursal, nombreCompleto, usada: false };
      return conStatus(202, { ok: true, metodo: "correo" });
    },
  },
  {
    metodo: "POST",
    patron: "/auth/registro/restaurantes/confirmar",
    publica: true,
    manejador: (p) => {
      const token = (p.cuerpo as { token?: unknown } | undefined)?.token;
      if (typeof token !== "string" || !TOKEN_RE.test(token)) return validacion("Enlace inválido.");
      const correo = correoDeToken(token);
      const s = correo ? solicitudes(p.estado)[correo] : undefined;
      if (!s || s.usada) return conStatus(404, { code: "not_found", message: "El enlace no es válido o ya venció. Vuelve a registrarte para recibir uno nuevo." });
      if (!p.estadoDeEscenario) return conStatus(503, { code: "service_unavailable", message: "El registro de restaurantes no está disponible aún en este despliegue." });
      s.usada = true; // un solo uso, como la base real
      const escenario = escenarioDeCorreo(s.correo);
      sembrarRestauranteNuevo(p.estadoDeEscenario(escenario), s);
      return conStatus(201, {
        code: `${escenario}~${DUENO.id}`,
        orgSlug: DUENO.orgSlug,
        trialEndsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        sucursal: { propertyId: PROP.id, slug: "sucursal-1", status: "inactive" },
      });
    },
  },

  // ---------- Primer valor en <30 min (owner/admin: STAFF_INVITE_ROLES) ----------
  {
    metodo: "GET",
    patron: "/v1/restaurantes/:id/admin/primer-valor",
    roles: GESTION,
    manejador: (p) => {
      const s = sucursalDe(p);
      if (!("propertyId" in s)) return s;
      const l = lecturas(p);
      return calcularPrimerValor({
        ...l,
        sucursal: { propertyId: s.propertyId, nombre: s.name, status: s.status },
        metodosPagoConfirmados: p.estado.obtener<boolean>(CLAVES_ALTA.metodosPago, () => false),
        agenteProbado: p.estado.obtener<boolean>(CLAVES_ALTA.pruebaAgente, () => false),
      });
    },
  },
  {
    metodo: "POST",
    patron: "/v1/restaurantes/:id/admin/primer-valor/metodos-pago",
    roles: GESTION,
    manejador: (p) => {
      const s = sucursalDe(p);
      if (!("propertyId" in s)) return s;
      const yaEstaba = p.estado.obtener<boolean>(CLAVES_ALTA.metodosPago, () => false);
      p.estado.guardar(CLAVES_ALTA.metodosPago, true);
      return { ok: true, yaEstaba };
    },
  },
  {
    metodo: "POST",
    patron: "/v1/restaurantes/:orgSlug/admin/alta-sucursal/:propertyId/activar",
    roles: GESTION,
    manejador: (p) => {
      const orgSlug = p.params["orgSlug"] ?? "";
      const propertyId = p.params["propertyId"] ?? "";
      if (!SLUG_RE.test(orgSlug) || !UUID_RE.test(propertyId)) return conStatus(404, { code: "not_found", message: "Sucursal no encontrada." });
      const l = lecturas(p);
      if (orgSlug !== p.persona?.orgSlug || propertyId !== l.sucursal.propertyId) return conStatus(404, { code: "not_found", message: "Sucursal no encontrada." });
      // Mismos pasos obligatorios que core.activar_propiedad_organizacion (0071): menu, horario y cobertura de entrega.
      const faltantes = [
        ...(l.productosDisponibles > 0 ? [] : ["menu"]),
        ...(l.tieneHorario ? [] : ["horario"]),
        ...(!l.aceptaDomicilio || l.coloniasConCobertura > 0 ? [] : ["zona_de_entrega"]),
      ];
      if (faltantes.length > 0) {
        return conStatus(409, { code: "configuracion_incompleta", message: `No se puede activar todavía: faltan pasos obligatorios antes de activar: ${faltantes.join("; ")}`, faltantes });
      }
      const yaEstabaActiva = l.sucursal.status === "active";
      l.sucursal.status = "active";
      return { propertyId: l.sucursal.propertyId, status: "active", yaEstabaActiva };
    },
  },
];
