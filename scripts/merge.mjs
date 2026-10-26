#!/usr/bin/env node
// 把多个公开插件索引合并成一个可直接挂到 DSH 插件市场的 index.json。
// 为什么不用现成库：字段结构简单，零依赖更容易在 GitHub Actions 里跑，也方便随时改规则。
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await readFile(join(root, 'sources.json'), 'utf8'))

const FETCH_TIMEOUT_MS = 30_000
const FETCH_RETRIES = 3

async function fetchJson(url, attempt = 1) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-mega-index' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    if (attempt < FETCH_RETRIES) {
      // 上游多半是 GitHub Pages/CDN，偶发 5xx 和超时很常见，退避重试一次比整天缺一个源好
      await new Promise(r => setTimeout(r, attempt * 2000))
      return fetchJson(url, attempt + 1)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// 不同源里 title/description 有的是字符串，有的是 {en,zh}，统一成后者，前端才能按语言取
function toLocalized(value) {
  if (value == null) return undefined
  if (typeof value === 'string') return value ? { en: value, zh: value } : undefined
  const out = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string' && v) out[k] = v
  return Object.keys(out).length ? out : undefined
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? ''))
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? '' } : null
}

function compareVersions(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa && !pb) return String(a).localeCompare(String(b))
  if (!pa) return -1
  if (!pb) return 1
  for (const k of ['major', 'minor', 'patch']) if (pa[k] !== pb[k]) return pa[k] - pb[k]
  // 有预发布标记的比正式版旧；同为预发布按字典序
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre.localeCompare(pb.pre)
}

function normalizeVersion(entry, indexUrl) {
  if (!entry || typeof entry.version !== 'string') return null
  const source = entry.source && typeof entry.source === 'object' ? { ...entry.source } : undefined
  if (source?.type === 'npm' && !source.registry) source.registry = 'https://registry.npmjs.org/'
  const out = { version: entry.version }
  if (Number.isFinite(entry.publishTimestamp)) out.publishTimestamp = entry.publishTimestamp
  if (source) out.source = source
  if (entry.engines && Object.keys(entry.engines).length) out.engines = entry.engines
  if (entry.dist && typeof entry.dist === 'object') out.dist = entry.dist
  return out
}

function normalizePlugin(raw, sourceId, indexUrl) {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) return null
  const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}
  const versions = Array.isArray(raw.versions) ? raw.versions.map(v => normalizeVersion(v, indexUrl)).filter(Boolean) : []
  const icon = typeof raw.icon === 'string' && raw.icon
    // 相对路径（icons/xxx.svg）在别的域下会 404，按源地址解析成绝对 URL
    ? new URL(raw.icon, indexUrl).href
    : undefined
  return {
    name: raw.name.trim(),
    title: toLocalized(raw.title),
    description: toLocalized(raw.description),
    author: typeof raw.author === 'string' ? raw.author : raw.author?.name,
    homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
    repository: raw.repository?.url ? { url: raw.repository.url, ...(raw.repository.directory ? { directory: raw.repository.directory } : {}) } : undefined,
    icon,
    metadata: {
      category: typeof meta.category === 'string' ? meta.category : undefined,
      keywords: Array.isArray(meta.keywords) ? meta.keywords.filter(k => typeof k === 'string') : [],
      sortKeys: meta.sortKeys && typeof meta.sortKeys === 'object' ? Object.fromEntries(Object.entries(meta.sortKeys).filter(([, v]) => Number.isFinite(v))) : {},
      labels: Array.isArray(meta.labels) ? meta.labels.filter(l => typeof l === 'string') : [],
    },
    versions,
  }
}

// 同一插件在不同源里的完整度差别很大，用“有版本数 + 关键字段数”挑一个主记录，其余只做补全
function score(plugin) {
  let s = plugin.versions.length * 2
  if (plugin.title) s += 2
  if (plugin.description) s += 2
  if (plugin.author) s += 1
  if (plugin.homepage) s += 1
  if (plugin.repository) s += 1
  if (plugin.icon) s += 1
  s += plugin.metadata.labels.length + plugin.metadata.keywords.length * 0.5
  return s
}

