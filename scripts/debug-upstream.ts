/**
 * 调试夹具：用项目自己的 src/lib（含 WBI 签名 + 设备指纹）直接请求 B 站上游，
 * 打印原始响应结构，用于排查字段映射与风控问题。
 *
 * 运行方式（需先由 esbuild 打包，因为 Node 原生 TS 剥离不支持无扩展名相对导入）：
 *   node node_modules/esbuild/bin/esbuild scripts/debug-upstream.ts --bundle \
 *     --format=esm --platform=node --target=node20 --outfile=.tmp/debug-upstream.mjs
 *   node .tmp/debug-upstream.mjs
 */

import type { Env } from '../src/types';
import { biliEnvelope, buildUrl } from '../src/lib/request';
import { signWbi, wbiGet } from '../src/lib/wbi';
import { getFingerprint, fingerprintToCookieString } from '../src/lib/fingerprint';

const env: Env = { REQUEST_TIMEOUT_MS: '20000', TRY_LOOK: 'true' };
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const MID = 486906719;
const GOOD_BVID = 'BV1GJ411x7h7';
const BAD_BVID = 'BV1GJ411x7z7';

function keysOf(value: unknown): string {
  if (Array.isArray(value)) return `[array len=${value.length}]`;
  if (value && typeof value === 'object') return Object.keys(value as object).join(', ');
  return typeof value;
}

function dump(label: string, value: unknown, limit = 1500): void {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  console.log(`\n----- ${label} -----`);
  console.log(text.length > limit ? `${text.slice(0, limit)}\n...(截断)` : text);
}

async function probeFingerprint(): Promise<void> {
  console.log('\n========== 0) 设备指纹 ==========');
  const fp = await getFingerprint(env, UA);
  console.log('buvid3 =', fp.buvid3);
  console.log('buvid4 =', fp.buvid4 || '(空，走兜底)');
  console.log('b_lsid =', fp.bLsid);
  console.log('_uuid  =', fp.uuid);
  console.log('cookie =', fingerprintToCookieString(fp));
}

async function probeSpaceVideos(): Promise<void> {
  console.log('\n========== 1) UP 主投稿 /x/space/wbi/arc/search（多 mid 对比） ==========');
  const mids = [8047632, 2, 486906719, 11783021];
  for (const mid of mids) {
    try {
      const data = await wbiGet<Record<string, unknown>>(
        env,
        '/x/space/wbi/arc/search',
        {
          mid,
          ps: 5,
          pn: 1,
          order: 'pubdate',
          platform: 'web',
          dm_img_list: '[]',
          dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
          dm_cover_img_str:
            'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwIChveDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzAsIEQzRDExKQ',
          dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
        },
        { referer: `https://space.bilibili.com/${mid}/video` },
      );
      const page = data.page as Record<string, unknown> | undefined;
      const list = data.list as Record<string, unknown> | undefined;
      const vlist = list?.vlist as unknown[] | undefined;
      console.log(
        `  mid=${mid} → count=${JSON.stringify(page?.count)} vlist=${vlist?.length ?? 0} pageKeys=${keysOf(page)} is_risk=${JSON.stringify(data.is_risk)}`,
      );
      if (Array.isArray(vlist) && vlist.length > 0) {
        console.log('    ✅ 首项字段名:', keysOf(vlist[0]));
        dump(`mid=${mid} 投稿首项`, vlist[0], 900);
      }
    } catch (err) {
      const e = err as { message?: string; code?: number; status?: number };
      console.log(`  mid=${mid} → ❌ code=${e.code} status=${e.status} msg=${e.message}`);
    }
  }
}

