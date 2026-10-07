// Genera los 15 audios PREGRABADOS de la llamada de Los Taquitos de PM (una sola vez) con el TTS de la cascada de voz y los guarda en
// apps/voice-worker/assets/. Uso (desde la raiz del repo):
//
//   OPENROUTER_API_KEY=... npm run voz:pregrabados -- [--tope-usd=0.25] [--voz=Kore] [--forzar] [--dir=apps/voice-worker/assets]
//
//   npm run voz:pregrabados -- --verificar [--dir=apps/voice-worker/assets]   (sin llave, sin costo: comprueba que los 15 WAV existen, son PCM16 mono, 8/16/24 kHz y duran > 0.5 s)
//
// Sin la llave falla con un mensaje claro y no genera nada. Respeta el tope de gasto (estimado antes de pedir el primer audio). Ver docs/VOZ-PM.md.
import { MENSAJES_PREGRABADOS } from "@atiende/domain-restaurantes";
import { VOZ_POR_DEFECTO } from "@atiende/voice-core";
import { PregrabadosError, generarPregrabados } from "../apps/voice-worker/src/pregrabados-generar.ts";
import { verificarPregrabados } from "../apps/voice-worker/src/pregrabados.ts";

function opcion(args: readonly string[], nombre: string): string | undefined {
  const pref = `--${nombre}=`;
  return args.find((a) => a.startsWith(pref))?.slice(pref.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--verificar")) {
    const v = await verificarPregrabados(opcion(args, "dir") ?? "apps/voice-worker/assets");
    for (const r of v.reportes) console.log(`${r.ok ? "OK   " : "FALLA"} ${r.id}${r.hz ? ` ${r.hz} Hz ${r.duracionS} s` : ""}${r.problema ? ` - ${r.problema}` : ""}`);
    console.log(v.ok ? "Los 15 pregrabados son validos. Escuchelos antes de desplegar." : "Hay pregrabados invalidos o faltantes: corre npm run voz:pregrabados.");
    process.exit(v.ok ? 0 : 1);
  }
  const resultado = await generarPregrabados({
    apiKey: process.env.OPENROUTER_API_KEY ?? null,
    textos: MENSAJES_PREGRABADOS,
    dir: opcion(args, "dir") ?? "apps/voice-worker/assets",
    voz: opcion(args, "voz") ?? VOZ_POR_DEFECTO,
    topeUsd: Number(opcion(args, "tope-usd") ?? "0.25"),
    forzar: args.includes("--forzar"),
  });
  console.log(`Generados: ${resultado.generados.length}. Ya existian (omitidos): ${resultado.omitidos.length}. Fallidos: ${resultado.fallidos.length}.`);
  console.log(`Costo estimado: ${(resultado.costoEstimadoMicroUsd / 1_000_000).toFixed(4)} USD.`);
  for (const f of resultado.fallidos) console.error(`  - ${f.id}: ${f.motivo}`);
  if (resultado.fallidos.length > 0) process.exitCode = 1;
  else console.log("Listo. Escuche los audios antes de publicarlos (docs/VOZ-PM.md, paso 5).");
}

main().catch((err: unknown) => {
  console.error(err instanceof PregrabadosError ? err.message : "Error inesperado al generar los pregrabados.");
  process.exit(1);
});
