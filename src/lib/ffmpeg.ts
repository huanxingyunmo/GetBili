/**
 * ffmpeg remux 封装（仅 Node 自托管运行时可用：Docker 镜像已 apk add ffmpeg；
 * 本地开发需自行安装 ffmpeg）。
 *
 * 为什么这样写：src/ 的类型环境是 lib DOM（tsconfig types: []，无 @types/node），
 * 为不污染 Cloudflare Workers / Vercel 的类型面，node: 模块通过运行时动态 import
 * 加载（esbuild 打包时内联，目标运行时是 node20，合法），类型面在本文件内手写。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 动态加载 node 内建模块（类型面手写，避免引入 @types/node） */
async function nodeModule(spec: string): Promise<any> {
  return await import(/* @vite-ignore */ spec);
}

/** ffmpeg 是否可用（可用 resolve，否则 reject） */
export async function ffmpegAvailable(): Promise<string> {
  const { spawn } = await nodeModule('node:child_process');
  return new Promise<string>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-version']);
    child.on('error', () => reject(new Error('ffmpeg 不可用')));
    child.on('close', (code: number | null) =>
      code === 0 ? resolve('ffmpeg') : reject(new Error('ffmpeg 不可用')),
    );
  });
}

/**
 * 用 ffmpeg -c copy 把分离的 DASH 音视频 remux 成单文件 mp4，返回 Buffer。
 * 不重编码，实测 20MB 素材约 2s。
 */
export async function mergeDashToMp4(
  videoUrl: string,
  audioUrl: string,
  referer: string,
): Promise<Uint8Array> {
  const [{ spawn }, fsP, osP, pathP] = await Promise.all([
    nodeModule('node:child_process'),
    nodeModule('node:fs/promises'),
    nodeModule('node:os'),
    nodeModule('node:path'),
  ]);

  const dir: string = await fsP.mkdtemp(osP.tmpdir() + pathP.sep + 'getbili-merge-');
  const vPath = osPathJoin(dir, 'v.m4s');
  const aPath = osPathJoin(dir, 'a.m4s');
  const outPath = osPathJoin(dir, 'out.mp4');

  try {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const headers = { Referer: referer, 'User-Agent': ua };

    const [vRes, aRes] = await Promise.all([
      fetch(videoUrl, { headers, redirect: 'follow' }),
      fetch(audioUrl, { headers, redirect: 'follow' }),
    ]);
    if (!vRes.ok || !aRes.ok) {
      throw new Error(`回源拉流失败（video ${vRes.status} / audio ${aRes.status}）`);
    }

    await Promise.all([
      fsP.writeFile(vPath, new Uint8Array(await vRes.arrayBuffer())),
      fsP.writeFile(aPath, new Uint8Array(await aRes.arrayBuffer())),
    ]);

    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-i', vPath, '-i', aPath,
        '-c', 'copy', '-movflags', '+faststart',
        outPath,
      ]);
      let stderr = '';
      child.stderr?.on('data', (d: Uint8Array) => { stderr += new TextDecoder().decode(d); });
      child.on('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
      child.on('close', (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(0, 300)}`)),
      );
    });

    const buf: Uint8Array = await fsP.readFile(outPath);
    return buf;
  } finally {
    await fsP.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** path.join 的本地替身（避免引入 path 类型） */
function osPathJoin(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}