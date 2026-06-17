// automation/orchestrator/engine.js
// 编排引擎：注入 read/queue/stepRunner/now，实现 advance 单步推进 + recover SW 恢复。
// 纯逻辑+注入（无 chrome 直接依赖），可 node 测。消费 state-machine.decideNext + recovery.decideRecovery。spec §2.2/§4.2。
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.__AS_ORCH_ENGINE__ = api;
})(typeof self !== 'undefined' ? self : this, function (nodeRequire) {
  'use strict';

  // 取 Plan 2-1 模块：node require / SW 全局（importScripts 已挂 self.__AS_ORCH_*）
  const sm = nodeRequire ? nodeRequire('./state-machine.js') : self.__AS_ORCH_SM__;
  const rec = nodeRequire ? nodeRequire('./recovery.js') : self.__AS_ORCH_RECOVERY__;
  const { decideNext } = sm;
  const { decideRecovery } = rec;

  const MAX_LOOP = 100;   // advance 循环上限防御（14 步 + cursor 推进正常 < 30 轮）
  const MAX_RETRY = 2;    // self-heal 重试上限红线（spec §6；与 brain/diagnoser MAX_RETRY 对齐）

  function findWorkflow(skeleton, workflowId) {
    const list = (skeleton && skeleton.batch && skeleton.batch.workflows) || [];
    return list.find(w => w.id === workflowId) || null;
  }

  // 从 step.result 提取要回填 workflow.product 的字段（渐进填充 spuId/skc/skuNo）
  function pickProduct(result) {
    const out = {};
    if (!result) return out;
    // grossMargin 不在白名单：它是 ⑥ 确认时 orchHitlConfirm 服务端 computeMargin 算落，不从 step.result 回填。
    for (const k of ['sourceUrl', 'dxmEditUrl', 'spuId', 'skc', 'skuNo', 'url1688', 'orderNo1688', 'poNo', 'returnPrice', 'cost1688', 'domesticShipping']) {
      if (result[k] != null) out[k] = result[k];
    }
    return out;
  }

  // HITL step → workflow.hitl 摘要。带 hitlSpec.fields 的步为回填型（editable+fields），否则纯确认。
  // recovery 的 hitl 在 recover 内直接构造、不走这（其 editable=false 语义不变）。targetUrl 供浮层「前往」。
  function buildHitl(step, product) {
    const spec = step.hitlSpec || null;
    const fields = (spec && Array.isArray(spec.fields)) ? spec.fields : [];
    // analysis:'margin' 步 → 算核价分析填 keyValues，复用纯确认型卡 kvRows 渲染（零 dashboard 改动）。
    let keyValues = {};
    if (step.analysis === 'margin') {
      const m = computeMargin(product || {});
      keyValues = m.ok ? m.display : { '核价': m.reason };
    }
    return {
      action: step.label, stepId: step.id, guide: step.guide || '',
      keyValues, reviewedBrief: '',
      editable: fields.length > 0,
      fieldType: null, options: null,   // 保留兼容（recovery 直构造不依赖这两）
      fields,
      targetUrl: (step.target && step.target.url) || null,
      status: 'pending',
    };
  }

  // publish 两段闸 HITL（kind:'publish'）：phase await-check → blocked / await-publish。
  // 进入 publish 步即停在 await-check（替代旧 manualGate）；bg 据 CAP_CHECK 结果转 phase。
  // 不携带 autoPublish：engine 纯函数不读 storage，开关初态由 dashboard 直接读 storage key。
  function buildPublishHitl(step, opts) {
    opts = opts || {};
    return {
      action: step.label, stepId: step.id, kind: 'publish', guide: step.guide || '',
      phase: opts.phase || 'await-check',
      checkResult: opts.checkResult || null,
      publishError: opts.publishError || null,
      editable: false, fields: [],
      targetUrl: (step.target && step.target.url) || null,
      status: 'pending',
    };
  }

  // 不可逆复核 HOLD → review-kind HITL（concerns + reason；editable:false，人工确认提交/中止）。
  // keyValues：放行前供人工核对的【已采集（非空）字段】（dashboard 复核卡渲染，guide「确认下方数据」落地）。
  function buildReviewHitl(step, verdict, product) {
    const present = {};
    for (const [k, v] of Object.entries(product || {})) {
      if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) present[k] = v;
    }
    return {
      action: '不可逆复核：' + step.label, stepId: step.id, kind: 'review', guide: step.guide || '',
      keyValues: present, reviewedBrief: '',
      concerns: (verdict && verdict.concerns) || [],
      reason: (verdict && verdict.reason) || '',
      editable: false, fields: [],
      targetUrl: (step.target && step.target.url) || null,
      status: 'pending',
    };
  }

  // 利润率计算（确定性纯函数）：毛利率口径 = (参考申报价 − 1688成本价 − 国内运费) / 参考申报价。
  // 确认申报价步（analysis:'margin'）的核价分析：buildHitl 用它填 keyValues 展示，orchHitlConfirm 用它落 grossMargin 快照。
  // 入参值可能是 string（HITL 输入框存 string）或 number；运费缺省/非数按 0；
  // 申报价或成本缺/非数、申报价≤0（不能做分母）→ ok:false（无法核价）。
  function computeMargin(product) {
    const num = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };
    const p = product || {};
    const rp = num(p.returnPrice);
    const cost = num(p.cost1688);
    const ship = num(p.domesticShipping) || 0;            // 运费缺省/非数 → 0
    if (rp === null || rp <= 0 || cost === null) {
      return { ok: false, reason: '数据不全无法核价（需参考申报价>0 + 1688成本价）' };
    }
    const value = (rp - cost - ship) / rp;
    return {
      ok: true,
      value,
      display: {
        '参考申报价': String(rp),
        '1688成本价': String(cost),
        '国内运费': String(ship),
        '毛利率': (value * 100).toFixed(1) + '%',
      },
    };
  }

  function makeEngine(deps) {
    const { read, queue, stepRunner } = deps;
    const now = deps.now || (() => null);
    const onStepSettled = deps.onStepSettled || (() => {});   // Plan 3：每步落地后通知（上报 STEP_RESULT），默认 noop
    const onPaused = deps.onPaused || (() => {});   // 后续刀：回填型 HITL pause 时通知 bg 请求大脑提议（fire-forget）
    const reviewGate = deps.reviewGate || null;   // 后续刀：不可逆步复核闸（async，注入；默认 null=不复核，release 沉睡）

    // 改 skeleton 里某 workflow（走 queue 串行化；workflow 不存在则跳过写）
    function mutateWorkflow(workflowId, fn) {
      return queue.enqueue(skeleton => {
        const wf = findWorkflow(skeleton, workflowId);
        if (!wf) return undefined;
        fn(wf);
        return skeleton;
      });
    }

    // 单步推进循环：读快照 → decideNext → 落地副作用 → 直到卡住（pause/complete/error/noop）
    async function advance(workflowId) {
      for (let guard = 0; guard < MAX_LOOP; guard++) {
        const wf = findWorkflow(await read(), workflowId);
        const decision = decideNext(wf);
        switch (decision.kind) {
          case 'run-auto': {
            const step = wf.steps[wf.cursor];                      // 本轮快照的 step 定义
            // 不可逆步闸（reversible===false 且未复核）：
            //   gate==='publish' 步 → 两段闸（不依赖大脑），停在 await-check，等 WF_PUBLISH_CHECK；
            //   其余 → 大脑复核闸（reviewGate 注入时；hold→停，pass/离线/超时→proceed）。
            if (step.reversible === false && !step.reviewed) {
              if (step.gate === 'publish') {
                await mutateWorkflow(workflowId, w => {
                  w.steps[w.cursor].status = 'paused'; w.status = 'paused';
                  w.hitl = buildPublishHitl(w.steps[w.cursor], { phase: 'await-check' });
                  w.updatedAt = now();
                });
                return;                                              // publish 两段闸：不跑 adapter，等 WF_PUBLISH_CHECK
              }
              if (reviewGate) {
                const verdict = await reviewGate(workflowId, step, wf);   // bg 实现：WS 往返+超时；离线/超时→null=proceed
                if (verdict && verdict.verdict === 'hold') {
                  await mutateWorkflow(workflowId, w => {
                    w.steps[w.cursor].status = 'paused'; w.status = 'paused';
                    w.hitl = buildReviewHitl(w.steps[w.cursor], verdict, w.product);
                    w.updatedAt = now();
                  });
                  return;                                            // 不跑 adapter，等人工确认提交/中止
                }
              }
            }
            await mutateWorkflow(workflowId, w => {
              const s = w.steps[w.cursor];
              s.status = 'running'; s.startedAt = now(); s.error = null; s.reviewed = true;   // checkpoint + PASS 标 reviewed
            });
            let res;
            try {
              res = await stepRunner(step, wf);                    // 调 feature 真实 adapter — 长操作，在 queue 外
            } catch (e) {
              res = { status: 'error', error: { category: 'read', code: 'STEP_THREW', message: String((e && e.message) || e), recoverable: false } };
            }
            await mutateWorkflow(workflowId, w => {
              const s = w.steps[w.cursor];
              s.committing = false; s.endedAt = now();
              if (res && res.status === 'done') {
                s.status = 'done'; s.result = res.result || null; s.error = null;
                Object.assign(w.product, pickProduct(res.result));  // 渐进填充
              } else {
                s.status = 'error';
                s.error = (res && res.error) || { category: 'business', code: 'UNKNOWN', message: '步骤失败', recoverable: false };
                w.status = 'error';
              }
              w.updatedAt = now();
            });
            onStepSettled(workflowId, step, res);   // Plan 3：通知（上报 STEP_RESULT 带 error+retryCount）；含 throw（res 已被 catch 包成 error）
            continue;
          }
          case 'pause-hitl': {
            await mutateWorkflow(workflowId, w => {
              w.steps[w.cursor].status = 'paused';
              w.status = 'paused';
              w.hitl = buildHitl(w.steps[w.cursor], w.product);   // 传 product 供 analysis 步算核价 keyValues
              w.updatedAt = now();
            });
            onPaused(workflowId);   // fire-forget：bg 据此为回填型步请求大脑提议（非回填步 bg 端自行过滤）
            return;                                                // 不驻留，等人确认
          }
          case 'advance-cursor': {
            await mutateWorkflow(workflowId, w => { w.cursor += 1; w.updatedAt = now(); });
            continue;
          }
          case 'complete': {
            await mutateWorkflow(workflowId, w => { w.status = 'done'; w.hitl = null; w.updatedAt = now(); });
            return;
          }
          case 'error': {
            await mutateWorkflow(workflowId, w => { w.status = 'error'; w.updatedAt = now(); });
            return;
          }
          default:                                                 // noop
            return;
        }
      }
      console.warn('[orch] advance 达循环上限 MAX_LOOP，疑似状态机异常', workflowId);
    }

    // SW 唤醒恢复：对 running workflow 的 cursor step 跑 decideRecovery（spec §4.2）
    async function recover(workflowId) {
      const wf = findWorkflow(await read(), workflowId);
      if (!wf || wf.status !== 'running') return { action: 'none' };
      const decision = decideRecovery(wf.steps[wf.cursor]);
      if (decision.action === 'rerun') {
        await mutateWorkflow(workflowId, w => {
          const s = w.steps[w.cursor];
          s.status = 'pending'; s.committing = false; s.error = null;
          w.updatedAt = now();
        });
        await advance(workflowId);
      } else if (decision.action === 'ask-hitl') {
        await mutateWorkflow(workflowId, w => {
          const s = w.steps[w.cursor];
          s.status = 'paused'; w.status = 'paused';
          w.hitl = {
            action: '恢复确认：' + s.label, stepId: s.id,
            keyValues: {}, reviewedBrief: '',
            prompt: '这步可能已执行，请确认：已完成→跳过 / 未完成→重试',
            editable: false, fieldType: 'recovery', options: ['已完成', '未完成'],
            targetUrl: (s.target && s.target.url) || null, status: 'pending',
          };
          w.updatedAt = now();
        });
      }
      return decision;
    }

    // Plan 3：应用大脑诊断决策（STATE_PATCH）。红线兜底（防大脑发错）后 retry / escalate。spec §6。
    async function applyDiagnosis(workflowId, patch) {
      const wf = findWorkflow(await read(), workflowId);
      if (!wf) return;
      const step = wf.steps[wf.cursor];
      if (!step || step.id !== patch.stepId) return;   // 只对当前 cursor step 生效
      let action = patch.action;
      const err = step.error || {};
      // 红线兜底：不可逆 / 超上限 强制 escalate（即使大脑说 retry）
      if (action === 'retry' && (err.recoverable === false || (step.retryCount || 0) >= MAX_RETRY)) {
        action = 'escalate';
      }
      if (action === 'retry') {
        await mutateWorkflow(workflowId, w => {
          const s = w.steps[w.cursor];
          s.status = 'pending'; s.error = null; s.committing = false;
          s.retryCount = (s.retryCount || 0) + 1;
          w.status = 'running'; w.updatedAt = now();
        });
        await advance(workflowId);
      } else {
        await mutateWorkflow(workflowId, w => {
          const s = w.steps[w.cursor];
          s.status = 'paused'; w.status = 'paused';
          w.hitl = buildHitl(s, w.product);
          w.hitl.reviewedBrief = (patch.reason || '') + '（大脑转人工）';
          w.updatedAt = now();
        });
      }
    }

    return { advance, recover, applyDiagnosis };
  }

  return { makeEngine, findWorkflow, pickProduct, buildHitl, buildReviewHitl, buildPublishHitl, computeMargin };
});
