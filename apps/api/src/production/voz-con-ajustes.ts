// Decorador del proveedor de voz que aplica los AJUSTES de la organizacion a la sesion de vista previa: la temperatura se manda a Gemini Live y la
// instruccion lleva el conocimiento automatico del negocio al principio, el comportamiento propio de la sucursal (con sus reglas duras) despues y el
// ritmo/estilo de habla al final (ver `instruccionConAjustes`). Asi la vista previa del panel suena como sonara la llamada con esos ajustes, sin tocar las
// rutas de voz. Si la lectura de ajustes falla, la sesion sale tal como la pidio la ruta (nunca se cae por esto).
import type { VoiceAgentProvider, VozSesionPreviewEntrada } from "@atiende/voice-core";
import { bloqueConocimientoOVacio, instruccionConAjustes, PostgresAjustesAgenteRepository, PostgresRestaurantesRepository } from "@atiende/domain-restaurantes";
import type { AjustesAgente } from "@atiende/domain-restaurantes";
import type { TenancyEngine } from "@atiende/core-tenancy";

export interface AjustesParaVoz {
  readonly ajustes: AjustesAgente;
  /** Bloque de conocimiento automatico para la instruccion ('' si no hay datos). */
  readonly conocimientoTexto: string;
}

export type ResolverAjustesVoz = (organizationId: string) => Promise<AjustesParaVoz | null>;

export function conAjustesDeVoz(inner: VoiceAgentProvider, resolver: ResolverAjustesVoz): VoiceAgentProvider {
  return {
    get id() {
      return inner.id;
    },
    catalogoVoces: () => inner.catalogoVoces(),
    salud: () => inner.salud(),
    ...(inner.abrirLlamada ? { abrirLlamada: inner.abrirLlamada } : {}),
    async emitirSesionPreview(entrada: VozSesionPreviewEntrada) {
      // Los ajustes son de restaurantes: hoteles y citas pasan directo, sin sesion extra ni consultas a restaurantes.*.
      if (entrada.vertical !== "restaurantes") return inner.emitirSesionPreview(entrada);
      let extra: AjustesParaVoz | null = null;
      try {
        extra = await resolver(entrada.organizationId);
      } catch {
        extra = null;
      }
      if (!extra) return inner.emitirSesionPreview(entrada);
      return inner.emitirSesionPreview({
        ...entrada,
        comportamiento: instruccionConAjustes(entrada.comportamiento, extra.ajustes, { texto: extra.conocimientoTexto }),
        temperatura: extra.ajustes.vozTemperatura,
      });
    },
  };
}

/** Resolver de produccion: sesion de SISTEMA (la emision del token ocurre fuera de la sesion del staff). Los repositorios degradan con SAVEPOINT contra la base sin migrar. */
export function resolverAjustesVozPostgres(engine: TenancyEngine): ResolverAjustesVoz {
  return (organizationId) =>
    engine.withAppSession({ userId: null }, async (db) => {
      const lectura = await new PostgresAjustesAgenteRepository(db).leer(organizationId);
      const bloque = await bloqueConocimientoOVacio(db, new PostgresRestaurantesRepository(db), organizationId);
      return { ajustes: lectura.valor, conocimientoTexto: bloque.texto };
    });
}
