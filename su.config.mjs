/* Su Configuration */
var path = location.pathname
var basePath = path.substring(0, path.lastIndexOf('/') + 1)

// Ensure basePath is correct even in proxied pages
if (path.includes('/calc/')) {
  basePath = path.substring(0, path.indexOf('/calc/') + 1)
}

self.__uv$config = {
  prefix: basePath + 'calc/',
  bare: basePath + 'telemetry/',
  wisp: '/ws/',
  searchEngine: 'https://duckduckgo.com/?q=%s',
  encodeUrl: Vector.codec.xor.encode,
  decodeUrl: Vector.codec.xor.decode,
  handler: basePath + 'su.handler.mjs?raw=true',
  bundle: basePath + 'su.bundle.mjs?raw=true',
  config: basePath + 'su.config.mjs?raw=true',
  sw: basePath + 'su.kernel.mjs?raw=true',
  client: basePath + 'su.canvas.mjs?raw=true',
}
