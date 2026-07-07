# 星渊 · STARFALL

一个**纯前端、单机、可闭环游玩**的太空 4X 策略游戏 Demo。

查看星图 → 建造/升级建筑 → 资源随时间增长 → 造舰编队 → 跨星系进军 → 与 AI 遭遇 →
观看 3D 战斗 → 占领星系 → 达成胜利或失败结算。一局约 10~20 分钟。

## 运行

```bash
npm install
npm run dev        # 启动开发服务器(默认 http://localhost:5173)
npm run build      # 生产构建(内含 tsc --noEmit 零报错校验)
npm run typecheck  # 仅类型检查
npm test           # sim 内核单元测试(确定性 / 星图 / 战斗 / 经济)
```

无后端、无网络请求(仅 Google Fonts 走 CDN,已配本地 fallback 字体栈)。
存档自动写入 localStorage,顶栏「新游戏」可开新局(新种子)。

## 技术栈

- **Vite + React 18 + TypeScript(strict)**
- **PixiJS v8** —— 2D 星图渲染(发光、脉动、缩放拖拽、在途舰队流光)
- **Three.js + EffectComposer / UnrealBloomPass** —— 3D 战斗观看器
- **zustand** —— 全局状态

## 架构

```
src/
  sim/     纯 TS 游戏内核:无 DOM/React/Pixi/Three 依赖,确定性、可回放、可单测
    types.ts     全部游戏状态类型
    rng.ts       种子随机(mulberry32)
    data.ts      建筑/舰船/克制/经济平衡数据
    galaxy.ts    星图生成(泊松采样 + MST 保连通 + 圈层)
    economy.ts   资源产出与建造/造舰 tick
    actions.ts   建筑/造舰入队(玩家与 AI 共用,不作弊)
    fleet.ts     舰队移动、燃料、遭遇战触发与结算
    combat.ts    战斗解算(双方编成 + 种子 → 逐回合事件数组)
    ai.ts        AI 决策状态机(经济 → 扩张 → 军事 → 进攻)
    game.ts      总入口:createGame / tick / dispatch + 胜负判定
  render/
    map/         PixiJS 星图渲染器
    battle/      Three.js 战斗观看器(消费 combat 输出定速回放)
  ui/            React 组件(HUD、侧面板、事件流、战报、结算、新手指引)
  store.ts       zustand:持有 GameState,驱动主循环,桥接 sim 与渲染
```

**核心原则:sim 是唯一真相。** 同一 seed + 同一操作序列 → 结果完全一致;render 与 ui
只读状态、只发 action。战斗由 `combat.ts` 瞬间算完全部回合,3D 观看器对事件数组做
约每回合 1.2 秒的定速播放(支持 2× 与跳过)。

## 玩法要点

- **资源:** 金属 / 晶体 / 燃料。行星类型(岩石/气态/冰)决定产出倾向。
- **建筑:** 每行星 6 格,5 种建筑(矿场、萃取厂、化工厂、造船厂、防御炮台),1~5 级。
- **舰船:** 护卫 / 驱逐 / 巡洋 / 殖民。克制环 **护卫→巡洋→驱逐→护卫**(伤害 ×1.5)。
- **胜利:** 占领核心星系并持有满 3 分钟,或歼灭 AI 全部舰船并占其母星外全部星系。
- **失败:** 核心被 AI 持有满 3 分钟,或母星外尽失、无舰且无力再造满 60 秒。
- 母星系不可被夺取(败方保底)。

## 开发脚本

```bash
npx tsx scripts/smoke.ts     # 无头跑多局 + 确定性校验
npx tsx scripts/winnable.ts  # 章法玩家可否在 10~20 分钟取胜的平衡验证
```
