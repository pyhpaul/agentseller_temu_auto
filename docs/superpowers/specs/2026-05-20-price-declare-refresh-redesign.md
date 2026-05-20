# price_declare 刷新逻辑重设计

**日期**：2026-05-20  
**状态**：已批准，待实现

## 问题

当前以 badge count 作为"服务器已更新"的判断信号，有三种不可控干扰：

1. 切 tab 后 badge 异步渲染，有短暂闪烁
2. 多 SKU 商品（同一 HJD 有多个调价单）服务器分批更新 count，减少量不确定
3. 后台随时可能新增数据，count 可能反增

这导致系统长期处于非稳态，maxCount / 等待时间参数难以调到最优，只能靠 fallback reload 维持。

## 根本原因

badge count 是不可控的外部信号，任何基于它的判断都不可靠。

## 解决方案

**把判断依据从 badge count 换成"目标行是否消失"。**

已确认事实：
- 切 tab 刷新后，已完全处理的行会从"待卖家确认"列表消失
- 同一 HJD 可能有多个调价单，需要多次处理，直到行消失
- 每次弹窗是完整的 SKU 列表，每次全部操作

## 新流程

```
processOneRow(rows[0]) 完成
  ↓ 记录 targetHJD = readHJD(rows[0])
triggerRefresh(reason, targetHJD)
  ↓
  loop（最多 5 次）:
    refreshListByTabSwitch()    — 切 tab 触发重新请求
    等 2s                       — 给 DOM 时间更新
    findPendingRows() 里还有 targetHJD？
      没有 → 行已消失，同步完成，退出
      有   → 再切一次 tab
  ↓
  5 次后行还在 → fallbackReload（切 tab 机制失效兜底）
```

## 多调价单（同一 HJD）自然支持

行还在 → mainLoop 下一轮 rows[0] 还是同一条 HJD → 再次 processOneRow → 处理下一个调价单 → 直到行消失。  
不需要额外跟踪，mainLoop 不变。

## 改动清单

| 改动 | 说明 |
|------|------|
| `triggerRefresh(reason, targetHJD)` | 新增 targetHJD 参数，用行消失判断同步 |
| 删除 `periodicRefreshIfNeeded` | 不再需要，改为每条处理完直接调 triggerRefresh |
| mainLoop 传 targetHJD | 处理前 `readHJD(rows[0])`，完成后传入 triggerRefresh |
| 删除 `processedCount / expectedAfter / prevCur` | 不再依赖 count |
| 删除 `readPendingTabCount` 相关判断 | 不再作为同步信号 |
| maxCount **5→5** | 保持 5 次 |
| 等待时间 **2s** | 保持 2s |
| UI 删除"每N条刷新"设置 | hardcode 每条刷新，无需用户配置 |
| `DEFAULT_SETTINGS` 删除 `refreshEvery` | 不再需要此字段 |

## 不变的部分

- `waitModalClose` 超时后发 Escape（保留）
- 失败时找取消按钮关弹窗（保留）
- fallbackReload + autoResume（保留）
- `_stopWake` 停止响应机制（保留）
