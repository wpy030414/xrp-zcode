/**
 * port.ts — 端口占用探测。
 *
 * V24 契约要求 `serve` 幂等：端口已有实例在监听时**干净退出**，不得抢占。
 * 因此这里只探测、不杀进程（旧实现会 taskkill/lsof 杀掉占用者，已废弃）。
 */

import net from 'node:net';

/** 在指定 host 上试绑一次，返回是否不可用 */
function probe(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES');
    });

    server.once('listening', () => {
      server.close(() => resolve(false));
    });

    server.listen(port, host);
  });
}

/**
 * 端口是否已被监听（EACCES 也视为不可用，启动方应退出）。
 *
 * 同时探测 loopback 与通配地址：Windows 上「127.0.0.1 已监听」时再绑
 * 0.0.0.0 仍可能成功，只探一个会漏判。
 */
export async function isPortInUse(port: number): Promise<boolean> {
  if (await probe(port, '127.0.0.1')) return true;
  return probe(port, '0.0.0.0');
}
