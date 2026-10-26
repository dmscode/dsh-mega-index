# dsh-mega-index

把多个公开的 DeepSeek Harness 插件索引合并成**一个**去重后的 `index.json`，每天由 GitHub Actions 自动刷新，通过 GitHub Pages 提供。

订阅地址（加进 DSH 插件市场的「索引源」）：

```
https://<你的用户名>.github.io/dsh-mega-index/index.json
```

## 它做什么

1. 拉取 `sources.json` 里启用的每个索引源。
2. 按插件名（不区分大小写）合并：字段互相补全，版本取并集并按语义化版本排序，星标/下载数这类指标取各源最大值。
3. 分类、标签、排序键统一到主源（`sources.json` 里第一项）的体系，其余源的分类名按 `categoryAliases` 归并，归并不上的丢弃——避免市场筛选面板里出现几十个只出现一次的怪分类。
4. 输出确定性的 `index.json`（插件按名字排序），只有内容真的变化才会产生一次提交。
5. 单个源挂掉不会让整份索引失败：失败的源记在 `stats.json` 里，其余照常合并；四个源全挂则保留上一份可用结果。

## 结构

| 文件 | 说明 |
| --- | --- |
| `sources.json` | 索引源列表、标题、分类别名表，改这里就能增删源 |
| `scripts/merge.mjs` | 合并脚本，零依赖，Node 22+ |
| `index.json` | 生成的聚合索引（已提交，便于直接 Pages 托管） |
| `stats.json` | 本次运行的时间、各源成功与否、插件与版本总数 |
| `.github/workflows/aggregate.yml` | 每天 03:17 UTC 跑一次，也支持手动触发 |

## 增删源

编辑 `sources.json` 的 `sources` 数组，`enabled: false` 可临时停用。第一项同时决定分类体系（`curateMetadata: false` 则保留所有源的原始分类）。

源必须是 `format: 1` 的结构：

```json
{ "format": 1, "plugins": [{ "name": "...", "versions": [{ "version": "1.0.0", "source": { "type": "npm" } }] }] }
```

## 本地跑

```bash
node scripts/merge.mjs
```

会打印每个源的结果和合并后的规模。`index.json` 写入仓库根目录。

## 注意

- 索引里的图标（`icon`）在合并时被改写成绝对 URL，指向原源，避免跨域 404。
- 版本信息原样保留 `source`（npm registry 或 git commit），市场据此安装；本仓库不镜像任何包内容。
- 合并只做字段级整合，不对包内容做安全检查，装之前仍以各源自己的标注为准。
