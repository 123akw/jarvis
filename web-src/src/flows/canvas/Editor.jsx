/* 流程画布编辑器（第十八轮，归画布代理；契约见 docs/proposals/2026-10-round18-flows.md §5）。
 *
 * 由 flows/Flows.jsx（列表页代理）在 /flows/<id> 时渲染：
 *   <Editor flowId="abc" | "new"  initial={{ name, graph }}（新建 / 模板 / 一句话生成时给草稿）
 *           onSaved={flow => …}（首次保存后 Flows 把地址换成 /flows/<id>）
 *           onBack={() => …}  onExpired={() => …}  session={session} />
 * 编辑器自己取节点目录（GET /api/flows/nodes）、读写流程、运行（SSE）。地基只放占位。 */
export default function Editor({ flowId }) {
  return <div className="jvf-editor-stub" data-flow-id={flowId}>流程画布建设中…</div>
}
