// R12 -- el camino de ENTRADA real (limitarLargoDelMensaje / sanearTextoEntrante de inbound.ts) contra jsonb de Postgres.
// Genera por stdout un SQL con un escenario por entrada hostil (la CLASE: controles, NUL, emoji cortado a media, mensaje enorme): el texto que SALE del
// codigo TypeScript debe caber en `whatsapp_append_turn` (antes R11-08/09 daban 22P05 / 22P02 y el webhook respondia 500).
// Uso: node --experimental-transform-types --no-warnings entradas-contra-pg.mjs | psql ... (run.sh lo hace despues de assertions.sql).
import { limitarLargoDelMensaje } from "../../packages/domain-restaurantes/src/whatsapp/inbound.ts";

const ORG = "00000000-0000-0000-0000-0000000f1101";
const entradas = [
  ["nul_en_medio", "quiero dos tacos\u0000 por favor"],
  ["solo_controles", "\u0000\u0001\u0002\u007f"],
  ["emoji_cortado_paridad_par", "🌮".repeat(2000)],
  ["emoji_cortado_paridad_impar", `a${"🌮".repeat(2000)}`],
  ["sustituto_suelto_de_origen", "tacos \uD83C sin par"],
  ["nul_mas_emoji_mas_enorme", `x\u0000${"🌮 ".repeat(400_000)}`],
  ["texto_normal_con_zwj", "quiero 👨‍👩‍👧‍👦 tacos"],
];

console.log("\\set ON_ERROR_STOP on");
console.log("set client_min_messages = warning;");
let n = 0;
for (const [nombre, crudo] of entradas) {
  n += 1;
  const limpio = limitarLargoDelMensaje(crudo);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(limpio) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(limpio)) {
    console.error(`entradas-contra-pg: '${nombre}' sigue trayendo un caracter que jsonb rechaza`);
    process.exit(2);
  }
  const json = JSON.stringify([{ role: "user", content: limpio }]);
  console.log(`\\echo '=== K${n}. ${nombre}: el texto que produce el TypeScript SI cabe en el historial (jsonb) ==='`);
  console.log("begin;\nset local role authenticated;\nselect set_config('request.jwt.claim.sub', '', true);");
  console.log(`select jsonb_array_length(restaurantes.whatsapp_append_turn('${ORG}', '+5299900001${String(n).padStart(2, "0")}', $j$${json}$j$::jsonb, 'active', null, null)) as ${nombre}_deberia_ser_1;`);
  console.log("rollback;");
}
console.log("\\echo '=== listo: K1..K7 deben devolver 1 (sin ERROR) ==='");