async function probeBadBvid(): Promise<void> {
  console.log(`\n========== 2) 不存在的 BV 号 ${BAD_BVID} ==========`);
  const signedDetail = await signWbi(
    env,
    buildUrl('/x/web-interface/wbi/view/detail', {
      platform: 'web',
      page_no: 1,
      p: 1,
      need_operation_card: 1,
      web_rm_repeat: 1,
      need_elec: 1,
      bvid: BAD_BVID,
    }),
  );
  const wbiRaw = await biliEnvelope<Record<string, unknown>>(env, signedDetail, {
    referer: `https://www.bilibili.com/video/${BAD_BVID}`,
  });
  console.log(`wbi/view/detail → code=${wbiRaw.code} message=${JSON.stringify(wbiRaw.message)}`);
  console.log('  data =', JSON.stringify(wbiRaw.data)?.slice(0, 300));
  console.log('  data keys =', keysOf(wbiRaw.data));
  const view = (wbiRaw.data as Record<string, unknown> | undefined)?.View;
  console.log('  data.View =', JSON.stringify(view)?.slice(0, 200), '| keys =', keysOf(view));

  const viewRaw = await biliEnvelope<Record<string, unknown>>(
    env,
    buildUrl('/x/web-interface/view', { bvid: BAD_BVID }),
    { referer: `https://www.bilibili.com/video/${BAD_BVID}` },
  );
  console.log(`view → code=${viewRaw.code} message=${JSON.stringify(viewRaw.message)}`);
  console.log('  data =', JSON.stringify(viewRaw.data)?.slice(0, 200));
}

async function probeGoodBvidRaw(): Promise<void> {
  console.log(`\n========== 3) 正常视频 ${GOOD_BVID} 的详情原始字段 ==========`);
  const signedDetail = await signWbi(
    env,
    buildUrl('/x/web-interface/wbi/view/detail', {
      platform: 'web',
      page_no: 1,
      p: 1,
      need_operation_card: 1,
      web_rm_repeat: 1,
      need_elec: 1,
      bvid: GOOD_BVID,
    }),
  );
  const raw = await biliEnvelope<Record<string, unknown>>(env, signedDetail, {
    referer: `https://www.bilibili.com/video/${GOOD_BVID}`,
  });
  console.log(`code=${raw.code} message=${JSON.stringify(raw.message)}`);
  const data = raw.data as Record<string, unknown> | undefined;
  console.log('data keys:', keysOf(data));
  const view = data?.View as Record<string, unknown> | undefined;
  if (view) {
    console.log('View keys:', keysOf(view));
    for (const key of ['bvid', 'aid', 'cid', 'videos', 'is_interactive', 'state', 'duration']) {
      console.log(`  View.${key} = ${JSON.stringify(view[key])}`);
    }
    console.log('  View.rights =', JSON.stringify(view.rights));
    console.log('  View.ugc_season =', view.ugc_season ? keysOf(view.ugc_season) : 'null');
    console.log('  View.pages[0] =', JSON.stringify((view.pages as unknown[])?.[0]));
  }
}

async function probePlayUrlRaw(): Promise<void> {
  console.log('\n========== 4) 播放地址原始响应 ==========');
  const detail = await biliEnvelope<Record<string, unknown>>(
    env,
    buildUrl('/x/web-interface/view', { bvid: GOOD_BVID }),
    { referer: `https://www.bilibili.com/video/${GOOD_BVID}` },
  );
  const cid = (detail.data as Record<string, unknown> | undefined)?.cid;
  console.log('resolved cid =', cid);

  const signed = await signWbi(
    env,
    buildUrl('/x/player/wbi/playurl', {
      bvid: GOOD_BVID,
      cid: cid as number,
      qn: 80,
      fnval: 4048,
      fourk: 1,
      voice_balance: 1,
      gaia_source: 'pre-load',
      web_location: 1550101,
      try_look: 1,
    }),
  );
  const raw = await biliEnvelope<Record<string, unknown>>(env, signed, {
    referer: `https://www.bilibili.com/video/${GOOD_BVID}`,
  });
  console.log(`code=${raw.code} message=${JSON.stringify(raw.message)}`);
  const data = raw.data;
  if (!data) return;
  for (const key of ['quality', 'format', 'accept_format', 'timelength']) {
    console.log(`  ${key} = ${JSON.stringify(data[key])}`);
  }
  console.log('  accept_quality =', JSON.stringify(data.accept_quality));
  const dash = data.dash as Record<string, unknown> | undefined;
  const video = dash?.video as Array<Record<string, unknown>> | undefined;
  console.log('  dash.video ids =', JSON.stringify((video ?? []).map((v) => v.id)));
  console.log('  dash.video[0] fields =', keysOf(video?.[0]));
  if (video?.[0]) {
    console.log('    baseUrl? =', 'baseUrl' in video[0], '| base_url? =', 'base_url' in video[0]);
    console.log('    mimeType? =', 'mimeType' in video[0], '| frameRate? =', 'frameRate' in video[0]);
  }
  console.log('  support_formats[0] =', JSON.stringify((data.support_formats as unknown[])?.[0]));
}

