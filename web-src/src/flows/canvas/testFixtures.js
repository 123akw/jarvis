/* 测试用的节点目录（契约 §3.2 的格式），catalog / Editor 测试共用。 */
export const CATALOG = {
  groups: [
    { id: 'steps', label: '积木', items: [
      { key: 'step:to_todo', type: 'step', role: 'output', title: '加到待办', icon: '✅', summary: '把条目加进待办', options: [], data: { step: 'to_todo', options: {} } },
      { key: 'step:feishu_send', type: 'step', role: 'output', title: '发到飞书', icon: '🕊️', available: false, reason: '先在设置里绑定飞书才能用', data: { step: 'feishu_send', options: {} } },
    ] },
    { id: 'basic', label: '基础', items: [
      { key: 'llm', type: 'llm', title: 'AI 处理', icon: '✨', summary: '让 AI 处理', data: { title: 'AI 处理', prompt: '' } },
      { key: 'start', type: 'start', title: '开始', data: {} },
    ] },
    { id: 'tools', label: '插件工具', items: [
      { key: 'tool:weather:weather__now', type: 'tool', title: '查实时天气', icon: '🌤️', summary: '查某个城市现在的天气', plugin: 'weather', plugin_name: '查天气', category: 'life',
        args: [{ name: 'city', label: '城市', type: 'string', required: true, description: '比如：北京' }], data: { title: '查实时天气', plugin: 'weather', tool: 'weather__now', args: {} }, available: true },
      { key: 'tool:calc:calc__eval', type: 'tool', title: '算一算', icon: '🧮', summary: '算个数', plugin: 'calc', plugin_name: '计算器', category: 'efficiency',
        args: [{ name: 'expression', label: '算式', type: 'string', required: true }], data: { title: '算一算', plugin: 'calc', tool: 'calc__eval', args: {} }, available: true },
      { key: 'tool:express:express__track', type: 'tool', title: '查快递', icon: '📦', plugin: 'express', plugin_name: '快递', category: 'life',
        args: [], data: { title: '查快递', plugin: 'express', tool: 'express__track', args: {} }, available: false, reason: '这个智能体还没装「快递」，到智能体设置里加上就能用' },
    ] },
    { id: 'skills', label: '技能', items: [
      { key: 'skill:work_report', type: 'llm', title: '周报写手', icon: '📝', data: { title: '周报写手', skill: 'work_report', prompt: '{{start.text}}' } },
    ] },
  ],
  categories: [{ id: 'efficiency', name: '效率' }, { id: 'life', name: '生活' }],
  outputs: { llm: ['text', 'items'], tool: ['text', 'items', 'links', 'files'], template: ['text', 'items'], step: ['text', 'items', 'title', 'links', 'parts'], condition: [], end: ['text', 'links'] },
  vars: { sys: [{ key: 'date', label: '今天日期' }, { key: 'time', label: '现在时间' }] },
  field_types: ['text', 'paragraph', 'file', 'number', 'select'],
}
