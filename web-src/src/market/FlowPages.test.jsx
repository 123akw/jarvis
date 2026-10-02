import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Brand from './Brand.jsx'
import Result from './Result.jsx'
import { ACCENTS } from './model.js'

/* 第十七轮：起名页与结果页「少即是多」 */

const plug = (id, name, icon) => ({ id, name, icon, examples: [] })
const PLUGINS = [plug('a', '日程提醒', '📅'), plug('b', '待办清单', '✅'), plug('c', '天气', '🌤️'), plug('d', '随手记', '📝')]

describe('起名页', () => {
  afterEach(cleanup)

  it('名字是唯一的大输入框；图标 / 主题色各一行单选；介绍标明可选；预览随之变化', async () => {
    const user = userEvent.setup()
    let brand = { name: '', icon: '✨', accent: ACCENTS[0].hex, tagline: '' }
    const onBrand = vi.fn(b => { brand = b })
    const { rerender } = render(<Brand brand={brand} accents={ACCENTS} onBrand={onBrand} profession={null} plugins={PLUGINS.slice(0, 2)} />)
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
    expect(screen.getByRole('textbox', { name: '名字' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /一句话介绍/ }).closest('div')).toHaveTextContent('可选')
    const icons = screen.getByRole('group', { name: '图标' })
    expect(within(icons).getAllByRole('radio').length).toBeGreaterThan(8)
    const colors = screen.getByRole('group', { name: /主题色/ })
    expect(within(colors).getAllByRole('radio')).toHaveLength(ACCENTS.length)

    await user.type(screen.getByRole('textbox', { name: '名字' }), '店')
    expect(onBrand).toHaveBeenLastCalledWith(expect.objectContaining({ name: '店' }))
    await user.click(within(icons).getByRole('radio', { name: '图标 🧋' }))
    expect(onBrand).toHaveBeenLastCalledWith(expect.objectContaining({ icon: '🧋' }))
    await user.click(within(colors).getByRole('radio', { name: '主题色 玫红' }))
    rerender(<Brand brand={{ ...brand, name: '小店', icon: '🧋' }} accents={ACCENTS} onBrand={onBrand} profession={null} plugins={PLUGINS.slice(0, 2)} />)
    const phone = screen.getByRole('figure', { name: '预览：小店在手机里的样子' })
    expect(phone).toHaveTextContent('2 个插件')
    expect(phone.style.getPropertyValue('--pa')).toBe('#FF375F')
    expect(screen.getByRole('radio', { name: '主题色 玫红' })).toBeChecked()
    // 不再写「第 2 步」；色名不常显（只在 aria-label / title 里）
    expect(screen.queryByText('第 2 步')).toBeNull()
    expect(screen.queryByText('玫红')).toBeNull()
  })

  it('字数到上限 80% 才显示计数；名字输入框沿用 #jvm-step-title（换到这一步时 Market 把焦点放到这里）', () => {
    const base = { name: '短名', icon: '✨', accent: ACCENTS[0].hex, tagline: '' }
    const { rerender } = render(<Brand brand={base} accents={ACCENTS} onBrand={vi.fn()} profession={null} plugins={[]} />)
    expect(screen.queryByText(/\/20$/)).toBeNull()
    rerender(<Brand brand={{ ...base, name: '一二三四五六七八九十一二三四五六' }} accents={ACCENTS} onBrand={vi.fn()} profession={null} plugins={[]} />)
    expect(screen.getByText('16/20')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '名字' })).toHaveAttribute('id', 'jvm-step-title')
    expect(screen.getByRole('heading', { level: 1, name: '给你的智能体起个名字' })).toBeInTheDocument()
  })
})

describe('结果页', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
  const platform = { name: '奶茶店小管家', icon: '🧋', accent: '#FF375F', tagline: '记订单' }

  it('单一焦点：标题「<名字> 已就绪」；账号卡两行 + 单项复制 + 警示；卡底「去登录」是唯一主按钮', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const onLogin = vi.fn()
    render(<Result platform={platform} plugins={PLUGINS} secret={{ username: 'u_1', password: 'pw-1' }} username="u_1"
      signedIn={false} onLogin={onLogin} onHome={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByRole('heading', { level: 1, name: '奶茶店小管家 已就绪' })).toHaveFocus()
    const key = screen.getByRole('region', { name: '专属账号与口令' })
    expect(within(key).getByRole('note')).toHaveTextContent('口令只显示这一次')
    await user.click(within(key).getByRole('button', { name: '复制口令' }))
    expect(writeText).toHaveBeenLastCalledWith('pw-1')
    await user.click(within(key).getByRole('button', { name: '去登录' }))
    expect(onLogin).toHaveBeenCalled()
    // 次要操作是一行文字按钮
    await user.click(screen.getByRole('button', { name: '复制账号和口令' }))
    expect(writeText).toHaveBeenLastCalledWith('账号：u_1\n口令：pw-1')
    expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '存成图片' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '再做一个' })).toBeInTheDocument()
    // 去掉了重复的说明
    expect(screen.queryByText(/智能体只用这些插件为你干活/)).toBeNull()
    expect(screen.queryByText(/添加到主屏幕/)).toBeNull()
  })

  it('装了哪些插件：叠放图标 +「查看 N 个插件」折叠；二维码收进「在手机上打开」折叠；口令不在时只剩一行说明', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 10 }, (_, i) => plug(`p${i}`, `插件${i}`, '🧩'))
    render(<Result platform={platform} plugins={many} secret={null} username="u_1"
      signedIn={false} onLogin={vi.fn()} onHome={vi.fn()} onReset={vi.fn()} />)
    const box = screen.getByRole('region', { name: '装了这些插件' })
    expect(box.querySelectorAll('.jvm-rp-stack i')).toHaveLength(9)   // 8 个 + 「+2」
    expect(box.querySelector('.jvm-rp-stack .is-more')).toHaveTextContent('+2')
    const toggle = within(box).getByRole('button', { name: '查看 10 个插件' })
    expect(box.querySelector('ul')).not.toBeVisible()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(box).getAllByRole('listitem')).toHaveLength(10)

    const phone = screen.getByRole('region', { name: '在手机上打开' })
    expect(within(phone).queryByRole('img')).toBeNull()
    await user.click(within(phone).getByRole('button', { name: '在手机上打开' }))
    expect(within(phone).getByRole('img', { name: /在手机上打开的二维码：.*\/login\?u=u_1/ })).toBeInTheDocument()

    const gone = screen.getByRole('region', { name: '专属账号' })
    expect(gone).toHaveTextContent('u_1')
    expect(gone).toHaveTextContent('口令只在生成时显示一次')
    expect(within(gone).getByRole('button', { name: '去登录' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制账号和口令' })).toBeNull()
  })
})
