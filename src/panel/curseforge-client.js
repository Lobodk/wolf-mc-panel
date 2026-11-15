'use strict';

function failure(code, cause, action, operation, httpStatus = 0) {
  const error = new Error(`Causa: ${cause} Acción: ${action} Operación: ${operation}. Código: ${httpStatus ? 'HTTP ' + httpStatus + ' · ' : ''}${code}.`);
  Object.assign(error, { code, httpStatus, operation, resolution: action });
  return error;
}

function operationFor(endpoint) {
  const file = /^\/mods\/(\d+)\/files\/(\d+)\/download-url$/.exec(endpoint);
  if (file) return `obtener descarga del mod ${file[1]}, archivo ${file[2]}`;
  if (/^\/mods\/\d+\/files/.test(endpoint)) return 'consultar versiones compatibles del mod';
  if (endpoint.startsWith('/mods/search')) return 'buscar mods compatibles';
  if (endpoint.startsWith('/fingerprints')) return 'identificar mods instalados';
  return 'consultar CurseForge';
}

function httpFailure(status, operation, { retryAfter = '', download = false } = {}) {
  if (status === 401) return failure('CF_API_KEY_REJECTED', 'CurseForge no acepta la clave API (HTTP 401).', 'Revisa la clave guardada y su autorización en CurseForge.', operation, status);
  if (status === 403) return failure(download ? 'CF_DOWNLOAD_FORBIDDEN' : 'CF_ACCESS_FORBIDDEN', download
    ? 'CurseForge denegó el acceso a esta descarga. No se ha podido confirmar si es una restricción del autor o de los permisos de la integración.'
    : 'CurseForge denegó esta petición. Puede ser una restricción de permisos de la integración; no demuestra por sí sola que la clave sea inválida.',
  download ? 'Abre el mod en CurseForge y, si está disponible, descarga el .jar y súbelo manualmente.' : 'Comprueba los permisos de tu integración de CurseForge e inténtalo más tarde.', operation, status);
  if (status === 429) {
    const seconds = /^\d{1,6}$/.test(retryAfter) ? Number(retryAfter) : 0;
    return failure('CF_RATE_LIMIT', 'CurseForge ha limitado temporalmente las solicitudes.', seconds ? `Espera al menos ${seconds} segundos antes de reintentar.` : 'Espera unos minutos antes de volver a intentarlo; no hace falta cambiar la clave.', operation, status);
  }
  if (status === 404) return failure('CF_NOT_FOUND', 'El mod o archivo solicitado ya no está disponible en ese servicio.', 'Actualiza la lista de versiones o comprueba la página del mod en CurseForge.', operation, status);
  if (status >= 500) return failure('CF_SERVICE_UNAVAILABLE', 'El servicio de CurseForge o su servidor de descargas está fallando.', 'Espera y vuelve a intentarlo más tarde.', operation, status);
  return failure('CF_HTTP_ERROR', 'El servicio rechazó la petición.', 'Comprueba el mod y la versión seleccionada. Si persiste, consulta el código HTTP indicado.', operation, status);
}

function networkFailure(error, operation) {
  const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || /TIMEOUT/.test(error?.cause?.code || '');
  return failure(timeout ? 'CF_TIMEOUT' : 'CF_CONNECTION_FAILED', timeout ? 'El servicio no respondió dentro del tiempo de espera.' : 'No se pudo conectar con el servicio; puede ser un fallo de red, DNS o conexión segura.', 'Comprueba la conexión de este PC e inténtalo de nuevo.', operation);
}

function createCurseForgeClient({ getApiKey, fetchImpl = fetch }) {
  async function request(endpoint, options = {}) {
    const operation = operationFor(endpoint);
    const apiKey = getApiKey();
    if (!apiKey) throw failure('CF_API_KEY_MISSING', 'No hay una clave API de CurseForge configurada.', 'Guarda tu clave en el Buscador de Mods.', operation);
    let response;
    try {
      response = await fetchImpl('https://api.curseforge.com/v1' + endpoint, {
        ...options,
        headers: { Accept: 'application/json', 'x-api-key': apiKey, ...(options.headers || {}) },
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) { throw networkFailure(error, operation); }
    const download = /^\/mods\/(\d+)\/files\/\d+\/download-url$/.exec(endpoint);
    if (!response.ok) {
      // A rejected file URL is not evidence of a bad API key. Confirm the author's setting.
      if (response.status === 403 && download) {
        try {
          const project = await fetchImpl('https://api.curseforge.com/v1/mods/' + download[1], {
            headers: { Accept: 'application/json', 'x-api-key': apiKey }, signal: AbortSignal.timeout(10000),
          });
          if (project.ok) {
            const data = (await project.json()).data;
            if (data?.allowModDistribution === false) {
              const name = String(data.name || 'Este mod').replace(/[\r\n]/g, ' ').slice(0, 140);
              throw failure('CF_DISTRIBUTION_DISABLED', `${name}: el autor ha desactivado las descargas para aplicaciones de terceros. Tu clave permite consultar la ficha, pero esta descarga está bloqueada.`, 'Pulsa «Abrir CurseForge», descarga allí el .jar y súbelo manualmente en Mods instalados. Revisa también sus dependencias.', operation, 403);
            }
          }
        } catch (error) { if (error.code === 'CF_DISTRIBUTION_DISABLED') throw error; }
      }
      throw httpFailure(response.status, operation, { download: !!download, retryAfter: response.headers?.get('retry-after') || '' });
    }
    let data;
    try { data = await response.json(); }
    catch { throw failure('CF_INVALID_RESPONSE', 'CurseForge devolvió una respuesta que el panel no puede leer.', 'Reinténtalo más tarde.', operation); }
    return data.data;
  }
  return { request };
}

module.exports = { createCurseForgeClient, httpFailure, networkFailure };
