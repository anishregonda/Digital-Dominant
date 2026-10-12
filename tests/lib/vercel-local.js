// A small stand-in for Vercel, for local previews and the end-to-end test:
//   - serves the built site (dist/) the way Vercel's static hosting does
//   - applies vercel.json "redirects" (before files) and "rewrites" (after files)
//   - routes /api/<name> to api/<name>.js and calls it the way Vercel's Node
//     runtime does: (req, res) with Vercel's helpers, i.e. the body already
//     read and parsed by content type into req.body (invalid JSON throws on
//     access), plus req.query, res.status(), res.json() and res.send()
//
//   npm run build && node tests/lib/vercel-local.js [port]    (default 4311)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

function withHelpers(req, res, raw) {
  const url = new URL(req.url, 'http://localhost');
  Object.defineProperty(req, 'query', { value: Object.fromEntries(url.searchParams), configurable: true });
  const type = req.headers['content-type'];
  let parsed;
  let done = false;
  Object.defineProperty(req, 'body', {
    configurable: true,
    get() {
      if (done) return parsed;
      if (type === undefined) {
        parsed = undefined;
      } else {
        const mime = String(type).split(';')[0].trim().toLowerCase();
        if (mime === 'application/json') {
          const text = raw.toString('utf8');
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
          }
        } else if (mime === 'text/plain') parsed = raw.toString('utf8');
        else if (mime === 'application/octet-stream') parsed = raw;
        else if (mime === 'application/x-www-form-urlencoded') parsed = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
        else parsed = undefined;
      }
      done = true;
      return parsed;
    },
  });
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (value) => {
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
  res.send = (value) => {
    if (typeof value === 'object' && value !== null && !Buffer.isBuffer(value)) return res.json(value);
    res.end(value);
    return res;
  };
}

export async function startVercelLocal({ root = REPO, distDir = 'dist', port = 4311, host = '127.0.0.1', log = false } = {}) {
  const config = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  const dist = path.resolve(root, distDir);
  const functions = new Map();

  const sendFile = async (req, res, file, status = 200) => {
    const body = await readFile(file);
    res.statusCode = status;
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', body.length);
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const fileFor = async (pathname) => {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dist, `.${rel}`);
    if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) return null;
    try {
      return (await stat(file)).isFile() ? file : null;
    } catch {
      return null;
    }
  };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      // 1. Functions: /api/<name> -> api/<name>.js (files starting with "_" are never routes)
      const fn = /^\/api\/([a-z0-9-]+)\/?$/i.exec(pathname);
      if (fn) {
        const file = path.join(root, 'api', `${fn[1]}.js`);
        let handler = functions.get(file);
        if (!handler) {
          try {
            await stat(file);
            handler = (await import(pathToFileURL(file).href)).default;
            functions.set(file, handler);
          } catch {
            handler = null;
          }
        }
        if (!handler) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk); // Vercel reads the body before the function runs
        withHelpers(req, res, Buffer.concat(chunks));
        await handler(req, res);
        return;
      }

      // 2. Redirects, before the filesystem (308 when permanent, as Vercel does)
      for (const r of config.redirects || []) {
        if (r.source === pathname) {
          res.statusCode = r.statusCode || (r.permanent === false ? 307 : 308);
          res.setHeader('Location', r.destination);
          res.end();
          return;
        }
      }

      // 3. Files
      const file = await fileFor(pathname);
      if (file) {
        await sendFile(req, res, file);
        return;
      }

      // 4. Rewrites, when no file matched
      for (const r of config.rewrites || []) {
        if (r.source === pathname) {
          const target = await fileFor(r.destination);
          if (target) {
            await sendFile(req, res, target);
            return;
          }
        }
      }

      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('404: NOT_FOUND');
    } catch (error) {
      if (!res.headersSent) res.statusCode = 500;
      res.end('Internal error');
      if (log) console.error(error);
    } finally {
      if (log) console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started} ms)`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]) || 4311;
  startVercelLocal({ port, log: true }).then(({ url }) => console.log(`Serving dist/ and api/ at ${url}`));
}
