#!/usr/bin/env node
/**
 * 对比 packages/dashboard/src 与 apps/desktop/src/renderer 的同名副本。
 *
 * 背景：两侧「同构但独立」（见 AGENTS.md），改共享 UI / 数据层时要求两边一起改。
 * 本脚本不阻断合并，只让「改了一边忘了另一边」在 PR 里立刻可见。
 *
 * 用法：
 *   node scripts/check-renderer-sync.mjs                 # 全量清单：列出内容不一致的同名文件
 *   node scripts/check-renderer-sync.mjs --base <ref>    # PR 模式：仅检查相对 <ref> 改动过的文件，
 *                                                        #   若只改了一侧且两侧内容不一致则告警
 *   node scripts/check-renderer-sync.mjs --strict        # 有告警时以非零码退出（默认恒为 0）
 *
 * 在 GitHub Actions 中运行时会输出 ::warning 注解并写入 Step Summary。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DASHBOARD_ROOT = 'packages/dashboard/src';
const RENDERER_ROOT = 'apps/desktop/src/renderer';

// 生成物或与共享 UI 无关的路径，不参与对比
const IGNORED = [/^routeTree\.gen\.ts$/, /^assets\//, /^old\//];

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const baseIdx = args.indexOf('--base');
const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : null;
if (baseIdx >= 0 && !baseRef) {
  console.error('--base 需要一个 git ref 参数');
  process.exit(2);
}

function git(...argv) {
  return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' });
}

function listTracked(prefix) {
  return git('ls-files', '--', prefix)
    .split('\n')
    .filter(Boolean)
    .map((f) => path.posix.relative(prefix, f))
    .filter((rel) => !IGNORED.some((re) => re.test(rel)));
}

function readIfExists(repoRelPath) {
  const abs = path.join(ROOT, repoRelPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/** rel → { dashboard: string|null, renderer: string|null } */
function loadPair(rel) {
  return {
    dashboard: readIfExists(path.posix.join(DASHBOARD_ROOT, rel)),
    renderer: readIfExists(path.posix.join(RENDERER_ROOT, rel)),
  };
}

const warnings = [];

if (baseRef) {
  // PR 模式：只看本次改动
  const mergeBase = git('merge-base', baseRef, 'HEAD').trim();
  const changed = new Set(
    git('diff', '--name-only', `${mergeBase}...HEAD`).split('\n').filter(Boolean),
  );

  const touchedRels = new Map(); // rel → { dashboardChanged, rendererChanged }
  for (const file of changed) {
    let rel = null;
    let side = null;
    if (file.startsWith(`${DASHBOARD_ROOT}/`)) {
      rel = path.posix.relative(DASHBOARD_ROOT, file);
      side = 'dashboard';
    } else if (file.startsWith(`${RENDERER_ROOT}/`)) {
      rel = path.posix.relative(RENDERER_ROOT, file);
      side = 'renderer';
    }
    if (!rel || IGNORED.some((re) => re.test(rel))) continue;
    const entry = touchedRels.get(rel) ?? { dashboard: false, renderer: false };
    entry[side] = true;
    touchedRels.set(rel, entry);
  }

  for (const [rel, touched] of touchedRels) {
    if (touched.dashboard && touched.renderer) continue; // 两侧都改了，OK
    const pair = loadPair(rel);
    if (pair.dashboard === null || pair.renderer === null) continue; // 单侧独有文件，OK
    if (pair.dashboard === pair.renderer) continue; // 改完仍一致（如同步删改），OK
    const changedSide = touched.dashboard ? DASHBOARD_ROOT : RENDERER_ROOT;
    const otherSide = touched.dashboard ? RENDERER_ROOT : DASHBOARD_ROOT;
    warnings.push({
      rel,
      file: path.posix.join(changedSide, rel),
      message:
        `本次只改了 ${changedSide}/${rel}，但 ${otherSide} 存在同名副本且内容不一致。` +
        `若是共享 UI / 数据层改动，请核对另一侧是否需要同步（AGENTS.md 约定）。`,
    });
  }
} else {
  // 全量清单模式
  const dashboardFiles = new Set(listTracked(DASHBOARD_ROOT));
  const rendererFiles = new Set(listTracked(RENDERER_ROOT));
  const shared = [...dashboardFiles].filter((f) => rendererFiles.has(f)).sort();

  let identical = 0;
  for (const rel of shared) {
    const pair = loadPair(rel);
    if (pair.dashboard === pair.renderer) {
      identical += 1;
    } else {
      warnings.push({
        rel,
        file: path.posix.join(DASHBOARD_ROOT, rel),
        message: `同名副本内容不一致：${DASHBOARD_ROOT}/${rel} ↔ ${RENDERER_ROOT}/${rel}`,
      });
    }
  }
  console.log(`同名副本共 ${shared.length} 个：一致 ${identical}，不一致 ${warnings.length}`);
}

for (const w of warnings) {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning file=${w.file}::${w.message}`);
  } else {
    console.log(`[warn] ${w.message}`);
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = warnings.length
    ? [
        '## Dashboard / Desktop renderer 同名副本检查',
        '',
        `发现 ${warnings.length} 个需要人工核对的文件（不阻断合并）：`,
        '',
        ...warnings.map((w) => `- \`${w.rel}\` — ${w.message}`),
      ]
    : ['## Dashboard / Desktop renderer 同名副本检查', '', '未发现单侧改动的同名副本。'];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

if (warnings.length === 0) {
  console.log(baseRef ? '本次改动未涉及单侧同名副本。' : '');
}
process.exit(strict && warnings.length > 0 ? 1 : 0);
