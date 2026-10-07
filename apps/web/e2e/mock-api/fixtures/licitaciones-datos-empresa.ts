// Fixtures de "Datos de la empresa" de licitaciones (aprobacion real de datos, migracion 036; perfil completo y procedencia, migracion 040). Forma = apps/web/src/verticals/licitaciones/
// lib/company-data-client.ts. Las reglas espejo del servidor (companyData.ts): decidir solo owner/admin, las tarifas exigen el token de
// step-up del propio usuario, solo se decide un dato pendiente (409 si ya se decidio) y 404 si no existe. Solo existe en la API simulada de e2e.
// Va ANTES de `rutasLicitaciones` en indice.ts: las lecturas vacias de ahi (Resumen) quedan tapadas por estas.
import { conStatus, fallo } from "../respuestas.ts";
import { personaDe } from "../personas.ts";
import type { Peticion, Ruta } from "../tipos.ts";
import { consumirStepUp } from "./step-up.ts";

const L = "/licitaciones/:id";

type Estado = "aprobado" | "pendiente_aprobacion" | "rechazado";
type Tipo = "rates" | "documents" | "capabilities" | "experience" | "signers" | "profile" | "products-services" | "locations" | "restrictions" | "stakeholders";
interface Dato {
  id: string;
  approvalStatus: Estado;
  proposedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Procedencia (REQ-142) del registro: quien lo capturo. Se publica en el mapa `provenance` del listado, no como campo del dato. */
  _prov?: { by: string; source: string; at: string };
  [campo: string]: unknown;
}
type Datos = Record<Tipo, Dato[]>;

const OWNER = personaDe("licitaciones", "owner");
const STAFF = personaDe("licitaciones", "staff");
const ADMIN = personaDe("licitaciones", "admin");

const autoria = (proposedBy: string) => ({ proposedBy, approvedBy: null, approvedAt: null });
const PROV_STAFF = { by: STAFF.id, source: "manual", at: "2026-09-20T15:00:00.000Z" };

