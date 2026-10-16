# Imagen del worker de telefonia de voz (apps/voice-worker). Se construye DESDE LA RAIZ del repo:
#
#   docker build -f apps/voice-worker/Dockerfile -t atiende-voice-worker .
#
# Sin daemon de Docker en la maquina de desarrollo (Docker Desktop instalado pero apagado) la imagen NO se construyo con `docker build`; sus pasos se REPLICARON con node
# sobre el arbol sin lo excluido por Dockerfile.dockerignore (4-oct-2026): etapa 1 (`npm ci --workspace @atiende/voice-worker --include-workspace-root --ignore-scripts` y
# `npm run bundle` -> dist/main.mjs de ~396 kB) y etapa 2 (`npm install --omit=dev --ignore-scripts` con dist/package.json y arranque de `node main.mjs`: /salud 503 con los
# motivos). Lo que SIGUE sin verificar: el binario nativo de LiveKit para linux (se resuelve en la imagen, no aqui) y el HEALTHCHECK dentro de un contenedor real.
# El host es Fly.io (apps/voice-worker/fly.toml; script scripts/voz/desplegar-worker.sh).
#
# Etapa 1: instala las dependencias del workspace y empaqueta el worker en un solo archivo (dist/main.mjs) con las versiones EXACTAS de los dos SDK de
# LiveKit (que traen un binario nativo y quedan fuera del bundle) en dist/package.json.
FROM node:22-bookworm-slim AS bundle
WORKDIR /repo
COPY . .
RUN npm ci --workspace @atiende/voice-worker --include-workspace-root --ignore-scripts \
 && npm run bundle -w @atiende/voice-worker

# Etapa 2: solo el bundle, los SDK de LiveKit y los audios pregrabados. Sin codigo fuente, sin devDependencies, sin secretos (todo entra por entorno).
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=bundle /repo/apps/voice-worker/dist/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=bundle /repo/apps/voice-worker/dist/main.mjs ./main.mjs
COPY --from=bundle /repo/apps/voice-worker/assets ./assets
ENV NODE_ENV=production PORT=8080 VOICE_ASSETS_DIR=/app/assets
USER node
EXPOSE 8080
# /salud responde 200 solo si el worker esta configurado; 503 con los motivos si no (nunca contesta llamadas a medias).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.mjs"]
