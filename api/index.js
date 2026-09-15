// PLACEHOLDER versionado a propósito -- ver scripts/build-vercel-function.mjs y el
// comentario de .gitignore junto a `/api/index.js.map`.
//
// Hallazgo real de infraestructura (2026-09-15): Vercel valida el patrón
// `vercel.json::functions["api/index.js"]` contra el árbol de archivos TAL COMO SE
// CLONÓ DE GIT, ANTES de ejecutar `buildCommand` -- si el archivo no existe ya en el
// repo, el build falla de inmediato ("The pattern ... doesn't match any Serverless
// Functions inside the `api` directory") sin siquiera intentar `npm run build`.
// Confirmado reproduciendo el build localmente con `vercel build`: el error
// desaparece en cuanto existe CUALQUIER archivo en esta ruta, y solo entonces Vercel
// procede a correr el buildCommand real.
//
// Por eso este archivo SÍ se comitea (a diferencia de `api/index.js.map`, que sigue
// ignorado) -- `scripts/build-vercel-function.mjs` lo SOBREESCRIBE SIEMPRE con el
// bundle real (`apps/api/src/vercel.ts` empaquetado) en cada build; el contenido de
// abajo nunca debería servir tráfico real. Si alguna vez lo hace (el build falló
// silenciosamente y Vercel sirvió este placeholder en vez de fallar el deploy),
// responde un 500 honesto en vez de fingir cualquier otra cosa.
export default function handler(_req, res) {
  res.status(500).json({
    code: "build_placeholder_served",
    message: "api/index.js placeholder sin reemplazar por el build real -- ver el comentario de cabecera de este archivo.",
  });
}
