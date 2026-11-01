/**
 * ffmpeg remux 封装（Node 自托管 / Vercel Node runtime）。
 *
 * ffmpeg 可执行文件解析顺序：
 *   1. ffmpeg-static 包内二进制（dependencies 里带了，Vercel/Docker 都有）；
 *   2. 回退 PATH 里的 ffmpeg（本地开发自行安装）。
 *
 * 为什么动态 import：src/ 的类型环境是 lib DOM（tsconfig types: []，无 @types/node），
 * 为不污染 Cloudflare Workers 的类型面，node: 模块在运行时以「拼接出的模块名」动态
 * import（esbuild 打包目标 node20，合法）；模块名拼接也让打包器无法静态分析
 * （此前字符串常量被 Vercel 构建打包导致整个函数 FUNCTION_INVOCATION_FAILED）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 动态加载模块：'node:' 前缀在函数内拼接，绕开打包器静态分析 */
async function nodeModule(spec: string): Promise<any> {
  const mod = 'node' + ':' + spec;
  return await import(/* @vite-ignore */ mod);
}

/** 解析 ffmpeg 可执行文件路径：优先 ffmpeg-static，回退 PATH */
async function ffmpegBin(): Promise<string> {
  try {
    const mod: any = await nodeModule('ffmpeg-static');
    const p = mod?.default ?? mod;
    if (typeof p === 'string' && p) return p;
  } catch {
    /* 包未安装时走 PATH */
  }
  return 'ffmpeg';
}

/** ffmpeg 是否可用（可用 resolve 出二进制路径，否则 reject） */
export async function ffmpegAvailable(): Promise<string> {
  const { spawn } = await nodeModule('child_process');
  const bin = await ffmpegBin();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ['-version']);
    child.on('error', () => reject(new Error('ffmpeg 不可用')));
    child.on('close', (code: number | null) =>
      code === 0 ? resolve(bin) : reject(new Error('ffmpeg 不可用')),
    );
  });
}

/**
 * 用 ffmpeg -c copy 把分离的 DASH 音视频 remux 成单文件 mp4，返回字节。
 * 不重编码，实测 20MB 素材约 2s。
 */
export async function mergeDashToMp4(
  videoUrl: string,
  audioUrl: string,
  referer: string,
): Promise<Uint8Array> {
  const [{ spawn }, fsP, osP, pathP, bin] = await Promise.all([
    nodeModule('child_process'),
    nodeModule('fs/promises'),
    nodeModule('os'),
    nodeModule('path'),
    ffmpegBin(),
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
      const child = spawn(bin, [
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

    return await fsP.readFile(outPath);
  } finally {
    await fsP.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** path.join 的本地替身（避免引入 path 类型；Node 在 Windows 也接受 / 分隔） */
function osPathJoin(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}