const semilla = (): Datos => ({
  rates: [
    { id: "rate-1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "pendiente_aprobacion", validFrom: "2026-01-01T00:00:00Z", validUntil: null, ...autoria(STAFF.id) },
    { id: "rate-2", concept: "supervision_obra", unitPrice: "800.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00Z", validUntil: null, proposedBy: STAFF.id, approvedBy: OWNER.id, approvedAt: "2026-09-20T16:00:00.000Z" },
  ],
  documents: [{ id: "doc-1", type: "acta_constitutiva", label: "Acta constitutiva", expiresAt: null, approvalStatus: "pendiente_aprobacion", ...autoria(STAFF.id) }],
  capabilities: [],
  experience: [],
  // El poder del firmante sembrado ya vencio (fecha fija en el pasado): la pantalla lo muestra en rojo.
  signers: [{ id: "sig-1", name: "Representante legal", role: "Apoderado", authorized: true, approvalStatus: "aprobado", proposedBy: STAFF.id, approvedBy: OWNER.id, approvedAt: "2026-09-20T16:00:00.000Z", validFrom: "2023-01-01", validUntil: "2025-12-31", identityDocId: null, actionLimits: null, _prov: PROV_STAFF }],
  // Perfil completo (040): sin perfil todavia; un socio capturado por la aplicacion y una restriccion sembrada.
  profile: [],
  "products-services": [],
  locations: [],
  restrictions: [],
  stakeholders: [{ id: "soc-1", kind: "socio", fullName: "Socia fundadora", rfc: null, participationPct: "60.00", approvalStatus: "aprobado", proposedBy: STAFF.id, approvedBy: OWNER.id, approvedAt: "2026-09-20T16:00:00.000Z", _prov: PROV_STAFF }],
});

const datos = (p: Peticion): Datos => {
  const d = p.estado.obtener<Datos>("licitaciones.datosEmpresa", semilla);
  // Control de pruebas: `mock.agregarAEstado("licitaciones.tarifasExtra", {...})` simula una tarifa nueva propuesta por otra persona.
  const extra = p.estado.obtener<Dato[]>("licitaciones.tarifasExtra", () => []);
  while (extra.length > 0) d.rates.push(extra.shift()!);
  return d;
};
const PEOPLE = { [OWNER.id]: OWNER.fullName, [STAFF.id]: STAFF.fullName, [ADMIN.id]: ADMIN.fullName };

const publicos = (lista: Dato[]) => lista.map(({ _prov: _omitida, ...resto }) => resto);
const procedenciaDe = (lista: Dato[]) => Object.fromEntries(lista.filter((d) => d._prov).map((d) => [d.id, d._prov]));

const listado = (clave: Tipo, claveRespuesta: string = clave): Ruta => ({
  metodo: "GET",
  patron: `${L}/company/${clave}`,
  manejador: (p) => {
    const lista = datos(p)[clave];
    return { [claveRespuesta]: publicos(lista), people: PEOPLE, provenance: procedenciaDe(lista), ...(clave === "signers" ? { vigenciaDisponible: true } : { disponible: true }) };
  },
});

const HOY = "2026-10-04T16:00:00.000Z";

/** Altas y ediciones del perfil completo: espejo de companyProfile.ts (nace pendiente, editar regresa a pendiente, procedencia de quien escribe). */
function escritura(clave: "products-services" | "locations" | "restrictions" | "stakeholders", prefijo: string): readonly Ruta[] {
  return [
    {
      metodo: "POST",
      patron: `${L}/company/${clave}`,
      manejador: (p) => {
        const lista = datos(p)[clave];
        const nuevo: Dato = { id: `${prefijo}-${lista.length + 1}`, ...(p.cuerpo as object), approvalStatus: "pendiente_aprobacion", ...autoria(p.persona!.id), _prov: { by: p.persona!.id, source: "manual", at: HOY } };
        lista.push(nuevo);
        return conStatus(201, publicos([nuevo])[0]);
      },
    },
    {
      metodo: "PATCH",
      patron: `${L}/company/${clave}/:itemId`,
      manejador: (p) => {
        const lista = datos(p)[clave];
        const dato = lista.find((d) => d.id === p.params.itemId);
        if (!dato) return fallo(404, "Dato de empresa no encontrado.");
        Object.assign(dato, p.cuerpo, { approvalStatus: "pendiente_aprobacion", approvedBy: null, approvedAt: null, proposedBy: p.persona!.id, _prov: { by: p.persona!.id, source: "manual", at: HOY } });
        return conStatus(200, publicos([dato])[0]);
      },
    },
    {
      metodo: "DELETE",
      patron: `${L}/company/${clave}/:itemId`,
      manejador: (p) => {
        const lista = datos(p)[clave];
        const indice = lista.findIndex((d) => d.id === p.params.itemId);
        if (indice === -1) return fallo(404, "Dato de empresa no encontrado.");
        lista.splice(indice, 1);
        return conStatus(200, { id: p.params.itemId, deleted: true });
      },
    },
  ];
}

/** Estratificacion simplificada SOLO para la API simulada (el calculo real vive en el servidor con las cifras de la ficha sin verificar). */
function mipymeDe(perfil: Dato | undefined) {
  const meta = { verificacion: "sin_verificar", validarConAbogado: true };
  const faltan: string[] = [];
  if (!perfil?.sector) faltan.push("sector");
  if (perfil?.employeeCount == null) faltan.push("numero de trabajadores");
  if (perfil?.annualSalesCents == null) faltan.push("ventas anuales");
  if (!perfil || faltan.length > 0) return perfil ? { status: "no_evaluable", motivo: "Faltan datos.", faltan, ...meta } : null;
  const puntaje = (perfil.employeeCount as number) * 0.1 + ((perfil.annualSalesCents as number) / 100 / 1_000_000) * 0.9;
  return { status: "calculado", estrato: puntaje <= 4.6 ? "micro" : puntaje <= 95 ? "pequena" : "mediana", puntajeCombinado: String(Math.round(puntaje * 100) / 100), ...meta };
}
const NORMA = { id: "ldcmipyme-estratificacion", titulo: "Estratificacion de empresas (REQ-109)", estadoVerificacion: "sin_verificar", validarConAbogado: true, nota: "Confirmar con abogado." };

function decidir(tipo: Tipo, parametro: string, decision: "aprobado" | "rechazado"): Ruta {
  return {
    metodo: "POST",
    patron: `${L}/company/${tipo}/:${parametro}/${decision === "aprobado" ? "approve" : "reject"}`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      // Solo las tarifas exigen el token de step-up del propio usuario (igual que `requireStepUp` en el servidor).
      if (tipo === "rates") { const sinStepUp = consumirStepUp(p); if (sinStepUp) return fallo(403, sinStepUp); }
      const dato = datos(p)[tipo].find((d) => d.id === p.params[parametro]);
      if (!dato) return fallo(404, "Dato de empresa no encontrado.");
      if (dato.proposedBy === p.persona!.id) return fallo(403, "La persona que propuso o editó por última vez este dato no puede decidirlo: lo debe decidir otra persona con rol de decisión.");
      if (dato.approvalStatus !== "pendiente_aprobacion") return fallo(409, "Este dato ya no está pendiente de aprobación (otra persona lo decidió o se editó). Vuelve a consultarlo.");
      dato.approvalStatus = decision;
      dato.approvedBy = p.persona!.id;
      dato.approvedAt = "2026-10-04T16:00:00.000Z";
      return conStatus(200, { id: dato.id, kind: tipo, approvalStatus: decision, decidedBy: p.persona!.id });
    },
  };
}

