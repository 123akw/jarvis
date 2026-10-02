/* 拖拽加入（第十七轮契约，见 docs/proposals/2026-10-round17-market.md）
 * 这是不做事的占位：由「拖拽」代理换成真实实现；版面代理按这里的签名接线，彼此不用等。
 *
 * <DndRoot onAdd canAdd onReorder onRemove>：包住整个市场页（Market.jsx）
 *   onAdd(ids: string[])           拖入 Dock 或点「+」后加入（套装是多个 id）
 *   canAdd(id) => '' | '原因'       不能加入时返回原因（需要配置 / 暂不可用 / 已在工具箱）
 *   onReorder(from, to)             工具箱内拖动排序（下标）
 *   onRemove(id)                    拖出工具箱 / 拖到删除区
 * useDragSource({ id, ids, kind })：插件卡 / 套装卡的根元素展开 dragProps；kind = 'plugin' | 'bundle'
 * flyToDock(fromEl, { icon })：点「+」加入时的飞入动画（reduced-motion 时什么都不做）
 * useDockDrop()：Toolbox（Dock）用，拿到放置区属性与拖拽状态 */
export const DOCK_ID = 'jvm-dock-drop'

export function DndRoot({ children }) {
  return children
}

export function useDragSource() {
  return { dragProps: {}, isDragging: false }
}

export function flyToDock() {}

export function useDockDrop() {
  return { dropProps: {}, isOver: false, dragging: null, reason: '' }
}
