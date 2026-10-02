/**
 * Cloudflare KV 的最小类型声明。
 *
 * 为什么不直接用 @cloudflare/workers-types：
 * Vercel 构建环境的安装集不保证包含这个 devDependency，而
 * tsconfig 的 compilerOptions.types 强引用一个缺失的包会直接
 * 构建失败（TS2688: Cannot find type definition file）。
 * 本项目在 Workers 上真正用到的 KV API 面只有 get/put 两个方法，
 * 自行声明即可让两平台共用同一套 tsconfig，无需按平台切换类型环境。
 *
 * 注意：文件内没有 import/export，因此为全局环境声明；
 * 放宽成完整 KV API 时再按需补充（delete/list/get with type 等）。
 */
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
