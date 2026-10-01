import type { DataChatScope } from "@atiende/agent-core/data-chat";
import {
  DataChatUnavailableError,
  type AntiguedadRow,
  type CarteraClienteRow,
  type CargaClienteRow,
  type CfdiTipoRow,
  type CierrePendienteRow,
  type DespachosDataChatReader,
  type DespachosDataChatWindow,
  type EfosAlertasResultado,
  type IvaClienteRow,
  type ObligacionRow,
  type VisibleClient,
} from "../../src/data-chat/index.ts";

export const ORG_A = "00000000-0000-0000-0000-0000000000a1";
export const CLIENT_ABARROTES = "00000000-0000-0000-0000-0000000000c1";
export const CLIENT_TALLER = "00000000-0000-0000-0000-0000000000c2";
export const CLIENT_CLINICA = "00000000-0000-0000-0000-0000000000c3";

export const ALL_CLIENTS: readonly VisibleClient[] = [
  { propertyId: CLIENT_ABARROTES, name: "Abarrotes La Esquina SA de CV" },
  { propertyId: CLIENT_TALLER, name: "Taller Mecánico Peninsular" },
  { propertyId: CLIENT_CLINICA, name: "Clínica Dental Mérida" },
];

/** 29-sep-2026 23:30 en Mérida = 30-sep 05:30 UTC (en UTC ya es "mañana"). */
export const NOW = new Date("2026-09-30T05:30:00.000Z");

export const ADMIN_SCOPE: DataChatScope = {
  organizationId: ORG_A,
  userId: "user-admin",
  vertical: "despachos",
  verticalRole: "admin",
  allowedPropertyIds: null,
  timezone: "America/Merida",
};

export const CONTADOR_TALLER_SCOPE: DataChatScope = { ...ADMIN_SCOPE, userId: "user-contador", verticalRole: "contador", allowedPropertyIds: [CLIENT_TALLER] };

export interface Call {
  readonly method: string;
  readonly window?: DespachosDataChatWindow;
  readonly extra?: unknown;
}

/** Doble del lector: registra cada llamada y respeta el alcance igual que la base real (filtra clientes visibles). */
export class FakeReader implements DespachosDataChatReader {
  readonly calls: Call[] = [];
  cartera: readonly CarteraClienteRow[] = [
    { cliente: "Abarrotes La Esquina SA de CV", cuentasPendientes: 4, montoPendiente: 120000.5, cuentasVencidas: 2, montoVencido: 45000.25 },
    { cliente: "Taller Mecánico Peninsular", cuentasPendientes: 1, montoPendiente: 8000, cuentasVencidas: 0, montoVencido: 0 },
  ];
  antiguedad: readonly AntiguedadRow[] = [
    { bucket: "Vigente (aún no vence)", cuentas: 2, monto: 75000.25 },
    { bucket: "1 a 30 días vencida", cuentas: 1, monto: 20000 },
    { bucket: "Más de 90 días vencida", cuentas: 1, monto: 25000.25 },
  ];
  cfdi: readonly CfdiTipoRow[] = [
    { tipo: "I", cfdi: 40, total: 250000.1, invalidos: 3, enRevision: 2 },
    { tipo: "N", cfdi: 12, total: 90000, invalidos: 0, enRevision: 0 },
  ];
  iva: readonly IvaClienteRow[] = [
    { cliente: "Abarrotes La Esquina SA de CV", cfdi: 30, base: 200000, ivaAcreditable: 32000 },
    { cliente: "Taller Mecánico Peninsular", cfdi: 10, base: 50000.1, ivaAcreditable: 8000.02 },
  ];
  obligaciones: readonly ObligacionRow[] = [
    { cliente: "Abarrotes La Esquina SA de CV", tipo: "IVA", periodo: "2026-09", fechaLimite: "2026-10-17", estado: "pendiente", prioridad: "alta" },
    { cliente: "Taller Mecánico Peninsular", tipo: "DIOT", periodo: "2026-08", fechaLimite: "2026-09-17", estado: "vencido", prioridad: "critica" },
    { cliente: "Clínica Dental Mérida", tipo: "ISR", periodo: "2026-08", fechaLimite: "2026-09-17", estado: "completado", prioridad: "media" },
  ];
  cierres: readonly CierrePendienteRow[] = [
    { cliente: "Abarrotes La Esquina SA de CV", anio: 2026, mes: 8, status: "overdue", tareasTotal: 10, tareasPendientes: 4, tareasVencidas: 3 },
    { cliente: "Taller Mecánico Peninsular", anio: 2026, mes: 9, status: "open", tareasTotal: 10, tareasPendientes: 9, tareasVencidas: 0 },
  ];
  carga: readonly CargaClienteRow[] = [
    { cliente: "Abarrotes La Esquina SA de CV", revisionesPendientes: 5, vencimientosAbiertos: 3, vencimientosVencidos: 1, tareasCierrePendientes: 4 },
    { cliente: "Taller Mecánico Peninsular", revisionesPendientes: 0, vencimientosAbiertos: 1, vencimientosVencidos: 0, tareasCierrePendientes: 9 },
  ];
  efos: EfosAlertasResultado = {
    estado: "disponible",
    periodoLista: "2026-09",
    truncado: false,
    alertas: [
      { cliente: "Abarrotes La Esquina SA de CV", rfcEmisor: "AAA010101AAA", emisorNombre: "Proveedor Fantasma SA", situacion: "definitivo", cfdi: 3, total: 58000.5 },
      { cliente: "Taller Mecánico Peninsular", rfcEmisor: "BBB020202BBB", emisorNombre: null, situacion: "presunto", cfdi: 1, total: 1200 },
    ],
  };
  failWith: Error | null = null;

  constructor(private readonly clients: readonly VisibleClient[] = ALL_CLIENTS) {}

  private enter(method: string, window?: DespachosDataChatWindow, extra?: unknown): void {
    this.calls.push({ method, window, extra });
    if (this.failWith && method !== "listVisibleClients") throw this.failWith;
  }

  async listVisibleClients(organizationId: string, propertyIds: readonly string[] | null): Promise<readonly VisibleClient[]> {
    this.enter("listVisibleClients", undefined, { organizationId, propertyIds });
    return propertyIds === null ? this.clients : this.clients.filter((c) => propertyIds.includes(c.propertyId));
  }
  async carteraPorCliente(w: DespachosDataChatWindow) {
    this.enter("carteraPorCliente", w);
    return this.cartera;
  }
  async antiguedadCobranza(w: DespachosDataChatWindow) {
    this.enter("antiguedadCobranza", w);
    return this.antiguedad;
  }
  async cfdiPorPeriodo(w: DespachosDataChatWindow) {
    this.enter("cfdiPorPeriodo", w);
    return this.cfdi;
  }
  async ivaAcreditable(w: DespachosDataChatWindow) {
    this.enter("ivaAcreditable", w);
    return this.iva;
  }
  async obligacionesFiscales(w: DespachosDataChatWindow) {
    this.enter("obligacionesFiscales", w);
    return this.obligaciones;
  }
  async cierresPendientes(w: DespachosDataChatWindow) {
    this.enter("cierresPendientes", w);
    return this.cierres;
  }
  async cargaDeTrabajo(w: DespachosDataChatWindow) {
    this.enter("cargaDeTrabajo", w);
    return this.carga;
  }
  async efosAlertas(clients: readonly VisibleClient[]) {
    this.enter("efosAlertas", undefined, clients.map((c) => c.propertyId));
    return this.efos;
  }
}

export const unavailable = (): DataChatUnavailableError => new DataChatUnavailableError("cobranza");
