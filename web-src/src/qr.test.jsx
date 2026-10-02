import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { QrCode, qrMatrix, qrPath } from './qr.jsx'

describe('qr', () => {
  it('生成方阵，带三个定位角', () => {
    const m = qrMatrix('https://jws.gkgeek-set.cn/p/ab12cd34')
    expect(m.length).toBeGreaterThanOrEqual(21)
    expect(m.every(row => row.length === m.length)).toBe(true)
    expect(m[0][0] && m[0][6] && m[6][0] && m[6][6]).toBe(true)   // 左上定位角
  })
  it('path 与 viewBox 含边距', () => {
    const { d, size } = qrPath('hi', { margin: 2 })
    expect(d.startsWith('M2 2')).toBe(true)
    expect(size).toBe(qrMatrix('hi').length + 4)
  })
  it('组件可读出内容', () => {
    const { getByRole } = render(<QrCode value="https://x.test/p/abc" label="平台二维码" />)
    expect(getByRole('img', { name: '平台二维码' })).toBeTruthy()
  })
})
