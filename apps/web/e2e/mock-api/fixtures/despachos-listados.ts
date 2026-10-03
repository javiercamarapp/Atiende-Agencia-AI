// Fixtures de los LISTADOS de despachos que migraron a DataTable (UNI-C-despachos.3): cobranza, vencimientos y staff.
// Forma = apps/web/src/verticals/despachos/lib/{cobranza,vencimientos,staff}-client.ts. Solo existe en la API simulada de e2e.
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("despachos");
const ORG = orgDe("despachos");
const D = "/despachos/:id";
void ORG;
void PROP;

const CUENTAS = [
  { id: "cta-1", invoiceId: "inv-1", facturaId: "A1B2C3D4-1111-2222-3333", monto: 11600, fechaVencimiento: "2026-08-15", diasVencido: 46, bucket: "31-60", score: 0.55, clienteNombre: "Abarrotes del Sureste SA de CV", clienteEmail: "compras@abarrotes.example.test", montoPagado: null, pagadoEn: null, creadoEn: "2026-08-01T15:00:00.000Z" },
  { id: "cta-2", invoiceId: "inv-2", facturaId: "E5F6A7B8-4444-5555-6666", monto: 3480, fechaVencimiento: "2026-10-20", diasVencido: -20, bucket: "0-30", score: 0.82, clienteNombre: "Taller Mecanico Pech", clienteEmail: null, montoPagado: null, pagadoEn: null, creadoEn: "2026-09-20T15:00:00.000Z" },
  { id: "cta-3", invoiceId: "inv-3", facturaId: "C9D0E1F2-7777-8888-9999", monto: 58000, fechaVencimiento: "2026-06-30", diasVencido: 92, bucket: "90+", score: 0.18, clienteNombre: "Constructora Caribe SA", clienteEmail: "pagos@caribe.example.test", montoPagado: null, pagadoEn: null, creadoEn: "2026-06-01T15:00:00.000Z" },
];

const VENCIMIENTOS = [
  { id: "ven-1", tipo: "IVA", periodo: "2026-09", fechaLimite: "2026-10-17", prioridad: "alta", estado: "pendiente", fechaPresentacion: null, comprobanteUrl: null, diasRestantes: 14, creadoEn: "2026-10-01T15:00:00.000Z", fundamento: "Art. 5-D LIVA: declaracion mensual a mas tardar el dia 17.", validarConFiscalista: false },
  { id: "ven-2", tipo: "DIOT", periodo: "2026-09", fechaLimite: "2026-10-17", prioridad: "media", estado: "en_proceso", fechaPresentacion: null, comprobanteUrl: null, diasRestantes: 14, creadoEn: "2026-10-01T15:00:00.000Z", fundamento: "Regla 4.5.1 RMF: DIOT mensual.", validarConFiscalista: true },
  { id: "ven-3", tipo: "ISR", periodo: "2026-08", fechaLimite: "2026-09-17", prioridad: "critica", estado: "completado", fechaPresentacion: "2026-09-15", comprobanteUrl: "https://example.test/acuse-isr.pdf", diasRestantes: -16, creadoEn: "2026-09-01T15:00:00.000Z", fundamento: "Art. 14 LISR: pago provisional mensual.", validarConFiscalista: false },
];

const INVITACIONES = [{ id: "inv-staff-1", email: "nuevo.contador@example.test", verticalRole: "contador", propertyIds: null, status: "pending", expiresAt: "2026-11-15T12:00:00.000Z", createdAt: "2026-10-01T12:00:00.000Z" }];
const MIEMBROS = [
  { id: "usr-1", email: "ana.contadora@example.test", fullName: "Ana Contadora", verticalRole: "contador", propertyIds: null },
  { id: "usr-2", email: "luis.auditor@example.test", fullName: "Luis Auditor", verticalRole: "auditor", propertyIds: null },
];

export const rutasDespachosListados: readonly Ruta[] = [
  { metodo: "GET", patron: `${D}/cobranza/cuentas`, manejador: () => CUENTAS },
  {
    metodo: "GET",
    patron: `${D}/cobranza/resumen`,
    manejador: () => ({
      totalCartera: 73080,
      totalCount: 3,
      totalEsperado: 25000,
      tasaRecuperacionEsperada: 34,
      porAntiguedad: {
        "0-30": { count: 1, monto: 3480, porcentaje: 5 },
        "31-60": { count: 1, monto: 11600, porcentaje: 16 },
        "61-90": { count: 0, monto: 0, porcentaje: 0 },
        "90+": { count: 1, monto: 58000, porcentaje: 79 },
      },
      alertas: [],
      topMontos: [],
    }),
  },
  { metodo: "GET", patron: `${D}/cfdi`, manejador: () => [] },
  { metodo: "GET", patron: `${D}/vencimientos`, manejador: () => VENCIMIENTOS },
  { metodo: "GET", patron: `${D}/admin/staff/invitaciones`, roles: ["admin", "owner"], manejador: () => ({ invitations: INVITACIONES }) },
  { metodo: "GET", patron: `${D}/admin/staff/miembros`, roles: ["admin", "owner"], manejador: () => ({ miembros: MIEMBROS }) },
];
