#!/usr/bin/env node
// Re-verifica contra la API PUBLICA de OpenRouter (sin llave) que proveedores sirven cada modelo de
// `VERIFIED_MODEL_HOSTS` (apps/api/src/production/llm-models.ts) y cuales tienen endpoint ZDR. Es una
// ayuda manual para actualizar esa tabla: NO corre en CI (necesita red) y no modifica nada.
// Uso: node scripts/check-llm-us-hosts.mjs [modelo ...]   (sin argumentos: todos los de la tabla)
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../apps/api/src/production/llm-models.ts", import.meta.url), "utf8");
const allowedBlock = source.match(/ALLOWED_PROVIDER_HOSTS: readonly string\[\] = \[([^\]]*)\]/)?.[1] ?? "";
const allowed = new Set([...allowedBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
const tableBlock = source.slice(source.indexOf("VERIFIED_MODEL_HOSTS"));
const fromTable = [...tableBlock.matchAll(/^ {2}"([a-z0-9._/-]+)": \{/gm)].map((m) => m[1]);
const models = process.argv.length > 2 ? process.argv.slice(2) : fromTable;

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
};

const zdr = new Set((await get("https://openrouter.ai/api/v1/endpoints/zdr")).data.map((e) => `${e.model_id}|${e.tag}`));
for (const model of models) {
  const { data } = await get(`https://openrouter.ai/api/v1/models/${model}/endpoints`);
  console.log(`\n${model}`);
  const usHosts = new Set();
  for (const e of data.endpoints) {
    const slug = e.tag.split("/")[0];
    const isAllowed = allowed.has(slug);
    const isZdr = zdr.has(`${model}|${e.tag}`);
    if (isAllowed && isZdr) usHosts.add(slug);
    console.log(`  ${e.tag.padEnd(28)} ${isAllowed ? "PERMITIDO" : "fuera de la lista"}  ${isZdr ? "ZDR" : "sin ZDR"}${e.status ? `  (status ${e.status})` : ""}`);
  }
  console.log(`  => proveedores permitidos con ZDR: ${usHosts.size ? [...usHosts].join(", ") : "NINGUNO (el modelo se rechaza en produccion)"}`);
}
