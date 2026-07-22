import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverHistories } from './history.js';
import { renderDashboard } from './report/dashboard.js';

/**
 * Local dashboard server.
 *
 * Binds to LOOPBACK ONLY (127.0.0.1) by design: results can name client
 * projects, so this must not become a service on the office network without a
 * deliberate decision. Nothing here reads source code — it serves the same
 * result files the static dashboard is built from.
 *
 * Histories are re-read on every request, so leaving this open while a run
 * finishes shows the new numbers on refresh. Zero dependencies (node:http).
 */

export interface ServeOptions {
  dirs: string[];
  port: number;
  host?: string;
}

export interface ServeHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function serveDashboard(opts: ServeOptions): Promise<ServeHandle> {
  const host = opts.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    handle(req, res, opts.dirs).catch((err) => {
      send(res, 500, `<h1>500</h1><pre>${escapeHtml(String(err))}</pre>`);
    });
  });

  const port = await listen(server, opts.port, host);
  return {
    port,
    url: `http://${host}:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, dirs: string[]): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  // Re-discover every request so a run that finishes while this is open shows up.
  const subjects = await discoverHistories(dirs);

  if (path === '/' || path === '/index.html') {
    const html = renderDashboard({
      subjects: subjects.map((s, i) => ({ ...s, reportHref: `/r/${i}` })),
      generatedAt: new Date().toISOString(),
    });
    return send(res, 200, html);
  }

  const reportMatch = /^\/r\/(\d+)$/.exec(path);
  if (reportMatch) {
    const subject = subjects[Number(reportMatch[1])];
    if (!subject) return send(res, 404, notFound('No such subject.'));
    const report = await readFile(join(subject.source, 'report.html'), 'utf8').catch(() => null);
    if (report === null) {
      return send(
        res,
        404,
        notFound(
          `No report.html in <code>${escapeHtml(subject.source)}</code> yet — it is written by the run that produced these scores.`,
        ),
      );
    }
    return send(res, 200, report);
  }

  send(res, 404, notFound('Nothing here.'));
}

function notFound(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Not found</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6;color:#16212c;background:#f7f9fb}
a{color:#2e5aac}code{background:#e9eef5;border-radius:4px;padding:1px 5px}
@media(prefers-color-scheme:dark){body{background:#0e141b;color:#e7edf3}a{color:#6e93f2}code{background:#26313d}}</style>
<h1>Not found</h1><p>${message}</p><p><a href="/">← back to the portfolio</a></p>`;
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store', // always reflect the latest results
  });
  res.end(html);
}

/** Listen, falling forward a few ports if the requested one is taken. */
function listen(server: ReturnType<typeof createServer>, port: number, host: string, attempt = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('error', onError);
      if (err.code === 'EADDRINUSE' && attempt < 10) {
        listen(server, port + 1, host, attempt + 1).then(resolve, reject);
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
