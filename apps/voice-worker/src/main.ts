// Punto de entrada del worker (proceso de larga vida): `node --experimental-strip-types src/main.ts`.
// Lee el entorno, arma la telefonia LiveKit y la escalera de voz de la plataforma y escucha llamadas. Ver README.md.
import { crearEscaleraPlataforma } from "@atiende/voice-core";
import type { SumideroLog } from "@atiende/domain-restaurantes";
import { ClienteApi } from "./api-cliente.ts";
import { cargarConfig } from "./config.ts";
import { crearPuertoLlmOpenRouter } from "./llm-openrouter.ts";
import { cargarPregrabados } from "./pregrabados.ts";
import { LiveKitTelefonia } from "./telefonia/livekit.ts";
import { Worker, crearServidorSalud } from "./worker.ts";

/** Log en JSON por linea. Solo recibe campos ya filtrados por `eventoSinPII` (lista cerrada, sin texto del cliente) o campos propios sin PII. */
const sumidero: SumideroLog = ({ evento, campos }) => console.log(JSON.stringify({ t: new Date().toISOString(), evento, ...campos }));
const logPlano = (evento: string, campos: Readonly<Record<string, string | number | boolean>> = {}): void => sumidero({ evento, campos });

async function main(): Promise<void> {
  const base = cargarConfig(process.env);
  const pregrabados = await cargarPregrabados(base.assetsDir);
  const config = cargarConfig(process.env, { pregrabadosFaltantes: pregrabados.faltantes });

  let worker: Worker;
  if (config.estado === "configurado" && config.livekit) {
    const telefonia = new LiveKitTelefonia({ ...config.livekit, log: logPlano });
    const api = new ClienteApi({ baseUrl: config.apiBaseUrl, internalSecret: config.internalSecret });
    const llm = config.openrouterApiKey ? crearPuertoLlmOpenRouter(config.openrouterApiKey) : null;
    worker = new Worker({
      config,
      telefonia,
      log: logPlano,
      deps: {
        config,
        pregrabados: pregrabados.audios,
        api,
        log: sumidero,
        crearEscalera: () => crearEscaleraPlataforma({ geminiApiKey: config.geminiApiKey, openrouterApiKey: config.openrouterApiKey, llm }),
      },
    });
  } else {
    worker = new Worker({ config, telefonia: null, deps: null, log: logPlano });
  }

  const servidor = crearServidorSalud(worker);
  servidor.listen(config.puertoSalud, () => logPlano("salud_escuchando", { puerto: config.puertoSalud }));
  await worker.iniciar();

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