export const rutasLicitacionesDatosEmpresa: readonly Ruta[] = [
  listado("rates"),
  listado("documents"),
  listado("capabilities"),
  listado("experience"),
  listado("signers"),
  listado("products-services", "productsServices"),
  listado("locations"),
  listado("restrictions"),
  listado("stakeholders"),
  {
    metodo: "GET",
    patron: `${L}/company/profile`,
    manejador: (p) => {
      const [perfil] = datos(p).profile;
      return { disponible: true, profile: perfil ? publicos([perfil])[0] : null, mipyme: mipymeDe(perfil), norma: NORMA, people: PEOPLE, provenance: procedenciaDe(datos(p).profile) };
    },
  },
  {
    metodo: "PUT",
    patron: `${L}/company/profile`,
    manejador: (p) => {
      const lista = datos(p).profile;
      const cuerpo = p.cuerpo as Record<string, unknown>;
      const datosPerfil = { ...cuerpo, taxId: String(cuerpo.taxId ?? "").trim().toUpperCase() };
      const previo = lista[0];
      if (previo) {
        Object.assign(previo, datosPerfil, { approvalStatus: "pendiente_aprobacion", approvedBy: null, approvedAt: null, proposedBy: p.persona!.id, _prov: { by: p.persona!.id, source: "manual", at: HOY } });
        return conStatus(200, publicos([previo])[0]);
      }
      const nuevo: Dato = { id: "perfil-1", ...datosPerfil, approvalStatus: "pendiente_aprobacion", ...autoria(p.persona!.id), _prov: { by: p.persona!.id, source: "manual", at: HOY } };
      lista.push(nuevo);
      return conStatus(201, publicos([nuevo])[0]);
    },
  },
  ...escritura("products-services", "prod"),
  ...escritura("locations", "ubi"),
  ...escritura("restrictions", "res"),
  ...escritura("stakeholders", "soc"),
  decidir("rates", "rateId", "aprobado"),
  decidir("rates", "rateId", "rechazado"),
  decidir("documents", "documentId", "aprobado"),
  decidir("documents", "documentId", "rechazado"),
  decidir("capabilities", "capabilityId", "aprobado"),
  decidir("capabilities", "capabilityId", "rechazado"),
  decidir("experience", "experienceId", "aprobado"),
  decidir("experience", "experienceId", "rechazado"),
  decidir("signers", "signerId", "aprobado"),
  decidir("signers", "signerId", "rechazado"),
  decidir("profile", "profileId", "aprobado"),
  decidir("profile", "profileId", "rechazado"),
  decidir("products-services", "itemId", "aprobado"),
  decidir("products-services", "itemId", "rechazado"),
  decidir("locations", "itemId", "aprobado"),
  decidir("locations", "itemId", "rechazado"),
  decidir("restrictions", "itemId", "aprobado"),
  decidir("restrictions", "itemId", "rechazado"),
  decidir("stakeholders", "itemId", "aprobado"),
  decidir("stakeholders", "itemId", "rechazado"),
  // Altas y ediciones de firmantes (con vigencia del poder): el listado de arriba ya los publica con `vigenciaDisponible`.
  {
    metodo: "POST",
    patron: `${L}/company/signers`,
    manejador: (p) => {
      const lista = datos(p).signers;
      const cuerpo = p.cuerpo as Record<string, unknown>;
      const nuevo: Dato = { id: `sig-${lista.length + 1}`, validUntil: null, identityDocId: null, actionLimits: null, ...cuerpo, approvalStatus: "pendiente_aprobacion", ...autoria(p.persona!.id), _prov: { by: p.persona!.id, source: "manual", at: HOY } };
      lista.push(nuevo);
      return conStatus(201, publicos([nuevo])[0]);
    },
  },
  {
    metodo: "PATCH",
    patron: `${L}/company/signers/:signerId`,
    manejador: (p) => {
      const dato = datos(p).signers.find((d) => d.id === p.params.signerId);
      if (!dato) return fallo(404, "Dato de empresa no encontrado.");
      Object.assign(dato, p.cuerpo, { approvalStatus: "pendiente_aprobacion", approvedBy: null, approvedAt: null, proposedBy: p.persona!.id, _prov: { by: p.persona!.id, source: "manual", at: HOY } });
      return conStatus(200, publicos([dato])[0]);
    },
  },
];
