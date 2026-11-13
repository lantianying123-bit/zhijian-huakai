import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist', import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.FLOWER_PORT ?? 4173);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.wasm': 'application/wasm',
};

createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url, `http://${host}:${port}`);
    const path = resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
    if (!path.startsWith(root + sep)) throw new Error('Outside of site');
    const file = await stat(path);
    if (!file.isFile()) throw new Error('File required');

    const headers = {
      'Content-Type': types[extname(path)] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    let start = 0;
    let end = file.size - 1;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match?.[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else if (match?.[2]) {
        start = Math.max(0, file.size - Number(match[2]));
      }
      if (!match || (!match[1] && !match[2]) || start > end) {
        response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD' || !file.size) response.end();
    else {
      const stream = createReadStream(path, { start, end });
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    }
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  }
}).listen(port, host, () => {
  console.log(`http://${host}:${port}`);
  if (process.argv.includes('--open') && process.platform === 'win32') {
    import('node:child_process').then(({ execFile }) => {
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', `http://${host}:${port}`]);
    });
  }
});
