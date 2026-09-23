import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/src/ui/app.js', ['src/ui/app.js', 'text/javascript']],
  ['/src/ui/styles.css', ['src/ui/styles.css', 'text/css']],
  ['/src/scenario/index.js', ['src/scenario/index.js', 'text/javascript']],
  ['/src/validator/index.js', ['src/validator/index.js', 'text/javascript']],
  ['/src/engine/index.js', ['src/engine/index.js', 'text/javascript']],
  ['/src/engine/data.js', ['src/engine/data.js', 'text/javascript']],
  ['/src/ai/index.js', ['src/ai/index.js', 'text/javascript']],
  ['/src/result/index.js', ['src/result/index.js', 'text/javascript']]
]);

const port = Number(process.env.PORT || 3000);
createServer(async (request, response) => {
  const asset = assets.get(new URL(request.url, 'http://localhost').pathname);
  if (!asset || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const content = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(500).end('Unable to load application');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Аким на 5 часов: http://127.0.0.1:${port}`);
});
