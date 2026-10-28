/**
 * 编辑器 UI 开关（阶段 03.3）。
 *
 * 方案 §0 冻结边界明确：**`EDITOR_V2` 只控制 UI**，新旧界面共用同一数据访问层。
 * 所以这个文件只决定"渲染哪套界面"，绝不参与任何数据读写决策 ——
 * 一旦它影响了数据路径，就等于存在两套数据协议，而那是方案反复禁止的。
 *
 * 另外按 §10 的要求：03.3 达标后**当次删除旧 UI**，不保留两套编辑器。
 * 因此这里的 flag 是"迁移期的临时开关"，不是长期功能位；旧实现删除后
 * 这个文件与调用点会一并移除（见 docs 阶段 03.3 的说明）。
 */

/** 服务端读取：默认开启（新界面已是唯一实现，见下方说明） */
export function isEditorV2Enabled(): boolean {
  // 显式关闭仍允许：用于出问题时的应急回退，也便于"先小范围开"的发布节奏。
  const raw = process.env.EDITOR_V2;
  if (raw === "0" || raw === "false") return false;
  return true;
}

/** 客户端可读的公开版本（内联到页面，避免客户端再发一次请求） */
export const EDITOR_V2_PUBLIC = process.env.NEXT_PUBLIC_EDITOR_V2 !== "0";