async function probeSearch(): Promise<void> {
  console.log('\n========== 5) 搜索接口原始响应 ==========');
  for (const [label, searchType, keyword] of [
    ['视频搜索', 'video', '罗翔'],
    ['UP主搜索', 'bili_user', '罗翔'],
  ] as const) {
    const signed = await signWbi(
      env,
      buildUrl('/x/web-interface/wbi/search/type', {
        search_type: searchType,
        keyword,
        page: 1,
        page_size: 5,
        order: 'totalrank',
        platform: 'pc',
        single_column: 0,
        web_location: 1430654,
      }),
    );
    const raw = await biliEnvelope<Record<string, unknown>>(env, signed, {
      referer: 'https://search.bilibili.com/',
    });
    console.log(`\n--- ${label} (search_type=${searchType}, keyword=${keyword}) code=${raw.code} msg=${JSON.stringify(raw.message)}`);
    const data = raw.data;
    console.log('  data keys:', keysOf(data));
    if (data) {
      const arr = (data.result ?? data.results) as unknown[] | undefined;
      console.log(`  result 数组长度 = ${arr?.length ?? '无该字段'}`);
      console.log(`  numResults = ${JSON.stringify(data.numResults)}`);
      if (Array.isArray(arr) && arr.length > 0) {
        console.log('  首项字段名:', keysOf(arr[0]));
      }
    }
  }
}

async function probeFavlist(): Promise<void> {
  console.log('\n========== 6) 收藏夹探测 ==========');
  const mids = [486906719, 8047632, 2, 11783021, 703007996];
  let picked: number | null = null;

  for (const mid of mids) {
    const raw = await biliEnvelope<Record<string, unknown>>(
      env,
      buildUrl('/x/v3/fav/folder/created/list-all', { up_mid: mid }),
      { referer: 'https://space.bilibili.com/' },
    );
    const list = (raw.data as Record<string, unknown> | undefined)?.list as
      | Array<Record<string, unknown>>
      | undefined;
    console.log(
      `  mid=${mid} code=${raw.code} msg=${JSON.stringify(raw.message)} folders=${list?.length ?? '无 list'}`,
    );
    if (Array.isArray(list) && list.length > 0) {
      for (const f of list.slice(0, 3)) {
        console.log(
          `     id=${f.id} title=${JSON.stringify(f.title)} media_count=${f.media_count} attr=${f.attr} fav_state=${f.fav_state}`,
        );
        if ((f.media_count as number) > 0 && picked === null) picked = f.id as number;
      }
    }
  }

  if (picked === null) {
    console.log('  → 没有探测到 media_count > 0 的公开收藏夹');
    return;
  }

  console.log(`\n  用 media_id=${picked} 调 /x/v3/fav/resource/list`);
  const res = await biliEnvelope<Record<string, unknown>>(
    env,
    buildUrl('/x/v3/fav/resource/list', {
      media_id: picked,
      pn: 1,
      ps: 3,
      platform: 'web',
      order: 'mtime',
      desc: 1,
    }),
    { referer: 'https://www.bilibili.com/' },
  );
  console.log(`  code=${res.code} msg=${JSON.stringify(res.message)}`);
  const data = res.data as Record<string, unknown> | undefined;
  console.log('  data keys:', keysOf(data));
  const info = data?.info as Record<string, unknown> | undefined;
  console.log('  info =', JSON.stringify({ id: info?.id, title: info?.title, media_count: info?.media_count, mid: info?.mid })?.slice(0, 200));
  const medias = data?.medias as Array<Record<string, unknown>> | undefined;
  console.log(`  medias=${medias?.length ?? 0} has_more=${JSON.stringify(data?.has_more)}`);
  if (medias?.[0]) {
    console.log('  medias[0] fields:', keysOf(medias[0]));
    dump('收藏项首项', medias[0], 900);
  }
}

async function main(): Promise<void> {
  await probeFingerprint();
  await probeSpaceVideos();
  await probeSearch();
  await probeFavlist();
  console.log('\n========== 完成 ==========');
}

main().catch((err) => {
  console.error('夹具异常：', err);
  process.exit(1);
});