function mergeLocalized(a, b) {
  if (!a) return b
  if (!b) return a
  return { ...b, ...a }
}

function mergeGroup(list) {
  const sorted = [...list].sort((x, y) => score(y) - score(x))
  const base = sorted[0]
  const merged = {
    name: base.name,
    title: base.title,
    description: base.description,
    author: base.author,
    homepage: base.homepage,
    repository: base.repository,
    icon: base.icon,
    metadata: {
      category: base.metadata.category,
      keywords: new Set(base.metadata.keywords),
      sortKeys: { ...base.metadata.sortKeys },
      labels: new Set(base.metadata.labels),
    },
    versions: new Map(base.versions.map(v => [v.version, v])),
  }
  for (const other of sorted.slice(1)) {
    merged.title ??= other.title
    merged.description = mergeLocalized(merged.description, other.description)
    merged.author ??= other.author
    merged.homepage ??= other.homepage
    merged.repository ??= other.repository
    merged.icon ??= other.icon
    merged.metadata.category ??= other.metadata.category
    for (const k of other.metadata.keywords) merged.metadata.keywords.add(k)
    for (const l of other.metadata.labels) merged.metadata.labels.add(l)
    for (const [k, v] of Object.entries(other.metadata.sortKeys)) {
      // 同类指标取最大值，避免被信息较少的源拉低星标/下载数
      merged.metadata.sortKeys[k] = Number.isFinite(merged.metadata.sortKeys[k]) ? Math.max(merged.metadata.sortKeys[k], v) : v
    }
    for (const v of other.versions) {
      const exist = merged.versions.get(v.version)
      if (!exist) merged.versions.set(v.version, v)
      else if (!exist.publishTimestamp && v.publishTimestamp) merged.versions.set(v.version, { ...v, ...exist })
    }
  }
  const versions = [...merged.versions.values()].sort((a, b) => compareVersions(b.version, a.version))
  const out = { name: merged.name }
  if (merged.title) out.title = merged.title
  if (merged.description) out.description = merged.description
  if (merged.author) out.author = merged.author
  if (merged.homepage) out.homepage = merged.homepage
  if (merged.repository) out.repository = merged.repository
  if (merged.icon) out.icon = merged.icon
  const metadata = {}
  if (merged.metadata.category) metadata.category = merged.metadata.category
  if (merged.metadata.keywords.size) metadata.keywords = [...merged.metadata.keywords].sort()
  if (Object.keys(merged.metadata.sortKeys).length) metadata.sortKeys = merged.metadata.sortKeys
  if (merged.metadata.labels.size) metadata.labels = [...merged.metadata.labels].sort()
  if (Object.keys(metadata).length) out.metadata = metadata
  if (versions.length) out.versions = versions
  return out
}

function mergeDefinitions(target, incoming) {
  if (!incoming || typeof incoming !== 'object') return
  for (const [key, value] of Object.entries(incoming)) target[key] ??= value
}

const sources = (config.sources ?? []).filter(s => s.enabled !== false)
const report = []
const groups = new Map()
const categories = {}
const sortKeys = {}
const labels = {}

