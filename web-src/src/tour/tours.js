/* 新手引导的内容（第十八轮）。每一步：
 *   target     页面上 data-tour="<锚点>" 的元素（锚点清单见契约 §5.1 / §5.2 / §5.3）；不写就是居中的说明卡
 *   title      一句话标题
 *   body       一两句人话（不出现英文工具名、技术术语）
 *   placement  气泡优先放哪边：'bottom' | 'top' | 'right' | 'left'（默认自动挑放得下的一边）
 * 目标暂时不存在会等最多 1.5 秒，还没有就跳过这一步；整套都找不到就不弹。 */

export const TOURS = {
  'flows-home': {
    label: '我的流程',
    steps: [
      { target: 'flows-new', title: '新建一条流程', body: '从空白画布开始，把插件、AI 一步步拼成你自己的自动化。' },
      { target: 'flows-compose', title: '一句话生成', body: '不想自己拼？说说你想自动化什么，贾维斯先帮你搭好草稿，再按需改。' },
      { target: 'flows-templates', title: '从模板开始', body: '办公、学习、开店、生活都有现成的模板，挑一个改改就能用。' },
      { target: 'flows-list', title: '你的流程都在这', body: '做好的流程可以直接运行、设成定时，也能看每次的运行记录。' },
    ],
  },
  'flows-editor': {
    label: '流程画布',
    steps: [
      { target: 'flow-palette', title: '节点都在左边', placement: 'right',
        body: 'AI 处理、插件工具、技能、积木都在这里。按住拖到画布上，就多了一步。' },
      { target: 'flow-canvas', title: '把节点连起来',
        body: '从一个节点右边的小圆点拖到下一个节点，上一步的结果就顺着连线往下传。' },
      { target: 'flow-node-start', title: '从「开始」出发',
        body: '开始节点决定运行时要填什么，比如一段文字、一个文件。' },
      { target: 'flow-config', title: '点节点，在右边配置', placement: 'left',
        body: '选中一个节点，右边就能改名字、写要求、填参数。' },
      { target: 'flow-var', title: '用上一步的结果', placement: 'left',
        body: '点「插入变量」，就能把前面节点的产出放进来，比如把「AI 处理」写好的文字发到飞书。' },
      { target: 'flow-run', title: '运行，看每一步', placement: 'bottom',
        body: '点运行，每个节点的结果都会实时显示，哪一步出了问题一眼就能看到。' },
      { target: 'flow-save', title: '记得保存', placement: 'bottom',
        body: '改完点保存（也可以按 ⌘S）。保存后还能在「我的流程」的「触发方式」里设成定时、收到消息或通过链接自动运行。' },
    ],
  },
  market: {
    label: '智能体市场',
    steps: [
      { target: 'market-search', title: '先搜一搜',
        body: '输入插件名字，或者直接说想让它帮你做什么，比如「帮我管店里的进货」。' },
      { target: 'market-card', title: '看中了就放进工具箱',
        body: '把卡片拖到下面的工具箱，或者点右边的 +。点卡片能看详情。' },
      { target: 'market-dock', title: '这是你的工具箱', placement: 'top',
        body: '挑好的插件都在这里，点开可以调顺序、拿出来。' },
      { target: 'market-next', title: '下一步：起名生成', placement: 'top',
        body: '挑好了点「下一步」，起个名字，就能生成你的专属智能体。' },
    ],
  },
  app: {
    label: '主界面',
    steps: [
      { target: 'app-input', title: '有事直接说', placement: 'top',
        body: '在这里打字、发文件或者语音通话，查资料、记事、写东西都行。' },
      { target: 'app-cmdk', title: '⌘K 快捷吩咐',
        body: '搜旧对话、打开设置，或者直接打「明天 9 点开会」加进日程。' },
      { target: 'app-today', title: '今日板',
        body: '今天的日程、待办和备忘都在这里，点一下就展开。' },
      { target: 'app-menu', title: '右上角菜单',
        body: '市场、我的流程、各种设置都在这里。想再看一遍引导，也在这里点「新手引导」。' },
    ],
  },
}

export const tourSteps = id => TOURS[id]?.steps || []
export const tourLabel = id => TOURS[id]?.label || ''
