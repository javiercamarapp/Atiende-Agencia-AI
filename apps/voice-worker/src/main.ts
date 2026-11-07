// Punto de entrada del worker (proceso de larga vida): `node --experimental-strip-types src/main.ts`.
// Lee el entorno, arma la telefonia LiveKit y la escalera de voz de la plataforma y escucha llamadas. Ver README.md.
import { VOZ_PLATAFORMA, crearEscaleraPlataforma } from "@atiende/voice-core";
import { CONFIRMACION_VOZ_PM, OMITIR_ACUSE_VOZ_PM, OPCIONES_ESCALERA_PM } from "./llamada.ts";
import { HERRAMIENTAS_VOZ_SOLO_LECTURA, LIMITES_VOZ_PM } from "@atiende/domain-restaurantes";
import type { SumideroLog } from "@atiende/domain-restaurantes";
import { ClienteApi } from "./api-cliente.ts";
import { cargarConfig } from "./config.ts";
import { crearPuertoLlmOpenRouter, crearPuertoLlmVozV2 } from "./llm-openrouter.ts";
import { cargarPregrabados } from "./pregrabados.ts";
import { crearProveedorTokenVertex } from "./vertex-token.ts";
import { Worker, crearServidorSalud } from "./worker.ts";
import { cargarCancelacionRuido } from "./telefonia/ruido.ts";

/** Log en JSON por linea. Solo recibe campos ya filtrados por `eventoSinPII` (lista cerrada, sin texto del cliente) o campos propios sin PII. */
const sumidero: SumideroLog = ({ evento, campos }) => console.log(JSON.stringify({ t: new Date().toISOString(), evento, ...campos }));
const logPlano = (evento: string, campos: Readonly<Record<string, string | number | boolean>> = {}): void => sumidero({ evento, campos });

async function main(): Promise<void> {
  const base = cargarConfig(process.env);
  const pregrabados = await cargarPregrabados(base.assetsDir);
  const config = cargarConfig(process.env, { pregrabadosFaltantes: pregrabados.faltantes });

  let worker: Worker;
  if (config.estado === "configurado" && config.livekit) {
    // Import diferido: el SDK de LiveKit trae un binario nativo. Un worker NO configurado (o en una maquina sin el binario) debe poder arrancar y
    // responder 503 en /salud en vez de caerse al cargar un modulo que no va a usar.
    const { LiveKitTelefonia } = await import("./telefonia/livekit.ts");
    // Cancelacion de ruido de LiveKit sobre el audio del cliente (`VOZ_RUIDO`, apagada por omision; Krisp requiere LiveKit Cloud). Si el modulo no carga, se atiende sin ella y se registra.
    const ruido = await cargarCancelacionRuido(config.ruido, logPlano);
    const telefonia = new LiveKitTelefonia({ ...config.livekit, log: logPlano, ...(ruido ? { cancelacionRuido: ruido } : {}) });
    const api = new ClienteApi({ baseUrl: config.apiBaseUrl, internalSecret: config.internalSecret });
    const llm = config.openrouterApiKey ? crearPuertoLlmOpenRouter(config.openrouterApiKey) : null;
    // Cascada v2 (Deepgram + OpenRouter en streaming): su propio puerto, que honra el modelo y el esfuerzo por turno y no manda `temperature`.
    const llmV2 = config.openrouterApiKey ? crearPuertoLlmVozV2(config.openrouterApiKey, undefined, { proveedoresZdr: config.proveedoresZdr }) : null;
    // Vertex AI (opcional, no activado por omision): el token de la cuenta de servicio se renueva solo; se pide al abrir cada sesion.
    const vertex = config.vertex ? { project: config.vertex.project, location: config.vertex.location, accessToken: crearProveedorTokenVertex({ credencialesJson: config.vertex.serviceAccountJson }) } : undefined;
    worker = new Worker({
      config,
      telefonia,
      log: logPlano,
      deps: {
        config,
        pregrabados: pregrabados.audios,
        api,
        log: sumidero,
        crearEscalera: () => crearEscaleraPlataforma({ geminiApiKey: config.geminiApiKey, openrouterApiKey: config.openrouterApiKey, deepgramApiKey: config.deepgramApiKey, elevenlabsApiKey: config.elevenlabsApiKey, ...(config.escalera ? { config: { ...VOZ_PLATAFORMA, escalera: config.escalera } } : {}), dosNiveles: config.cerebroDosNiveles, cascadaV2Habilitada: config.cascadaV2Habilitada, confirmacionAntesDeCrear: CONFIRMACION_VOZ_PM, omitirAcuse: OMITIR_ACUSE_VOZ_PM, llm, llmV2, log: sumidero, herramientasEnParalelo: HERRAMIENTAS_VOZ_SOLO_LECTURA, ...(Object.keys(config.vad).length > 0 ? { vad: config.vad } : {}), ...(vertex ? { vertex } : {}) }, OPCIONES_ESCALERA_PM),
        ...(config.costoMaxLlamadaMicroUsd !== null ? { limites: { ...LIMITES_VOZ_PM, costoMaxMicroUsd: config.costoMaxLlamadaMicroUsd } } : {}),
      },
    });
  } else {
    worker = new Worker({ config, telefonia: null, deps: null, log: logPlano });
  }

  const servidor = crearServidorSalud(worker);
  servidor.listen(config.puertoSalud, () => logPlano("salud_escuchando", { puerto: config.puertoSalud }));
  await worker.iniciar();

  // Perro guardian: si el sondeo de LiveKit lleva 2 min sin responder (y no hay llamadas), se sale con error para que Fly reinicie la maquina.
  const guardian = setInterval(() => {
    if (!worker.latidoVencido()) return;
    logPlano("worker_sin_latido_reiniciando");
    process.exit(1);
  }, 30_000);
  guardian.unref();

  const apagar = (): void => {
    logPlano("worker_apagando");
    void worker.detener().finally(() => {
      servidor.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", apagar);
  process.on("SIGINT", apagar);
}

main().catch(() => {
  // Sin detalle: el error podria traer una URL con credenciales del SDK.
  logPlano("worker_error_fatal");
  process.exit(1);
});
