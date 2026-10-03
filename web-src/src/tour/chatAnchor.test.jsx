import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../api.js', () => ({ getHistory: vi.fn(async () => []), chatStream: vi.fn(), uploadDocument: vi.fn() }))
vi.mock('../VoiceCall.jsx', () => ({ default: () => null }))

import Chat from '../Chat.jsx'

afterEach(cleanup)

it('主应用引导「有事直接说」的锚点包住对话输入框', async () => {
  render(<Chat threadId="t1" />)
  const box = await screen.findByPlaceholderText(/吩咐一句/)
  expect(box.closest('[data-tour="app-input"]')).not.toBeNull()
})
