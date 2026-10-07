// Fixtures de "Datos de la empresa" de licitaciones (aprobacion real de datos, migracion 036). Forma = apps/web/src/verticals/licitaciones/
// lib/company-data-client.ts. Las reglas espejo del servidor (companyData.ts): decidir solo owner/admin, las tarifas exigen el token de
// step-up del propio usuario, solo se decide un dato pendiente (409 si ya se decidio) y 404 si no existe. Solo existe en la API simulada de e2e.
// Va ANTES de `rutasLicitaciones` en indice.ts: las lecturas vacias de ahi (Resumen) quedan tapadas por estas.
import { conStatus, fallo } from "../respuestas.ts";
import { personaDe } from "../personas.ts";
import type { Peticion, Ruta } from "../tipos.ts";
import { consumirStepUp } from "./step-up.ts";

const L = "/licitaciones/:id";

type Estado = "aprobado" | "pendiente_aprobacion" | "rechazado";
type Tipo = "rates" | "documents" | "capabilities" | "experience" | "signers";
interface Dato {
  id: string;
  approvalStatus: Estado;
  proposedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  [campo: string]: unknown;
}
type Datos = Record<Tipo, Dato[]>;

const OWNER = personaDe("licitaciones", "owner");
const STAFF = personaDe("licitaciones", "staff");
const ADMIN = personaDe("licitaciones", "admin");

const autoria = (proposedBy: string) => ({ proposedBy, approvedBy: null, approvedAt: null });

const semilla = (): Datos => ({
  rates: [
    { id: "rate-1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "pendiente_aprobacion", validFrom: "2026-01-01T00:00:00Z", validUntil: null, ...autoria(STAFF.id) },
    { id: "rate-2", concept: "supervision_obra", unitPrice: "800.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00Z", validUntil: null, proposedBy: STAFF.id, approvedBy: OWNER.id, approvedAt: "2026-09-20T16:00:00.000Z" },
  ],
  documents: [{ id: "doc-1", type: "acta_constitutiva", label: "Acta constitutiva", expiresAt: null, approvalStatus: "pendiente_aprobacion", ...autoria(STAFF.id) }],
  capabilities: [],
  experience: [],
  signers: [{ id: "sig-1", name: "Representante legal", role: "Apoderado", authorized: true, approvalStatus: "aprobado", proposedBy: STAFF.id, approvedBy: OWNER.id, approvedAt: "2026-09-20T16:00:00.000Z" }],
});

const datos = (p: Peticion): Datos => {
  const d = p.estado.obtener<Datos>("licitaciones.datosEmpresa", semilla);
  // Control de pruebas: `mock.agregarAEstado("licitaciones.tarifasExtra", {...})` simula una tarifa nueva propuesta por otra persona.
  const extra = p.estado.obtener<Dato[]>("licitaciones.tarifasExtra", () => []);
  while (extra.length > 0) d.rates.push(extra.shift()!);
  return d;
};
const PEOPLE = { [OWNER.id]: OWNER.fullName, [STAFF.id]: STAFF.fullName, [ADMIN.id]: ADMIN.fullName };

const listado = (clave: Tipo): Ruta => ({ metodo: "GET", patron: `${L}/company/${clave}`, manejador: (p) => ({ [clave]: datos(p)[clave], people: PEOPLE }) });

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
];
