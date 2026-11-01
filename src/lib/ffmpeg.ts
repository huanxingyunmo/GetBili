/**
 * ffmpeg remux 封装（Node 自托管 / Vercel Node runtime）。
 *
 * ffmpeg 可执行文件解析顺序：
 *   1. @ffmpeg-installer 包内二进制（按平台装 optionalDependencies，Vercel/Docker 都有）；
 *   2. 回退 PATH 里的 ffmpeg（本地开发自行安装）。
 *
 * 为什么动态 import：src/ 的类型环境是 lib DOM（tsconfig types: []，无 @types/node），
 * 为不污染 Cloudflare Workers 的类型面，node: 模块在运行时以「拼接出的模块名」动态
 * import（esbuild 打包目标 node20，合法）；模块名拼接也让打包器无法静态分析
 * （此前字符串常量被 Vercel 构建打包导致整个函数 FUNCTION_INVOCATION_FAILED）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare const process: { env: Record<string, string | undefined>; platform?: string };

/** 动态加载模块：'node:' 前缀在函数内拼接，绕开打包器静态分析 */
async function nodeModule(spec: string): Promise<any> {
  const mod = 'node' + ':' + spec;
  return await import(/* @vite-ignore */ mod);
}

/**
 * 解析 ffmpeg 可执行文件路径：候选依次探测，首个 spawn 成功者胜出。
 * 候选：环境变量 FFMPEG_PATH > @ffmpeg-installer 各平台目录 > ffmpeg-static > PATH。
 * 不用包自带的路径解析 —— 它们靠 __dirname 定位，esbuild bundle 后失效，逐候选 spawn 探测最稳。
 */
async function ffmpegBin(): Promise<string> {
  const pathP: any = await nodeModule('path');
  const fsP: any = await nodeModule('fs/promises');
  const candidates: string[] = [];

  if (typeof process !== 'undefined' && process.env?.FFMPEG_PATH) {
    candidates.push(process.env.FFMPEG_PATH);
  }
  // 平台标识（Vercel=linux-x64；本地 Windows=win32-x64；Docker alpine=linux-x64 musl 兼容 glibc 版）
  const platform = typeof process !== 'undefined' && process.platform ? process.platform : 'linux';
  const isWin = platform === 'win32';
  const exeName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const roots = ['.', '/var/task', '/app'];
  for (const root of roots) {
    // @ffmpeg-installer 布局
    for (const plat of [platform + '-x64', 'linux-x64', 'win32-x64']) {
      candidates.push(pathP.join(root, 'node_modules', '@ffmpeg-installer', plat, exeName));
    }
    // ffmpeg-static 布局（Docker 兼容）
    candidates.push(pathP.join(root, 'node_modules', 'ffmpeg-static', exeName));
  }
  candidates.push('ffmpeg');

  const { spawn } = await nodeModule('child_process');
  for (const cand of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const child = spawn(cand, ['-version']);
        child.on('error', () => resolve(false));
        child.on('close', (code: number | null) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
    if (ok) return cand;
  }
  throw new Error('ffmpeg 不可用');
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
    // 与 /:id/file 一致：带 Range 触发 CDN 流式返回（无 Range 在部分出口 IP 上会被回 567）
    const headers = { Referer: referer, 'User-Agent': ua, Range: 'bytes=0-' };

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