# 服装量体号型归并与下单汇总 · Uniform Size Tally Studio

> 类型：前端 Web 应用（纯前端）｜难度：★★★｜技术栈：**Vue 3 + TypeScript + Vite**（`<script setup>` 单文件组件；手写 CSS + 本地表格导入；禁用 UI 组件库与表格库，见 README §5.1）

## 1. 一句话简介
学校订校服、工厂订工装：把几百人的量体数据按国标号型归并成「哪个号型多少套」，生成给服装厂的下单汇总表，并保证总数一个不差。

## 2. 真实场景与痛点
- 量体表是几百行的 Excel：身高、体重、胸围、腰围、性别、班级/车间，手工归号型要一整天，还容易串行。
- 号型档位不是简单四舍五入：身高 5cm 一档、**胸腰差决定型别（Y/A/B/C）**，边界值（167.5 这种）归哪档全凭经验，不同人算出来不一样。
- **总数必须守恒**：汇总表里的数量加起来必须等于量体人数，对不上服装厂就不接单；手工漏行很常见。
- 特殊体型（加肥加大、超高等）要单独列出定制，混在常规档里会出错。
- 量体现场记在纸上，回办公室再录一遍，抄错身高体重没人发现。

## 3. 目标用户
- 学校后勤/班主任（校服）、工厂行政（工装）。
- 服装厂业务员（帮客户做归并）。
- 单位工会/后勤（制服、演出服）。

## 4. 核心功能（MVP）
1. **量体录入**：单人录入（移动端优先：大数字键盘、身高体重胸腰围、性别、班级/车间、备注）与批量导入（CSV/Excel，**两步式 dry_run 预览**：新增/更新/错误行）。
2. **号型归并（核心）**：
   - 规则配置：身高档位（默认 5cm：155/160/165/170/175/180…）、型别按**胸腰差**（Y/A/B/C/B 之上加肥）、男女不同标准；
   - 自动归并并可人工覆写（覆写要留痕并标记原因）；
   - **边界规则显式化**（如 167.5cm 归 170 档），规则版本化，页面显示「依据哪版规则」。
3. **异常与特殊体型**：
   - 数值异常拦截（身高 80cm、胸围 < 身高一半等），标为待确认；
   - 特殊体型标记（加肥加大、特体、超高等）→ 单独清单，不混入常规档。
4. **汇总表**：号型 × 性别 × 数量；按班级/车间的小计；总人数与总套数。
5. **守恒校验（核心）**：`Σ 常规档数量 + Σ 特殊单列数量 = 量体有效人数`；不守恒时**不允许导出下单表**，并列出差异（哪几行没归到）。
6. **导出**：下单汇总表（Excel/PDF）、量体明细（含号型结果，可回贴给学校核对）、特殊体型清单。

## 5. 进阶功能
- 量体现场离线录入（本地缓存，回办公室一次性同步/导出）。
- 号型分布图与尺码建议（哪个档偏多，建议备货比例）——仅导出数据，不做可视化看板。
- 身高体重 → 建议初始号型的辅助计算（提示：仅供录入参考，**最终以实测胸腰围为准**）。
- 多批次合并（春装/秋装两批，分别归并与合计）。

## 6. 页面结构
```
/                 项目列表（学校/工厂 × 批次）
/measure/:id      量体录入（单人/连续录入）
/import/:id       批量导入（dry_run 预览与错误定位）
/rules            号型规则配置（档位、型别、边界规则，版本化）
/merge/:id        归并结果与人工覆写
/summary/:id      汇总表与守恒校验
/export/:id       下单表与明细导出
```

## 7. 数据模型
```ts
type Gender = 'male'|'female';
type PatternFit = 'Y'|'A'|'B'|'C';
type SizeRule = {
  version: string;
  heightStepCm: number;                     // 默认 5
  heightAnchor: number;                     // 默认 155（档位锚点）
  boundaryRule: 'round_up'|'nearest';       // 边界归上 / 就近
  fitByChestWaistDiff: {                    // 胸腰差 → 型别（男女各自一套）
    gender: Gender; ranges: { fit: PatternFit; minCm: number; maxCm: number }[];
  }[];
  specialFlags: { code: string; label: string }[];  // 加肥/特体/超高
  effectiveFrom: string;
};
type Person = {
  id: string; name: string; gender: Gender; orgUnit: string;        // 班级/车间
  heightCm: number; weightKg?: number; chestCm: number; waistCm: number;
  specialFlag?: string; note?: string;
  result?: { sizeCode: string;        // 如 "170/88A"
             fit: PatternFit; manualOverride?: { sizeCode: string; by: string; reason: string } };
  anomaly?: ('height_out_of_range'|'chest_out_of_range'|'missing_chest')[];
};
type Project = { id: string; name: string; ruleVersion: string; persons: Person[];
                 batches?: string[]; updatedAt: number };
type SummaryRow = { sizeCode: string; gender: Gender; qty: number; isSpecial: boolean };
```

