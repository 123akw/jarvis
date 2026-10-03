import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RunPanel from './RunPanel.jsx'

/* 运行面板的输入：没动过的字段显示默认值，必填检查也算上默认值（第十九轮修） */

const graph = {
  nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: '开始', fields: [
    { key: 'group', label: '按哪一列分组', type: 'text', required: true, default: '区域' },
    { key: 'note', label: '备注', type: 'text', required: true },
  ] } }],
  edges: [],
}

afterEach(cleanup)

describe('运行面板输入的默认值', () => {
  it('没动过的字段显示默认值，不算没填；真没填的仍拦下', () => {
    const onRun = vi.fn()
    const { rerender } = render(<RunPanel graph={graph} index={{}} run={null} inputs={{}} onInputs={() => {}} onRun={onRun}
      onStop={() => {}} onClose={() => {}} onLocate={() => {}} onFocusNode={() => {}} />)
    expect(screen.getByLabelText(/按哪一列分组/)).toHaveValue('区域')
    fireEvent.click(screen.getByRole('button', { name: '开始运行' }))
    expect(onRun).not.toHaveBeenCalled()   // 「备注」没默认值也没填
    rerender(<RunPanel graph={graph} index={{}} run={null} inputs={{ note: '月底前' }} onInputs={() => {}} onRun={onRun}
      onStop={() => {}} onClose={() => {}} onLocate={() => {}} onFocusNode={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '开始运行' }))
    expect(onRun).toHaveBeenCalledTimes(1)
  })
})
