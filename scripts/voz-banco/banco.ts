// CLI del banco de pruebas de voz (esqueleto, sin proveedores reales). Uso (desde la raiz del repo):
//   npx vite-node scripts/voz-banco/banco.ts listar                      adaptadores registrados
//   npx vite-node scripts/voz-banco/banco.ts validar-corpus              valida PM_CORPUS_SIM (ruta privada, fuera del repo); imprime solo conteos
//   npx vite-node scripts/voz-banco/banco.ts ejemplo [on|off|servidor]   corre los 3 escenarios de ejemplo con el adaptador falso (sin red, sin gasto)
// No llama a ningun proveedor, no lee llaves y no escribe resultados.
import { fileURLToPath } from "node:url";
import { cargarCorpusPrivado, cargarEjemplos } from "./corpus.ts";
import { correrLlamada } from "./correr-llamada.ts";
import { crearAdaptador, listarAdaptadores } from "./registro.ts";
import { TopeExcedido, TopeGasto, corteDeEntorno } from "./topes.ts";
import type { ModoCompuerta } from "./tipos.ts";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));

async function principal(argv: readonly string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === "listar") {
    console.log(listarAdaptadores().join("\n"));
    return 0;
  }
  if (cmd === "validar-corpus") {
    const { validos, errores } = cargarCorpusPrivado(process.env, RAIZ);
    console.log(JSON.stringify({ validos: validos.length, conErrores: errores.length, errores: errores.slice(0, 20) }));
    return errores.length === 0 ? 0 : 2;
  }
  if (cmd === "ejemplo") {
    const modo = (arg ?? "on") as ModoCompuerta;
    if (!["on", "off", "servidor"].includes(modo)) throw new Error("modo de compuerta: on | off | servidor");
    const tope = new TopeGasto(corteDeEntorno(process.env), 1);
    const adaptador = crearAdaptador("falso");
    const salida = [];
    try {
      for (const escenario of cargarEjemplos()) {
        const r = await correrLlamada({
          adaptador, escenario, rep: 1, modoCliente: "stt-final", modoCompuerta: modo, tope,
          apertura: { instruccion: "ejemplo", voiceId: "falso", herramientas: [] },
          ejecutor: async () => ({ ok: true }),
        });
        salida.push({ escenario: r.escenario, turnos: r.turnos.length, herramientas: r.herramientas.length, intentosCrearSinConfirmar: r.intentosCrearSinConfirmar });
      }
    } catch (x) {
      if (x instanceof TopeExcedido) { console.error(x.message); return 3; }
      throw x;
    }
    console.log(JSON.stringify(salida));
    return 0;
  }
  console.error("comandos: listar | validar-corpus | ejemplo [on|off|servidor]");
  return 1;
}

process.exitCode = await principal(process.argv.slice(2));
