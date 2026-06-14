// error-chip.js — step error 三分层 chip（spec §6.2）。read 紫红 / validate 黄 / business 红。
// category 是路由字段（spec §4.1）。视觉权重 business > validate > read（介入紧迫度）。
import { h } from './dom.js';

const CAT_LABEL = { read: '读取', validate: '校验', business: '业务' };

// 返回 chip 元素；error 为 null 返回 null（调用方过滤）
export function errorChip(error) {
  if (!error || !error.category) return null;
  const cat = error.category;
  const msg = error.message ? String(error.message) : '';
  const short = msg.length > 24 ? msg.slice(0, 24) + '…' : msg;
  return h('span', {
    class: 'err-chip ' + cat,
    title: msg + (error.suggestion ? '\n建议：' + error.suggestion : ''),
  }, `${CAT_LABEL[cat] || cat}${short ? '：' + short : ''}`);
}