// 分类/标签/排序键的“权威定义”取优先级最高的那个源，其余源的定义只用于兜底
let primaryDefs = null
for (const source of sources) {
  const started = Date.now()
  try {
    const data = await fetchJson(source.url)
    if (data?.format !== 1 || !Array.isArray(data.plugins)) throw new Error('unexpected format')
    primaryDefs ??= {
      categories: data.metadata?.categories ?? {},
      sortKeys: data.metadata?.sortKeys ?? {},
      labels: data.metadata?.labels ?? {},
    }
    mergeDefinitions(categories, data.metadata?.categories)
    mergeDefinitions(sortKeys, data.metadata?.sortKeys)
    mergeDefinitions(labels, data.metadata?.labels)
    let kept = 0
    for (const raw of data.plugins) {
      const plugin = normalizePlugin(raw, source.id, source.url)
      if (!plugin) continue
      const key = plugin.name.toLowerCase()
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(plugin)
      kept++
    }
    report.push({ id: source.id, url: source.url, ok: true, plugins: kept, ms: Date.now() - started })
  } catch (err) {
    // 单个源挂掉不应该让整份索引失败，保留上一份可用数据更重要
    report.push({ id: source.id, url: source.url, ok: false, error: String(err?.message ?? err), ms: Date.now() - started })
  }
}

const merged = [...groups.values()]
  .map(mergeGroup)
  .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))

// 各源的分类/标签/排序键体系并不统一（会出现 “npm”“unchecked” 这类当作分类的噪声），
// 默认只保留主源定义过的那一套，市场里的筛选面板才不会变成一长串杂项。
if (config.curateMetadata !== false) {
  const knownCategories = new Set(Object.keys(primaryDefs?.categories ?? categories))
  const knownLabels = new Set(Object.keys(primaryDefs?.labels ?? labels))
  const knownSortKeys = new Set(Object.keys(primaryDefs?.sortKeys ?? sortKeys))
  // 各源对同一类的叫法不同（ui/interface、dev/development），按别名表归并到主源的分类体系；
  // 归并不出结果的直接去掉，宁可不分类也不要冒出几十个只出现一次的怪分类
  const aliases = config.categoryAliases ?? {}
  const canonicalCategory = (raw) => {
    const v = aliases[raw] ?? raw
    return knownCategories.has(v) ? v : undefined
  }
  for (const plugin of merged) {
    const meta = plugin.metadata
    if (!meta) continue
    if (meta.category) {
      const c = canonicalCategory(meta.category)
      if (c) meta.category = c
      else delete meta.category
    }
    if (meta.labels) {
      meta.labels = meta.labels.filter(l => knownLabels.has(l))
      if (!meta.labels.length) delete meta.labels
    }
    if (meta.sortKeys) {
      for (const key of Object.keys(meta.sortKeys)) if (!knownSortKeys.has(key)) delete meta.sortKeys[key]
      if (!Object.keys(meta.sortKeys).length) delete meta.sortKeys
    }
    if (!Object.keys(meta).length) delete plugin.metadata
  }
}

const output = {
  format: 1,
  title: toLocalized(config.title),
  description: toLocalized(config.description),
  metadata: (() => {
    const defs = config.curateMetadata !== false && primaryDefs ? primaryDefs : { categories, sortKeys, labels }
    return {
      categories: Object.keys(defs.categories).length ? defs.categories : undefined,
      sortKeys: Object.keys(defs.sortKeys).length ? defs.sortKeys : undefined,
      labels: Object.keys(defs.labels).length ? defs.labels : undefined,
    }
  })(),
  plugins: merged,
}

const json = JSON.stringify(output, null, 2) + '\n'
await writeFile(join(root, 'index.json'), json)
await writeFile(join(root, 'stats.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  sources: report,
  plugins: merged.length,
  versions: merged.reduce((n, p) => n + (p.versions?.length ?? 0), 0),
  bytes: Buffer.byteLength(json),
}, null, 2) + '\n')

const failed = report.filter(r => !r.ok)
console.log(`sources: ${report.length - failed.length}/${report.length} ok`)
for (const r of report) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.id.padEnd(14)} ${r.ok ? `${r.plugins} plugins` : r.error} (${r.ms}ms)`)
}
console.log(`merged: ${merged.length} unique plugins, ${output.plugins.reduce((n, p) => n + (p.versions?.length ?? 0), 0)} versions, ${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MiB`)
if (merged.length === 0) {
  console.error('no plugins merged; keeping previous index.json untouched')
  process.exit(1)
}
