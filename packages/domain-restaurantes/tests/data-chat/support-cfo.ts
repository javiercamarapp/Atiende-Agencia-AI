// CFO-09 · dobles de prueba de las herramientas CFO del copiloto: el lector falso entrega un `ServicioCfo` REAL sobre el repositorio en memoria
// con el dataset SINTETICO de CFO-04 (nada de esto es un export real ni toca una base).
import type { DataChatScope } from "@atiende/agent-core/data-chat";
import { InMemoryCfoRepository, type DatasetCfoMemoria, type OpcionesCfoMemoria } from "../../src/cfo/repositorio-memoria.ts";
import { ServicioCfo, type EntradaServicioCfo } from "../../src/cfo/servicio.ts";
import type { FilaEntregaPercentiles } from "../../src/cfo/tipos.ts";
import type { VisibleBranch } from "../../src/data-chat/index.ts";
import { SUCURSALES_PM_SINTETICAS, generarDatasetSintetico } from "../fixtures/cfo-pm-sintetico.ts";
import { FakeReader, ORG_A } from "./support.ts";

export const SUC = SUCURSALES_PM_SINTETICAS;
export const IDS = SUC.map((s) => s.propertyId);
export const [T1, T2, , , T8] = IDS as [string, string, string, string, string, string, string];

export const CFO_BRANCHES: readonly VisibleBranch[] = SUC.map((s) => ({ propertyId: s.propertyId, name: s.nombre, slug: s.codigo.toLowerCase() }));

/** Miercoles 30-sep-2026 12:00 en Merida (UTC-6): el periodo `semana_pasada` (21-27 sep) cae dentro del dataset sintetico. */
export const MIERCOLES_MERIDA = new Date("2026-09-30T18:00:00.000Z");

export const OWNER_CFO_SCOPE: DataChatScope = { organizationId: ORG_A, userId: "user-owner", vertical: "restaurantes", verticalRole: "owner", allowedPropertyIds: null, timezone: "America/Merida" };
export const GERENTE_T1_SCOPE: DataChatScope = { ...OWNER_CFO_SCOPE, userId: "user-gerente", verticalRole: "admin", allowedPropertyIds: [T1] };

const D = generarDatasetSintetico({ diasRango: 120 });
const COBERTURA = IDS.map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-27", zona: "America/Merida", corte: "01:00:00" }));
const PERCENTILES: FilaEntregaPercentiles[] = [
  ...IDS.map((id, i) => ({ propertyId: id, alcance: "sucursal" as const, entregados: 100, p50Min: 35, p90Min: 50 + i * 3 })),
  { propertyId: null, alcance: "conjunto" as const, entregados: 700, p50Min: 37, p90Min: 58 },
];

export interface OpcionesLectorCfo {
  readonly dataset?: Partial<DatasetCfoMemoria>;
  readonly repo?: Partial<OpcionesCfoMemoria>;
  readonly falla?: Error;
}

/** Lector falso con CFO: respeta el alcance igual que la base (sucursales visibles) y arma un servicio real en memoria. */
export class CfoFakeReader extends FakeReader {
  readonly servicios: ServicioCfo[] = [];
  readonly entradas: Array<Omit<EntradaServicioCfo, "repo">> = [];

  constructor(private readonly op: OpcionesLectorCfo = {}) {
    super(CFO_BRANCHES);
  }

  cfo = async (entrada: Omit<EntradaServicioCfo, "repo">): Promise<ServicioCfo> => {
    if (this.op.falla) throw this.op.falla;
    this.entradas.push(entrada);
    const repo = new InMemoryCfoRepository({
      sucursales: IDS,
      permitidas: entrada.alcance.propertyIds,
      organizacionCompleta: entrada.alcance.organizacionCompleta,
      dataset: {
        ventasDiarias: D.ventasDiarias, cortesias: D.cortesias, ventasHora: D.ventasHora, productos: D.productos, agenteDiario: D.agenteDiario, comandasPos: D.comandasPos,
        clientesResumen: D.clientes, agotados: D.agotados, cobertura: COBERTURA, entregasPercentiles: PERCENTILES, ...this.op.dataset,
      },
      ...this.op.repo,
    });
    const s = new ServicioCfo({ ...entrada, repo });
    this.servicios.push(s);
    return s;
  };
}

export const DATASET_SINTETICO = D;
