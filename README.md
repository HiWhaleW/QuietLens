<p align="center">
  <img src="media/quietlens-product-preview.png" alt="QuietLens 黄浦咖啡馆感官适配地图" width="1200">
</p>

<h1 align="center">QuietLens</h1>

<p align="center">
  为感官偏好寻找更合适的城市空间。<br>
  不再只看热门与总分，而是理解一家咖啡馆在此刻是否适合你。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=061A2E" alt="React 19">
  <img src="https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite 6">
  <img src="https://img.shields.io/badge/Leaflet-1.9-199900?style=flat-square&logo=leaflet&logoColor=white" alt="Leaflet 1.9">
  <img src="https://img.shields.io/badge/coverage-黄浦区%2010%20家-0B57D0?style=flat-square" alt="黄浦区 10 家咖啡馆">
  <img src="https://img.shields.io/badge/license-all%20rights%20reserved-D84A3A?style=flat-square" alt="All rights reserved">
</p>

<p align="center">
  <a href="#quietlens-是什么"><strong>产品介绍</strong></a>
  ·
  <a href="#本地运行"><strong>本地运行</strong></a>
  ·
  <a href="https://github.com/HiWhaleW/QuietLens/issues"><strong>反馈问题</strong></a>
</p>

> [!NOTE]
> QuietLens 是桌面端作品集原型，当前受控范围为上海黄浦区 10 家咖啡馆。页面展示的是可解释的环境参考，不是实时座位、实时分贝、实时客流或营业状态保证；出发前请通过地图平台核对最新信息。

> [!IMPORTANT]
> **非医疗产品 · 非商业授权。** QuietLens 不进行医学诊断，也不承诺某个地点对所有人都“足够安静”。仓库代码、视觉资产与文档均保留所有权利，使用边界以 [LICENSE](LICENSE) 为准。

## QuietLens 是什么

QuietLens 是一个面向感官敏感者、远程工作者和城市独处需求的地点决策原型。用户可以根据当前活动和到店时间，调整对安静、低拥挤、自然光与座位友好的重视程度；系统随之重新计算地点适配度，并把结果放回地图空间中比较。

它解决的不是“哪家店最热门”，而是一个更具体的问题：

> 在我此刻的任务、时间和感官状态下，哪家店更不容易打断我？

## 核心体验

| 能力 | 用户价值 |
| --- | --- |
| 情境化选择 | 在深度工作、放松休息和轻松聊天之间切换当前任务。 |
| 四项感官偏好 | 分别调整安静度、低拥挤、自然光和座位友好度。 |
| 时间与区域上下文 | 根据计划到店时段查看更贴近当下的环境参考。 |
| 地图优先比较 | 在原创蓝黄水彩地图上直观看到 10 家黄浦候选。 |
| 可解释地点详情 | 查看适配分、置信度、建议时段、四项参考与证据状态。 |
| 不确定性可见 | 主动呈现可能冲突和未知项，不把估计包装成事实。 |
| 水彩场景展开 | 点击地点后，以破纸动效展开基于门店空间特征创作的原创水彩场景。 |

## 产品闭环

```text
选择当前活动 → 调整感官偏好 → 设定区域与时段
→ 地图重新计算 → 对比候选 → 查看证据、冲突与未知项
```

适配分由确定性规则计算。同一套输入会得到同一结果，避免用不可解释的生成式输出替代产品判断。

## 数据与承诺边界

| QuietLens 会做 | QuietLens 不会做 |
| --- | --- |
| 显示受控门店范围内的编辑参考与证据状态 | 把缺失证据当成条件已经满足 |
| 将环境差异拆成四个可比较维度 | 声称掌握实时座位、分贝或人流 |
| 明确提示低置信、冲突和时效风险 | 将感官参考表述为医学或安全保证 |
| 保留地图、数据与视觉资产的必要来源边界 | 上传本地环境文件、API Key 或研究原始素材 |

当前版本无需账号、托管数据库或 API Key。仓库的 `.gitignore` 会排除 `.env*`、本地研究目录、构建产物和系统文件；发布前仍应人工检查待提交内容。

## 本地运行

要求：Node.js 20+ 与 npm。

```bash
git clone https://github.com/HiWhaleW/QuietLens.git
cd QuietLens
npm install
npm run dev
```

打开终端输出的本地地址即可体验。当前公开版本不需要创建环境变量文件。

生产构建：

```bash
npm run build
npm run preview
```

## 技术实现

- React 19 + Vite 6
- React Leaflet + Leaflet 地图交互
- 三层离散水彩地图：上海总览、中心城区、黄浦街区
- 本地原创地图与门店水彩资产，不依赖第三方在线底图样式
- 确定性适配计算、时段修正与门店坐标投影
- 日间 / 夜间显示模式与 `prefers-reduced-motion` 动效降级
- 桌面优先，当前最小体验宽度为 1180px

## 项目结构

```text
src/                 产品界面、地图与适配逻辑
public/assets/map/   三层水彩地图
public/assets/cafes/ 原创门店水彩场景
tests/               地图投影与托管回归测试
worker/              静态托管入口
media/               README 公开展示素材
```

## 验证

```bash
npm run test:map
npm run test:sites
npm run build
```

## License

Copyright © 2026 QuietLens. All rights reserved.

公开可见不代表授予复制、修改、分发或商业使用许可。完整条款见 [LICENSE](LICENSE)。
