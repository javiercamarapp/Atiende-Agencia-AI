// Fixtures de las pruebas de mensajes al huesped (H-P3-03). Fechas fijas; sin datos reales.
import { InMemoryMensajesHuespedRepository, type CandidatoMensajeHuesped, type ContextoMensajesHuesped, type OpcionesInMemoryMensajesHuesped, type WithMensajesHuespedTx } from "../../src/index.ts";

export const ORG = "00000000-0000-0000-0000-00000000a001";
export const PROP = "00000000-0000-0000-0000-0000000a1a01";
/** 2031-07-02 20:00 UTC = 14:00 en Ciudad de Mexico (dentro de la ventana 08:00-21:00). */
export const AHORA = new Date("2031-07-02T20:00:00Z");

export function candidato(parcial: Partial<CandidatoMensajeHuesped> = {}): CandidatoMensajeHuesped {
  return {
    evento: "hold.aprobado",
    refTipo: "hold",
    refId: "00000000-0000-0000-0000-0000000f1001",
    organizationId: ORG,
    propertyId: PROP,
    propiedadNombre: "Hotel Brisa",
    orgSlug: "hotel-brisa",
    zonaHoraria: "America/Mexico_City",
    huespedNombre: "Ana Torres",
    telefono: "5511112222",
    correo: "ana@example.com",
    llegada: "2031-09-10",
    salida: "2031-09-12",
    totalCentavos: 119000,
    venceEn: "2031-07-03T19:00:00Z",
    disparoEn: "2031-07-02T19:00:00Z",
    phoneNumberId: "10000000000001",
    whatsappHabilitado: true,
    ultimaEntradaEn: null,
    ventanaInicio: "08:00:00",
    ventanaFin: "21:00:00",
    resenaUrl: null,
    horasAntes: null,
    ...parcial,
  };
}

export interface Entorno {
  readonly repo: InMemoryMensajesHuespedRepository;
  readonly withTx: WithMensajesHuespedTx;
  readonly consultasSupresion: string[];
  suprimidos: Set<string>;
  fallaSupresion: boolean;
}

/** Entorno de ejecucion: un repositorio en memoria, una "transaccion" por unidad y una lista de supresion controlable. */
export function crearEntorno(opciones: OpcionesInMemoryMensajesHuesped = {}): Entorno {
  const repo = new InMemoryMensajesHuespedRepository(opciones);
  const entorno: Entorno = {
    repo,
    consultasSupresion: [],
    suprimidos: new Set<string>(),
    fallaSupresion: false,
    withTx: async <T,>(fn: (ctx: ContextoMensajesHuesped) => Promise<T>): Promise<T> =>
      fn({
        repo,
        esSuprimido: async (tipo, valor) => {
          entorno.consultasSupresion.push(`${tipo}:${valor}`);
          if (entorno.fallaSupresion) throw new Error("lista de supresion no verificable");
          return entorno.suprimidos.has(`${tipo}:${valor}`);
        },
      }),
  };
  return entorno;
}

export const OPCIONES = { appBaseUrl: "https://app.atiende.ai", credencialMeta: true, ahora: AHORA } as const;