## 8. 关键实现点
- **号型判定规则必须显式、可测、可版本化**（这是本项目的核心）：
  ```
  1) 身高档：档位 = anchor + step × round((H - anchor) / step)
     boundaryRule = round_up → 167.5 归 170；nearest → 167.5 归 165（半数按指定方向）
     规则必须写进 UI 说明并在测试里覆盖 167.5 / 182.5 / 边界两侧
  2) 型别：diff = 胸围 - 腰围（cm，负值或不合理值 → 异常）
     Y: 22~17 | A: 16~12 | B: 11~7 | C: 6~2（男女区间不同，全部从 SizeRule 读取）
  3) sizeCode = `${height} / ${chestFix} ${fit}`（胸围按 4cm 一档就近取整，规则同 1）
  ```
  **不允许把档位与型别阈值硬编码在组件里**，必须从 `SizeRule` 读，规则改版后旧项目按旧版本解释。
- **守恒校验是导出前置条件**：`Σ(常规档 qty) + Σ(特殊 qty) === 有效人数`；有效人数 = 总行数 − 被标记「无效/重复」的行数；不守恒时按钮禁用并给出差异明细（**逐行列出未归并的行号**）。
- **人工覆写留痕**：覆写后仍要计入总数守恒（覆写只改号型归属，不改人数）；统计时同时显示「按规则归并」与「人工覆写 N 条」。
- **导入严格校验**：表头识别（列名模糊匹配 + 用户确认映射）、数值范围、性别值（男/女/M/F）、重复行（同名 + 同班级 + 同身高体重 → 提示可能重复，**不自动删除**）。
- **离线可用**：现场无网，量体录入走 IndexedDB，本地导出 CSV 兜底。
- **精度**：身高/胸围/腰围 0.5cm 精度（存储用 0.5 的整数倍，避免浮点比较误差）；**判定用整数倍比较，不用浮点相等**。
- **性能**：5000 人归并 < 200ms；导入 5000 行解析与校验 < 2s。

## 9. 交互与视觉要点
- 录入页为「连续录入」优化：回车即存下一条、自动聚焦身高、触屏大按键（现场量体时手忙）。
- 归并结果用表格（号型 × 性别），可点击展开看每个号型下的人名列表。
- 异常与特殊体型用独立卡片置顶（提示「N 条待确认」），不混在正常流里。
- 守恒校验区显示等式（`常规 512 + 特殊 8 = 有效 520 / 总录入 522`），差异行可点击跳转。

## 10. 验收标准
- 号型判定：构造 40 组用例（含 167.5 / 182.5 边界、胸腰差落区间端点、男女不同区间、胸腰差为负、胸围缺失），结果与规则定义 100% 一致。
- 规则版本：切换规则版本后，旧项目结果不变（断言）；页面显示所用版本号。
- **守恒**：500 行含 3 条无效数据时，`常规 + 特殊 = 有效人数` 成立；人为制造 1 条未归并行时导出被阻止并列出该行（断言）。
- 人工覆写：覆写后守恒仍成立，报告中显示覆写条数与原因。
- 导入：100 行含 5 条错误，dry_run 精确定位到行号与原因；正式导入后可重传不产生重复（同一文件指纹幂等）。
- 重复行提示但不自动删除（断言）。
- 5000 人归并 < 200ms；离线录入 300 条后导出完整。
- 导出下单表与页面汇总逐行一致。

## 11. 边界（刻意不做）
不做在线下单与服装厂对接、不做量体照片与版型建模、不做库存与仓库管理、不做学员/员工考勤档案——核心只做**量体数据归并 + 汇总守恒 + 下单表导出**，避开黑名单中的电商订单、仓库库存、考勤 OA 方向。

## 12. 容器化与构建（Docker）

- **Dockerfile（多阶段）**：`node:20-alpine` 构建 → `nginx:1.27-alpine` 只拷 `dist/` 与 `nginx.conf`
- **docker-compose.yml**：服务名 `app-030`，端口 **`8110:80`**，`restart: unless-stopped`；`HEALTHCHECK` 请求 `/healthz`
- **nginx.conf**：SPA 回退；哈希资源 `immutable`；`index.html` no-cache；gzip
- **无后端、无上传**：量体数据只在本机（浏览器），README 必须写明「数据不出本地」这一隐私承诺
- 中文字体与号型规则表本地打包

```bash
cd frontend/app-030
docker compose up -d --build
curl http://localhost:8110/healthz
docker compose down
```

- **验收**：`http://localhost:8110` 完成「配置号型规则 → 录入/导入量体 → 归并 → 守恒校验 → 导出下单表」；断网可用；镜像 < 60MB。

### 忽略文件（.dockerignore / .gitignore）

- **`.dockerignore`**：`node_modules`、`dist`、`.git`、`.gitignore`、`.env`、`.env.*`、`*.log`、`coverage`、`.vscode`、`.idea`、`Dockerfile`、`nginx.conf`、`README.md`
  - `node_modules` 必须排除；**保留** `package-lock.json`、`src/data/size-rules.json`（号型规则表）
  - **绝不能把真实量体数据打进镜像**（`src/data/*.csv`、`samples/*.xlsx` 必须在 `.dockerignore` 排除）
- **`.gitignore`**：`node_modules/`、`dist/`、`.env*`、`*.log`、`coverage/`、`.DS_Store`、`.vscode/`、`.idea/`，另排**量体名单与下单表** `data/measurements/`、`data/*.xlsx`、`data/*.csv`、`exports/`（含姓名与身体尺寸，属个人隐私，绝不入库）
- **自检**：构建上下文 < 5MB 且不含任何真实量体数据（断言）；`git status` 不出现量体名单与下单表
